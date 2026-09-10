/**
 * The generated-ctx adapter (H4): maps the Convex mutation context onto the
 * GM processing store surfaces from ./store.ts, composed OVER B4's adapter
 * (`gmTx`) for every authority read/write; the GM authority seam is
 * consumed, not duplicated. The workflow restart mapping is E3's exported
 * `restartAnalysisWorkflow`, consumed the same way.
 *
 * `normalizeId` is the proved id bridge (A3): the cores speak plain-string
 * ids, typed index chains live only here. Projections stay bounded and
 * payload-free: inspection reads carry ids, states, versions and sanitized
 * closed kinds only, never source content or job input payloads.
 */

import type { WorkflowId } from "@convex-dev/workflow";
import type { MutationCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import { workflow } from "../../platform/pipeline";
import { publishEvent } from "../../platform/publish";
import { restartAnalysisWorkflow } from "../../processing/text/analyze";
import { deriveProcessingState } from "../../sources/read/rows";
import { gmTx } from "../../access/gm/storeAdapter";
import { REANALYSIS_PIPELINE_PLACEHOLDER } from "./cores";
import type {
  AttemptView,
  ChangeSetView,
  DiagnosticEventView,
  JobView,
  ProcessingRunView,
  SourceView,
  StepView,
} from "./cores";
import type { ProcessingTx } from "./store";

type Db = MutationCtx["db"];

function runViewOf(row: Doc<"processingRuns">): ProcessingRunView {
  return {
    runId: row._id,
    companyId: row.companyId,
    sourceId: row.sourceId,
    kind: row.kind,
    reanalysisOfRunId: row.reanalysisOfRunId ?? null,
    pipelineVersion: row.pipelineVersion,
    promptVersion: row.promptVersion,
    schemaVersion: row.schemaVersion,
    modelConfigurationVersion: row.modelConfigurationVersion,
    state: row.state,
    checkpoint: row.checkpoint ?? null,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs ?? null,
  };
}

function stepViewOf(row: Doc<"processingSteps">): StepView {
  return {
    stepId: row._id,
    runId: row.runId,
    sequence: row.sequence,
    stepKind: row.stepKind,
    state: row.state,
    startedAtMs: row.startedAtMs ?? null,
    finishedAtMs: row.finishedAtMs ?? null,
  };
}

function attemptViewOf(row: Doc<"processingAttempts">): AttemptView {
  return {
    stepId: row.stepId,
    attempt: row.attempt,
    outcome: row.outcome,
    provider: row.provider ?? null,
    model: row.model ?? null,
    errorKind: row.errorKind ?? null,
    startedAtMs: row.startedAtMs,
    finishedAtMs: row.finishedAtMs ?? null,
  };
}

function jobViewOf(row: Doc<"durableJobs">): JobView {
  return {
    jobId: row._id,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lastErrorKind: row.lastErrorKind ?? null,
    externalOutcome: row.externalOutcome ?? null,
  };
}

/** Adapts one Convex mutation transaction to the GM processing surface. */
export function processingTx(tx: MutationCtx): ProcessingTx {
  const db: Db = tx.db;
  const base = gmTx(tx);
  return {
    ...base,
    runById: async (runId) => {
      const id = db.normalizeId("processingRuns", runId);
      if (id === null) {
        return null;
      }
      const row = await db.get(id);
      return row === null ? null : runViewOf(row);
    },
    stepById: async (stepId) => {
      const id = db.normalizeId("processingSteps", stepId);
      if (id === null) {
        return null;
      }
      const row = await db.get(id);
      return row === null ? null : stepViewOf(row);
    },
    stepsOfRun: async (runId) => {
      const id = db.normalizeId("processingRuns", runId);
      if (id === null) {
        return [];
      }
      const rows = await db
        .query("processingSteps")
        .withIndex("by_run_sequence", (q) => q.eq("runId", id))
        .collect();
      return rows.map(stepViewOf).sort((a, b) => a.sequence - b.sequence);
    },
    attemptsOfSteps: async (stepIds) => {
      const views: AttemptView[] = [];
      for (const stepId of stepIds) {
        const id = db.normalizeId("processingSteps", stepId);
        if (id === null) {
          continue;
        }
        const rows = await db
          .query("processingAttempts")
          .withIndex("by_step_attempt", (q) => q.eq("stepId", id))
          .collect();
        views.push(...rows.map(attemptViewOf));
      }
      return views.sort((a, b) => a.attempt - b.attempt);
    },
    jobsOfRun: async (runId, limit) => {
      // No by_run index exists on durableJobs (the A2 fragment owns the
      // table): scope by the run's company through by_company, then filter
      // on processingRunId. Bounded output; alpha-scale scan.
      const runId2 = db.normalizeId("processingRuns", runId);
      if (runId2 === null) {
        return [];
      }
      const runRow = await db.get(runId2);
      if (runRow === null) {
        return [];
      }
      const rows = await db
        .query("durableJobs")
        .withIndex("by_company", (q) => q.eq("companyId", runRow.companyId))
        .filter((q) => q.eq(q.field("processingRunId"), runId2))
        .take(limit);
      return rows.map(jobViewOf);
    },
    sourceById: async (sourceId) => {
      const id = db.normalizeId("sources", sourceId);
      if (id === null) {
        return null;
      }
      const row = await db.get(id);
      if (row === null) {
        return null;
      }
      const latestRun = await db
        .query("processingRuns")
        .withIndex("by_source_started", (q) => q.eq("sourceId", id))
        .order("desc")
        .first();
      const view: SourceView = {
        sourceId: row._id,
        companyId: row.companyId,
        authorUserId: row.authorUserId,
        lifecycle: row.lifecycle,
        processingState: deriveProcessingState(
          latestRun === null ? null : { state: latestRun.state },
        ),
        sentAtMs: row.sentAtMs,
      };
      return view;
    },
    latestRunOfSource: async (sourceId) => {
      const id = db.normalizeId("sources", sourceId);
      if (id === null) {
        return null;
      }
      const row = await db
        .query("processingRuns")
        .withIndex("by_source_started", (q) => q.eq("sourceId", id))
        .order("desc")
        .first();
      return row === null ? null : runViewOf(row);
    },
    changeSetsOfSource: async (sourceId, limit) => {
      const id = db.normalizeId("sources", sourceId);
      if (id === null) {
        return [];
      }
      const rows = await db
        .query("changeSets")
        .withIndex("by_source", (q) => q.eq("sourceId", id))
        .order("desc")
        .take(limit);
      const views: ChangeSetView[] = rows.map((row) => ({
        changeSetId: row._id,
        state: row.state,
        preparedAtMs: row.preparedAtMs,
        publishedAtMs: row.publishedAtMs ?? null,
        failedReason: row.failedReason ?? null,
      }));
      return views;
    },
    recentDiagnostics: async (limit) => {
      const rows = await db
        .query("diagnosticEvents")
        .withIndex("by_time")
        .order("desc")
        .take(limit);
      const views: DiagnosticEventView[] = rows.map((row) => ({
        kind: row.kind,
        metadata: row.technicalMetadata.map((entry) => ({
          key: entry.key,
          value: entry.value,
        })),
        redactionsApplied: row.redactionsApplied ?? null,
        atMs: row.atMs,
      }));
      return views;
    },
    patchRunRunning: async (runId) => {
      const id = db.normalizeId("processingRuns", runId);
      if (id === null) {
        return false;
      }
      // `finishedAtMs: undefined` DELETES the terminal timestamp (Convex
      // patch semantics): the run row returns to running in place, keeping
      // its id, kind, versions and journal (semantic run identity).
      await db.patch(id, { state: "running", finishedAtMs: undefined });
      return true;
    },
    restartRunWorkflow: async (workflowId, from) => {
      // The single documented cast: the workflow id string came from the run
      // row's checkpoint, written by the workflow engine itself (the
      // asConvexId precedent: one nominal brand over one engine string).
      const typed = workflowId as WorkflowId;
      if (from === "start") {
        await workflow.restart(tx, typed, {});
      } else {
        // E3's own restart mapping (the helper's docblock names this GM path
        // as its consumer): one home for the stage restart semantics.
        await restartAnalysisWorkflow(tx, typed, from);
      }
    },
    insertReanalysisRun: async (row) => {
      const companyId = db.normalizeId("companies", row.companyId);
      const sourceId = db.normalizeId("sources", row.sourceId);
      if (companyId === null || sourceId === null) {
        throw new Error("processing: invalid reanalysis reference");
      }
      const reanalysisOfRunId =
        row.reanalysisOfRunId === null
          ? null
          : db.normalizeId("processingRuns", row.reanalysisOfRunId);
      if (reanalysisOfRunId === null && row.reanalysisOfRunId !== null) {
        throw new Error("processing: invalid reanalysis run reference");
      }
      return await db.insert("processingRuns", {
        companyId,
        sourceId,
        kind: "reanalysis",
        ...(reanalysisOfRunId !== null && { reanalysisOfRunId }),
        // The same placeholder seeds E3's own reanalysis path writes; the
        // workflow's loadContextStage pins the real server-approved versions.
        pipelineVersion: REANALYSIS_PIPELINE_PLACEHOLDER,
        promptVersion: "none",
        schemaVersion: "none",
        modelConfigurationVersion: "none",
        state: "running",
        startedAtMs: row.startedAtMs,
      });
    },
    publishReanalysisRequested: async (publication) => {
      const result = await publishEvent(tx, {
        companyId: publication.companyId,
        eventName: "operations.reanalysisRequested",
        payload: {
          sourceId: publication.sourceId,
          newRunId: publication.newRunId,
          reanalysisOfRunId: publication.reanalysisOfRunId,
        },
        dedupKey: `operations.reanalysisRequested:${publication.newRunId}`,
      });
      return result.eventId;
    },
    insertProcessingAudit: async (row) => {
      const actorUserId = db.normalizeId("users", row.actorUserId);
      const gmGrantId = db.normalizeId("gmAccessGrants", row.gmGrantId);
      if (actorUserId === null || gmGrantId === null) {
        throw new Error("processing: invalid audit reference");
      }
      // null companyId / processingRunId are valid audit shapes (mode-level
      // rows); only an unnormalizable NON-null reference fails.
      const companyId =
        row.companyId === null ? null : db.normalizeId("companies", row.companyId);
      if (companyId === null && row.companyId !== null) {
        throw new Error("processing: invalid audit company reference");
      }
      const processingRunId =
        row.processingRunId === null
          ? null
          : db.normalizeId("processingRuns", row.processingRunId);
      if (processingRunId === null && row.processingRunId !== null) {
        throw new Error("processing: invalid audit run reference");
      }
      await db.insert("auditRecords", {
        actorUserId,
        gmGrantId,
        ...(companyId !== null && { companyId }),
        operationName: row.operationName,
        gmBasis: row.gmBasis,
        outcome: row.outcome,
        gmTargetRevision: row.gmTargetRevision,
        ...(processingRunId !== null && { processingRunId }),
        atMs: row.atMs,
      });
    },
  };
}
