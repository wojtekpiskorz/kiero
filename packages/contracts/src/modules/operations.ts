/**
 * Operations module surface (architecture "Deep modules": Operations).
 * Implements lanes: H4 (inspection/retry), I2 (telemetry), I3 (exports),
 * I4 (deletion), I5/I6 (backups/recovery).
 *
 * Audited GM actions, pipeline versions, backup completeness, external
 * deletion/revocation ledger, retention, health and cost alerts. GM does not
 * edit immutable sources; retry and reanalysis keep source identity and are
 * linked new runs. Exports exclude other tenants and credentials; permanent
 * deletion invalidates affected downloads immediately.
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { ExportState } from "../media";
import { operationEntry, eventEntry } from "./registration";

/** Lifecycle of one processing run (a reanalysis links to the run it repeats). */
export const ProcessingRunState = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "superseded",
]);
export type ProcessingRunState = Schema.Schema.Type<typeof ProcessingRunState>;

export const operationsOperations = {
  // H4 amendment (issue #52, coordinated addition on the B3/B4 precedent):
  // the audited GM processing inspector. Every input that targets company
  // data states its basis ("podstawa"); GM authority is resolved from an
  // OPEN gmAccessGrants row inside the same transaction, and the protected
  // audit row (actor, grant, basis, outcome, target revision, run) lands in
  // that transaction. Inspection reads carry ids, states, versions, bounded
  // sanitized outputs and redacted diagnostics only; never source content,
  // job input payloads or provider payloads. The projection is generic over
  // the canonical processingRuns/processingSteps/processingAttempts records:
  // it shows whatever stages a run actually recorded and never claims an
  // unimplemented executor works.
  "operations.inspectProcessingRun": operationEntry({
    kind: "operation",
    name: "operations.inspectProcessingRun",
    input: Schema.Struct({
      processingRunId: tableIdSchema("processingRuns"),
      basis: Schema.NonEmptyString,
    }),
    result: Schema.Struct({
      run: Schema.Struct({
        runId: tableIdSchema("processingRuns"),
        sourceId: tableIdSchema("sources"),
        companyId: tableIdSchema("companies"),
        kind: Schema.Literals(["initial_analysis", "reanalysis"]),
        reanalysisOfRunId: Schema.NullOr(tableIdSchema("processingRuns")),
        state: ProcessingRunState,
        pipelineVersion: Schema.String,
        promptVersion: Schema.String,
        schemaVersion: Schema.String,
        modelConfigurationVersion: Schema.String,
        startedAtMs: Schema.Number,
        finishedAtMs: Schema.NullOr(Schema.Number),
      }),
      source: Schema.Struct({
        sourceId: tableIdSchema("sources"),
        authorUserId: tableIdSchema("users"),
        lifecycle: Schema.Literals(["active", "withdrawn", "purged"]),
        processingState: Schema.String,
        sentAtMs: Schema.Number,
      }),
      steps: Schema.Array(
        Schema.Struct({
          stepId: tableIdSchema("processingSteps"),
          sequence: Schema.Number,
          stepKind: Schema.String,
          state: Schema.Literals(["pending", "running", "succeeded", "failed"]),
          startedAtMs: Schema.NullOr(Schema.Number),
          finishedAtMs: Schema.NullOr(Schema.Number),
        }),
      ),
      attempts: Schema.Array(
        Schema.Struct({
          stepId: tableIdSchema("processingSteps"),
          attempt: Schema.Number,
          outcome: Schema.Literals(["succeeded", "failed", "timeout", "unknown"]),
          provider: Schema.NullOr(Schema.String),
          model: Schema.NullOr(Schema.String),
          errorKind: Schema.NullOr(Schema.String),
          startedAtMs: Schema.Number,
          finishedAtMs: Schema.NullOr(Schema.Number),
        }),
      ),
      jobs: Schema.Array(
        Schema.Struct({
          jobId: tableIdSchema("durableJobs"),
          kind: Schema.String,
          state: Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"]),
          attempts: Schema.Number,
          maxAttempts: Schema.Number,
          lastErrorKind: Schema.NullOr(Schema.String),
          externalOutcome: Schema.NullOr(Schema.String),
        }),
      ),
      derivedChanges: Schema.Array(
        Schema.Struct({
          changeSetId: tableIdSchema("changeSets"),
          state: Schema.String,
          preparedAtMs: Schema.Number,
          publishedAtMs: Schema.NullOr(Schema.Number),
          failedReason: Schema.NullOr(Schema.String),
        }),
      ),
      diagnostics: Schema.Array(
        Schema.Struct({
          kind: Schema.String,
          metadata: Schema.Array(
            Schema.Struct({ key: Schema.String, value: Schema.String }),
          ),
          redactionsApplied: Schema.NullOr(Schema.Number),
          atMs: Schema.Number,
        }),
      ),
      blockers: Schema.Array(
        Schema.Struct({
          code: Schema.NonEmptyString,
          detail: Schema.NullOr(Schema.String),
        }),
      ),
    }),
    // validation: whitespace-only basis (decode passes, trim check rejects).
    errorKinds: ["forbidden", "not_found", "validation"],
  }),
  // H4 amendment (issue #52): retry resumes APPROVED compatible work and
  // preserves semantic run identity (same run row, same versions, journal
  // replay of committed stages). The operator states the run state they
  // inspected (`expectedRunState`, the stale-revision guard: a run that
  // moved on is refused, which also covers the completion race); the run's
  // workflow version must be one this deployment can resume. Never edits
  // the immutable source; never selects a model.
  "operations.retryProcessingStep": operationEntry({
    kind: "operation",
    name: "operations.retryProcessingStep",
    input: Schema.Struct({
      stepId: tableIdSchema("processingSteps"),
      expectedRunState: ProcessingRunState,
      basis: Schema.NonEmptyString,
    }),
    result: Schema.Struct({
      runId: tableIdSchema("processingRuns"),
      stepId: tableIdSchema("processingSteps"),
      state: Schema.Literal("running"),
      restartedFrom: Schema.NonEmptyString,
    }),
    errorKinds: ["forbidden", "not_found", "conflict", "validation", "unsupported"],
  }),
  // H4 amendment (issue #52): deliberate reanalysis is a linked NEW run over
  // the same immutable source, through the server-approved E3/E2
  // configuration (no model selection anywhere in the input). The operator
  // states the source's latest run they inspected (`expectedLatestRunId`,
  // null when the source has none): a newer run landing meanwhile refuses as
  // stale. The new run links to the run it repeats; provenance and versions
  // are the new run's own.
  "operations.requestReanalysis": operationEntry({
    kind: "operation",
    name: "operations.requestReanalysis",
    input: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      reason: Schema.NonEmptyString,
      expectedLatestRunId: Schema.NullOr(tableIdSchema("processingRuns")),
    }),
    result: Schema.Struct({
      processingRunId: tableIdSchema("processingRuns"),
      reanalysisOfRunId: Schema.NullOr(tableIdSchema("processingRuns")),
    }),
    errorKinds: ["forbidden", "not_found", "conflict", "validation"],
  }),
  "operations.requestExport": operationEntry({
    kind: "operation",
    name: "operations.requestExport",
    input: Schema.Struct({}),
    result: Schema.Struct({ exportId: tableIdSchema("exports"), state: ExportState }),
    errorKinds: ["forbidden"],
  }),
  "operations.emitDiagnosticEvent": operationEntry({
    kind: "operation",
    name: "operations.emitDiagnosticEvent",
    input: Schema.Struct({
      kind: Schema.NonEmptyString,
      /** Redacted, bounded technical metadata only, never raw content. */
      technicalMetadata: Schema.Array(
        Schema.Struct({ key: Schema.NonEmptyString, value: Schema.String }),
      ),
    }),
    result: Schema.Struct({ diagnosticEventId: tableIdSchema("diagnosticEvents") }),
    errorKinds: ["forbidden", "validation"],
  }),
  "operations.verifyRecoverySet": operationEntry({
    kind: "operation",
    name: "operations.verifyRecoverySet",
    input: Schema.Struct({ recoveryManifestId: tableIdSchema("recoveryManifests") }),
    result: Schema.Struct({
      recoveryManifestId: tableIdSchema("recoveryManifests"),
      complete: Schema.Boolean,
    }),
    errorKinds: ["forbidden", "not_found", "unavailable"],
  }),
} as const;

export const operationsEvents = {
  "operations.reanalysisRequested": eventEntry({
    kind: "event",
    name: "operations.reanalysisRequested",
    payload: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      newRunId: tableIdSchema("processingRuns"),
      reanalysisOfRunId: Schema.NullOr(tableIdSchema("processingRuns")),
    }),
  }),
  "operations.exportCompleted": eventEntry({
    kind: "event",
    name: "operations.exportCompleted",
    payload: Schema.Struct({ exportId: tableIdSchema("exports") }),
  }),
  "operations.exportInvalidated": eventEntry({
    kind: "event",
    name: "operations.exportInvalidated",
    payload: Schema.Struct({ exportId: tableIdSchema("exports") }),
  }),
  "operations.deletionRecorded": eventEntry({
    kind: "event",
    name: "operations.deletionRecorded",
    payload: Schema.Struct({ deletionRecordId: tableIdSchema("deletionRecords") }),
  }),
  "operations.recoverySetVerified": eventEntry({
    kind: "event",
    name: "operations.recoverySetVerified",
    payload: Schema.Struct({
      recoveryManifestId: tableIdSchema("recoveryManifests"),
      complete: Schema.Boolean,
    }),
  }),
  "operations.diagnosticEmitted": eventEntry({
    kind: "event",
    name: "operations.diagnosticEmitted",
    payload: Schema.Struct({ diagnosticEventId: tableIdSchema("diagnosticEvents") }),
  }),
} as const;
