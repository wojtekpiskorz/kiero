/**
 * Durable job envelope.
 *
 * Durable execution uses Convex Workflow / the native scheduler (the one
 * canonical engine; see architecture "Deep modules"). This envelope is the
 * registration shape a module hands to that engine: a closed job kind, its
 * input (validated by that kind's schema), bounded retry policy and the
 * source/run linkage that makes retries keep source identity and run
 * semantics. Reanalysis is a linked NEW run; it can never overwrite a newer
 * correction.
 *
 * Candidate contract until A3 proves the executor composition.
 */

import { Schema } from "effect";
import { tableIdSchema, DurableJobKeySchema, IdempotencyKeySchema } from "./tableIds";

/** Closed vocabulary of durable job kinds. New kinds are a coordinated change. */
export const DurableJobKind = Schema.Literals([
  "processing.transcribe_segment",
  "processing.extract_fragments",
  "processing.analyze_change_plan",
  "processing.normalize_photo",
  "memory.publish_change_set",
  "memory.recompute_dependents",
  "notifications.evaluate_due_intents",
  "notifications.deliver_push",
  "calendar.project_copy",
  "calendar.reconcile_outcome",
  "exports.build_archive",
  "deletion.purge_source",
  "backups.verify_manifest",
  "search.index_generation",
  "access.cleanup_revocation",
]);
export type DurableJobKind = Schema.Schema.Type<typeof DurableJobKind>;

/** Lifecycle of a durable job. */
export const DurableJobState = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type DurableJobState = Schema.Schema.Type<typeof DurableJobState>;

/** Bounded retry policy declared at registration. */
export const RetryPolicy = Schema.Struct({
  maxAttempts: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  backoffBaseMs: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type RetryPolicy = Schema.Schema.Type<typeof RetryPolicy>;

/**
 * Provenance linkage that keeps retries honest: the source the job works on
 * and, for reanalysis, the run that produced the previous result.
 */
export const JobProvenance = Schema.Struct({
  companyId: tableIdSchema("companies"),
  sourceId: Schema.optionalKey(tableIdSchema("sources")),
  processingRunId: Schema.optionalKey(tableIdSchema("processingRuns")),
  /** Set when this job is a linked reanalysis of an earlier run. */
  reanalysisOfRunId: Schema.optionalKey(tableIdSchema("processingRuns")),
});
export type JobProvenance = Schema.Schema.Type<typeof JobProvenance>;

/** Registration envelope for one durable job. */
export const DurableJobEnvelope = Schema.Struct({
  jobKey: DurableJobKeySchema,
  kind: DurableJobKind,
  /** Input validated against the kind's schema before registration. */
  input: Schema.Unknown,
  provenance: JobProvenance,
  policy: RetryPolicy,
  /** Idempotency key of the command that requested the job, when there was one. */
  idempotencyKey: Schema.optionalKey(IdempotencyKeySchema),
  state: DurableJobState,
});
export type DurableJobEnvelope = Schema.Schema.Type<typeof DurableJobEnvelope>;
