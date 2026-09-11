/**
 * Permanent deletion ledger and purge tracking (A2 candidate, certified by
 * A3; completed by I4).
 *
 * Owning implementer: I4 (purge and derived-access invalidation).
 * Permanently deleted sources become inaccessible immediately; active or
 * reconstructing derivatives are purged within 24 hours; isolated backup
 * content expires within 30 days. The ledger row is content-free and
 * survives application database rollback, so a restore cannot resurrect
 * deleted data.
 *
 * I4 completion (the owning lane finishes the fragment):
 *
 * - `deletionRecords.purgeDeadlineAtMs`: the 24-hour window's anchor set by
 *   the initiating transaction (stages inherit it). The row itself stays
 *   CONTENT-FREE (counts and opaque identities only, never text): I5's
 *   backup inventory reads it verbatim into the separately-hashed ledger
 *   file, and I6's quarantine restore replays it before access opens.
 * - `deletionPurgeStages`: one row per derivative family of one deletion
 *   record (media bytes, transcripts, findings marking, search index,
 *   notification work, exports). Stage state is the administrator's
 *   pending/complete/failed view; the durable `deletion.purge_source` job
 *   owns retries, and I2's incident scan sees the exhausted job. The
 *   media stage carries the R2 object keys it must delete (server-owned
 *   opaque identities, not content).
 *
 * Tables: deletionRecords, deletionPurgeStages.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

/** The derivative families one permanent deletion must purge or prove done. */
export const PURGE_STAGE_KINDS = [
  "media_objects",
  "transcripts",
  "findings_marking",
  "search_index",
  "notification_work",
  "exports",
] as const;
export type PurgeStageKind = (typeof PURGE_STAGE_KINDS)[number];

/** The purge window: derivatives purged or visibly failed within 24 hours. */
export const PURGE_DEADLINE_MS = 24 * 60 * 60 * 1000;

export const deletionTables = {
  /** Content-free record of one permanent deletion/revocation. */
  deletionRecords: defineTable({
    companyId: shared.companyId,
    kind: v.union(v.literal("source_purge"), v.literal("data_revocation")),
    targetSourceId: v.optional(shared.sourceId),
    requestedByUserId: shared.userId,
    /** Scope summary without deleted content (counts/kinds, never text). */
    scopeSummary: v.string(),
    createdAtMs: shared.tsMs,
    /**
     * I4 completion: when the 24-hour purge window of this record closes.
     * Optional only so pre-I4 fixtures stay valid; every source_purge row
     * I4 writes carries it.
     */
    purgeDeadlineAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_time", ["companyId", "createdAtMs"])
    // I4: the idempotent re-request path and the executor's null-record
    // resolution find the source's ledger row through this index.
    .index("by_target_source", ["targetSourceId"]),

  /**
   * One derivative family's purge state inside one deletion record (I4).
   * The rows are the administrator's cleanup status and the 24-hour
   * tracking surface; the durable job's own row remains the retry
   * authority. No user content ever lands here: the media stage lists
   * server-owned object keys only.
   */
  deletionPurgeStages: defineTable({
    deletionRecordId: shared.deletionRecordId,
    companyId: shared.companyId,
    sourceId: shared.sourceId,
    stageKind: v.union(
      v.literal("media_objects"),
      v.literal("transcripts"),
      v.literal("findings_marking"),
      v.literal("search_index"),
      v.literal("notification_work"),
      v.literal("exports"),
    ),
    state: v.union(
      v.literal("pending"),
      v.literal("purged"),
      v.literal("failed"),
    ),
    attempts: shared.counter,
    /** The media stage's R2 object keys (opaque identities, JSON array). */
    objectKeysJson: v.optional(v.string()),
    lastErrorKind: v.optional(v.string()),
    purgedAtMs: v.optional(shared.tsMs),
    deadlineAtMs: shared.tsMs,
    createdAtMs: shared.tsMs,
  })
    .index("by_record", ["deletionRecordId"])
    .index("by_source", ["sourceId"])
    .index("by_state_deadline", ["state", "deadlineAtMs"]),
} as const;
