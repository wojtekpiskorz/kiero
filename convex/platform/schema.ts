/**
 * Platform durable-execution tables (candidate fragment, A2).
 *
 * Owning implementer: A3 (executor composition proof), H4 (inspection/
 * retry), D6/E2 (pipeline stages). Convex Workflow / the native scheduler is
 * the one canonical durable engine; these tables are its inspectable state.
 *
 * Retry preserves source identity and compatible run semantics. Reanalysis
 * is a linked NEW run and cannot overwrite a newer correction. Checkpoints
 * are opaque to the schema (workflow-owned strings); attempts keep provider
 * routing evidence for GM inspection.
 *
 * Tables: processingRuns, processingSteps, processingAttempts, durableJobs.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../schema/shared";

export const platformTables = {
  /** One analysis run over a source; reanalysis links to the run it repeats. */
  processingRuns: defineTable({
    companyId: shared.companyId,
    sourceId: shared.sourceId,
    kind: v.union(v.literal("initial_analysis"), v.literal("reanalysis")),
    reanalysisOfRunId: v.optional(shared.processingRunId),
    pipelineVersion: v.string(),
    promptVersion: v.string(),
    schemaVersion: v.string(),
    modelConfigurationVersion: v.string(),
    state: v.union(
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("superseded"),
    ),
    /** Opaque workflow checkpoint, owned by the durable engine. */
    checkpoint: v.optional(v.string()),
    startedAtMs: shared.tsMs,
    finishedAtMs: v.optional(shared.tsMs),
  })
    .index("by_source_started", ["sourceId", "startedAtMs"])
    .index("by_company_state", ["companyId", "state"]),

  /** One bounded stage inside a run (accept, extract, plan, publish...). */
  processingSteps: defineTable({
    runId: shared.processingRunId,
    stepKind: v.string(),
    sequence: shared.revisionCounter,
    state: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    startedAtMs: v.optional(shared.tsMs),
    finishedAtMs: v.optional(shared.tsMs),
    outputRef: v.optional(v.string()),
  }).index("by_run_sequence", ["runId", "sequence"]),

  /** Attempt history of one step; actual provider route is recorded. */
  processingAttempts: defineTable({
    stepId: shared.processingStepId,
    attempt: shared.revisionCounter,
    outcome: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("timeout"),
      v.literal("unknown"),
    ),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    /** Closed error kind only; sanitized, no provider payloads. */
    errorKind: v.optional(v.string()),
    startedAtMs: shared.tsMs,
    finishedAtMs: v.optional(shared.tsMs),
  }).index("by_step_attempt", ["stepId", "attempt"]),

  /** Durable job registrations (the outbox's executable counterpart). */
  durableJobs: defineTable({
    jobKey: v.string(),
    kind: v.union(
      v.literal("processing.transcribe_segment"),
      v.literal("processing.extract_fragments"),
      v.literal("processing.analyze_change_plan"),
      v.literal("processing.normalize_photo"),
      v.literal("memory.publish_change_set"),
      v.literal("memory.recompute_dependents"),
      v.literal("notifications.evaluate_due_intents"),
      v.literal("notifications.deliver_push"),
      v.literal("calendar.project_copy"),
      v.literal("calendar.reconcile_outcome"),
      v.literal("exports.build_archive"),
      v.literal("deletion.purge_source"),
      v.literal("backups.verify_manifest"),
      v.literal("search.index_generation"),
      v.literal("access.cleanup_revocation"),
    ),
    companyId: v.optional(shared.companyId),
    sourceId: v.optional(shared.sourceId),
    processingRunId: v.optional(shared.processingRunId),
    state: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    /** Job input, encoded through the kind's input schema. */
    inputJson: v.string(),
    attempts: shared.revisionCounter,
    maxAttempts: shared.revisionCounter,
    createdAtMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
  })
    .index("by_kind_state", ["kind", "state"])
    .index("by_company", ["companyId"]),
} as const;
