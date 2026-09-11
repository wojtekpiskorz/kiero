/**
 * I5 focused verification, part 2: the REAL Convex transactions
 * (begin/complete/fail/sweep/freshness) driven through the in-memory
 * harness - the server owns closure, so partial sets can never be labelled
 * complete, and overlapping writers can never both hold a slot.
 */

import { describe, expect, it } from "vitest";
import {
  beginRunTx,
  completeRunTx,
  freshnessCheckTx,
  sweepCompleteTx,
  sweepPlanTx,
} from "../../convex/operations/backups/functions";
import type { CompleteInput } from "../../convex/operations/backups/functions";
import {
  LEASE_MS,
  SCHEDULE_INTERVAL_MS,
  tierOfSlot,
  retentionMsOfTier,
  slotOf,
} from "../../convex/operations/backups/slot";
import { fakeBackupCtx, BACKUP_TABLES, type FakeCtx } from "./harness";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * Deterministic test clock: a PAST slot far from the current boundary for
 * lease-matrix tests, and a CURRENT-slot anchor (pushed to the next slot
 * when the wall clock is too close to the boundary for in-slot steps).
 */
const PAST_SLOT = slotOf(Date.now()) - 24 * 60 * MIN;
function currentSlotAnchor(): number {
  const now = Date.now();
  const slot = slotOf(now);
  return now - slot < 13 * MIN ? slot : slot + SCHEDULE_INTERVAL_MS;
}

interface SeededMedia {
  readonly objectKey: string;
  readonly bytes: number;
  readonly sourceId: string | null;
}

/** Seeds one verified retained representation (+ attachment, optional source). */
async function seedMedia(ctx: FakeCtx, media: SeededMedia): Promise<void> {
  const attachmentId = await ctx.db.insert("attachments", {
    uploadId: "kupload0000ttttttttttttttttt",
    kind: "image",
    objectKey: media.objectKey,
    ...(media.sourceId === null ? {} : { sourceId: media.sourceId }),
    createdAtMs: Date.now(),
  });
  await ctx.db.insert("mediaRepresentations", {
    attachmentId,
    role: "retained",
    objectKey: media.objectKey,
    contentHash: "proof-sha256:1",
    transformVersion: "test/1",
    verifiedAtMs: Date.now(),
    createdAtMs: Date.now(),
    bytes: media.bytes,
  });
}

function fakeSha(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 16 ** 64;
  }
  return hash.toString(16).padStart(64, "0");
}

type BeginForComplete = {
  manifestId?: string;
  attempt?: number;
  media?: readonly { objectKey: string; bytes: number | null }[];
  ledger?: readonly unknown[];
};

/** A complete input matching the begin inventory (plus optional drops). */
function completeInputFor(
  begin: BeginForComplete,
  overrides: Partial<CompleteInput> = {},
): CompleteInput {
  const media = (begin.media ?? []).map((entry) => ({
    objectKey: entry.objectKey,
    sha256: fakeSha(entry.objectKey),
    bytes: entry.bytes ?? 12,
  }));
  return {
    manifestId: begin.manifestId!,
    attempt: begin.attempt!,
    database: { sha256: fakeSha("database"), bytes: 340 },
    media,
    ledger: { sha256: fakeSha("ledger"), bytes: 90, count: begin.ledger?.length ?? 0 },
    manifestHash: fakeSha("manifest"),
    droppedPurged: [],
    ...overrides,
  };
}

describe("begin: the single-run lease", () => {
  it("an empty slot acquires a lease with the inventory and ledger anchored", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    await seedMedia(ctx, { objectKey: "companies/k1/uploads/k2/0-a", bytes: 12, sourceId: null });
    const now = PAST_SLOT + 1000;
    const begin = await beginRunTx(asTx(ctx), now);
    expect(begin.status).toBe("acquired");
    if (begin.status !== "acquired") {
      return;
    }
    expect(begin.attempt).toBe(1);
    expect(begin.slotMs).toBe(slotOf(now));
    expect(begin.leaseExpiresAtMs).toBe(now + LEASE_MS);
    expect(begin.media).toHaveLength(1);
    expect(begin.media[0]?.objectKey).toBe("companies/k1/uploads/k2/0-a");
    expect(begin.ledger).toEqual([]);
    const row = await ctx.db.query("recoveryManifests").collect();
    expect(row).toHaveLength(1);
    expect(row[0]?.state).toBe("building");
    expect(row[0]?.inventoryJson).toContain("0-a");
  });

  it("a second attempt while the lease is live is refused (no overlapping writers)", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const slot = PAST_SLOT;
    await beginRunTx(asTx(ctx), slot + 1000);
    const second = await beginRunTx(asTx(ctx), slot + 2 * 1000);
    expect(second).toMatchObject({ status: "refused", reason: "lease_held" });
    // And nothing was written for the refusal.
    expect(await ctx.db.query("recoveryManifests").collect()).toHaveLength(1);
  });

  it("an expired lease is taken over with a bumped attempt (interrupted run resumes)", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const slot = PAST_SLOT;
    const first = await beginRunTx(asTx(ctx), slot + 1000);
    expect(first.status).toBe("acquired");
    const takeover = await beginRunTx(asTx(ctx), slot + LEASE_MS + 1000);
    expect(takeover).toMatchObject({ status: "acquired", attempt: 2 });
    expect(await ctx.db.query("recoveryManifests").collect()).toHaveLength(1);
  });

  it("a failed current slot is retryable; the next slot starts a fresh row", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const slot = currentSlotAnchor();
    const begin = await beginRunTx(asTx(ctx), slot + 1000);
    if (begin.status !== "acquired") {
      throw new Error("begin failed");
    }
    await ctx.db.patch(begin.manifestId, { state: "failed", failureReason: "export_failed" });
    const retry = await beginRunTx(asTx(ctx), slot + 2 * MIN);
    expect(retry).toMatchObject({ status: "acquired", attempt: 2 });
    // Past the slot window the failed history stays and the NEW slot (the
    // scheduler always targets the current one) opens its own row.
    const next = await beginRunTx(asTx(ctx), slot + SCHEDULE_INTERVAL_MS + 5 * MIN);
    expect(next).toMatchObject({ status: "acquired", attempt: 1 });
    const rows = await ctx.db.query("recoveryManifests").collect();
    expect(rows).toHaveLength(2);
    // The retried row is building again; the two rows are distinct slots.
    expect(new Set(rows.map((row) => row.slotMs)).size).toBe(2);
  });
});

describe("complete: server-side closure verification", () => {
  it("verifies a matching set, recomputes tier and retention, and audits the publication", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    await seedMedia(ctx, { objectKey: "companies/k1/uploads/k2/0-a", bytes: 12, sourceId: null });
    await seedMedia(ctx, { objectKey: "companies/k1/uploads/k2/1-b", bytes: 30, sourceId: null });
    const begin = await beginRunTx(asTx(ctx), Date.now());
    if (begin.status !== "acquired") {
      throw new Error("begin failed");
    }
    const result = await completeRunTx(asTx(ctx), completeInputFor(begin));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.tier).toBe(tierOfSlot(begin.slotMs));
    expect(result.expiresAtMs).toBe(begin.slotMs + retentionMsOfTier(result.tier));
    expect(result.usage.mediaBytes).toBe(42);
    const row = (await ctx.db.query("recoveryManifests").collect())[0]!;
    expect(row.state).toBe("verified");
    expect(row.mediaObjectCount).toBe(2);
    expect(row.databaseManifestHash).toBe(fakeSha("database"));
    const audits = await ctx.db.query("auditRecords").collect();
    expect(audits.some((entry) => entry.operationName === "operations.backup.manifestPublished")).toBe(true);
  });

  it("a MISSING media object fails closure (partial output is never complete)", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    await seedMedia(ctx, { objectKey: "companies/k1/uploads/k2/0-a", bytes: 12, sourceId: null });
    await seedMedia(ctx, { objectKey: "companies/k1/uploads/k2/1-b", bytes: 30, sourceId: null });
    const begin = await beginRunTx(asTx(ctx), Date.now());
    if (begin.status !== "acquired") {
      throw new Error("begin failed");
    }
    const partial = completeInputFor(begin, {
      media: [{ objectKey: "companies/k1/uploads/k2/0-a", sha256: fakeSha("x"), bytes: 12 }],
    });
    const result = await completeRunTx(asTx(ctx), partial);
    expect(result).toMatchObject({ ok: false, reason: "media_closure_failed" });
    const row = (await ctx.db.query("recoveryManifests").collect())[0]!;
    expect(row.state).toBe("building");
  });

  it("an EXTRA media object fails closure too", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    await seedMedia(ctx, { objectKey: "companies/k1/uploads/k2/0-a", bytes: 12, sourceId: null });
    const begin = await beginRunTx(asTx(ctx), Date.now());
    if (begin.status !== "acquired") {
      throw new Error("begin failed");
    }
    const extra = completeInputFor(begin, {
      media: [
        { objectKey: "companies/k1/uploads/k2/0-a", sha256: fakeSha("x"), bytes: 12 },
        { objectKey: "companies/k1/uploads/k2/9-z", sha256: fakeSha("z"), bytes: 1 },
      ],
    });
    expect(await completeRunTx(asTx(ctx), extra)).toMatchObject({
      ok: false,
      reason: "media_closure_failed",
    });
  });

  it("a wrong byte size fails (the ledger's recorded size is the authority)", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    await seedMedia(ctx, { objectKey: "companies/k1/uploads/k2/0-a", bytes: 12, sourceId: null });
    const begin = await beginRunTx(asTx(ctx), Date.now());
    if (begin.status !== "acquired") {
      throw new Error("begin failed");
    }
    const wrong = completeInputFor(begin, {
      media: [{ objectKey: "companies/k1/uploads/k2/0-a", sha256: fakeSha("x"), bytes: 999 }],
    });
    expect(await completeRunTx(asTx(ctx), wrong)).toMatchObject({
      ok: false,
      reason: "media_bytes_mismatch",
    });
  });

  it("lease/attempt/ledger guards reject stale or mismatched completions", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const begin = await beginRunTx(asTx(ctx), Date.now());
    if (begin.status !== "acquired") {
      throw new Error("begin failed");
    }
    const staleAttempt = completeInputFor(begin, { attempt: begin.attempt + 5 });
    expect(await completeRunTx(asTx(ctx), staleAttempt)).toMatchObject({
      ok: false,
      reason: "attempt_mismatch",
    });
    const wrongLedger = completeInputFor(begin, {
      ledger: { sha256: fakeSha("l"), bytes: 90, count: 7 },
    });
    expect(await completeRunTx(asTx(ctx), wrongLedger)).toMatchObject({
      ok: false,
      reason: "ledger_count_mismatch",
    });
    const badHash = completeInputFor(begin, {
      manifestHash: "not-a-hash",
    });
    expect(await completeRunTx(asTx(ctx), badHash)).toMatchObject({
      ok: false,
      reason: "manifest_hash_invalid",
    });
  });

  it("purge-backed drops close a set honestly; unverifiable drops are rejected", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const sourceId = "ksourcex000ttttttttttttttttt";
    await seedMedia(ctx, { objectKey: "companies/k1/uploads/k2/0-a", bytes: 12, sourceId });
    await ctx.db.insert("deletionRecords", {
      companyId: "kcompany00ttttttttttttttttt",
      kind: "source_purge",
      targetSourceId: sourceId,
      requestedByUserId: "kuser00000ttttttttttttttttt",
      scopeSummary: "count=1",
      createdAtMs: Date.now() - MIN,
    });
    const begin = await beginRunTx(asTx(ctx), Date.now());
    if (begin.status !== "acquired") {
      throw new Error("begin failed");
    }
    // The purge record means begin already excluded the entry (media: []).
    expect(begin.media).toHaveLength(0);
    expect(begin.purgedDrops).toHaveLength(1);
    const dropped = completeInputFor(begin, {
      media: [],
      droppedPurged: begin.purgedDrops ?? [],
    });
    const result = await completeRunTx(asTx(ctx), dropped);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage.mediaObjects).toBe(0);
    }

    // Without a purge record the same claim is unverifiable.
    const ctx2 = fakeBackupCtx(BACKUP_TABLES);
    await seedMedia(ctx2, { objectKey: "companies/k1/uploads/k2/0-a", bytes: 12, sourceId: null });
    const begin2 = await beginRunTx(asTx(ctx2), Date.now());
    if (begin2.status !== "acquired") {
      throw new Error("begin failed");
    }
    const unverifiable = completeInputFor(begin2, {
      media: [],
      droppedPurged: [{ objectKey: "companies/k1/uploads/k2/0-a", sourceId: "ksource0000tttttttttttttttt" }],
    });
    expect(await completeRunTx(asTx(ctx2), unverifiable)).toMatchObject({
      ok: false,
      reason: "purged_drop_unverifiable",
    });
  });
});

describe("the reference-aware retention sweep (server side)", () => {
  async function seedVerified(
    ctx: FakeCtx,
    slotMs: number,
    keys: string[],
    expiresAtMs: number | undefined,
  ): Promise<string> {
    return ctx.db.insert("recoveryManifests", {
      snapshotAtMs: slotMs,
      state: "verified",
      databaseManifestHash: "0".repeat(64),
      slotMs,
      attempts: 1,
      tier: "frequent",
      inventoryJson: JSON.stringify(keys.map((objectKey) => ({ objectKey, contentHash: "x", bytes: null, sourceId: null }))),
      ledgerCount: 0,
      verifiedAtMs: slotMs,
      completedAtMs: slotMs,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      mediaObjectCount: keys.length,
    });
  }

  it("expired sets are collected; surviving sets and their references stay", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const now = Date.now();
    const expiredId = await seedVerified(ctx, now - 49 * MIN, ["shared/a", "old/a"], now - MIN);
    await seedVerified(ctx, now - 10 * MIN, ["shared/a"], now + 47 * HOUR);
    const plan = await sweepPlanTx(ctx.db as never, now);
    expect(plan.plan.expiredSets).toHaveLength(1);
    expect(plan.plan.deletableObjectKeys).toEqual(["old/a"]);
    expect(plan.referencedByAnyManifest).toEqual(["old/a", "shared/a"]);

    const applied = await sweepCompleteTx(asTx(ctx), { collectedManifestIds: [expiredId] }, now);
    expect(applied.collected).toBe(1);
    const rows = await ctx.db.query("recoveryManifests").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mediaObjectCount).toBe(1);
    const audits = await ctx.db.query("auditRecords").collect();
    expect(audits.some((entry) => entry.operationName === "operations.backup.retentionSweep")).toBe(true);
  });

  it("an interrupted sweep replays idempotently; a moved deadline is skipped, never collected", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const now = Date.now();
    const expiredId = await seedVerified(ctx, now - 49 * MIN, ["x"], now - MIN);
    const survivingId = await seedVerified(ctx, now - 10 * MIN, ["y"], now + 47 * HOUR);
    const first = await sweepCompleteTx(asTx(ctx), { collectedManifestIds: [expiredId] }, now);
    expect(first.collected).toBe(1);
    const replay = await sweepCompleteTx(
      asTx(ctx),
      { collectedManifestIds: [expiredId, survivingId] },
      now,
    );
    expect(replay.replayed).toBe(1);
    expect(replay.skipped).toBe(1);
    expect(await ctx.db.query("recoveryManifests").collect()).toHaveLength(1);
  });

  it("failed rows older than 48h are pruned as history; fresh failures stay visible", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const now = Date.now();
    await ctx.db.insert("recoveryManifests", {
      snapshotAtMs: now - 49 * HOUR,
      state: "failed",
      databaseManifestHash: "",
      slotMs: now - 49 * HOUR,
      attempts: 1,
      failureReason: "export_failed",
    });
    await ctx.db.insert("recoveryManifests", {
      snapshotAtMs: now - 10 * MIN,
      state: "failed",
      databaseManifestHash: "",
      slotMs: now - 10 * MIN,
      attempts: 1,
      failureReason: "export_failed",
    });
    const applied = await sweepCompleteTx(asTx(ctx), { collectedManifestIds: [] }, now);
    expect(applied.prunedFailed).toBe(1);
    const rows = await ctx.db.query("recoveryManifests").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.failureReason).toBe("export_failed");
  });
});

describe("freshness alerting (the I2 seam)", () => {
  it("emits the deduplicated stale diagnostic beyond one hour of the newest verified snapshot", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const now = Date.now();
    await ctx.db.insert("recoveryManifests", {
      snapshotAtMs: now - 2 * 60 * MIN,
      state: "verified",
      databaseManifestHash: "0".repeat(64),
      slotMs: now - 2 * 60 * MIN,
      attempts: 1,
      verifiedAtMs: now - 2 * 60 * MIN,
      expiresAtMs: now + 46 * HOUR,
    });
    const first = await freshnessCheckTx(asTx(ctx), now);
    expect(first.state).toBe("stale");
    expect(first.emitted).toBe(true);
    // Deduped per episode (same anchor).
    const second = await freshnessCheckTx(asTx(ctx), now + MIN);
    expect(second.emitted).toBe(false);
    expect(second.reason).toBe("deduplicated");
    const events = await ctx.db.query("diagnosticEvents").collect();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("ops.backup.stale");
    expect(String(events[0]?.dedupKey)).toBe(`backup_stale:${now - 2 * 60 * MIN}`);
  });

  it("never emits when no attempt ever ran (lane not wired, not silently broken)", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const result = await freshnessCheckTx(asTx(ctx), Date.now());
    expect(result.emitted).toBe(false);
    expect(result.reason).toBe("no_attempts");
  });

  it("attempts that never verified alert as never_verified", async () => {
    const ctx = fakeBackupCtx(BACKUP_TABLES);
    const now = Date.now();
    await ctx.db.insert("recoveryManifests", {
      snapshotAtMs: now - 90 * MIN,
      state: "failed",
      databaseManifestHash: "",
      slotMs: now - 90 * MIN,
      attempts: 3,
      failureReason: "export_failed",
    });
    const result = await freshnessCheckTx(asTx(ctx), now);
    expect(result.state).toBe("never_verified");
    expect(result.emitted).toBe(true);
  });
});

/** The fake ctx as the MutationCtx the transactions take. */
function asTx(ctx: FakeCtx): never {
  return ctx as unknown as never;
}
