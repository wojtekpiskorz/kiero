/**
 * A3 proof 3: durable workflow crash/restart semantics on @convex-dev/workflow.
 *
 * A pipeline with 5 mechanical stages hits an armed transient failure at
 * stage 3 (the arm marker is itself a journaled step). Observed: stages 1-2
 * recorded exactly once, run failed, marker armed; the operator disarms the
 * failure (the fix) and RESTARTS the workflow from its journal: stages 1-2
 * replay as no-ops, stage 3 re-executes against the fixed condition and the
 * pipeline completes. The step ledger shows each stage exactly once (no
 * duplicate stage effects on replay) and the run ends succeeded.
 *
 * Rows produced:
 *   W1 run+workflow created atomically     W2 failure leaves stages 1..3 once
 *   W3 restart completes from the journal  W4 no duplicate stage rows
 *
 * Usage: node docs/evidence/platform/scripts/proof3-workflow-restart.mjs
 */

import { httpClient, loadEnv, pollUntil, record, stamp, summarize } from "./lib.mjs";

console.log(`# proof3 workflow crash/restart :: started ${stamp()}`);
const client = httpClient();

const seed = await client.action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error("probeSeed failed");
const { sourceId } = seed.value;

// --- W1: atomic run + workflow creation with a deterministic stage-4 failure ----

const kick = await client.action("platform/probe:probeKickCrashPipeline", {
  sourceId,
  stageCount: 5,
  failAtStage: 3,
});
if (kick._tag !== "ok") throw new Error(`kick failed: ${JSON.stringify(kick)}`);
const { runId, workflowId } = kick.value;
record(
  "W1 run row and workflow are created atomically (kick returns both)",
  typeof runId === "string" && typeof workflowId === "string" ? "PASS" : "FAIL",
  `runId=${runId} workflowId=${workflowId}`,
);

// --- W2: the armed failure leaves stages 1..2 committed, run failed ----------

const failedState = await pollUntil(
  "workflow fails after stage 3",
  async () => {
    const state = await client.action("platform/probe:probeRunState", { runId });
    if (state._tag !== "ok") return null;
    const { run, steps } = state.value;
    return run.state === "failed" && steps.length === 2 ? state.value : null;
  },
  { timeoutMs: 90_000, intervalMs: 3_000 },
);
record(
  "W2 armed transient failure at stage 3 leaves stages 1..2 exactly once",
  failedState.steps.length === 2 &&
    failedState.steps.map((s) => s.sequence).join(",") === "1,2" &&
    failedState.failureMarkers === 1
    ? "PASS"
    : "FAIL",
  `run=${failedState.run.state} steps=[${failedState.steps.map((s) => s.sequence)}] markers=${failedState.failureMarkers}`,
);

// --- W3: restart from the journal completes the pipeline -------------------------

const restart = await client.action("platform/probe:probeRestartWorkflow", {
  workflowId,
  runId,
  stage: 3,
});
if (restart._tag !== "ok") throw new Error(`restart failed: ${JSON.stringify(restart)}`);
const doneState = await pollUntil(
  "workflow completes after restart",
  async () => {
    const state = await client.action("platform/probe:probeRunState", { runId });
    if (state._tag !== "ok") return null;
    return state.value.run.state === "succeeded" && state.value.steps.length === 5
      ? state.value
      : null;
  },
  { timeoutMs: 120_000, intervalMs: 3_000 },
);
record(
  "W3 restart resumes from the journal and completes all 5 stages",
  doneState.run.state === "succeeded" ? "PASS" : "FAIL",
  `run=${doneState.run.state} stages=${doneState.steps.length}`,
);

// --- W4: no duplicate stage rows after replay ------------------------------------

const sequences = doneState.steps.map((step) => step.sequence);
const uniqueSequences = [...new Set(sequences)];
record(
  "W4 journal replay executes each stage exactly once (no duplicate effects)",
  sequences.length === 5 && uniqueSequences.length === 5 &&
    uniqueSequences.join(",") === "1,2,3,4,5"
    ? "PASS"
    : "FAIL",
  `stage ledger = [${sequences}]`,
);

void loadEnv;
process.exit(summarize() ? 0 : 1);
