/**
 * Recovery manifest table (candidate fragment, A2).
 *
 * Owning implementers: I5 (scheduled complete backups), I6 (quarantine
 * restore drill). A backup is complete only after the database snapshot and
 * every referenced retained media object are verified against the manifest.
 * Restore happens in quarantine; current deletions/revocations are replayed
 * before access is permitted.
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
    mediaObjectCount: v.optional(v.float64()),
    verifiedAtMs: v.optional(shared.tsMs),
    expiresAtMs: v.optional(shared.tsMs),
    failureReason: v.optional(v.string()),
  }).index("by_snapshot", ["snapshotAtMs"]),
} as const;
