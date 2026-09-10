/**
 * The `processing.join_multimodal` executor and durable join workflow
 * (E4): the partial-safe multimodal analysis of ONE mixed source.
 *
 * Composition (issue #38): E3's text planning (planning surface + journal
 * discipline), D5's retained representations (the deterministic selection
 * defines the anchor coordinate space), D6's transcript versions (per-
 * segment text + original-time interval anchors), E2's chat and vision
 * adapters, staged through the ONE canonical workflow engine:
 *
 * 1. `evaluateMediaStage` (one mutation, retried with backoff while media
 *    is ACTIVELY progressing): orders STT for audio attachments that lack
 *    an order (the D6 seam, production channel), auto-orders vision for
 *    retained representations without one, then computes the pure joined
 *    coverage. Actively-pending media waits inside a bounded wall-clock
 *    budget; blocked (planning+lastErrorKind) and terminal inputs never
 *    wait — the join proceeds partial-safe over them.
 * 2. the per-image vision passes (one ACTION + one record MUTATION each,
 *    through E2's vision adapter; both routes failing leaves the image
 *    pending with a sanitized reason, resumable), in ./vision.ts.
 * 3. `loadJoinedContextStage`: E3's tenant-filtered context plus the
 *    joined coverage, the assembled transcript segments and the vision
 *    observations, with the run's version pins.
 * 4. `modelJoinStage` (one ACTION): the bounded agent loop over E2's chat
 *    route with the JOIN tool surface; decoded calls accumulate through
 *    the multimodal reducer (never executed), in ./modelStage.ts.
 * 5. `raiseJoinClarificationStage` (one mutation per question): the
 *    source-backed Sprawa do wyjaśnienia through C2's checked dispatch,
 *    with mixed-family fragment anchors.
 * 6. `publishJoinGroupStage` (one mutation per bounded group): the
 *    completeness gate against a FRESH coverage read, the mid-run
 *    staleness guard, per-evidence fragment ensuring, then C2 prepare +
 *    publish, in ./publish.ts.
 *
 * Text-only sources never reach the workflow (the executor no-ops them —
 * E3's analyze owns those); E3's text analysis of a mixed source runs
 * independently and publishes its text-grounded groups (independent
 * confirmed text is never blocked), while THIS join carries the
 * media-dependent conclusions with partial-safe semantics.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { start, vResultValidator, type WorkflowId } from "@convex-dev/workflow";
import { joinMultimodalInput, okResult, type ResultEnvelope } from "@kiero/contracts";
import { ROUTING_CONFIG_VERSION } from "@kiero/providers";
import {
  JOIN_PROMPT_VERSION,
  JOIN_SCHEMA_VERSION,
  MEDIA_WAIT_BUDGET_MS,
  MULTIMODAL_JOIN_PIPELINE_VERSION,
  boundMultimodalGroups,
  decideJoinedCompleteness,
  inputWorthWaiting,
  joinCoverage as joinCoverageOf,
  type AnalysisContext,
  type JoinAnalysisContext,
  type LocatedEvidence,
  type MultimodalPlanningState,
} from "@kiero/agent";
import { workflow } from "../../platform/pipeline";
import { bridgeIdentity, authorSessionId, resolveRequestContext } from "../../platform/context";
import { dispatchMemoryCommand } from "../../memory/findings/dispatch";
import { orderAudioTranscript } from "../audio/orders";
import { loadAnalysisContext } from "../text/analysisContext";
import type { JobExecutor } from "../../platform/executors";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  JOIN_CLARIFICATION_BASE,
  JOIN_CLARIFY_STEP_KIND,
  JOIN_EVALUATE_SEQUENCE,
  JOIN_EVALUATE_STEP_KIND,
  JOIN_LOAD_CONTEXT_SEQUENCE,
  JOIN_PUBLISH_STEP_KIND,
  JOIN_STEP_BASE,
  JOIN_VISION_STEP_OFFSET,
  anchorOfEvidence,
  ensureAnchorFragment,
  initialAnalysisRun,
  recordJoinStep,
} from "./journal";
import {
  loadCompletedTranscriptSegments,
  loadCompletedVisionObservations,
  loadCoverageSourceView,
} from "./coverageLoader";
import { orderVisionExtraction } from "./visionOrders";

/** The model-configuration version label recorded on every join run. */
export const JOIN_MODEL_CONFIGURATION_VERSION =
  `e2.routing/${ROUTING_CONFIG_VERSION}#chat_analysis+vision_extraction`;

// ---------------------------------------------------------------------------
// Stage 1: evaluate media (order STT/vision, compute the joined coverage,
// bounded-wait actively progressing inputs).
// ---------------------------------------------------------------------------

/** The evaluate stage's serializable result (journal-safe). */
export interface EvaluateMediaResult {
  readonly mediaPresent: boolean;
  readonly visionOrderIds: Id<"visionOrders">[];
  readonly completeness: "complete" | "partial_unresolved_inputs" | "blocked_external";
}

/** The evaluate stage mutation (idempotent; orders + records + decides). */
export const evaluateMediaStage = internalMutation({
  args: { runId: v.id("processingRuns") },
  returns: v.any(),
  handler: async (ctx, args): Promise<EvaluateMediaResult> => {
    const run = await ctx.db.get(args.runId);
    if (run === null) {
      throw new Error("join: run row missing");
    }
    const source = await ctx.db.get(run.sourceId);
    if (source === null) {
      throw new Error("join: source row missing");
    }
    if (source.lifecycle !== "active") {
      await recordJoinStep(ctx.db, args.runId, JOIN_EVALUATE_SEQUENCE, JOIN_EVALUATE_STEP_KIND, {
        state: "failed",
        output: { error: "source_not_active" },
      });
      throw new Error("join: source no longer active");
    }

    // --- order STT for audio attachments without any order (D6 seam) -----
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_source", (q) => q.eq("sourceId", source._id))
      .collect();
    const mediaAttachments = attachments.filter(
      (attachment) => attachment.kind === "audio" || attachment.kind === "image",
    );
    if (mediaAttachments.length === 0) {
      // Text-only source: E3's analyze owns it; the join has nothing to do.
      await recordJoinStep(ctx.db, args.runId, JOIN_EVALUATE_SEQUENCE, JOIN_EVALUATE_STEP_KIND, {
        state: "succeeded",
        output: { mediaPresent: false },
      });
      return { mediaPresent: false, visionOrderIds: [], completeness: "complete" };
    }
    const session = await authorSessionId(ctx.db, source.authorUserId);
    const requestContext =
      session === null
        ? null
        : await resolveRequestContext(ctx.db, bridgeIdentity(session, Date.now()));
    for (const attachment of mediaAttachments) {
      if (attachment.kind !== "audio") {
        continue;
      }
      const orders = await ctx.db
        .query("audioTranscripts")
        .withIndex("by_attachment", (q) => q.eq("attachmentId", attachment._id))
        .collect();
      if (orders.length === 0 && requestContext !== null) {
        await orderAudioTranscript(ctx, requestContext, {
          attachmentId: attachment._id,
          bytesChannel: "media_worker",
        });
      }
    }

    // --- auto-order vision for retained representations without one ------
    if (requestContext !== null) {
      for (const input of (await loadCoverageSourceView(ctx.db, source._id)).imageInputs) {
        if (input.representationId === null) {
          continue;
        }
        const representationId = ctx.db.normalizeId(
          "mediaRepresentations",
          input.representationId,
        );
        if (representationId === null) {
          continue;
        }
        const existing = await ctx.db
          .query("visionOrders")
          .withIndex("by_representation", (q) => q.eq("representationId", representationId))
          .collect();
        if (existing.length === 0) {
          await orderVisionExtraction(ctx, requestContext, {
            attachmentId: input.attachmentId,
            bytesChannel: "media_worker",
          });
        }
      }
    }

    // --- the pure joined coverage ------------------------------------------
    const view = await loadCoverageSourceView(ctx.db, source._id);
    const snapshot = joinCoverageOf(view);
    const completeness = decideJoinedCompleteness(snapshot);
    const visionOrders = await ctx.db
      .query("visionOrders")
      .withIndex("by_source", (q) => q.eq("sourceId", source._id))
      .collect();
    const visionOrderIds = visionOrders
      .filter((order) => order.state === "pending")
      .map((order) => order._id);
    await recordJoinStep(ctx.db, args.runId, JOIN_EVALUATE_SEQUENCE, JOIN_EVALUATE_STEP_KIND, {
      state: "succeeded",
      output: {
        mediaPresent: true,
        completeness,
        inputs: snapshot.inputs,
      },
    });
    return {
      mediaPresent: true,
      visionOrderIds,
      completeness,
    };
  },
});

/** The pure media-status read the bounded wait polls (no writes). */
export const mediaStatusQuery = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const view = await loadCoverageSourceView(ctx.db, args.sourceId);
    const snapshot = joinCoverageOf(view);
    // The wait only covers inputs THIS WORKFLOW cannot complete itself:
    // photo normalization (no retained representation yet) and STT
    // (actively progressing). An image whose representation is ready is
    // completed by the workflow's own vision stage next; blocked and
    // terminal inputs never wait (partial-safe proceeds over them).
    const representationReady = new Set(
      view.imageInputs
        .filter((input) => input.representationId !== null)
        .map((input) => input.attachmentId),
    );
    const waiting = snapshot.inputs.filter((input) => {
      if (!inputWorthWaiting(input)) {
        return false;
      }
      if (input.kind === "image" && input.attachmentId !== null && representationReady.has(input.attachmentId)) {
        return false;
      }
      return true;
    });
    return {
      waiting: waiting.map((input) => input.kind),
    };
  },
});

/**
 * The bounded wait for actively-progressing media (one ACTION, so it may
 * sleep): polls the pure media status until nothing is actively pending or
 * the wall-clock budget runs out — then the caller proceeds partial-safe.
 * Blocked (planning+lastErrorKind) and terminal inputs never wait here.
 */
export const waitForMediaSettled = internalAction({
  args: { sourceId: v.id("sources"), deadlineMs: v.float64() },
  handler: async (ctx, args): Promise<{ waitedOut: boolean }> => {
    for (;;) {
      const status = await ctx.runQuery(internal.processing.multimodal.join.mediaStatusQuery, {
        sourceId: args.sourceId,
      });
      if (status.waiting.length === 0) {
        return { waitedOut: false };
      }
      if (Date.now() >= args.deadlineMs) {
        return { waitedOut: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  },
});

// ---------------------------------------------------------------------------
// Stage 3: load the joined context and pin the run's versions.
// ---------------------------------------------------------------------------

/** The loaded joined context plus company facts the later stages need. */
export interface LoadedJoinResult {
  readonly context: JoinAnalysisContext;
  readonly companyId: string;
  readonly companyDefaultCurrency: string;
}

export const loadJoinedContextStage = internalMutation({
  args: { runId: v.id("processingRuns") },
  returns: v.any(),
  handler: async (ctx, args): Promise<LoadedJoinResult> => {
    const run = await ctx.db.get(args.runId);
    if (run === null) {
      throw new Error("join: run row missing");
    }
    const source = await ctx.db.get(run.sourceId);
    if (source === null) {
      throw new Error("join: source row missing");
    }
    // The join's own version pins (MULTIMODAL_JOIN_PIPELINE_VERSION etc.)
    // are recorded on the join's STEP row and the checkpoint's `join` key —
    // NEVER on the run row's version columns: the initial run is SHARED with
    // E3's text stages (E3 owns the run-level labels it wrote first); a join
    // overwriting them would erase which pipeline produced the text plan.
    const base: AnalysisContext = await loadAnalysisContext(ctx.db, {
      source,
      runId: args.runId,
      runKind: run.kind,
      reanalysisOfRunId: run.reanalysisOfRunId ?? null,
    });
    const view = await loadCoverageSourceView(ctx.db, source._id);
    const snapshot = joinCoverageOf(view);
    const segments = await loadCompletedTranscriptSegments(ctx.db, view);
    const observations = await loadCompletedVisionObservations(ctx.db, view);
    const context: JoinAnalysisContext = {
      base,
      coverage: snapshot,
      transcriptSegments: segments,
      visionObservations: observations,
    };
    const company = await ctx.db.get(source.companyId);
    await recordJoinStep(ctx.db, args.runId, JOIN_LOAD_CONTEXT_SEQUENCE, "e4_load_joined_context", {
      state: "succeeded",
      output: {
        versions: {
          pipeline: MULTIMODAL_JOIN_PIPELINE_VERSION,
          prompt: JOIN_PROMPT_VERSION,
          schema: JOIN_SCHEMA_VERSION,
          modelConfiguration: JOIN_MODEL_CONFIGURATION_VERSION,
        },
        completeness: decideJoinedCompleteness(snapshot),
        inputs: snapshot.inputs,
        transcriptSegments: segments.length,
        visionObservations: observations.length,
      },
    });
    return {
      context,
      companyId: source.companyId,
      companyDefaultCurrency: company?.defaultCurrency ?? "PLN",
    };
  },
});

// ---------------------------------------------------------------------------
// Stage 5: one source-backed clarification with mixed-family anchors.
// ---------------------------------------------------------------------------

export const raiseJoinClarificationStage = internalMutation({
  args: { runId: v.id("processingRuns"), index: v.number(), clarification: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const run = await ctx.db.get(args.runId);
    if (run === null) {
      throw new Error("join: run row missing");
    }
    const source = await ctx.db.get(run.sourceId);
    if (source === null) {
      throw new Error("join: source row missing");
    }
    const draft = args.clarification as {
      question: string;
      evidence: readonly LocatedEvidence[];
      scope: { kind: "company" | "project"; projectId: string | null };
    };
    const sequence = JOIN_CLARIFICATION_BASE + args.index;
    const finish = async (state: "succeeded" | "failed", output: unknown) => {
      await recordJoinStep(ctx.db, args.runId, sequence, JOIN_CLARIFY_STEP_KIND, { state, output });
      return okResult({ outcome: output });
    };
    const fragmentIds: Id<"sourceFragments">[] = [];
    for (const item of draft.evidence) {
      const extractionId = ctx.db.normalizeId("extractions", item.extractionId);
      if (extractionId === null) {
        return finish("failed", { outcome: "failed", error: "extraction_id_invalid" });
      }
      const extraction = await ctx.db.get(extractionId);
      if (extraction === null || extraction.sourceId !== source._id) {
        return finish("failed", { outcome: "failed", error: "extraction_not_in_source" });
      }
      const anchor = anchorOfEvidence(item);
      const fragmentId = await ensureAnchorFragment(ctx.db, source._id, extractionId, anchor);
      fragmentIds.push(fragmentId);
    }
    const session = await authorSessionId(ctx.db, source.authorUserId);
    if (session === null) {
      return finish("failed", { outcome: "failed", error: "actor_session_unavailable" });
    }
    const result = await dispatchMemoryCommand(
      ctx,
      {
        operation: "memory.raiseClarification",
        input: {
          question: draft.question,
          conflictingEvidence: fragmentIds,
          scope:
            draft.scope.kind === "company"
              ? { _tag: "company" }
              : { _tag: "project", projectId: draft.scope.projectId },
        },
        expectedRevisions: [],
      },
      session,
    );
    const outcome =
      result._tag === "ok"
        ? { state: "succeeded" as const, output: { clarificationRaised: true } }
        : { state: "failed" as const, output: { error: result.error.code } };
    return finish(outcome.state, outcome);
  },
});

// ---------------------------------------------------------------------------
// The workflow, its completion hook and the registered executor.
// ---------------------------------------------------------------------------

/** The durable multimodal-join workflow over one mixed source's run. */
export const joinMultimodalWorkflow = workflow
  .define({
    args: {
      jobKey: v.string(),
      runId: v.id("processingRuns"),
      sourceId: v.id("sources"),
    },
    returns: v.object({ stagesCompleted: v.float64() }),
  })
  .handler(async (step, args) => {
    // ORDERING (the partial-safe budget): the evaluate mutation runs FIRST —
    // it is the production orderer of STT and vision orders, so the bounded
    // wait that follows can only make sense over media that is ALREADY
    // progressing. Then the wait (an ACTION, so it may sleep) grants the
    // budget to actively-progressing inputs (photo normalization, STT
    // segments); blocked and terminal inputs never wait. A SECOND evaluate
    // pass afterwards picks up representations that became retained during
    // the wait (idempotent: existing orders replay) and recomputes the
    // pending vision orders the vision stage attempts. The journal keeps
    // the FIRST pass's step record (recordJoinStep never patches a
    // succeeded step); the load-context step that follows records the
    // post-wait coverage the workflow actually consumes.
    const evaluate = await step.runMutation(
      internal.processing.multimodal.join.evaluateMediaStage,
      { runId: args.runId },
    );
    if (!evaluate.mediaPresent) {
      return { stagesCompleted: 1 };
    }
    const wait = await step.runAction(
      internal.processing.multimodal.join.waitForMediaSettled,
      { sourceId: args.sourceId, deadlineMs: Date.now() + MEDIA_WAIT_BUDGET_MS },
      {
        retry: { maxAttempts: 4, initialBackoffMs: 5_000, base: 2 },
      },
    );
    void wait;
    const settled = await step.runMutation(
      internal.processing.multimodal.join.evaluateMediaStage,
      { runId: args.runId },
    );
    let stagesCompleted = 1;
    for (const [index, orderId] of settled.visionOrderIds.entries()) {
      const outcome = await step.runAction(
        internal.processing.multimodal.vision.attemptVisionExtraction,
        { orderId },
        {
          retry: { maxAttempts: 2, initialBackoffMs: 5_000, base: 2 },
        },
      );
      await step.runMutation(internal.processing.multimodal.vision.recordVisionOutcome, {
        orderId,
        outcome,
        stepSequence: JOIN_STEP_BASE + JOIN_VISION_STEP_OFFSET + index,
      });
      stagesCompleted += 1;
    }
    const loaded = await step.runMutation(
      internal.processing.multimodal.join.loadJoinedContextStage,
      { runId: args.runId },
    );
    const plan = await step.runAction(
      internal.processing.multimodal.modelStage.modelJoinStage,
      {
        runId: args.runId,
        loaded: {
          context: loaded.context,
          companyId: loaded.companyId,
          companyDefaultCurrency: loaded.companyDefaultCurrency,
        },
      },
      {
        retry: { maxAttempts: 3, initialBackoffMs: 15_000, base: 2 },
      },
    );
    const state: MultimodalPlanningState = {
      proposals: plan.proposals,
      projectBindings: plan.projectBindings,
      clarifications: plan.clarifications,
    };
    const bounded = boundMultimodalGroups(state, loaded.context);
    const bindingNames = new Map<string, string>();
    for (const binding of plan.projectBindings) {
      if (binding.displayName !== null) {
        bindingNames.set(binding.handle, binding.displayName);
      }
    }
    stagesCompleted += 2;
    for (const [index, clarification] of bounded.clarifications.entries()) {
      await step.runMutation(internal.processing.multimodal.join.raiseJoinClarificationStage, {
        runId: args.runId,
        index,
        clarification: {
          question: clarification.question,
          evidence: clarification.evidence,
          scope: clarification.scope,
        },
      });
      stagesCompleted += 1;
    }
    for (const [index, group] of bounded.groups.entries()) {
      await step.runMutation(internal.processing.multimodal.publish.publishJoinGroupStage, {
        runId: args.runId,
        index,
        group: {
          key: group.key,
          proposals: group.proposals.map((proposal) => ({
            intent: proposal.intent,
            semanticKey: proposal.semanticKey,
            evidence: proposal.evidence,
            replacesFindingId: proposal.replacesFindingId,
            derivesFromFindingIds: proposal.derivesFromFindingIds,
            readConfidence: proposal.readConfidence,
            valueWire: proposal.valueWire,
          })),
          analysisRevisions: group.analysisRevisions,
          waitForMedia: group.waitForMedia,
          ...(group.key.kind === "project" &&
          group.key.projectId !== null &&
          group.key.projectId.startsWith("new:")
            ? { bindingDisplayName: bindingNames.get(group.key.projectId) ?? null }
            : {}),
        },
      });
      stagesCompleted += 1;
    }
    return { stagesCompleted };
  });

/** Records the workflow's terminal outcome on the job and the run. */
export const completeJoinRun = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: v.object({
      jobKey: v.string(),
      runId: v.id("processingRuns"),
      sourceId: v.id("sources"),
    }),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    const succeeded = args.result.kind === "success";
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.context.jobKey))
      .first();
    if (job !== null && job.state !== "succeeded" && job.state !== "cancelled") {
      await ctx.db.patch(job._id, {
        state: succeeded ? "succeeded" : "failed",
        ...(succeeded ? {} : { lastErrorKind: "join_workflow_failed" }),
        updatedAtMs: nowMs,
        finishedAtMs: nowMs,
      });
    }
    // The honest per-source outcome summary. The checkpoint is MERGED, not
    // replaced: the initial run's journal is shared with E3's text stages
    // and D6's segment steps (their summaries keep their keys; mine keeps
    // `join`). The step rows remain the durable record either way.
    const runRow = await ctx.db.get(args.context.runId);
    let checkpoint: Record<string, unknown> = {};
    if (runRow?.checkpoint !== undefined) {
      try {
        const parsed = JSON.parse(runRow.checkpoint) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          checkpoint = parsed as Record<string, unknown>;
        }
      } catch {
        checkpoint = {};
      }
    }
    const steps = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.context.runId))
      .collect();
    const joinSteps = steps
      .filter((row) => row.stepKind.startsWith("e4_"))
      .map((row) => ({ sequence: row.sequence, kind: row.stepKind, state: row.state }));
    const groupOutcomes = joinSteps.filter((row) => row.kind === JOIN_PUBLISH_STEP_KIND);
    // The join's version pins, as recorded by the load-context step (the run
    // row's own labels stay E3's — the initial run is shared).
    const loadStep = steps.find(
      (row) => row.stepKind === "e4_load_joined_context" && row.state === "succeeded",
    );
    let versions: unknown = null;
    if (loadStep?.outputRef !== undefined) {
      try {
        const parsed = JSON.parse(loadStep.outputRef) as { versions?: unknown };
        versions = parsed.versions ?? null;
      } catch {
        versions = null;
      }
    }
    await ctx.db.patch(args.context.runId, {
      // E3's completion owns the shared initial run's terminal state when
      // its analysis already finished; a still-running run gets the join's
      // honest terminal state.
      ...(runRow?.state === "running" ? { state: succeeded ? ("succeeded" as const) : ("failed" as const) } : {}),
      checkpoint: JSON.stringify({
        ...checkpoint,
        join: {
          workflowId: args.workflowId,
          succeeded,
          groups: groupOutcomes,
          steps: joinSteps.length,
          ...(versions === null ? {} : { versions }),
        },
      }),
      ...(runRow?.finishedAtMs === undefined ? { finishedAtMs: nowMs } : {}),
    });
  },
});

/** The registered executor for `processing.join_multimodal`. */
export const joinMultimodalExecutor: JobExecutor = {
  jobKind: "processing.join_multimodal",
  execute: async (ctx, job, input) => {
    const decoded = Schema.decodeUnknownSync(joinMultimodalInput)(input);
    const sourceId = ctx.db.normalizeId("sources", decoded.sourceId);
    if (sourceId === null) {
      return { outcome: "failed", errorKind: "source_id_invalid", retryable: false };
    }
    const source = await ctx.db.get(sourceId);
    if (source === null) {
      return { outcome: "failed", errorKind: "source_missing", retryable: false };
    }
    if (source.lifecycle !== "active") {
      return { outcome: "failed", errorKind: "source_not_active", retryable: false };
    }
    // Text-only sources are E3's analyze alone: the join has nothing to do.
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
      .collect();
    const hasMedia = attachments.some(
      (attachment) => attachment.kind === "audio" || attachment.kind === "image",
    );
    if (!hasMedia) {
      return { outcome: "succeeded" };
    }
    // Resolve the run: the reanalysis kicker's NEW run when handed one,
    // else the source's initial analysis run (D6's anchoring rule).
    let runId = decoded.processingRunId === null
      ? null
      : ctx.db.normalizeId("processingRuns", decoded.processingRunId);
    if (runId === null) {
      runId = await initialAnalysisRun(ctx.db, sourceId);
      if (runId === null) {
        return { outcome: "failed", errorKind: "processing_run_missing", retryable: false };
      }
    }
    const workflowId = await start(
      ctx,
      internal.processing.multimodal.join.joinMultimodalWorkflow,
      { jobKey: job.jobKey, runId, sourceId },
      {
        onComplete: internal.processing.multimodal.join.completeJoinRun,
        context: { jobKey: job.jobKey, runId, sourceId },
        startAsync: true,
      },
    );
    // MERGE the workflow pointer into the run's checkpoint (never replace:
    // the shared initial run's checkpoint already carries E3's keys — an
    // overwrite here would erase the text lane's record).
    const current = await ctx.db.get(runId);
    let existingCheckpoint: Record<string, unknown> = {};
    if (current?.checkpoint !== undefined) {
      try {
        const parsed = JSON.parse(current.checkpoint) as unknown;
        if (typeof parsed === "object" && parsed !== null) {
          existingCheckpoint = parsed as Record<string, unknown>;
        }
      } catch {
        existingCheckpoint = {};
      }
    }
    await ctx.db.patch(runId, {
      checkpoint: JSON.stringify({
        ...existingCheckpoint,
        joinWorkflowId: workflowId,
      }),
    });
    return { outcome: "delegated" };
  },
};

/**
 * Restarts a failed join workflow from its journal (the A3 restart
 * semantics; the probe exposes it for the live evidence).
 */
export async function restartJoinWorkflow(
  ctx: MutationCtx,
  workflowId: WorkflowId,
  target: "evaluate" | "model" | "group",
): Promise<void> {
  await workflow.restart(ctx, workflowId, {
    from:
      target === "evaluate"
        ? internal.processing.multimodal.join.evaluateMediaStage
        : target === "model"
          ? internal.processing.multimodal.modelStage.modelJoinStage
          : internal.processing.multimodal.publish.publishJoinGroupStage,
  });
}
