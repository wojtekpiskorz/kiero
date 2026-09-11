/**
 * The complete-backup decision model (I5).
 *
 * PURE MODULE (no Convex imports), mirrored by infra/backups/*.json which
 * tests/i5 asserts cannot drift. Every scheduling, lease, freshness,
 * retention and deleted-content rule lives HERE so the Convex functions,
 * the backup Container and the tests share one definition:
 *
 * - Cadence: one run slot every 15 minutes; a slot admits exactly one
 *   single-run lease; overlapping attempts of the same slot are refused
 *   while the lease is live, and an interrupted lease can be taken over
 *   (resumable: every object write is content-addressed and idempotent).
 * - Freshness is measured from the DATABASE SNAPSHOT time of the newest
 *   VERIFIED manifest, never from completion time; beyond one hour the
 *   staleness monitor emits an I2 diagnostic event (deduped per episode).
 * - Retention: frequent sets 48 hours, daily sets (the first slot of each
 *   UTC day) through day 14. Media objects live in one shared pool and are
 *   collected reference-aware: an object is deleted only when NO surviving
 *   manifest references it.
 * - Deleted-content expiry: purged source content must not survive in
 *   backups beyond 30 days. Because no set outlives 14 days, the bound
 *   holds by construction; the invariant is asserted (runtime + tests) so
 *   a future retention extension cannot silently break it.
 */

/** The accepted schedule cadence (every 15 minutes). */
export const SCHEDULE_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Single-run lease length. Shorter than the cadence so a lease can never
 * span two slots; long enough for one export + media copy pass.
 */
export const LEASE_MS = 12 * 60 * 1000;

/** Max attempts (fresh starts + takeovers + retries) per slot. */
export const MAX_ATTEMPTS_PER_SLOT = 3;

/** A complete set older than this (by snapshot time) is stale. */
export const FRESHNESS_LIMIT_MS = 60 * 60 * 1000;

/** Frequent complete sets are retained 48 hours. */
export const FREQUENT_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Daily complete sets are retained through day 14. */
export const DAILY_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** Purged source content must be gone from backups within 30 days. */
export const DELETED_CONTENT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Objects older than this and unreferenced by any manifest are orphans
 * (interrupted runs' leftovers). The constant is mirrored by the executor
 * (apps/backup-worker src/pipeline.ts owns the decision: only it sees
 * bucket listings); tests/i5 asserts the mirror cannot drift.
 */
export const ORPHAN_GRACE_MS = 48 * 60 * 60 * 1000;

/** Retention deadline (ms after the slot) of a tier. */
export function retentionMsOfTier(tier: BackupTier): number {
  return tier === "daily" ? DAILY_RETENTION_MS : FREQUENT_RETENTION_MS;
}

/** The retention tier of a slot: the first slot of a UTC day is daily. */
export function tierOfSlot(slotMs: number): BackupTier {
  return slotMs % (24 * 60 * 60 * 1000) === 0 ? "daily" : "frequent";
}

/** The run slot a timestamp belongs to (floor to the 15-minute grid). */
export function slotOf(nowMs: number): number {
  return Math.floor(nowMs / SCHEDULE_INTERVAL_MS) * SCHEDULE_INTERVAL_MS;
}

/** True while `nowMs` is still inside the slot's 15-minute window. */
export function slotIsCurrent(slotMs: number, nowMs: number): boolean {
  return nowMs >= slotMs && nowMs < slotMs + SCHEDULE_INTERVAL_MS;
}

export type BackupTier = "frequent" | "daily";

/** The manifest lifecycle states (the certified A2/A3 union, unchanged). */
export type ManifestState = "building" | "verified" | "failed";

/** The row shape the lease/freshness/retention decisions read. */
export interface ManifestRowView {
  readonly slotMs: number;
  readonly state: ManifestState;
  readonly attempts: number;
  readonly leaseExpiresAtMs?: number | undefined;
  readonly snapshotAtMs: number;
  readonly expiresAtMs?: number | undefined;
}

/**
 * The begin decision for one slot. `start` creates a fresh building row,
 * `takeover`/`retry` re-enter the existing row (bumping attempts), and the
 * refusals explain themselves in closed vocabulary.
 */
export type BeginDecision =
  | { readonly action: "start" }
  | { readonly action: "takeover"; readonly reason: "lease_expired" }
  | { readonly action: "retry"; readonly reason: "slot_failed_retryable" }
  | {
      readonly action: "refuse";
      readonly reason: "lease_held" | "already_complete" | "attempts_exhausted" | "slot_passed";
    };

/**
 * Decides what a scheduler attempt of `slotMs` may do, given the row that
 * slot already has (if any). One slot admits one live writer; a verified
 * slot is idempotently complete; a failed slot may retry while it is still
 * current and attempts remain; a stalled building row is taken over once
 * its lease expired (interrupted runs resume, they never overlap).
 */
export function decideBegin(
  slotMs: number,
  existing: ManifestRowView | null,
  nowMs: number,
): BeginDecision {
  if (existing === null) {
    return { action: "start" };
  }
  if (existing.slotMs !== slotMs) {
    return { action: "refuse", reason: "slot_passed" };
  }
  if (existing.state === "verified") {
    return { action: "refuse", reason: "already_complete" };
  }
  if (existing.state === "building") {
    if ((existing.leaseExpiresAtMs ?? 0) > nowMs) {
      return { action: "refuse", reason: "lease_held" };
    }
    if (existing.attempts >= MAX_ATTEMPTS_PER_SLOT) {
      return { action: "refuse", reason: "attempts_exhausted" };
    }
    return { action: "takeover", reason: "lease_expired" };
  }
  // failed: retryable only while the slot is still the current one.
  if (!slotIsCurrent(slotMs, nowMs) || existing.attempts >= MAX_ATTEMPTS_PER_SLOT) {
    return { action: "refuse", reason: existing.attempts >= MAX_ATTEMPTS_PER_SLOT ? "attempts_exhausted" : "slot_passed" };
  }
  return { action: "retry", reason: "slot_failed_retryable" };
}

/** Freshness of the complete-backup chain, measured by SNAPSHOT time. */
export interface FreshnessState {
  readonly state: "fresh" | "stale" | "never_verified";
  /** Age of the newest verified snapshot; null when none exists. */
  readonly ageMs: number | null;
  /** Dedup anchor of the staleness episode (the newest verified snapshot). */
  readonly dedupAnchorMs: number | null;
  /** Failed attempts inside the freshness window (context, not the metric). */
  readonly recentFailures: number;
}

/**
 * Evaluates backup freshness from snapshot times (never completion times):
 * stale when the newest VERIFIED snapshot is older than one hour. Failed
 * rows are context; a chain that only ever fails is `never_verified`.
 */
export function freshnessOf(
  verifiedSnapshotsAtMs: readonly number[],
  failedTimesAtMs: readonly number[],
  nowMs: number,
): FreshnessState {
  const newest = verifiedSnapshotsAtMs.length === 0 ? null : Math.max(...verifiedSnapshotsAtMs);
  if (newest === null) {
    return {
      state: "never_verified",
      ageMs: null,
      dedupAnchorMs: null,
      recentFailures: failedTimesAtMs.filter((at) => nowMs - at <= FRESHNESS_LIMIT_MS).length,
    };
  }
  const ageMs = Math.max(0, nowMs - newest);
  return {
    state: ageMs > FRESHNESS_LIMIT_MS ? "stale" : "fresh",
    ageMs,
    dedupAnchorMs: newest,
    recentFailures: failedTimesAtMs.filter((at) => nowMs - at <= FRESHNESS_LIMIT_MS).length,
  };
}

/** Dedup identity of one staleness episode (anchored like I2 silence). */
export function staleDedupKey(anchorMs: number): string {
  return `backup_stale:${anchorMs}`;
}

/** One collected/expired set the sweep must remove. */
export interface ExpiredSet {
  readonly manifestId: string;
  readonly slotMs: number;
  readonly mediaObjectKeys: readonly string[];
}

/** The reference-aware retention sweep plan for one pass. */
export interface SweepPlan {
  /** Verified sets past their retention deadline (rows + objects go). */
  readonly expiredSets: readonly ExpiredSet[];
  /** Union of object keys referenced by SURVIVING verified manifests. */
  readonly survivingReferences: readonly string[];
  /**
   * Object keys safe to delete: referenced only by expiring sets. A key
   * referenced by ANY surviving manifest is NEVER deletable.
   */
  readonly deletableObjectKeys: readonly string[];
}

/**
 * Computes the sweep plan: expired sets are collected, and their objects
 * are deletable only when no surviving manifest still references them.
 */
export function planSweep(
  rows: readonly {
    manifestId: string;
    slotMs: number;
    state: ManifestState;
    expiresAtMs?: number | undefined;
    mediaObjectKeys: readonly string[];
  }[],
  nowMs: number,
): SweepPlan {
  const expiredSets: ExpiredSet[] = [];
  const survivingReferences = new Set<string>();
  for (const row of rows) {
    if (row.state !== "verified") {
      continue;
    }
    if (row.expiresAtMs !== undefined && row.expiresAtMs <= nowMs) {
      expiredSets.push({
        manifestId: row.manifestId,
        slotMs: row.slotMs,
        mediaObjectKeys: [...row.mediaObjectKeys],
      });
    } else {
      for (const key of row.mediaObjectKeys) {
        survivingReferences.add(key);
      }
    }
  }
  const deletable = new Set<string>();
  for (const set of expiredSets) {
    for (const key of set.mediaObjectKeys) {
      if (!survivingReferences.has(key)) {
        deletable.add(key);
      }
    }
  }
  return {
    expiredSets,
    survivingReferences: [...survivingReferences].sort(),
    deletableObjectKeys: [...deletable].sort(),
  };
}

/**
 * The orphan-decision rule, stated once for tests to pin (the executor's
 * copy in apps/backup-worker applies it against real listings; the
 * schema.test asserts the grace constants cannot drift): a POOL key
 * (media/<objectKey>) is collectable when no manifest row references the
 * underlying objectKey and the object is older than the grace window.
 */
export function isOrphanCandidate(
  poolKey: string,
  referencedPoolKeys: readonly string[],
  lastModifiedMs: number,
  nowMs: number,
  graceMs: number = ORPHAN_GRACE_MS,
): boolean {
  return !referencedPoolKeys.includes(poolKey) && nowMs - lastModifiedMs > graceMs;
}

/**
 * The deleted-content bound: no set may outlive the 30-day expiry of
 * purged content. Holds by construction while retention <= 30 days; the
 * runtime check makes a violating configuration fail loudly instead of
 * silently keeping purged bytes in backups.
 */
export function deletedContentInvariantHolds(): boolean {
  return (
    FREQUENT_RETENTION_MS <= DELETED_CONTENT_EXPIRY_MS &&
    DAILY_RETENTION_MS <= DELETED_CONTENT_EXPIRY_MS
  );
}

/** Closed failure-reason vocabulary shape (validated before storage). */
export function isValidFailureReason(reason: string): boolean {
  return /^[a-z][a-z0-9_]{1,63}$/.test(reason);
}

/** sha256 hex shape (manifest hashes the protocol accepts). */
export function isSha256Hex(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

/** Backup-pool object-key shape (tenant namespace paths, no traversal). */
export function isSafeObjectKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9/._-]{0,512}$/.test(key) && !key.includes("..");
}

/** Canonical stable JSON for hashed manifests (sorted keys, no padding). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

// --- plan-limit measurement (P12: observed costs and hard limits) ----------

/** The measured usage of one run, in the provider's own units. */
export interface RunUsage {
  readonly databaseBytes: number;
  readonly mediaBytes: number;
  readonly mediaObjects: number;
  /** S3 Class A operations (PUTs/DELETEs) issued by this run. */
  readonly classAOps: number;
  /** S3 Class B operations (GETs/HEADs/LISTs) issued by this run. */
  readonly classBOps: number;
}

/** The configured free-plan hard limits (mirror: infra/backups/plan-limits.json). */
export interface PlanLimits {
  readonly storageFreeBytes: number;
  readonly classAFreePerMonth: number;
  readonly classBFreePerMonth: number;
}

export const R2_FREE_PLAN_LIMITS: PlanLimits = {
  storageFreeBytes: 10 * 1000 * 1000 * 1000,
  classAFreePerMonth: 1_000_000,
  classBFreePerMonth: 10_000_000,
};

/**
 * Which free allowances the measured usage exceeds (closed categories). The
 * per-run usage carries the byte counts; the monthly accumulators come from
 * the cost accounting period.
 */
export function exceededAllowances(
  storedBytesTotal: number,
  monthlyClassA: number,
  monthlyClassB: number,
  limits: PlanLimits = R2_FREE_PLAN_LIMITS,
): readonly ("storage" | "class_a_ops" | "class_b_ops")[] {
  const exceeded: ("storage" | "class_a_ops" | "class_b_ops")[] = [];
  if (storedBytesTotal > limits.storageFreeBytes) {
    exceeded.push("storage");
  }
  if (monthlyClassA > limits.classAFreePerMonth) {
    exceeded.push("class_a_ops");
  }
  if (monthlyClassB > limits.classBFreePerMonth) {
    exceeded.push("class_b_ops");
  }
  return exceeded;
}
