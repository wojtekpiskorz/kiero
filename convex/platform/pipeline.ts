/**
 * The durable processing pipeline (A3): @convex-dev/workflow, the one
 * canonical workflow engine, composed with the native scheduler.
 *
 * What remains here is the platform's OWN mechanical proof workflow
 * (`processingPipeline`, driven by the guarded probes): the run row and the
 * workflow are created in ONE transaction, each stage records a
 * `processingSteps` row idempotently (insert-if-absent on the run+sequence
 * index) and computes its payload with Effect 4 RC, and `onComplete`
 * records the terminal outcome on both the job and the run. No provider
 * call and no business memory write happens here.
 *
 * Crash/restart semantics proved here (P06 at platform level): a workflow
 * whose stage N fails deterministically leaves stages 1..N-1 committed
 * exactly once; restarting from the journal resumes AFTER them without
 * re-executing committed stages, verified by counting step rows. The
 * `WorkflowManager` instance this module owns also powers E3's real
 * text-analysis workflow (convex/processing/text/analyze.ts), which
 * replaced the mechanical executor for `processing.analyze_change_plan`
 * behind the same seam.
 */

import { Effect } from "effect";
import { v } from "convex/values";
import { WorkflowManager, start, vResultValidator, type WorkflowId } from "@convex-dev/workflow";
import { okResult } from "@kiero/contracts";
import type { ResultEnvelope } from "@kiero/contracts";
import { components } from "../_generated/api";
import { internalMutation, internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** The one workflow manager instance (component installed in convex.config.ts). */
export const workflow = new WorkflowManager(components.workflow);

const PIPELINE_VERSION = "a3-mechanical-1";
const PROMPT_VERSION = "a3-none";
const SCHEMA_VERSION = "a3-1";
const MODEL_CONFIGURATION_VERSION = "a3-none";
/** Sequence base for failure-marker step rows (kept outside 1..N). */
const FAILURE_MARKER_BASE = 10_000;

/** Whether the armed-failure marker exists for one stage. */
export const isFailureArmed = internalQuery({
  args: { runId: v.id("processingRuns"), stage: v.float64() },
  handler: async (ctx, args) => {
    const marker = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) =>
        q.eq("runId", args.runId).eq("sequence", FAILURE_MARKER_BASE + args.stage),
      )
      .first();
    return marker !== null;
  },
});

/** Arms the deterministic stage failure (a journaled, committed step). */
export const markFailure = internalMutation({
  args: { runId: v.id("processingRuns"), stage: v.float64() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) =>
        q.eq("runId", args.runId).eq("sequence", FAILURE_MARKER_BASE + args.stage),
      )
      .first();
    if (existing !== null) {
      return existing._id;
    }
    return ctx.db.insert("processingSteps", {
      runId: args.runId,
      stepKind: "failure_marker",
      sequence: FAILURE_MARKER_BASE + args.stage,
      state: "failed",
      outputRef: "armed",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
  },
});

/** Disarms the failure (the "operator fixed the external system" action). */
export const disarmFailure = internalMutation({
  args: { runId: v.id("processingRuns"), stage: v.float64() },
  handler: async (ctx, args) => {
    await disarmFailureMarker(ctx, args.runId, args.stage);
  },
});

/**
 * Deterministic Effect domain computation for one pipeline stage. With
 * `failWhileArmed`, the stage models a transient external failure: it throws
 * while the failure marker is armed, and succeeds once an operator disarms
 * it, so the recovery story (fix, then restart) is real, not a replay
 * artifact.
 */
export const computeStage = internalAction({
  args: {
    seed: v.string(),
    stage: v.float64(),
    runId: v.optional(v.id("processingRuns")),
    failWhileArmed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.failWhileArmed === true && args.runId !== undefined) {
      const armed = await ctx.runQuery(internal.platform.pipeline.isFailureArmed, {
        runId: args.runId,
        stage: args.stage,
      });
      if (armed) {
        throw new Error(`pipeline: injected transient external failure at stage ${args.stage}`);
      }
    }
    const program: Effect.Effect<string, never> = Effect.succeed(
      `stage ${args.stage} of ${args.seed}: ${args.seed.toUpperCase()}#${args.stage}`,
    );
    return Effect.runPromise(program);
  },
});

/** Records one stage idempotently (insert-if-absent on run+sequence). */
export const recordStage = internalMutation({
  args: {
    runId: v.id("processingRuns"),
    stage: v.float64(),
    stepKind: v.string(),
    output: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId).eq("sequence", args.stage))
      .first();
    if (existing !== null) {
      // Journal replay: the stage already committed; do not duplicate it.
      return existing._id;
    }
    return ctx.db.insert("processingSteps", {
      runId: args.runId,
      stepKind: args.stepKind,
      sequence: args.stage,
      state: "succeeded",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      outputRef: args.output,
    });
  },
});

/** Marks the run row's terminal state. */
export const completeRun = internalMutation({
  args: {
    runId: v.id("processingRuns"),
    state: v.union(v.literal("succeeded"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, {
      state: args.state,
      finishedAtMs: Date.now(),
    });
  },
});

/** The durable pipeline workflow: idempotent stages over one run row. */
export const processingPipeline = workflow
  .define({
    args: {
      jobKey: v.string(),
      runId: v.id("processingRuns"),
      stageCount: v.float64(),
      failAtStage: v.optional(v.float64()),
    },
    returns: v.object({ stagesCompleted: v.float64() }),
  })
  .handler(async (step, args) => {
    for (let stage = 1; stage <= args.stageCount; stage += 1) {
      const isFailureStage = args.failAtStage !== undefined && stage === args.failAtStage;
      if (isFailureStage) {
        // Arm the transient failure as a JOURNALED step, then hit it: the
        // workflow fails with stages 1..stage-1 committed exactly once, and
        // recovery is disarm + restart (not a replay artifact).
        await step.runMutation(internal.platform.pipeline.markFailure, {
          runId: args.runId,
          stage,
        });
      }
      const output = await step.runAction(internal.platform.pipeline.computeStage, {
        seed: args.jobKey,
        stage,
        runId: args.runId,
        ...(isFailureStage ? { failWhileArmed: true } : {}),
      });
      await step.runMutation(internal.platform.pipeline.recordStage, {
        runId: args.runId,
        stage,
        stepKind: "mechanical_stage",
        output,
      });
    }
    await step.runMutation(internal.platform.pipeline.completeRun, {
      runId: args.runId,
      state: "succeeded",
    });
    return { stagesCompleted: args.stageCount };
  });

/** Records the workflow's terminal outcome on the durable job and run. */
export const completeAnalysis = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: v.object({ jobKey: v.string(), runId: v.id("processingRuns") }),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.context.jobKey))
      .first();
    if (job !== null && job.state !== "succeeded" && job.state !== "cancelled") {
      if (args.result.kind === "success") {
        await ctx.db.patch(job._id, {
          state: "succeeded",
          updatedAtMs: nowMs,
          finishedAtMs: nowMs,
        });
      } else {
        await ctx.db.patch(job._id, {
          state: "failed",
          lastErrorKind: "pipeline_workflow_failed",
          updatedAtMs: nowMs,
          finishedAtMs: nowMs,
        });
      }
    }
    await ctx.db.patch(args.context.runId, {
      state: args.result.kind === "success" ? "succeeded" : "failed",
      finishedAtMs: nowMs,
    });
  },
});

/** Creates the run row and starts the workflow in ONE transaction. */
async function createRunAndStartWorkflow(
  ctx: MutationCtx,
  params: {
    jobKey: string;
    sourceId: Id<"sources">;
    kind: "initial_analysis" | "reanalysis";
    stageCount: number;
    failAtStage?: number;
  },
): Promise<{ runId: Id<"processingRuns">; workflowId: string }> {
  const source = await ctx.db.get(params.sourceId);
  if (source === null) {
    throw new Error("pipeline: source row missing");
  }
  const runId = await ctx.db.insert("processingRuns", {
    companyId: source.companyId,
    sourceId: params.sourceId,
    kind: params.kind,
    pipelineVersion: PIPELINE_VERSION,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    modelConfigurationVersion: MODEL_CONFIGURATION_VERSION,
    state: "running",
    checkpoint: params.jobKey,
    startedAtMs: Date.now(),
  });
  const workflowId = await start(
    ctx,
    internal.platform.pipeline.processingPipeline,
    {
      jobKey: params.jobKey,
      runId,
      stageCount: params.stageCount,
      ...(params.failAtStage === undefined ? {} : { failAtStage: params.failAtStage }),
    },
    {
      onComplete: internal.platform.pipeline.completeAnalysis,
      context: { jobKey: params.jobKey, runId },
      startAsync: true,
    },
  );
  return { runId, workflowId };
}

/** The crash/restart proof entry: run row + workflow, atomically. */
export async function startProofPipeline(
  ctx: MutationCtx,
  params: { sourceId: Id<"sources">; stageCount: number; failAtStage?: number },
): Promise<ResultEnvelope> {
  const jobKey = `probe-workflow-${crypto.randomUUID()}`;
  const { runId, workflowId } = await createRunAndStartWorkflow(ctx, {
    jobKey,
    sourceId: params.sourceId,
    kind: "initial_analysis",
    stageCount: params.stageCount,
    ...(params.failAtStage === undefined ? {} : { failAtStage: params.failAtStage }),
  });
  return okResult({ runId, workflowId, jobKey });
}

/**
 * Recovery: disarm the injected transient failure, then restart the failed
 * workflow from its journal (committed stages replay as no-ops; the failing
 * stage re-executes against the fixed external condition).
 */
export async function restartProofPipeline(
  ctx: MutationCtx,
  workflowId: WorkflowId,
  runId: Id<"processingRuns">,
  stage: number,
): Promise<void> {
  await disarmFailureMarker(ctx, runId, stage);
  // Restart from the failed compute step: journal replay would otherwise
  // re-throw the journaled step error instead of re-executing the (now
  // fixed) stage against the disarmed condition.
  await workflow.restart(ctx, workflowId, {
    from: internal.platform.pipeline.computeStage,
  });
}

/** The failure marker lookup shared by disarmFailure and restart. */
async function findFailureMarker(
  db: MutationCtx["db"],
  runId: Id<"processingRuns">,
  stage: number,
) {
  return db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) =>
      q.eq("runId", runId).eq("sequence", FAILURE_MARKER_BASE + stage),
    )
    .first();
}

async function disarmFailureMarker(
  ctx: MutationCtx,
  runId: Id<"processingRuns">,
  stage: number,
): Promise<void> {
  const marker = await findFailureMarker(ctx.db, runId, stage);
  if (marker !== null) {
    await ctx.db.delete(marker._id);
  }
}
