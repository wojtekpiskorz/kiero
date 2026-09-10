/**
 * H4 focused verification (1/5): the pure decision cores; workflow
 * identity parsing, retry eligibility in check order (stale revision,
 * already-running stage, not-failed stage, superseded, missing identity,
 * unsupported version), the restart target mapping, the reanalysis target
 * decision (active source, inspected latest run), the blocker derivation
 * (failed/stuck stages, exhausted/uncertain jobs, withdrawn source), the
 * redacted-diagnostic projection and the target-revision spellings.
 */

import { describe, expect, it } from "vitest";
import { TEXT_ANALYSIS_PIPELINE_VERSION } from "@kiero/agent";
import { ACCEPTANCE_PIPELINE_VERSION } from "../../convex/sources/accept/acceptance";
import {
  DIAGNOSTIC_SCAN_ROWS,
  MAX_INSPECT_ATTEMPTS,
  MAX_INSPECT_CHANGE_SETS,
  MAX_INSPECT_DIAGNOSTICS,
  MAX_INSPECT_STEPS,
  REANALYSIS_PIPELINE_PLACEHOLDER,
  RETRYABLE_PIPELINE_VERSIONS,
  decideReanalysisTarget,
  decideRetry,
  deriveBlockers,
  diagnosticsForTarget,
  isPipelineStage,
  parseWorkflowIdentity,
  pipelineVersionRetryable,
  restartTargetOfStep,
  runTargetRevision,
  sourceTargetRevision,
  type DiagnosticEventView,
  type JobView,
  type ProcessingRunView,
  type SourceView,
  type StepView,
} from "../../convex/operations/processing/cores";

const RUN_ID = "k57run0001q2x9w7c1vbn8hj6t0a5q3z";
const SOURCE_ID = "k57src0001q2x9w7c1vbn8hj6t0a5q3z";

describe("parseWorkflowIdentity", () => {
  it("reads the workflow id the analyze executor records on the checkpoint", () => {
    expect(parseWorkflowIdentity(JSON.stringify({ workflowId: "wf-123" }))).toBe("wf-123");
  });

  it("resolves null for absent, non-JSON and identity-free checkpoints", () => {
    expect(parseWorkflowIdentity(null)).toBeNull();
    expect(parseWorkflowIdentity("probe-workflow-uuid")).toBeNull(); // A3 mechanical shape
    expect(parseWorkflowIdentity(JSON.stringify({ groups: [] }))).toBeNull();
    expect(parseWorkflowIdentity(JSON.stringify({ workflowId: "" }))).toBeNull();
  });

  it("keeps the identity through the completion summary checkpoint", () => {
    const completion = JSON.stringify({
      workflowId: "wf-keep",
      groups: [],
      clarified: 0,
      completeness: null,
    });
    expect(parseWorkflowIdentity(completion)).toBe("wf-keep");
  });
});

describe("pipelineVersionRetryable", () => {
  it("accepts exactly the resumable families: current analysis, D1 seed, reanalysis placeholder", () => {
    expect([...RETRYABLE_PIPELINE_VERSIONS].sort()).toEqual(
      [
        TEXT_ANALYSIS_PIPELINE_VERSION,
        ACCEPTANCE_PIPELINE_VERSION,
        REANALYSIS_PIPELINE_PLACEHOLDER,
      ].sort(),
    );
    expect(pipelineVersionRetryable(TEXT_ANALYSIS_PIPELINE_VERSION)).toBe(true);
    expect(pipelineVersionRetryable("d1.accept/1")).toBe(true);
    expect(pipelineVersionRetryable("pending-e3")).toBe(true);
  });

  it("refuses the mechanical proof, dev fixtures and unknown future versions", () => {
    expect(pipelineVersionRetryable("a3-mechanical-1")).toBe(false);
    expect(pipelineVersionRetryable("dev-proof")).toBe(false);
    expect(pipelineVersionRetryable("e4.vision/9")).toBe(false);
  });
});

describe("decideRetry (the check order)", () => {
  const eligible = {
    runState: "failed" as const,
    stepState: "failed" as const,
    expectedRunState: "failed" as const,
    pipelineVersion: TEXT_ANALYSIS_PIPELINE_VERSION,
    workflowId: "wf-1",
  };

  it("allows a failed compatible stage of a failed run", () => {
    expect(decideRetry(eligible)).toEqual({ ok: true });
  });

  it("stale revision first: the inspected state must still be the run's state", () => {
    expect(
      decideRetry({ ...eligible, expectedRunState: "failed", runState: "succeeded" }),
    ).toEqual({ ok: false, kind: "conflict", code: "run_state_stale" });
  });

  it("already-running second: an inspected running run is refused even with matching state", () => {
    expect(
      decideRetry({ ...eligible, runState: "running", expectedRunState: "running" }),
    ).toEqual({ ok: false, kind: "conflict", code: "run_already_running" });
  });

  it("only a failed or stuck stage is retryable work", () => {
    expect(decideRetry({ ...eligible, stepState: "succeeded" })).toEqual({
      ok: false,
      kind: "conflict",
      code: "stage_not_failed",
    });
    // The stuck shape: a stage still running/pending inside a FAILED run
    // (the workflow died around it) is retryable work.
    for (const stepState of ["running", "pending"] as const) {
      expect(decideRetry({ ...eligible, stepState })).toEqual({ ok: true });
    }
    // A running row on a SUCCEEDED run is not retryable (conservative: only
    // failed steps of partial-completion runs are).
    for (const stepState of ["running", "pending"] as const) {
      expect(
        decideRetry({ ...eligible, runState: "succeeded", expectedRunState: "succeeded", stepState }),
      ).toEqual({ ok: false, kind: "conflict", code: "stage_not_failed" });
    }
  });

  it("a superseded run is history, not work", () => {
    expect(
      decideRetry({ ...eligible, runState: "superseded", expectedRunState: "superseded" }),
    ).toEqual({ ok: false, kind: "conflict", code: "run_superseded" });
  });

  it("missing workflow identity and unsupported version are honest unsupported refusals", () => {
    expect(decideRetry({ ...eligible, workflowId: null })).toEqual({
      ok: false,
      kind: "unsupported",
      code: "workflow_identity_missing",
    });
    expect(decideRetry({ ...eligible, pipelineVersion: "dev-proof" })).toEqual({
      ok: false,
      kind: "unsupported",
      code: "workflow_version_unsupported",
    });
  });

  it("a failed group of a SUCCEEDED run (partial completion) is retryable work", () => {
    expect(
      decideRetry({
        ...eligible,
        runState: "succeeded",
        expectedRunState: "succeeded",
      }),
    ).toEqual({ ok: true });
  });
});

describe("restartTargetOfStep", () => {
  it("maps the model and group stages to their named functions, others to a full restart", () => {
    expect(restartTargetOfStep("model_analysis")).toBe("model");
    expect(restartTargetOfStep("publish_group")).toBe("group");
    expect(restartTargetOfStep("load_context")).toBe("start");
    expect(restartTargetOfStep("extract_text")).toBe("start");
  });
});

describe("decideReanalysisTarget", () => {
  it("allows an active source with the inspected latest run", () => {
    expect(
      decideReanalysisTarget({
        lifecycle: "active",
        expectedLatestRunId: RUN_ID,
        latestRunId: RUN_ID,
      }),
    ).toEqual({ ok: true });
    expect(
      decideReanalysisTarget({ lifecycle: "active", expectedLatestRunId: null, latestRunId: null }),
    ).toEqual({ ok: true });
  });

  it("refuses a withdrawn/purged source", () => {
    for (const lifecycle of ["withdrawn", "purged"] as const) {
      expect(
        decideReanalysisTarget({ lifecycle, expectedLatestRunId: RUN_ID, latestRunId: RUN_ID }),
      ).toEqual({ ok: false, kind: "conflict", code: "source_not_active" });
    }
  });

  it("refuses stale inspections: any mismatch with the current latest run", () => {
    expect(
      decideReanalysisTarget({ lifecycle: "active", expectedLatestRunId: null, latestRunId: RUN_ID }),
    ).toEqual({ ok: false, kind: "conflict", code: "newer_run_exists" });
    expect(
      decideReanalysisTarget({ lifecycle: "active", expectedLatestRunId: "k57other", latestRunId: RUN_ID }),
    ).toEqual({ ok: false, kind: "conflict", code: "newer_run_exists" });
    expect(
      decideReanalysisTarget({ lifecycle: "active", expectedLatestRunId: RUN_ID, latestRunId: null }),
    ).toEqual({ ok: false, kind: "conflict", code: "newer_run_exists" });
  });
});

describe("the inspection projection helpers", () => {
  const run: ProcessingRunView = {
    runId: RUN_ID,
    companyId: "k57company1",
    sourceId: SOURCE_ID,
    kind: "initial_analysis",
    reanalysisOfRunId: null,
    pipelineVersion: "e3.text/1",
    promptVersion: "e3.prompt/1",
    schemaVersion: "e3.schema/1",
    modelConfigurationVersion: "e2.routing/1#chat_analysis",
    state: "failed",
    checkpoint: null,
    startedAtMs: 1,
    finishedAtMs: 2,
  };
  const source: SourceView = {
    sourceId: SOURCE_ID,
    companyId: "k57company1",
    authorUserId: "k57author",
    lifecycle: "active",
    processingState: "failed",
    sentAtMs: 1,
  };
  const step = (overrides: Partial<StepView>): StepView => ({
    stepId: `k57stp${overrides.sequence ?? 1}`,
    runId: RUN_ID,
    sequence: 1,
    stepKind: "publish_group",
    state: "failed",
    startedAtMs: 1,
    finishedAtMs: 2,
    ...overrides,
  });
  const job = (overrides: Partial<JobView>): JobView => ({
    jobId: `k57job${Math.floor(Math.random() * 1e9)}`,
    kind: "processing.analyze_change_plan",
    state: "succeeded",
    attempts: 1,
    maxAttempts: 3,
    lastErrorKind: null,
    externalOutcome: null,
    ...overrides,
  });

  it("isPipelineStage excludes the A3/E3 failure-marker rows", () => {
    expect(isPipelineStage(step({ stepKind: "failure_marker" }))).toBe(false);
    expect(isPipelineStage(step({ stepKind: "outcome_failure_marker" }))).toBe(false);
    expect(isPipelineStage(step({ stepKind: "publish_group" }))).toBe(true);
  });

  it("deriveBlockers lists nothing for a healthy run", () => {
    expect(
      deriveBlockers({
        run: { ...run, state: "succeeded" },
        source,
        steps: [step({ state: "succeeded", stepKind: "model_analysis" })],
        jobs: [job({})],
      }),
    ).toEqual([]);
  });

  it("deriveBlockers lists a withdrawn source, failed stages, stuck stages, exhausted and uncertain jobs", () => {
    const blockers = deriveBlockers({
      run,
      source: { ...source, lifecycle: "withdrawn" },
      steps: [
        step({ sequence: 30, stepKind: "model_analysis", state: "failed" }),
        step({ sequence: 1_000, stepKind: "publish_group", state: "running" }),
      ],
      jobs: [
        job({ state: "failed", lastErrorKind: "max_attempts_exceeded", kind: "processing.transcribe_segment" }),
        job({ state: "running", externalOutcome: "timeout", kind: "processing.normalize_photo" }),
        job({ state: "failed", lastErrorKind: "analysis_workflow_failed" }),
      ],
    });
    expect(blockers).toEqual([
      { code: "source_withdrawn", detail: "źródło withdrawn" },
      { code: "stage_failed", detail: "model_analysis#30" },
      { code: "stage_stuck", detail: "publish_group#1000" },
      { code: "job_attempts_exhausted", detail: "processing.transcribe_segment" },
      { code: "job_outcome_uncertain", detail: "processing.normalize_photo" },
      { code: "job_failed", detail: "processing.analyze_change_plan:analysis_workflow_failed" },
    ]);
  });

  it("a stuck stage of a RUNNING run is not a blocker (it is just in progress)", () => {
    expect(
      deriveBlockers({
        run: { ...run, state: "running" },
        source,
        steps: [step({ state: "running", stepKind: "model_analysis" })],
        jobs: [],
      }),
    ).toEqual([]);
  });

  it("a failed run with no other visible cause still derives the honest run_failed blocker", () => {
    expect(
      deriveBlockers({
        run,
        source,
        steps: [step({ state: "succeeded", stepKind: "model_analysis" })],
        jobs: [],
      }),
    ).toEqual([{ code: "run_failed", detail: null }]);
  });

  it("diagnosticsForTarget matches sanitized runId/sourceId metadata and bounds the tail", () => {
    const rows: DiagnosticEventView[] = [
      {
        kind: "ops.processing.failed",
        metadata: [{ key: "runId", value: RUN_ID }],
        redactionsApplied: 0,
        atMs: 3,
      },
      {
        kind: "ops.save.failed",
        metadata: [{ key: "sourceId", value: SOURCE_ID }],
        redactionsApplied: 2,
        atMs: 2,
      },
      {
        kind: "ops.processing.failed",
        metadata: [{ key: "runId", value: "k57someotherrun0000000000000000" }],
        redactionsApplied: 0,
        atMs: 1,
      },
    ];
    const matched = diagnosticsForTarget(rows, RUN_ID, SOURCE_ID, MAX_INSPECT_DIAGNOSTICS);
    expect(matched).toHaveLength(2);
    expect(matched.map((row) => row.kind)).toEqual(["ops.processing.failed", "ops.save.failed"]);
    expect(diagnosticsForTarget(rows, RUN_ID, SOURCE_ID, 1)).toHaveLength(1);
  });

  it("the projection bounds are sane and consistent", () => {
    expect(MAX_INSPECT_STEPS).toBe(50);
    expect(MAX_INSPECT_ATTEMPTS).toBe(100);
    expect(MAX_INSPECT_CHANGE_SETS).toBe(10);
    expect(MAX_INSPECT_DIAGNOSTICS).toBe(20);
    expect(DIAGNOSTIC_SCAN_ROWS).toBeGreaterThanOrEqual(MAX_INSPECT_DIAGNOSTICS);
  });

  it("target revisions are bounded machine spellings", () => {
    expect(runTargetRevision(RUN_ID, "failed")).toBe(`${RUN_ID}@failed`);
    expect(sourceTargetRevision(RUN_ID)).toBe(`source@${RUN_ID}`);
    expect(sourceTargetRevision(null)).toBe("source@none");
  });
});
