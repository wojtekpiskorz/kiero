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
 *    pending with a sanitized reason, resumable).
 * 3. `loadJoinedContextStage`: E3's tenant-filtered context plus the
 *    joined coverage, the assembled transcript segments and the vision
 *    observations, with the run's version pins.
 * 4. `modelJoinStage` (one ACTION): the bounded agent loop over E2's chat
 *    route with the JOIN tool surface; decoded calls accumulate through
 *    the multimodal reducer — never executed.
 * 5. `raiseJoinClarificationStage` (one mutation per question): the
 *    source-backed Sprawa do wyjaśnienia through C2's checked dispatch,
 *    with mixed-family fragment anchors.
 * 6. `publishJoinGroupStage` (one mutation per bounded group): the
 *    completeness gate against a FRESH coverage read (a mid-run
 *    re-normalization refuses the group — coordinates never move beneath
 *    a published finding), the mid-run staleness guard, per-evidence
 *    fragment ensuring (text ranges, audio intervals, image regions), then
 *    C2 prepare + publish with the analysis revisions as caller
 *    expectations.
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
import {
  joinMultimodalInput,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  ROUTING_CONFIG_VERSION,
  runChatTurn,
  type AnyChatToolSpec,
  type ChatCallResult,
  type OpenRouterCredentials,
} from "@kiero/providers";
import {
  JOIN_PROMPT_VERSION,
  JOIN_SCHEMA_VERSION,
  JOIN_TOOLS,
  MAX_JOIN_MODEL_TURNS,
  MEDIA_WAIT_BUDGET_MS,
  MULTIMODAL_JOIN_PIPELINE_VERSION,
  applyMultimodalCall,
  boundMultimodalGroups,
  decideGroupPublish,
  decideJoinedCompleteness,
  emptyMultimodalState,
  emptyJoinPlanNudge,
  inputWorthWaiting,
  joinAnalysisSystemPrompt,
  joinCoverage as joinCoverageOf,
  joinSourceUserMessage,
  mediaClaimsBackedByCompleteInputs,
  validateImageRegion,
  type AnalysisContext,
  type JoinAnalysisContext,
  type LocatedEvidence,
  type MultimodalFindingProposal,
  type MultimodalPlanningState,
} from "@kiero/agent";
import { workflow } from "../../platform/pipeline";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import { dispatchMemoryCommand } from "../../memory/findings/dispatch";
import { identifyProjectEntry, performIdentifyProject } from "../../projects/operations";
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
  JOIN_CLARIFY_STEP_KIND,
  JOIN_EVALUATE_STEP_KIND,
  JOIN_MODEL_STEP_KIND,
  JOIN_PUBLISH_STEP_KIND,
  JOIN_STEP_BASE,
  JOIN_VISION_STEP_OFFSET,
  ensureAnchorFragment,
  joinStepRow,
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

// Stage sequence numbers inside the E4 keyspace.
export const JOIN_EVALUATE_SEQUENCE = JOIN_STEP_BASE + 1;
export const JOIN_LOAD_CONTEXT_SEQUENCE = JOIN_STEP_BASE + 2;
export const JOIN_MODEL_SEQUENCE = JOIN_STEP_BASE + 3;
/** Clarification steps start here (one per raised question). */
export const JOIN_CLARIFICATION_BASE = JOIN_STEP_BASE + 500;
/** Publication-group steps start here (one per bounded group). */
export const JOIN_GROUP_BASE = JOIN_STEP_BASE + 1_000;

/** E4's own failure/outcome marker bases (the A3 crash-proof pattern). */
export const JOIN_FAILURE_MARKER_BASE = 16_000_000;
export const JOIN_OUTCOME_MARKER_BASE = 17_000_000;

/** Whether the armed THROW marker exists for one stage sequence. */
async function joinFailureMarkerArmed(
  db: MutationCtx["db"],
  runId: Id<"processingRuns">,
  sequence: number,
): Promise<boolean> {
  const rows = await db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) => q.eq("runId", runId).eq("sequence", JOIN_FAILURE_MARKER_BASE + sequence))
    .collect();
  return rows.length > 0;
}

/** Whether the armed OUTCOME marker exists for one stage sequence. */
async function joinOutcomeMarkerArmed(
  db: MutationCtx["db"],
  runId: Id<"processingRuns">,
  sequence: number,
): Promise<boolean> {
  const rows = await db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) => q.eq("runId", runId).eq("sequence", JOIN_OUTCOME_MARKER_BASE + sequence))
    .collect();
  return rows.length > 0;
}

/** The author session: the agent acts within the source author's firm. */
async function authorSessionId(
  db: MutationCtx["db"],
  authorUserId: Id<"users">,
): Promise<Id<"sessions"> | null> {
  const sessions = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", authorUserId))
    .collect();
  const live = sessions
    .filter((session) => session.revokedAtMs === undefined)
    .sort((a, b) => b.startedAtMs - a.startedAtMs);
  return live[0]?._id ?? null;
}

// ---------------------------------------------------------------------------
// Stage 1: evaluate media (order STT/vision, compute the joined coverage,
// bounded-wait actively progressing inputs).
// ---------------------------------------------------------------------------

/** The evaluate stage's serializable result (journal-safe). */
export interface EvaluateMediaResult {
  readonly mediaPresent: boolean;
  readonly visionOrderIds: Id<"visionOrders">[];
  readonly coverageInputs: readonly {
    attachmentId: string | null;
    kind: "text" | "audio" | "image";
    status: string;
    extractionId: string | null;
    representationId: string | null;
    lastErrorKind: string | null;
  }[];
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
      return { mediaPresent: false, visionOrderIds: [], coverageInputs: [], completeness: "complete" };
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
      coverageInputs: snapshot.inputs,
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
// Stage 4: the bounded joined agent loop through E2's chat adapter.
// ---------------------------------------------------------------------------

/** Records one provider call's attempts (step row + processingAttempts). */
export const recordJoinModelCall = internalMutation({
  args: {
    runId: v.id("processingRuns"),
    turn: v.number(),
    record: v.any(),
    companyId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await joinStepRow(ctx.db, args.runId, JOIN_MODEL_SEQUENCE, JOIN_MODEL_STEP_KIND);
    const stepId =
      existing?._id ??
      (await ctx.db.insert("processingSteps", {
        runId: args.runId,
        stepKind: JOIN_MODEL_STEP_KIND,
        sequence: JOIN_MODEL_SEQUENCE,
        state: "running",
        startedAtMs: Date.now(),
      }));
    const attempts = (args.record as { attempts: Record<string, unknown>[] }).attempts;
    let index = 0;
    let highestAttemptNumber = args.turn * 100;
    for (const attempt of attempts) {
      index += 1;
      let attemptNumber = args.turn * 100 + index;
      while (
        (await ctx.db
          .query("processingAttempts")
          .withIndex("by_step_attempt", (q) => q.eq("stepId", stepId).eq("attempt", attemptNumber))
          .first()) !== null
      ) {
        attemptNumber += 1_000;
      }
      highestAttemptNumber = Math.max(highestAttemptNumber, attemptNumber);
      const outcome = attempt.outcome === "succeeded" ? "succeeded" : "failed";
      const model =
        typeof attempt.observedModel === "string"
          ? attempt.observedModel
          : typeof attempt.requestedModel === "string"
            ? attempt.requestedModel
            : null;
      await ctx.db.insert("processingAttempts", {
        stepId: stepId as Id<"processingSteps">,
        attempt: attemptNumber,
        outcome,
        provider: "openrouter",
        ...(model === null ? {} : { model }),
        ...(outcome === "failed" && typeof attempt.failureKind === "string"
          ? { errorKind: attempt.failureKind }
          : {}),
        startedAtMs: typeof attempt.startedAtMs === "number" ? attempt.startedAtMs : Date.now(),
        finishedAtMs: typeof attempt.finishedAtMs === "number" ? attempt.finishedAtMs : Date.now(),
      });
    }
    const success = attempts.find((a) => a.outcome === "succeeded");
    const failure = [...attempts].reverse().find((a) => a.outcome === "failed");
    const named = success ?? failure;
    await ctx.runMutation(internal.integrations.ai.record.recordProviderCall, {
      companyId: args.companyId,
      routeId: "chat_analysis",
      actualModel:
        (typeof named?.observedModel === "string" ? named.observedModel : undefined) ??
        (typeof named?.requestedModel === "string" ? named.requestedModel : undefined) ??
        "unknown",
      outcome: success !== undefined ? "succeeded" : "failed",
      dedupKey: `integrations.modelCall:e4:${args.runId}:turn${args.turn}:a${highestAttemptNumber}`,
    });
  },
});

/** Marks the join model step finished with its bounded summary. */
export const finalizeJoinModelStep = internalMutation({
  args: { runId: v.id("processingRuns"), summary: v.any() },
  handler: async (ctx, args) => {
    await recordJoinStep(ctx.db, args.runId, JOIN_MODEL_SEQUENCE, JOIN_MODEL_STEP_KIND, {
      state: "succeeded",
      output: args.summary,
    });
  },
});

/** The bounded joined agent loop: decoded tool calls accumulate, never execute. */
export const modelJoinStage = internalAction({
  args: { runId: v.id("processingRuns"), loaded: v.any() },
  returns: v.any(),
  handler: async (ctx, args): Promise<MultimodalPlanningState & { turns: number }> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error("join: provider_key_not_configured");
    }
    const credentials: OpenRouterCredentials = { apiKey };
    const loaded = args.loaded as LoadedJoinResult;
    const context = loaded.context;
    const tools: AnyChatToolSpec[] = JOIN_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: tool.input,
    }));
    let state = emptyMultimodalState();
    const messages: {
      role: "user" | "assistant";
      content: { kind: "text"; text: string }[];
    }[] = [
      {
        role: "user",
        content: [{ kind: "text", text: joinSourceUserMessage(context) }],
      },
    ];
    let turns = 0;
    let finalText = "";
    const turnLog: { turn: number; text: string; calls: string[]; results: string[] }[] = [];
    while (turns < MAX_JOIN_MODEL_TURNS) {
      turns += 1;
      const call: ChatCallResult = await runChatTurn(credentials, {
        messages,
        tools,
        systemPrompt: joinAnalysisSystemPrompt(),
      });
      await ctx.runMutation(internal.processing.multimodal.join.recordJoinModelCall, {
        runId: args.runId,
        turn: turns,
        record: call.record,
        companyId: loaded.companyId,
      });
      if (call.outcome.outcome === "failed") {
        const kind = call.outcome.failure.kind;
        const hasValidatedWork =
          state.proposals.length > 0 || state.clarifications.length > 0;
        if ((kind === "output_rejected" || kind === "unknown_tool") && hasValidatedWork) {
          break; // keep the validated partial plan (E3's semantics)
        }
        throw new Error(`join: provider_failed:${kind}`);
      }
      const turn = call.outcome.value;
      finalText = turn.text.slice(0, 600);
      if (turn.toolCalls.length === 0) {
        const empty =
          state.proposals.length === 0 &&
          state.clarifications.length === 0 &&
          state.projectBindings.length === 0;
        if (empty && turns < MAX_JOIN_MODEL_TURNS) {
          messages.push({
            role: "user",
            content: [{ kind: "text", text: emptyJoinPlanNudge() }],
          });
          continue;
        }
        break;
      }
      messages.push({
        role: "assistant",
        content: [
          {
            kind: "text",
            text: turn.toolCalls
              .map((call_) => JSON.stringify({ narzedzie: call_.name, argumenty: call_.arguments }))
              .join("\n"),
          },
        ],
      });
      const turnResults: string[] = [];
      for (const toolCall of turn.toolCalls) {
        const outcome = applyMultimodalCall(
          state,
          context,
          { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
          loaded.companyDefaultCurrency,
        );
        state = outcome.state;
        turnResults.push(outcome.toolResult.slice(0, 200));
        messages.push({
          role: "user",
          content: [
            { kind: "text", text: `WYNIK NARZĘDZIA ${toolCall.name}: ${outcome.toolResult}` },
          ],
        });
      }
      turnLog.push({
        turn: turns,
        text: turn.text.slice(0, 300),
        calls: turn.toolCalls.map((call_) => call_.name),
        results: turnResults,
      });
    }
    await ctx.runMutation(internal.processing.multimodal.join.finalizeJoinModelStep, {
      runId: args.runId,
      summary: {
        turns,
        proposals: state.proposals.length,
        clarifications: state.clarifications.length,
        projects: state.projectBindings.length,
        finalText,
        turnLog,
      },
    });
    return { ...state, turns };
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

/** Rebuilds the fragment anchor of one located evidence item (total per tag). */
function anchorOfEvidence(
  item: LocatedEvidence,
):
  | { _tag: "whole_source" }
  | { _tag: "text_range"; startOffset: number; endOffset: number }
  | { _tag: "audio_interval"; startMs: number; endMs: number }
  | { _tag: "image_region"; x: number; y: number; width: number; height: number } {
  switch (item._tag) {
    case "text_range":
      return { _tag: "text_range", startOffset: item.startOffset, endOffset: item.endOffset };
    case "audio_interval":
      return { _tag: "audio_interval", startMs: item.startMs, endMs: item.endMs };
    case "image_region":
      return {
        _tag: "image_region",
        x: item.region.x,
        y: item.region.y,
        width: item.region.width,
        height: item.region.height,
      };
  }
}

// ---------------------------------------------------------------------------
// Stage 6: one bounded joined publication group through C1 + C2.
// ---------------------------------------------------------------------------

/** The wire shape of one joined proposal as the workflow hands it over. */
export interface JoinGroupProposalWire {
  readonly intent: "record" | "correct";
  readonly semanticKey: string;
  /**
   * Located evidence EXACTLY as the reducer accumulated it (the
   * LocatedEvidence union: image items carry their region NESTED under
   * `region`, never as flat x/y fields — the coordinate-space authority).
   */
  readonly evidence: readonly LocatedEvidence[];
  readonly replacesFindingId: string | null;
  readonly derivesFromFindingIds: readonly string[];
  readonly readConfidence: number;
  readonly valueWire: unknown;
}

/** One bounded joined group handed to the publish stage. */
export interface JoinGroupStageInput {
  readonly key: { kind: "company" | "project"; projectId: string | null };
  readonly proposals: JoinGroupProposalWire[];
  readonly analysisRevisions: { findingId: string; revision: number }[];
  readonly waitForMedia: boolean;
  readonly bindingDisplayName?: string | null;
}

export const publishJoinGroupStage = internalMutation({
  args: { runId: v.id("processingRuns"), index: v.number(), group: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    publishJoinGroupTransaction(ctx, {
      runId: args.runId,
      index: args.index,
      group: args.group,
    }),
});

/** The publish transaction (idempotent by step sequence; testable). */
export async function publishJoinGroupTransaction(
  ctx: MutationCtx,
  params: { runId: Id<"processingRuns">; index: number; group: unknown },
): Promise<ResultEnvelope> {
  const group = params.group as JoinGroupStageInput;
  const sequence = JOIN_GROUP_BASE + params.index;
  const run = await ctx.db.get(params.runId);
  if (run === null) {
    throw new Error("join: run row missing");
  }
  const source = await ctx.db.get(run.sourceId);
  if (source === null) {
    throw new Error("join: source row missing");
  }
  const finish = async (state: "succeeded" | "failed", output: unknown) => {
    await recordJoinStep(ctx.db, params.runId, sequence, JOIN_PUBLISH_STEP_KIND, { state, output });
    return okResult({ outcome: output });
  };

  // The deterministic group-isolation proof hook (E3's pattern).
  if (await joinOutcomeMarkerArmed(ctx.db, params.runId, sequence)) {
    return finish("failed", { outcome: "failed", error: "probe_injected_group_failure" });
  }

  // Partial-safe bounding: a group whose evidence waits for unresolved
  // media claims inspection of nothing — recorded pending, never published.
  if (group.waitForMedia) {
    return finish("succeeded", { outcome: "pending_segments", key: group.key });
  }

  // Defensive honesty against a FRESH coverage read: every evidence
  // extraction must still be a complete input (a mid-run re-normalization
  // or a superseded transcript version refuses the group — coordinates
  // never move beneath a published finding; the recovery is a linked
  // reanalysis, which re-joins onto the newer versions).
  const freshView = await loadCoverageSourceView(ctx.db, source._id);
  const freshCoverage = joinCoverageOf(freshView);
  const wireProposals: MultimodalFindingProposal[] = group.proposals.map((proposal) => ({
    intent: proposal.intent,
    semanticKey: proposal.semanticKey,
    scope:
      group.key.kind === "company"
        ? { kind: "company" }
        : { kind: "project", projectId: group.key.projectId ?? "" },
    valueWire: proposal.valueWire,
    knowledgeStateWire: "known",
    evidence: proposal.evidence,
    replacesFindingId: proposal.replacesFindingId,
    derivesFromFindingIds: [...proposal.derivesFromFindingIds],
    readConfidence: proposal.readConfidence,
  }));
  if (!mediaClaimsBackedByCompleteInputs({ proposals: wireProposals }, freshCoverage)) {
    return finish("succeeded", { outcome: "pending_segments", key: group.key, fresh: true });
  }

    // --- resolve the group's scope (C1 identification for `new:N`) -------
    let scopeProjectId: Id<"projects"> | null = null;
    if (group.key.kind === "project") {
      const handle = group.key.projectId ?? "";
      if (handle.startsWith("new:")) {
        const displayName = group.bindingDisplayName ?? null;
        if (displayName === null || displayName.trim().length === 0) {
          return finish("failed", { outcome: "failed", error: "project_binding_missing" });
        }
        const session = await authorSessionId(ctx.db, source.authorUserId);
        if (session === null) {
          return finish("failed", { outcome: "failed", error: "actor_session_unavailable" });
        }
        const bridgeContext = await resolveRequestContext(
          ctx.db,
          bridgeIdentity(session, Date.now()),
        );
        if (bridgeContext === null) {
          return finish("failed", { outcome: "failed", error: "actor_context_unresolved" });
        }
        const input = Schema.decodeUnknownSync(identifyProjectEntry.input)({
          displayName,
          initialStage: "inquiry",
          clientId: null,
        });
        const identified = await performIdentifyProject(ctx, bridgeContext, input);
        if (identified._tag !== "ok") {
          return finish("failed", { outcome: "failed", error: identified.error.code });
        }
        const created = identified.value as { projectId: string };
        const normalized = ctx.db.normalizeId("projects", created.projectId);
        if (normalized === null) {
          return finish("failed", { outcome: "failed", error: "project_id_unresolvable" });
        }
        scopeProjectId = normalized;
      } else {
        const normalized = ctx.db.normalizeId("projects", handle);
        if (normalized === null) {
          return finish("failed", { outcome: "failed", error: "project_scope_invalid" });
        }
        const project = await ctx.db.get(normalized);
        if (project === null || project.companyId !== source.companyId) {
          return finish("failed", { outcome: "failed", error: "project_scope_not_found" });
        }
        scopeProjectId = normalized;
      }
    }

    // --- the mid-run staleness guard (E3's rule, joined) ------------------
    const currentRevisions: Record<string, number> = {};
    for (const expectation of group.analysisRevisions) {
      const findingId = ctx.db.normalizeId("findings", expectation.findingId);
      const finding = findingId === null ? null : await ctx.db.get(findingId);
      if (finding === null || finding.companyId !== source.companyId) {
        continue;
      }
      currentRevisions[finding._id] = finding.revisionCounter;
    }
    const decision = decideGroupPublish({
      analysisRevisions: group.analysisRevisions,
      currentRevisions,
    });
    if (decision.decision === "refuse") {
      return finish("succeeded", {
        outcome: "stale_refused",
        key: group.key,
        code: decision.code,
      });
    }

    // --- build the source-linked planned revisions with mixed anchors ----
    const plannedRevisions: unknown[] = [];
    for (const proposal of group.proposals) {
      const evidence: {
        sourceId: string;
        fragmentId: string | null;
        supportKind: string;
        extractionId: string;
      }[] = [];
      for (const item of proposal.evidence) {
        const extractionId = ctx.db.normalizeId("extractions", item.extractionId);
        if (extractionId === null) {
          return finish("failed", { outcome: "failed", error: "extraction_id_invalid" });
        }
        const extraction = await ctx.db.get(extractionId);
        if (extraction === null || extraction.sourceId !== source._id) {
          // Cross-tenant or foreign-source extraction: typed refusal.
          return finish("failed", { outcome: "failed", error: "extraction_not_in_source" });
        }
        if (item._tag === "image_region") {
          // The coordinate-space authority: the region must lie inside the
          // representation the extraction row pins.
          const representationId = extraction.representationId;
          if (representationId === undefined) {
            return finish("failed", { outcome: "failed", error: "vision_extraction_unpinned" });
          }
          const representation = await ctx.db.get(representationId);
          if (representation === null) {
            return finish("failed", { outcome: "failed", error: "representation_row_missing" });
          }
          const check = validateImageRegion(item.region, {
            width: representation.width ?? 0,
            height: representation.height ?? 0,
          });
          if (!check.valid) {
            return finish("failed", {
              outcome: "failed",
              error: `image_region_invalid:${check.reason}`,
            });
          }
        }
        const fragmentId = await ensureAnchorFragment(
          ctx.db,
          source._id,
          extractionId,
          anchorOfEvidence(item),
        );
        evidence.push({
          sourceId: source._id,
          fragmentId,
          supportKind: "support",
          extractionId,
        });
      }
      plannedRevisions.push({
        findingId: proposal.replacesFindingId,
        scope:
          scopeProjectId === null
            ? { _tag: "company" }
            : { _tag: "project", projectId: scopeProjectId },
        semanticKey: proposal.semanticKey,
        value: proposal.valueWire,
        knowledgeState: { _tag: "known" },
        effectiveFrom: null,
        evidence,
        derivesFrom: proposal.derivesFromFindingIds,
      });
    }

    // --- C2 prepare + publish through the checked dispatch ---------------
    const session = await authorSessionId(ctx.db, source.authorUserId);
    if (session === null) {
      return finish("failed", { outcome: "failed", error: "actor_session_unavailable" });
    }
    const prepared = await dispatchMemoryCommand(
      ctx,
      {
        operation: "memory.prepareChangeSet",
        input: { sourceId: source._id, plannedRevisions },
        expectedRevisions: [],
      },
      session,
    );
    if (prepared._tag !== "ok") {
      return finish("failed", { outcome: "failed", error: prepared.error.code });
    }
    const changeSet = prepared.value as { changeSetId: Id<"changeSets"> };
    const published = await dispatchMemoryCommand(
      ctx,
      {
        operation: "memory.publishChangeSet",
        input: {
          changeSetId: changeSet.changeSetId,
          expectedRevisions: group.analysisRevisions,
        },
        expectedRevisions: [],
      },
      session,
    );
    if (published._tag !== "ok") {
      const kind = published.error.code;
      const stale = kind === "stale_plan" || kind === "caller_expectation_mismatch";
      return finish(stale ? "succeeded" : "failed", {
        outcome: stale ? "stale_refused" : "failed",
        key: group.key,
        error: kind,
      });
    }
    const receipt = published.value as { publishedRevisionIds: Id<"findingRevisions">[] };

    // --- crash-proof hook: the armed marker throws AFTER the writes ------
    if (await joinFailureMarkerArmed(ctx.db, params.runId, sequence)) {
      throw new Error("join: injected failure after group publication");
    }
    return finish("succeeded", {
      outcome: "published",
      key: group.key,
      changeSetId: changeSet.changeSetId,
      revisions: receipt.publishedRevisionIds.length,
      ...(scopeProjectId !== null ? { projectId: scopeProjectId } : {}),
    });
}

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
    // the wait (idempotent: existing orders replay, the step record takes
    // the latest pass's output) and recomputes the pending vision orders the
    // vision stage attempts.
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
      internal.processing.multimodal.join.modelJoinStage,
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
      await step.runMutation(internal.processing.multimodal.join.publishJoinGroupStage, {
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
      const runs = await ctx.db
        .query("processingRuns")
        .withIndex("by_source_started", (q) => q.eq("sourceId", sourceId))
        .collect();
      const initial = runs.slice().sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
      if (initial === undefined) {
        return { outcome: "failed", errorKind: "processing_run_missing", retryable: false };
      }
      runId = initial._id;
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
          ? internal.processing.multimodal.join.modelJoinStage
          : internal.processing.multimodal.join.publishJoinGroupStage,
  });
}
