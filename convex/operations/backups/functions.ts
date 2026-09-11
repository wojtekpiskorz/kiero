/**
 * The complete-backup function surface (I5).
 *
 * The Convex side is the coordination authority; the EU backup Container
 * (apps/backup-worker) is the executor. One 15-minute run:
 *
 * 1. `beginRun` (single-run lease): decides start/takeover/retry/refuse for
 *    the current slot, reads the retained-media inventory (D3 seam) and the
 *    content-free deletion ledger (I4 seam) atomically, and stores the
 *    inventory on the building row as the closure authority.
 * 2. The executor exports the database snapshot with the pinned documented
 *    mechanism (the pre-installed `convex export` binary), copies every inventory object
 *    into the private EU backup bucket's shared media pool (idempotent,
 *    content-verified), writes the deletion ledger as its own hashed file,
 *    and publishes the immutable manifest object LAST.
 * 3. `completeRun` verifies closure SERVER-SIDE (published media list must
 *    equal the begin inventory minus typed purge drops; hashes, sizes and
 *    ledger count must match; tier and retention deadline are recomputed,
 *    never trusted from the client) before a row may become `verified`.
 *    A partial set can therefore never be labelled complete.
 * 4. `failRun` records a typed failure; freshness alerting (I2 seam) and the
 *    next slot's retry take it from there.
 * 5. `sweepPlan`/`sweepComplete` run the reference-aware retention pass:
 *    expired sets are collected, pooled objects are deleted only when no
 *    SURVIVING manifest references them, and stale failed rows are pruned.
 *
 * Health/cost events (I2 seam) are emitted by the HTTP boundary and the
 * cron tick around these functions: every attempt records a `backup.job`
 * heartbeat, completed runs record measured cost entries, and the
 * freshness check emits the deduplicated `ops.backup.stale` diagnostic.
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { emitDiagnosticEvent } from "../telemetry/emit";
import {
  canonicalJson,
  deletedContentInvariantHolds,
  decideBegin,
  exceededAllowances as exceededAllowanceCategories,
  freshnessOf,
  isSha256Hex,
  isValidFailureReason,
  planSweep,
  retentionMsOfTier,
  slotOf,
  staleDedupKey,
  R2_FREE_PLAN_LIMITS,
  tierOfSlot,
  LEASE_MS,
  type RunUsage,
} from "./slot";
import { periodOf } from "../telemetry/costs";
import {
  deletionLedgerSnapshot,
  purgedDropsOf,
  retainedMediaInventory,
  type InventoryEntry,
  type LedgerEntry,
} from "./inventory";

// --- explicit result types (closed reasons; no internal detail crosses) ----

export interface BeginAcquired {
  readonly status: "acquired";
  readonly manifestId: string;
  readonly attempt: number;
  readonly slotMs: number;
  readonly snapshotAtMs: number;
  readonly tier: "frequent" | "daily";
  readonly leaseExpiresAtMs: number;
  /** The media objects this run must copy and verify (purge drops removed). */
  readonly media: readonly InventoryEntry[];
  /** Purge-recorded drops already excluded from `media` (I4 seam). */
  readonly purgedDrops: readonly { objectKey: string; sourceId: string }[];
  /** The content-free deletion/revocation ledger to carry separately. */
  readonly ledger: readonly LedgerEntry[];
}

export interface BeginRefused {
  readonly status: "refused";
  readonly reason:
    | "lease_held"
    | "already_complete"
    | "attempts_exhausted"
    | "slot_passed"
    | "inventory_invalid"
    | "retention_invariant_broken";
  readonly manifestId?: string;
  readonly leaseExpiresAtMs?: number;
}

export type BeginResult = BeginAcquired | BeginRefused;

export interface CompleteOk {
  readonly ok: true;
  readonly manifestId: string;
  readonly tier: "frequent" | "daily";
  readonly expiresAtMs: number;
  readonly mediaManifestHash: string;
  /** The run's measured usage (P12): bytes, object count and S3 op counts. */
  readonly usage: RunUsage;
}

export type CompleteFailureReason =
  | "manifest_not_building"
  | "lease_expired"
  | "attempt_mismatch"
  | "inventory_corrupt"
  | "purged_drop_unverifiable"
  | "media_closure_failed"
  | "media_duplicate_key"
  | "media_hash_invalid"
  | "media_bytes_mismatch"
  | "database_hash_invalid"
  | "ledger_count_mismatch"
  | "manifest_hash_invalid"
  | "usage_invalid";

export type CompleteResult = CompleteOk | { readonly ok: false; readonly reason: CompleteFailureReason };

export interface CompleteMediaEntry {
  readonly objectKey: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface CompleteInput {
  readonly manifestId: string;
  readonly attempt: number;
  readonly database: { readonly sha256: string; readonly bytes: number };
  readonly media: readonly CompleteMediaEntry[];
  readonly ledger: { readonly sha256: string; readonly bytes: number; readonly count: number };
  readonly manifestHash: string;
  readonly droppedPurged: readonly { objectKey: string; sourceId: string }[];
  /** Executor-measured S3 Class A ops (PUTs/DELETEs) of this run (P12). */
  readonly classAOps: number;
  /** Executor-measured S3 Class B ops (GETs/HEADs/LISTs) of this run (P12). */
  readonly classBOps: number;
}

// --- shared reads ----------------------------------------------------------------

/** Loads the row of one slot, if any. */
async function slotRow(db: QueryCtx["db"], slotMs: number) {
  return db
    .query("recoveryManifests")
    .withIndex("by_slot", (q) => q.eq("slotMs", slotMs))
    .first();
}

/** Parses a row's stored inventory into its object-key list. */
function keysOfInventoryJson(inventoryJson: string | undefined): string[] {
  if (inventoryJson === undefined) {
    return [];
  }
  try {
    return (JSON.parse(inventoryJson) as InventoryEntry[]).map((entry) => entry.objectKey);
  } catch {
    return [];
  }
}

async function sha256HexOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// --- begin: the single-run lease + atomic inventory anchor ----------------------

/**
 * The begin transaction: the pure decision (slot.ts) applied to the slot's
 * row, plus the inventory/ledger anchor stored on the building row.
 * Refusals never write (except an invalid inventory, which fails the
 * in-flight row typed so the attempt is visible).
 */
export async function beginRunTx(ctx: MutationCtx, nowMs: number = Date.now()): Promise<BeginResult> {
  if (!deletedContentInvariantHolds()) {
    // A retention configuration that could keep purged bytes beyond 30 days
    // must fail loudly, never silently back up.
    return { status: "refused", reason: "retention_invariant_broken" };
  }
  const slotMs = slotOf(nowMs);
  const existing = await slotRow(ctx.db, slotMs);
  const decision = decideBegin(
    slotMs,
    existing === null
      ? null
      : {
          slotMs: existing.slotMs ?? slotMs,
          state: existing.state,
          attempts: existing.attempts ?? 1,
          ...(existing.leaseExpiresAtMs === undefined
            ? {}
            : { leaseExpiresAtMs: existing.leaseExpiresAtMs }),
          snapshotAtMs: existing.snapshotAtMs,
          ...(existing.expiresAtMs === undefined ? {} : { expiresAtMs: existing.expiresAtMs }),
        },
    nowMs,
  );
  const refused = (
    reason: BeginRefused["reason"],
  ): BeginRefused => ({
    status: "refused",
    reason,
    ...(existing === null
      ? {}
      : {
          manifestId: existing._id as string,
          ...(existing.leaseExpiresAtMs === undefined
            ? {}
            : { leaseExpiresAtMs: existing.leaseExpiresAtMs }),
        }),
  });

  if (decision.action === "refuse") {
    return refused(decision.reason);
  }

  const inventory = await retainedMediaInventory(ctx.db);
  if (!Array.isArray(inventory)) {
    if (existing !== null && existing.state === "building") {
      await ctx.db.patch(existing._id, { state: "failed", failureReason: inventory.reason });
    }
    return { status: "refused", reason: "inventory_invalid" };
  }
  const ledger = await deletionLedgerSnapshot(ctx.db);
  // Every acquire re-anchors the snapshot time: the inventory (and the
  // export that follows) reflects the CURRENT database state, and freshness
  // is measured from that snapshot, never from an attempt's start.
  const snapshotAtMs = nowMs;
  const leaseExpiresAtMs = nowMs + LEASE_MS;

  const purgedDrops = purgedDropsOf(inventory, ledger, snapshotAtMs);
  const dropKeys = new Set(purgedDrops.map((drop) => drop.objectKey));
  const media = inventory.filter((entry) => !dropKeys.has(entry.objectKey));

  const rowValues = {
    state: "building" as const,
    snapshotAtMs,
    leaseExpiresAtMs,
    inventoryJson: JSON.stringify(inventory),
    ledgerCount: ledger.length,
  };
  let manifestId: string;
  let attempt: number;
  if (decision.action === "start") {
    attempt = 1;
    manifestId = (await ctx.db.insert("recoveryManifests", {
      ...rowValues,
      attempts: attempt,
      databaseManifestHash: "",
      slotMs,
    })) as string;
  } else {
    if (existing === null) {
      // Unreachable by construction (takeover/retry only come from an
      // existing row); ONE guard keeps the narrowing explicit.
      return refused("slot_passed");
    }
    attempt = (existing.attempts ?? 1) + 1;
    manifestId = existing._id as string;
    await ctx.db.patch(existing._id, {
      ...rowValues,
      attempts: attempt,
      failureReason: undefined,
      expiresAtMs: undefined,
    });
  }
  return {
    status: "acquired",
    manifestId,
    attempt,
    slotMs,
    snapshotAtMs,
    tier: tierOfSlot(slotMs),
    leaseExpiresAtMs,
    media,
    purgedDrops,
    ledger,
  };
}

export const beginRun = internalMutation({
  args: {
    /**
     * PROOF/TEST CLOCK OVERRIDE (never used in production): the tx's
     * existing `nowMs` parameter, exposed so the guarded proof action can
     * acquire a slot OTHER than the current one - a live proof must not
     * wait out the 15-minute grid between scenarios, and a completed slot
     * is `already_complete` forever by design. The HTTP run route sends no
     * body, so production always decides on real wall-clock time; the
     * decision logic itself reads this value unchanged.
     */
    nowMs: v.optional(v.float64()),
  },
  handler: async (ctx, args): Promise<BeginResult> => beginRunTx(ctx, args.nowMs ?? Date.now()),
});

// --- complete: server-side closure verification -----------------------------------

/**
 * Verifies and publishes one manifest. The CLIENT provides measured hashes;
 * the SERVER owns every decision: closure against the begin inventory,
 * purge-drop validation against the ledger, tier/retention recomputation
 * from the slot. Only a fully verified set becomes `verified`.
 */
export async function completeRunTx(ctx: MutationCtx, input: CompleteInput): Promise<CompleteResult> {
  const id = ctx.db.normalizeId("recoveryManifests", input.manifestId);
  if (id === null) {
    return { ok: false, reason: "manifest_not_building" };
  }
  const row = await ctx.db.get(id);
  if (row === null || row.state !== "building") {
    return { ok: false, reason: "manifest_not_building" };
  }
  if ((row.leaseExpiresAtMs ?? 0) <= Date.now()) {
    return { ok: false, reason: "lease_expired" };
  }
  if ((row.attempts ?? 0) !== input.attempt) {
    return { ok: false, reason: "attempt_mismatch" };
  }
  let expected: InventoryEntry[];
  try {
    expected = JSON.parse(row.inventoryJson ?? "[]") as InventoryEntry[];
  } catch {
    return { ok: false, reason: "inventory_corrupt" };
  }
  const nowMs = Date.now();
  const ledger = await deletionLedgerSnapshot(ctx.db);
  const purgedSources = new Set<string>();
  for (const entry of ledger) {
    if (
      entry.kind === "source_purge" &&
      entry.targetSourceId !== null &&
      entry.createdAtMs <= nowMs
    ) {
      purgedSources.add(entry.targetSourceId);
    }
  }
  // Every claimed drop must be an inventory entry whose source has a purge
  // record at or before completion (mid-run purges included).
  const dropKeys = new Set<string>();
  for (const drop of input.droppedPurged) {
    const entry = expected.find((candidate) => candidate.objectKey === drop.objectKey);
    if (
      entry === undefined ||
      entry.sourceId === null ||
      entry.sourceId !== drop.sourceId ||
      !purgedSources.has(drop.sourceId)
    ) {
      return { ok: false, reason: "purged_drop_unverifiable" };
    }
    dropKeys.add(drop.objectKey);
  }
  const published = new Map<string, CompleteMediaEntry>();
  for (const entry of input.media) {
    if (published.has(entry.objectKey)) {
      return { ok: false, reason: "media_duplicate_key" };
    }
    published.set(entry.objectKey, entry);
  }
  // Closure: the published set must EQUAL the inventory minus validated drops.
  const expectedKeys = new Set(
    expected.filter((entry) => !dropKeys.has(entry.objectKey)).map((entry) => entry.objectKey),
  );
  if (
    expectedKeys.size !== published.size ||
    [...expectedKeys].some((key) => !published.has(key))
  ) {
    return { ok: false, reason: "media_closure_failed" };
  }
  let mediaBytes = 0;
  for (const entry of expected) {
    if (dropKeys.has(entry.objectKey)) {
      continue;
    }
    const measured = published.get(entry.objectKey);
    if (measured === undefined || !isSha256Hex(measured.sha256)) {
      return { ok: false, reason: "media_hash_invalid" };
    }
    if (entry.bytes !== null && entry.bytes !== measured.bytes) {
      return { ok: false, reason: "media_bytes_mismatch" };
    }
    mediaBytes += measured.bytes;
  }
  if (!isSha256Hex(input.database.sha256) || input.database.bytes < 0) {
    return { ok: false, reason: "database_hash_invalid" };
  }
  if (!Number.isFinite(input.classAOps) || input.classAOps < 0 || !Number.isFinite(input.classBOps) || input.classBOps < 0) {
    return { ok: false, reason: "usage_invalid" };
  }
  if (input.ledger.count !== (row.ledgerCount ?? 0)) {
    return { ok: false, reason: "ledger_count_mismatch" };
  }
  if (!isSha256Hex(input.manifestHash)) {
    return { ok: false, reason: "manifest_hash_invalid" };
  }
  const slotAnchor = row.slotMs ?? slotOf(row.snapshotAtMs);
  const tier = tierOfSlot(slotAnchor);
  const expiresAtMs = slotAnchor + retentionMsOfTier(tier);
  const mediaManifestHash = await sha256HexOf(
    canonicalJson(
      [...input.media]
        .sort((left, right) => (left.objectKey < right.objectKey ? -1 : 1))
        .map((entry) => ({ objectKey: entry.objectKey, sha256: entry.sha256, bytes: entry.bytes })),
    ),
  );
  const usage: RunUsage = {
    databaseBytes: input.database.bytes,
    mediaBytes,
    mediaObjects: input.media.length,
    classAOps: input.classAOps,
    classBOps: input.classBOps,
  };
  await ctx.db.patch(id, {
    state: "verified",
    databaseManifestHash: input.database.sha256,
    mediaManifestHash,
    mediaObjectCount: input.media.length,
    verifiedAtMs: nowMs,
    completedAtMs: nowMs,
    expiresAtMs,
    tier,
    databaseBytes: input.database.bytes,
    mediaBytes,
    manifestHash: input.manifestHash,
    classAOps: input.classAOps,
    classBOps: input.classBOps,
    purgedDroppedJson: canonicalJson(input.droppedPurged),
    failureReason: undefined,
  });
  await ctx.db.insert("auditRecords", {
    operationName: "operations.backup.manifestPublished",
    atMs: nowMs,
  });
  return {
    ok: true,
    manifestId: id as string,
    tier,
    expiresAtMs,
    mediaManifestHash,
    usage,
  };
}

export const completeRun = internalMutation({
  args: {
    manifestId: v.string(),
    attempt: v.float64(),
    database: v.object({ sha256: v.string(), bytes: v.float64() }),
    media: v.array(v.object({ objectKey: v.string(), sha256: v.string(), bytes: v.float64() })),
    ledger: v.object({ sha256: v.string(), bytes: v.float64(), count: v.float64() }),
    manifestHash: v.string(),
    droppedPurged: v.array(v.object({ objectKey: v.string(), sourceId: v.string() })),
    classAOps: v.float64(),
    classBOps: v.float64(),
  },
  handler: async (ctx, args): Promise<CompleteResult> => completeRunTx(ctx, args),
});

// --- fail --------------------------------------------------------------------------

export const failRun = internalMutation({
  args: { manifestId: v.string(), attempt: v.float64(), reason: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    if (!isValidFailureReason(args.reason)) {
      return { ok: false, reason: "reason_invalid" };
    }
    const id = ctx.db.normalizeId("recoveryManifests", args.manifestId);
    if (id === null) {
      return { ok: false, reason: "manifest_not_building" };
    }
    const row = await ctx.db.get(id);
    if (row === null || row.state !== "building" || (row.attempts ?? 0) !== args.attempt) {
      return { ok: false, reason: "manifest_not_building" };
    }
    await ctx.db.patch(id, { state: "failed", failureReason: args.reason });
    return { ok: true };
  },
});

// --- the reference-aware retention sweep --------------------------------------------

export interface SweepPlanView {
  readonly plan: ReturnType<typeof planSweep>;
  /** Every key referenced by ANY row (verified/building/failed): the orphan guard. */
  readonly referencedByAnyManifest: readonly string[];
}

/** The sweep plan over all manifest rows (read-only; the executor applies it). */
export async function sweepPlanTx(db: QueryCtx["db"], nowMs: number = Date.now()): Promise<SweepPlanView> {
  const rows = await db.query("recoveryManifests").collect();
  const views = rows.map((row) => ({
    manifestId: row._id as string,
    slotMs: row.slotMs ?? row.snapshotAtMs,
    state: row.state,
    ...(row.expiresAtMs === undefined ? {} : { expiresAtMs: row.expiresAtMs }),
    mediaObjectKeys: keysOfInventoryJson(row.inventoryJson),
  }));
  return {
    plan: planSweep(views, nowMs),
    referencedByAnyManifest: [...new Set(views.flatMap((view) => view.mediaObjectKeys))].sort(),
  };
}

export const sweepPlan = internalQuery({
  args: {},
  handler: async (ctx): Promise<SweepPlanView> => sweepPlanTx(ctx.db),
});

/** How long failed rows survive as visible history before pruning. */
export const FAILED_ROW_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * Applies a finished sweep: collected expired sets' rows go, stale failed
 * rows are pruned, and one audited retention-evidence record is written
 * (J5 reads this trail). Idempotent: rows already gone count as replayed.
 */
export async function sweepCompleteTx(
  ctx: MutationCtx,
  args: { collectedManifestIds: readonly string[]; deletedObjectKeys?: readonly string[]; orphanKeysRemoved?: readonly string[] },
  nowMs: number = Date.now(),
): Promise<{ collected: number; replayed: number; prunedFailed: number; skipped: number }> {
  let collected = 0;
  let replayed = 0;
  let skipped = 0;
  for (const manifestId of args.collectedManifestIds) {
    const id = ctx.db.normalizeId("recoveryManifests", manifestId);
    if (id === null) {
      replayed += 1;
      continue;
    }
    const row = await ctx.db.get(id);
    if (row === null) {
      replayed += 1; // an interrupted sweep's replay
      continue;
    }
    // Never collect an in-flight run or a set whose deadline has not passed.
    if (row.state === "building" || (row.expiresAtMs !== undefined && row.expiresAtMs > nowMs)) {
      skipped += 1;
      continue;
    }
    await ctx.db.delete(id);
    collected += 1;
  }
  // Failed rows are history, not recovery sets: prune them after 48h.
  const failedRows = await ctx.db
    .query("recoveryManifests")
    .withIndex("by_state", (q) => q.eq("state", "failed"))
    .collect();
  let prunedFailed = 0;
  for (const row of failedRows) {
    if (nowMs - row.snapshotAtMs > FAILED_ROW_RETENTION_MS) {
      await ctx.db.delete(row._id);
      prunedFailed += 1;
    }
  }
  await ctx.db.insert("auditRecords", {
    operationName: "operations.backup.retentionSweep",
    atMs: nowMs,
  });
  return { collected, replayed, prunedFailed, skipped };
}

export const sweepComplete = internalMutation({
  args: {
    collectedManifestIds: v.array(v.string()),
    deletedObjectKeys: v.array(v.string()),
    orphanKeysRemoved: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<{ collected: number; replayed: number; prunedFailed: number; skipped: number }> =>
    sweepCompleteTx(ctx, args),
});

// --- freshness (I2 seam) -------------------------------------------------------------

/** The rows the freshness check reads. */
async function freshnessInputs(db: QueryCtx["db"]) {
  const verified = await db
    .query("recoveryManifests")
    .withIndex("by_state", (q) => q.eq("state", "verified"))
    .collect();
  const failed = await db
    .query("recoveryManifests")
    .withIndex("by_state", (q) => q.eq("state", "failed"))
    .collect();
  return {
    verifiedSnapshotsAtMs: verified.map((row) => row.snapshotAtMs),
    failedTimesAtMs: failed.map((row) => row.snapshotAtMs),
    anyAttempt: verified.length + failed.length > 0,
  };
}

export interface FreshnessResult {
  readonly state: "fresh" | "stale" | "never_verified";
  readonly ageMs: number | null;
  readonly emitted: boolean;
  readonly reason?: string;
}

/**
 * Evaluates freshness from SNAPSHOT times and emits the deduplicated
 * `ops.backup.stale` diagnostic when the newest verified set is older than
 * one hour (or attempts exist but none ever verified). Never emits when no
 * backup attempt ever ran (the lane is not wired yet, not silently broken).
 */
export async function freshnessCheckTx(ctx: MutationCtx, nowMs: number = Date.now()): Promise<FreshnessResult> {
  const inputs = await freshnessInputs(ctx.db);
  const freshness = freshnessOf(inputs.verifiedSnapshotsAtMs, inputs.failedTimesAtMs, nowMs);
  if (freshness.state === "fresh") {
    return { state: freshness.state, ageMs: freshness.ageMs, emitted: false };
  }
  if (freshness.state === "never_verified" && !inputs.anyAttempt) {
    return { state: freshness.state, ageMs: null, emitted: false, reason: "no_attempts" };
  }
  const result = await emitDiagnosticEvent(ctx, {
    kind: "ops.backup.stale",
    metadata: [
      { key: "serviceName", value: "backup.job" },
      { key: "state", value: freshness.state === "stale" ? "stale" : "never_verified" },
      { key: "ageMs", value: String(freshness.ageMs ?? 0) },
      { key: "count", value: String(freshness.recentFailures) },
    ],
    serviceName: "backup.job",
    dedupKey: staleDedupKey(freshness.dedupAnchorMs ?? 0),
  });
  return {
    state: freshness.state,
    ageMs: freshness.ageMs,
    emitted: result.emitted,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  };
}

export const freshnessCheck = internalMutation({
  args: {},
  handler: async (ctx): Promise<FreshnessResult> => freshnessCheckTx(ctx),
});

// --- the cron tick (Convex-owned schedule) ---------------------------------------------

/** One slot's row, for the tick's due-slot check. */
export const slotRowQuery = internalQuery({
  args: { slotMs: v.float64() },
  handler: async (ctx, args): Promise<{ manifestId: string; state: string } | null> => {
    const row = await slotRow(ctx.db, args.slotMs);
    return row === null ? null : { manifestId: row._id as string, state: row.state };
  },
});

/**
 * The Convex-owned schedule tick (every 15 minutes, convex/crons.ts): runs
 * the freshness check, and when the current slot has NO row at all (the
 * Container missed its own trigger), pings the backup worker's run endpoint
 * best-effort so the schedule converges under partial scheduler loss.
 */
export const backupTick = internalAction({
  args: {},
  handler: async (ctx): Promise<{
    freshness: FreshnessResult;
    dueSlotEmpty: boolean;
    ping: { attempted: boolean; status?: number; failed?: string };
  }> => {
    const freshness = await ctx.runMutation(
      internal.operations.backups.functions.freshnessCheck,
      {},
    );
    const slotMs = slotOf(Date.now());
    const row = await ctx.runQuery(internal.operations.backups.functions.slotRowQuery, { slotMs });
    const dueSlotEmpty = row === null;
    const ping: { attempted: boolean; status?: number; failed?: string } = { attempted: false };
    const workerUrl = process.env.KIERO_BACKUP_WORKER_URL;
    if (dueSlotEmpty && workerUrl !== undefined && workerUrl !== "") {
      ping.attempted = true;
      try {
        const response = await fetch(`${workerUrl.replace(/\/$/, "")}/run`, {
          method: "POST",
          headers: {
            ...(process.env.KIERO_SERVICE_TOKEN === undefined
              ? {}
              : { authorization: `Bearer ${process.env.KIERO_SERVICE_TOKEN}` }),
          },
        });
        ping.status = response.status;
      } catch {
        ping.failed = "fetch_failed";
      }
    }
    return { freshness, dueSlotEmpty, ping };
  },
});

// --- the composed state read (proofs, I6, J5) --------------------------------------------

export const backupsState = internalQuery({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const rows = await ctx.db
      .query("recoveryManifests")
      .withIndex("by_snapshot")
      .order("desc")
      .take(50);
    const inputs = await freshnessInputs(ctx.db);
    const freshness = freshnessOf(inputs.verifiedSnapshotsAtMs, inputs.failedTimesAtMs, Date.now());
    const pooledKeys = new Map<string, number>();
    for (const row of rows) {
      if (row.state !== "verified") {
        continue;
      }
      try {
        for (const entry of JSON.parse(row.inventoryJson ?? "[]") as InventoryEntry[]) {
          pooledKeys.set(entry.objectKey, entry.bytes ?? 0);
        }
      } catch {
        // A corrupt inventory on a verified row is surfaced by the sweep;
        // the state read must never throw across the boundary.
      }
    }
    const pooledBytes = [...pooledKeys.values()].reduce((total, bytes) => total + bytes, 0);
    // P12 monthly ops rollup: the executor counts Class A/B ops per run
    // (complete stores them); the state read sums the calendar month's
    // verified runs and compares against the free allowances (slot.ts).
    const currentPeriod = periodOf(Date.now());
    let monthlyClassA = 0;
    let monthlyClassB = 0;
    const verifiedRows = await ctx.db
      .query("recoveryManifests")
      .withIndex("by_state", (q) => q.eq("state", "verified"))
      .collect();
    for (const row of verifiedRows) {
      if (periodOf(row.snapshotAtMs) === currentPeriod) {
        monthlyClassA += row.classAOps ?? 0;
        monthlyClassB += row.classBOps ?? 0;
      }
    }
    return {
      atMs: Date.now(),
      freshness,
      deletedContentInvariantHolds: deletedContentInvariantHolds(),
      pooledObjectCount: pooledKeys.size,
      // P12 measurement: pooled bytes against the configured free allowance
      // (R2_FREE_PLAN_LIMITS mirror in infra/backups/plan-limits.json), plus
      // the month's measured Class A/B ops and which allowances they exceed.
      pooledBytes,
      storageFreeBytes: R2_FREE_PLAN_LIMITS.storageFreeBytes,
      withinStorageFreeAllowance: pooledBytes <= R2_FREE_PLAN_LIMITS.storageFreeBytes,
      monthlyClassAOps: monthlyClassA,
      monthlyClassBOps: monthlyClassB,
      exceededAllowances: exceededAllowanceCategories(pooledBytes, monthlyClassA, monthlyClassB),
      manifests: rows.map((row) => ({
        manifestId: row._id as string,
        slotMs: row.slotMs ?? null,
        snapshotAtMs: row.snapshotAtMs,
        state: row.state,
        tier: row.tier ?? null,
        attempts: row.attempts ?? null,
        ...(row.expiresAtMs === undefined ? {} : { expiresAtMs: row.expiresAtMs }),
        ...(row.verifiedAtMs === undefined ? {} : { verifiedAtMs: row.verifiedAtMs }),
        ...(row.completedAtMs === undefined ? {} : { completedAtMs: row.completedAtMs }),
        ...(row.failureReason === undefined ? {} : { failureReason: row.failureReason }),
        ...(row.databaseBytes === undefined ? {} : { databaseBytes: row.databaseBytes }),
        ...(row.mediaBytes === undefined ? {} : { mediaBytes: row.mediaBytes }),
        ...(row.mediaObjectCount === undefined ? {} : { mediaObjectCount: row.mediaObjectCount }),
        ...(row.classAOps === undefined ? {} : { classAOps: row.classAOps }),
        ...(row.classBOps === undefined ? {} : { classBOps: row.classBOps }),
        ...(row.manifestHash === undefined ? {} : { manifestHash: row.manifestHash }),
        ...(row.databaseManifestHash === undefined
          ? {}
          : { databaseManifestHash: row.databaseManifestHash }),
        ...(row.mediaManifestHash === undefined ? {} : { mediaManifestHash: row.mediaManifestHash }),
      })),
    };
  },
});
