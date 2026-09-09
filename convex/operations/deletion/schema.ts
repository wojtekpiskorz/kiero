/**
 * Permanent deletion ledger (A2 candidate, certified by A3).
 *
 * Owning implementer: I4 (purge and derived-access invalidation).
 * Permanently deleted sources become inaccessible immediately; active or
 * reconstructing derivatives are purged within 24 hours; isolated backup
 * content expires within 30 days. The ledger row is content-free and
 * survives application database rollback, so a restore cannot resurrect
 * deleted data.
 *
 * Tables: deletionRecords.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

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
  }).index("by_company_time", ["companyId", "createdAtMs"]),
} as const;
