/**
 * Recovery manifest table (A2 candidate, certified by A3; completed by I5).
 *
 * Owning implementers: I5 (scheduled complete backups), I6 (quarantine
 * restore drill). A backup is complete only after the database snapshot and
 * every referenced retained media object are verified against the manifest.
 * Restore happens in quarantine; current deletions/revocations are replayed
 * before access is permitted.
 *
 * I5 completion (the owning lane finishes the fragment; every added column
 * is OPTIONAL so the certified A2/A3 baseline and its fixtures stay valid):
 *
 * - `slotMs` / `leaseExpiresAtMs` / `attempts`: the 15-minute run slot, the
 *   single-run lease guarding it against overlapping writers, and the
 *   bounded attempt counter (fresh start + takeovers + retries).
 * - `tier` / `expiresAtMs`: frequent (48h) vs daily (through day 14)
 *   retention class and its deadline; `expiresAtMs` is set only when a set
 *   is VERIFIED (a building row has none).
 * - `inventoryJson`: the retained-media inventory read atomically at begin;
 *   it is BOTH the closure authority at complete-time (the published media
 *   list must equal it, minus typed purge drops) and the reference registry
 *   the retention sweep uses (objects are pooled and shared across sets).
 * - `ledgerCount` / `purgedDroppedJson`: the content-free deletion/revocation
 *   ledger snapshot size carried in the set, and the media keys dropped at
 *   build time because their sources have purge records (I4 seam).
 * - byte/usage columns and `manifestHash` for cost measurement (P12) and
 *   I6's immutable-manifest contract. `databaseManifestHash` is the sha256
 *   of the export zip and is "" while the set is still building (the
 *   baseline column is required; empty means not yet known).
 *
 * Tables: recoveryManifests.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const backupsTables = {
  /** Verified manifest of one backup set (database + referenced media). */
  recoveryManifests: defineTable({
    snapshotAtMs: shared.tsMs,
    state: v.union(
      v.literal("building"),
      v.literal("verified"),
      v.literal("failed"),
    ),
    databaseManifestHash: v.string(),
    mediaManifestHash: v.optional(v.string()),
    mediaObjectCount: v.optional(shared.counter),
    verifiedAtMs: v.optional(shared.tsMs),
    expiresAtMs: v.optional(shared.tsMs),
    failureReason: v.optional(v.string()),
    // I5 completion (all optional; see the module doc).
    slotMs: v.optional(shared.tsMs),
    leaseExpiresAtMs: v.optional(shared.tsMs),
    attempts: v.optional(shared.counter),
    tier: v.optional(v.union(v.literal("frequent"), v.literal("daily"))),
    inventoryJson: v.optional(v.string()),
    ledgerCount: v.optional(shared.counter),
    purgedDroppedJson: v.optional(v.string()),
    databaseBytes: v.optional(v.float64()),
    mediaBytes: v.optional(v.float64()),
    completedAtMs: v.optional(shared.tsMs),
    manifestHash: v.optional(v.string()),
    // P12 measurement: the executor-measured S3 Class A/B op counts of the
    // run that verified this set (plan-limits.json; monthly rollup in the
    // backups state read compares them against the free allowances).
    classAOps: v.optional(shared.counter),
    classBOps: v.optional(shared.counter),
  })
    .index("by_snapshot", ["snapshotAtMs"])
    .index("by_slot", ["slotMs"])
    .index("by_state", ["state"]),
} as const;
