/**
 * GM processing decision cores (H4): the pure, timestamp-free decisions
 * behind audited processing inspection and the retry/reanalysis controls.
 *
 * Everything here is pure over plain views (no Convex types, no db), the
 * pattern the B4 cores set: the transactional halves (./operations.ts) feed
 * them row snapshots, the unit tests pin them, and the live proofs exercise
 * them through the real dispatch. The decisions implement the issue's
 * authority and identity model:
 *
 * - RETRY resumes approved compatible work and preserves semantic run
 *   identity: the run row keeps its id, kind, versions and journal; only its
 *   state returns to running and the workflow resumes from its journal.
 *   The operator states the run state they inspected (the stale-revision
 *   guard, which also refuses the completion race); a run this deployment
 *   cannot resume (no workflow identity, or an unknown pipeline version) is
 *   refused as unsupported; never a false claim that unimplemented
 *   executors work.
 * - REANALYSIS is a linked NEW run over the same immutable source through
 *   the server-approved configuration; the operator states the source's
 *   latest run they inspected, and a newer run landing meanwhile refuses as
 *   stale (a deliberate reanalysis must not silently duplicate concurrent
 *   work). No model selection exists anywhere in the decision surface.
 * - Inspection never mutates: the derived blocker list and the redacted
 *   diagnostic projection are pure functions of canonical records.
 */

import { TEXT_ANALYSIS_PIPELINE_VERSION } from "@kiero/agent";
import { ACCEPTANCE_PIPELINE_VERSION } from "../../sources/accept/acceptance";

/** One processingRuns row snapshot (the inspection/retry surface). */
export interface ProcessingRunView {
  readonly runId: string;
  readonly companyId: string;
  readonly sourceId: string;
  readonly kind: "initial_analysis" | "reanalysis";
  readonly reanalysisOfRunId: string | null;
  readonly pipelineVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly modelConfigurationVersion: string;
  readonly state: "running" | "succeeded" | "failed" | "superseded";
  /** The raw checkpoint string (opaque to the schema; parsed here). */
  readonly checkpoint: string | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
}

/** One processingSteps row snapshot. */
export interface StepView {
  readonly stepId: string;
  readonly runId: string;
  readonly sequence: number;
  readonly stepKind: string;
  readonly state: "pending" | "running" | "succeeded" | "failed";
  readonly startedAtMs: number | null;
  readonly finishedAtMs: number | null;
}

/** One processingAttempts row snapshot (approved model route evidence). */
export interface AttemptView {
  readonly stepId: string;
  readonly attempt: number;
  readonly outcome: "succeeded" | "failed" | "timeout" | "unknown";
  readonly provider: string | null;
  readonly model: string | null;
  readonly errorKind: string | null;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
}

/** One durableJobs row snapshot linked to the run. */
export interface JobView {
  readonly jobId: string;
  readonly kind: string;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastErrorKind: string | null;
  readonly externalOutcome: string | null;
}

/** The protected source detail the inspection shows (no content). */
export interface SourceView {
  readonly sourceId: string;
  readonly companyId: string;
  readonly authorUserId: string;
  readonly lifecycle: "active" | "withdrawn" | "purged";
  readonly processingState: string;
  readonly sentAtMs: number;
}

/** One I2 redacted diagnostic event snapshot (already sanitized at write). */
export interface DiagnosticEventView {
  readonly kind: string;
  readonly metadata: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly redactionsApplied: number | null;
  readonly atMs: number;
}

/** One changeSets row snapshot of the run's source (derived changes). */
export interface ChangeSetView {
  readonly changeSetId: string;
  readonly state: string;
  readonly preparedAtMs: number;
  readonly publishedAtMs: number | null;
  readonly failedReason: string | null;
}

/** One derived blocker (a closed code plus a bounded detail). */
export interface ProcessingBlocker {
  readonly code: string;
  readonly detail: string | null;
}

// ---------------------------------------------------------------------------
// Workflow identity and compatibility
// ---------------------------------------------------------------------------

/**
 * The workflow identity a run records on its checkpoint (the E3 analyze
 * executor writes `{workflowId}` when it starts the workflow; the
 * completion summary preserves it). Non-JSON checkpoints (the A3 mechanical
 * proof's plain job key) resolve to null: honestly unresumable here.
 */
export function parseWorkflowIdentity(checkpoint: string | null): string | null {
  if (checkpoint === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(checkpoint) as { workflowId?: unknown };
    return typeof parsed.workflowId === "string" && parsed.workflowId.length > 0
      ? parsed.workflowId
      : null;
  } catch {
    return null;
  }
}

/**
 * The reanalysis seed placeholder, pinned to E3's own spelling
 * (convex/processing/text/probe.ts kickReanalysis): a reanalysis run this
 * module creates is byte-identical in shape to the runs E3's own reanalysis
 * path creates, and equally retryable before loadContextStage pins versions.
 */
export const REANALYSIS_PIPELINE_PLACEHOLDER = "pending-e3";

/**
 * Pipeline versions whose FAILED or PARTIALLY FAILED runs this deployment
 * can resume through the E3 analysis workflow restart seam: the current
 * text-analysis pipeline, the D1 acceptance seed an initial run carries
 * before loadContextStage pins it, and the reanalysis placeholder above.
 * Anything else (the A3 mechanical proof, dev fixtures, future versions) is
 * refused as unsupported; this surface never claims to resume a workflow
 * it does not own.
 */
export const RETRYABLE_PIPELINE_VERSIONS: ReadonlySet<string> = new Set([
  TEXT_ANALYSIS_PIPELINE_VERSION,
  ACCEPTANCE_PIPELINE_VERSION,
  REANALYSIS_PIPELINE_PLACEHOLDER,
]);

/** Whether a run's pipeline version is resumable here. */
export function pipelineVersionRetryable(pipelineVersion: string): boolean {
  return RETRYABLE_PIPELINE_VERSIONS.has(pipelineVersion);
}

// ---------------------------------------------------------------------------
// Retry (resume approved compatible work, same run identity)
// ---------------------------------------------------------------------------

/** The denial half of the retry decision. */
export type RetryDenial =
  | {
      readonly ok: false;
      readonly kind: "conflict";
      readonly code:
        | "run_state_stale"
        | "run_already_running"
        | "stage_not_failed"
        | "run_superseded";
    }
  | {
      readonly ok: false;
      readonly kind: "unsupported";
      readonly code: "workflow_identity_missing" | "workflow_version_unsupported";
    };

/** Whether one step state is retryable work inside the given run state. */
function stepRetryable(
  stepState: StepView["state"],
  runState: ProcessingRunView["state"],
): boolean {
  if (stepState === "failed") {
    return true;
  }
  // The STUCK shape the issue names: a step still marked running/pending on
  // a FAILED run (the workflow died around it, e.g. a provider window that
  // exhausted the stage retries before any step row was finalized). The run
  // is terminal, so the row is definitively stale, never live.
  return (
    (stepState === "running" || stepState === "pending") && runState === "failed"
  );
}

/**
 * The retry decision. Check order is the operator's honest read of the
 * world, then the target's own eligibility, then what this deployment can
 * resume:
 *
 * 1. `run_state_stale`: the run moved since the operator inspected it (the
 *    stale-revision guard; also refuses the completion race; a run that
 *    succeeded meanwhile is stale, not retryable);
 * 2. `run_already_running`: the operator inspected a running run and still
 *    asked to retry (the already-running-stage guard);
 * 3. `stage_not_failed`: only a FAILED or STUCK stage is retryable work
 *    (stuck = still running/pending inside a FAILED run); succeeded stages
 *    and live stages are not;
 * 4. `run_superseded`: a superseded run is history, not work;
 * 5. `workflow_identity_missing`: the run has no resumable workflow identity;
 * 6. `workflow_version_unsupported`: the run's pipeline version is not one
 *    this deployment can resume.
 */
export function decideRetry(args: {
  readonly runState: ProcessingRunView["state"];
  readonly stepState: StepView["state"];
  readonly expectedRunState: ProcessingRunView["state"];
  readonly pipelineVersion: string;
  readonly workflowId: string | null;
}): { readonly ok: true } | RetryDenial {
  if (args.expectedRunState !== args.runState) {
    return { ok: false, kind: "conflict", code: "run_state_stale" };
  }
  if (args.runState === "running") {
    return { ok: false, kind: "conflict", code: "run_already_running" };
  }
  if (!stepRetryable(args.stepState, args.runState)) {
    return { ok: false, kind: "conflict", code: "stage_not_failed" };
  }
  if (args.runState === "superseded") {
    return { ok: false, kind: "conflict", code: "run_superseded" };
  }
  if (args.workflowId === null) {
    return { ok: false, kind: "unsupported", code: "workflow_identity_missing" };
  }
  if (!pipelineVersionRetryable(args.pipelineVersion)) {
    return { ok: false, kind: "unsupported", code: "workflow_version_unsupported" };
  }
  return { ok: true };
}

/**
 * The restart origin for one step kind: the model analysis stage and the
 * publication-group stage have named workflow functions to resume from;
 * every other stage kind resumes from the workflow start (journal replay
 * re-executes only unjournaled steps).
 */
export function restartTargetOfStep(stepKind: string): "model" | "group" | "start" {
  if (stepKind === "model_analysis") {
    return "model";
  }
  if (stepKind === "publish_group") {
    return "group";
  }
  return "start";
}

// ---------------------------------------------------------------------------
// Reanalysis (a linked new run, server-approved configuration)
// ---------------------------------------------------------------------------

/** The denial half of the reanalysis target decision. */
export type ReanalysisDenial =
  | { readonly ok: false; readonly kind: "conflict"; readonly code: "source_not_active" | "newer_run_exists" };

/**
 * The reanalysis target decision: only an ACTIVE source supports deliberate
 * reanalysis (a withdrawn source is history), and the operator must have
 * inspected the source's CURRENT latest run; a newer run landing meanwhile
 * refuses as stale instead of silently stacking a duplicate reanalysis.
 * `expectedLatestRunId` is null when the operator saw a source without runs.
 */
export function decideReanalysisTarget(args: {
  readonly lifecycle: SourceView["lifecycle"];
  readonly expectedLatestRunId: string | null;
  readonly latestRunId: string | null;
}): { readonly ok: true } | ReanalysisDenial {
  if (args.lifecycle !== "active") {
    return { ok: false, kind: "conflict", code: "source_not_active" };
  }
  if (args.expectedLatestRunId !== args.latestRunId) {
    return { ok: false, kind: "conflict", code: "newer_run_exists" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Inspection projection (pure)
// ---------------------------------------------------------------------------

/**
 * Step kinds that are probe plumbing, not pipeline stages: the A3/E3
 * failure-marker rows live outside the stage sequences. They are excluded
 * from the inspection stage list exactly like E3's own state read excludes
 * them (it counts them separately); the panel shows real stages only.
 */
const MARKER_STEP_KINDS = new Set(["failure_marker", "outcome_failure_marker"]);

/** Whether one step row is a real pipeline stage (not a marker row). */
export function isPipelineStage(step: StepView): boolean {
  return !MARKER_STEP_KINDS.has(step.stepKind);
}

/**
 * The derived blocker list: what currently prevents this run's work from
 * completing, computed from canonical records only (never a provider
 * payload, never free prose). A healthy run derives an empty list.
 */
export function deriveBlockers(args: {
  readonly run: ProcessingRunView;
  readonly source: SourceView;
  readonly steps: readonly StepView[];
  readonly jobs: readonly JobView[];
}): ProcessingBlocker[] {
  const blockers: ProcessingBlocker[] = [];
  if (args.source.lifecycle !== "active") {
    blockers.push({
      code: "source_withdrawn",
      detail: `źródło ${args.source.lifecycle}`,
    });
  }
  for (const step of args.steps) {
    if (step.state === "failed") {
      blockers.push({
        code: "stage_failed",
        detail: `${step.stepKind}#${step.sequence}`,
      });
    } else if (
      (step.state === "running" || step.state === "pending") &&
      args.run.state !== "running"
    ) {
      // A non-running run with a stage still marked running/pending: the
      // stuck-work shape the issue's "failed/stuck" retry eligibility names.
      blockers.push({
        code: "stage_stuck",
        detail: `${step.stepKind}#${step.sequence}`,
      });
    }
  }
  for (const job of args.jobs) {
    if (job.state === "failed" && job.lastErrorKind === "max_attempts_exceeded") {
      blockers.push({
        code: "job_attempts_exhausted",
        detail: job.kind,
      });
    } else if (job.state === "failed") {
      blockers.push({
        code: "job_failed",
        detail: `${job.kind}:${job.lastErrorKind ?? "unknown"}`,
      });
    } else if (
      job.state === "running" &&
      (job.externalOutcome === "timeout" || job.externalOutcome === "unknown")
    ) {
      blockers.push({
        code: "job_outcome_uncertain",
        detail: job.kind,
      });
    }
  }
  if (args.run.state === "failed" && blockers.length === 0) {
    blockers.push({ code: "run_failed", detail: null });
  }
  return blockers;
}

/**
 * The run's redacted diagnostics: I2 diagnostic events whose sanitized
 * metadata names this run or this source (the incident scan writes
 * ops.processing.* events keyed by runId/sourceId). Rows arrive ALREADY
 * sanitized (the only writer of diagnosticEvents is I2's redaction path);
 * this filter never widens what it returns.
 */
export function diagnosticsForTarget(
  rows: readonly DiagnosticEventView[],
  runId: string,
  sourceId: string,
  limit: number,
): DiagnosticEventView[] {
  const matching = rows.filter((row) =>
    row.metadata.some(
      (entry) =>
        (entry.key === "runId" && entry.value === runId) ||
        (entry.key === "sourceId" && entry.value === sourceId),
    ),
  );
  return matching.slice(0, limit);
}

/** Bounded projections the inspection returns (alpha-scale honesty). */
export const MAX_INSPECT_STEPS = 50;
export const MAX_INSPECT_ATTEMPTS = 100;
export const MAX_INSPECT_JOBS = 10;
export const MAX_INSPECT_CHANGE_SETS = 10;
export const MAX_INSPECT_DIAGNOSTICS = 20;
/** How many recent diagnostic rows the adapter reads before filtering. */
export const DIAGNOSTIC_SCAN_ROWS = 100;

/** The target revision string the audit row records for a run operation. */
export function runTargetRevision(runId: string, state: string): string {
  return `${runId}@${state}`;
}

/** The target revision string the audit row records for a reanalysis. */
export function sourceTargetRevision(latestRunId: string | null): string {
  return `source@${latestRunId ?? "none"}`;
}
