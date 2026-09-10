/**
 * Platform durable-execution tables (A2 candidate fragment, amended by A3
 * during certification).
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
 * A3 certification amendments to the A2 candidate (see the certification
 * note in docs/implementation/contracts/README.md):
 * - `durableJobs.by_jobKey` index (job-key dedup lookup inside the
 *   registration transaction) and `lastErrorKind`/`finishedAtMs` outcome
 *   columns (sanitized closed error kind only).
 * - `externalEffects`: the observable ledger the external echo stand-in
 *   writes; the no-duplicate-effect proof counts rows here, per dedup key.
 *
 * Tables: processingRuns, processingSteps, processingAttempts, durableJobs,
 * outboxEvents, externalEffects.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../schema/shared";
import {
  DurableJobKind,
  DurableJobState,
  OutboxDeliveryState,
  ProcessingRunState,
} from "@kiero/contracts";

// Vocabulary pins: the job kind and state unions must equal their
// contracts-side schemas' encoded literals exactly, or this file fails
// typecheck.

const durableJobKind: ValueValidator<Encoded<typeof DurableJobKind>> = v.union(
  v.literal("processing.transcribe_segment"),
  v.literal("processing.extract_fragments"),
  v.literal("processing.analyze_change_plan"),
  v.literal("processing.normalize_photo"),
  v.literal("memory.publish_change_set"),
  v.literal("memory.recompute_dependents"),
  v.literal("attention.evaluate_due_intents"),
  // F4 amendment (flagged shared-file change): the task-reminder scheduling
  // job kind joins the closed union (the contracts DurableJobKind is the
  // authority; the typecheck pins equality).
  v.literal("attention.schedule_task_reminders"),
  v.literal("attention.deliver_push"),
  v.literal("calendar.project_copy"),
  v.literal("calendar.reconcile_outcome"),
  v.literal("exports.build_archive"),
  v.literal("deletion.purge_source"),
  v.literal("backups.verify_manifest"),
  v.literal("search.index_generation"),
  v.literal("access.cleanup_revocation"),
  v.literal("platform.echo_delivery"),
);

const processingRunState: ValueValidator<Encoded<typeof ProcessingRunState>> =
  v.union(
    v.literal("running"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("superseded"),
  );

const durableJobState: ValueValidator<Encoded<typeof DurableJobState>> = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("cancelled"),
);

const outboxDeliveryState: ValueValidator<Encoded<typeof OutboxDeliveryState>> =
  v.union(
    v.literal("pending"),
    v.literal("in_flight"),
    v.literal("delivered"),
    v.literal("failed"),
    v.literal("superseded"),
  );

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
    state: processingRunState,
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
    sequence: shared.counter,
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
    attempt: shared.counter,
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

  /** Durable job registrations (the executable counterpart of the outbox). */
  durableJobs: defineTable({
    jobKey: v.string(),
    kind: durableJobKind,
    companyId: v.optional(shared.companyId),
    sourceId: v.optional(shared.sourceId),
    processingRunId: v.optional(shared.processingRunId),
    /**
     * Semantic dedup identity shared with the outbox row/event that caused
     * this job; lets the drain recognize work a publisher already
     * registered atomically (no double registration from the edge).
     */
    dedupKey: v.optional(v.string()),
    state: durableJobState,
    /** Job input, encoded through the kind's input schema. */
    inputJson: v.string(),
    attempts: shared.counter,
    maxAttempts: shared.counter,
    /** Sanitized closed error kind of the terminal/last failure, if any. */
    lastErrorKind: v.optional(v.string()),
    /** External delivery outcome when the job's effect left the transaction. */
    externalOutcome: v.optional(
      v.union(
        v.literal("succeeded"),
        v.literal("failed"),
        v.literal("timeout"),
        v.literal("unknown"),
      ),
    ),
    createdAtMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
    finishedAtMs: v.optional(shared.tsMs),
  })
    .index("by_kind_state", ["kind", "state"])
    .index("by_jobKey", ["jobKey"])
    .index("by_dedup", ["dedupKey"])
    .index("by_company", ["companyId"]),

  /**
   * The durable outbox: one row per published domain event awaiting
   * delivery. State changes and their side-effect intents are written
   * together; delivery is a separate retryable step (architecture protocol
   * steps 7-9).
   */
  outboxEvents: defineTable({
    eventId: v.string(),
    companyId: shared.companyId,
    eventName: v.string(),
    /** Full DomainEventEnvelope, encoded through the event's payload schema. */
    envelopeJson: v.string(),
    deliveryState: outboxDeliveryState,
    attempts: shared.counter,
    dedupKey: v.optional(v.string()),
    nextAttemptAtMs: v.optional(shared.tsMs),
    /** Sanitized closed error kind of the delivery failure, if any. */
    lastErrorKind: v.optional(v.string()),
    createdAtMs: shared.tsMs,
  })
    .index("by_delivery", ["deliveryState", "nextAttemptAtMs"])
    .index("by_company", ["companyId"])
    .index("by_dedup", ["dedupKey"]),

  /**
   * A3 amendment: observable ledger of effects that left the transaction.
   * Written by the external stand-in (the echo endpoint) itself, one row per
   * HTTP call it actually received; it does not dedup. The
   * no-duplicate-effect proof counts rows per `dedupKey`: correct replay and
   * reconciliation leave exactly one.
   */
  externalEffects: defineTable({
    dedupKey: v.string(),
    serviceName: v.string(),
    /** Sanitized bounded payload snapshot (never secrets or raw content). */
    payload: v.string(),
    receivedAtMs: shared.tsMs,
  })
    .index("by_dedup", ["dedupKey"])
    .index("by_service", ["serviceName"]),
} as const;
