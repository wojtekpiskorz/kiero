/**
 * Audit and diagnostic tables (candidate fragment, A2).
 *
 * Owning implementer: I2 (redacted diagnostics, health, cost alerts).
 * Audit records are canonical protected data with actor and change/run
 * references. Diagnostic events are redacted, bounded to the accepted
 * window, and exclude raw messages, audio/images, transcripts, prompts and
 * tokens. GM activity is audited and excluded from alpha success metrics.
 *
 * Tables: auditRecords, diagnosticEvents.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const telemetryTables = {
  /** Canonical protected audit trail of significant actions. */
  auditRecords: defineTable({
    companyId: v.optional(shared.companyId),
    actorUserId: v.optional(shared.userId),
    gmGrantId: v.optional(shared.gmAccessGrantId),
    operationName: v.string(),
    changeSetId: v.optional(shared.changeSetId),
    processingRunId: v.optional(shared.processingRunId),
    atMs: shared.tsMs,
  })
    .index("by_company_time", ["companyId", "atMs"])
    .index("by_run", ["processingRunId"]),

  /** Redacted technical event within the accepted retention window. */
  diagnosticEvents: defineTable({
    kind: v.string(),
    /** Bounded allow-listed technical metadata only; never content. */
    technicalMetadata: v.array(v.object({ key: v.string(), value: v.string() })),
    redactionVersion: v.string(),
    atMs: shared.tsMs,
  }).index("by_kind_time", ["kind", "atMs"]),
} as const;
