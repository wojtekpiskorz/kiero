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

export const operationsOperations = {
  "operations.inspectProcessingRun": operationEntry({
    kind: "operation",
    name: "operations.inspectProcessingRun",
    input: Schema.Struct({ processingRunId: tableIdSchema("processingRuns") }),
    result: Schema.Struct({
      processingRunId: tableIdSchema("processingRuns"),
      state: Schema.Literals(["running", "succeeded", "failed", "superseded"]),
    }),
    errorKinds: ["forbidden", "not_found"],
  }),
  "operations.retryProcessingStep": operationEntry({
    kind: "operation",
    name: "operations.retryProcessingStep",
    input: Schema.Struct({ stepId: tableIdSchema("processingSteps") }),
    result: Schema.Struct({ stepId: tableIdSchema("processingSteps") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  "operations.requestReanalysis": operationEntry({
    kind: "operation",
    name: "operations.requestReanalysis",
    input: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      reason: Schema.NonEmptyString,
    }),
    result: Schema.Struct({
      processingRunId: tableIdSchema("processingRuns"),
      reanalysisOfRunId: Schema.NullOr(tableIdSchema("processingRuns")),
    }),
    errorKinds: ["forbidden", "not_found", "conflict"],
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
