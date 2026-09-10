/**
 * The `processing.analyze_change_plan` executor and durable analysis
 * workflow (E3): text analysis into checked, durable memory change plans.
 *
 * Composition (issue #37): D1's accepted text sources, C1 project
 * identification, C2's checked publication and E2's chat adapter, staged
 * through the ONE canonical workflow engine (@convex-dev/workflow, the A3
 * seam — this lane replaces the mechanical stage computations behind it):
 *
 * 1. `loadContextStage` (one mutation): the tenant-filtered analysis
 *    context — current findings WITH their revision counters (the
 *    input-revision version the run records), projects, coverage,
 *    bounded recent sources. Patches the run's pipeline/prompt/schema/
 *    model-configuration versions.
 * 2. `modelAnalysisStage` (one action, the external effect): the bounded
 *    agent loop through `runChatTurn` with the three typed tools. Tool
 *    arguments come back DECODED through the declared Effect schemas and
 *    are validated/accumulated by the pure reducer — never executed. Each
 *    provider call records `processingAttempts` rows (observed model,
 *    latency, usage) and a sanitized `integrations.providerCallCompleted`
 *    event.
 * 3. `raiseClarificationStage` (one mutation per question): the
 *    source-backed Sprawa do wyjaśnienia through the checked dispatch —
 *    a correctly raised question is a SUCCESS outcome, not a stuck job;
 *    nothing retries it.
 * 4. `publishGroupStage` (one mutation per bounded group): recheck the
 *    analysis's input revisions against CURRENT counters (mid-run
 *    staleness refuses the group), resolve `new:N` project handles through
 *    C1's `identifyProject`, build source-linked planned revisions with
 *    located text-range fragments, then prepare + publish through C2 with
 *    the analysis revisions as CALLER expectations — the wiring that makes
 *    a stale plan refuse instead of overwriting a newer correction.
 *
 * Crash/replay semantics: every stage records its step idempotently
 * (insert-if-absent on run+sequence); the workflow journal replays
 * completed actions without re-calling the provider; a crash during one
 * group's publication rolls back that group's transaction entirely, and a
 * restart re-executes only unjournaled steps — no duplicate revisions,
 * tasks or intents.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { start, vResultValidator, type WorkflowId } from "@convex-dev/workflow";
import {
  analyzeChangePlanInput,
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
  PLANNING_PROMPT_VERSION,
  PLANNING_SCHEMA_VERSION,
  PLANNING_TOOLS,
  TEXT_ANALYSIS_PIPELINE_VERSION,
  MAX_MODEL_TURNS,
  analysisSystemPrompt,
  applyDecodedCall,
  assistantToolCallsMessage,
  boundPublicationGroups,
  decideGroupPublish,
  emptyPlanningState,
  emptyPlanNudge,
  finalTurnInstruction,
  sourceUserMessage,
  toolResultMessage,
  type AnalysisContext,
  type PlanningState,
} from "@kiero/agent";
import { workflow } from "../../platform/pipeline";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import { dispatchMemoryCommand } from "../../memory/findings/dispatch";
import { identifyProjectEntry, performIdentifyProject } from "../../projects/operations";
import type { JobExecutor } from "../../platform/executors";
import {
  internalMutation,
  internalAction,
  type MutationCtx,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { loadAnalysisContext } from "./analysisContext";

/** The model-configuration version label recorded on every run. */
export const MODEL_CONFIGURATION_VERSION = `e2.routing/${ROUTING_CONFIG_VERSION}#chat_analysis`;

// Stage sequence numbers (the run's resumable stage status).
export const LOAD_CONTEXT_SEQUENCE = 20;
export const MODEL_ANALYSIS_SEQUENCE = 30;
/** Clarification steps start here (one per raised question). */
export const CLARIFICATION_SEQUENCE_BASE = 500;
/** Publication-group steps start here (one per bounded group). */
export const GROUP_SEQUENCE_BASE = 1_000;
/** Failure markers (the A3 crash-proof pattern) live outside the stages. */
export const FAILURE_MARKER_BASE = 100_000;
/** Outcome markers (recorded group failure, no exception) for the isolation proof. */
export const OUTCOME_MARKER_BASE = 200_000;

// ---------------------------------------------------------------------------
// Idempotent step recording (insert-if-absent on run+sequence).
// ---------------------------------------------------------------------------

async function stepRow(
  db: MutationCtx["db"],
  runId: Id<"processingRuns">,
  sequence: number,
) {
  return db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) => q.eq("runId", runId).eq("sequence", sequence))
    .first();
}

/** Whether the armed failure marker exists for one stage index. */
export async function analysisFailureArmed(
  db: MutationCtx["db"],
  runId: Id<"processingRuns">,
  sequence: number,
): Promise<boolean> {
  const marker = await stepRow(db, runId, FAILURE_MARKER_BASE + sequence);
  return marker !== null;
}

/**
 * Whether the armed OUTCOME marker exists for one stage index: unlike the
 * throw marker, this one makes the group's publication fail as a RECORDED
 * OUTCOME (state failed, no exception), so the workflow continues and the
 * independent groups still commit — the deterministic proof of group
 * isolation ("independent groups commit once and failed work stays
 * pending").
 */
export async function analysisOutcomeFailureArmed(
  db: MutationCtx["db"],
  runId: Id<"processingRuns">,
  sequence: number,
): Promise<boolean> {
  const marker = await stepRow(db, runId, OUTCOME_MARKER_BASE + sequence);
  return marker !== null;
}

/** Records one step row idempotently with its outcome payload. */
async function recordStep(
  db: MutationCtx["db"],
  runId: Id<"processingRuns">,
  sequence: number,
  stepKind: string,
  outcome: { state: "succeeded" | "failed"; output: unknown },
): Promise<void> {
  const existing = await stepRow(db, runId, sequence);
  const patch = {
    runId,
    stepKind,
    sequence,
    state: outcome.state,
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
    outputRef: JSON.stringify(outcome.output),
  };
  if (existing === null) {
    await db.insert("processingSteps", patch);
  } else if (existing.state === "running" || existing.state === "pending") {
    await db.patch(existing._id, patch);
  }
}

/**
 * The author session: the agent acts within the source author's firm
 * permissions ("Działa w zakresie uprawnień użytkownika i firmy", issue 8)
 * through a server-resolved session row — never client input, and never a
 * fabricated identity.
 */
async function authorSessionId(
  db: MutationCtx["db"],
  authorUserId: Id<"users">,
): Promise<Id<"sessions"> | null> {
  const session = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", authorUserId))
    .order("desc")
    .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
    .first();
  return session?._id ?? null;
}

/** Finds or creates the text-range fragment for one located quote. */
async function ensureTextRangeFragment(
  db: MutationCtx["db"],
  sourceId: Id<"sources">,
  extractionId: Id<"extractions">,
  startOffset: number,
  endOffset: number,
): Promise<Id<"sourceFragments">> {
  const fragments = await db
    .query("sourceFragments")
    .withIndex("by_extraction", (q) => q.eq("extractionId", extractionId))
    .collect();
  const match = fragments.find(
    (fragment) =>
      fragment.anchor._tag === "text_range" &&
      fragment.anchor.startOffset === startOffset &&
      fragment.anchor.endOffset === endOffset,
  );
  if (match !== undefined) {
    return match._id;
  }
  return db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor: { _tag: "text_range", startOffset, endOffset },
    createdAtMs: Date.now(),
  });
}

/** The text extraction id of one source (D1 guarantees exactly one). */
async function textExtractionOf(
  db: MutationCtx["db"],
  sourceId: Id<"sources">,
): Promise<Id<"extractions"> | null> {
  const row = await db
    .query("extractions")
    .withIndex("by_source_kind", (q) => q.eq("sourceId", sourceId).eq("kind", "text"))
    .first();
  return row?._id ?? null;
}

// ---------------------------------------------------------------------------
// Stage 1: load the tenant-filtered context and pin the run's versions.
// ---------------------------------------------------------------------------

/** The loaded context plus the company facts the later stages need. */
export interface LoadedStageResult {
  readonly context: AnalysisContext;
  readonly companyId: string;
  readonly companyDefaultCurrency: string;
}

export const loadContextStage = internalMutation({
  args: { runId: v.id("processingRuns") },
  returns: v.any(),
  handler: async (ctx, args): Promise<LoadedStageResult> => {
    const run = await ctx.db.get(args.runId);
    if (run === null) {
      throw new Error("analysis: run row missing");
    }
    const source = await ctx.db.get(run.sourceId);
    if (source === null) {
      throw new Error("analysis: source row missing");
    }
    if (source.lifecycle !== "active") {
      await recordStep(ctx.db, args.runId, LOAD_CONTEXT_SEQUENCE, "load_context", {
        state: "failed",
        output: { error: "source_not_active" },
      });
      throw new Error("analysis: source no longer active");
    }
    // The run's version pins (idempotent patches: D1 seeded placeholder
    // versions; the analysis records the real ones exactly once here).
    await ctx.db.patch(args.runId, {
      pipelineVersion: TEXT_ANALYSIS_PIPELINE_VERSION,
      promptVersion: PLANNING_PROMPT_VERSION,
      schemaVersion: PLANNING_SCHEMA_VERSION,
      modelConfigurationVersion: MODEL_CONFIGURATION_VERSION,
    });
    const context = await loadAnalysisContext(ctx.db, {
      source,
      runId: args.runId,
      runKind: run.kind,
      reanalysisOfRunId: run.reanalysisOfRunId ?? null,
    });
    const company = await ctx.db.get(source.companyId);
    await recordStep(ctx.db, args.runId, LOAD_CONTEXT_SEQUENCE, "load_context", {
      state: "succeeded",
      output: {
        projects: context.projects.length,
        findings: context.findings.length,
        pendingSegments: context.coverage.pendingSegments,
        recordedRevisions: context.findings.map((finding) => ({
          findingId: finding.findingId,
          revision: finding.revisionCounter,
        })),
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
// Stage 2: the bounded agent loop through E2's chat adapter.
// ---------------------------------------------------------------------------

/** Records one provider call's attempts (step row + processingAttempts). */
export const recordModelCall = internalMutation({
  args: {
    runId: v.id("processingRuns"),
    turn: v.number(),
    record: v.any(),
    companyId: v.string(),
  },
  handler: async (ctx, args) => {
    let step = await stepRow(ctx.db, args.runId, MODEL_ANALYSIS_SEQUENCE);
    if (step === null) {
      const stepId = await ctx.db.insert("processingSteps", {
        runId: args.runId,
        stepKind: "model_analysis",
        sequence: MODEL_ANALYSIS_SEQUENCE,
        state: "running",
        startedAtMs: Date.now(),
      });
      step = (await ctx.db.get(stepId)) ?? null;
    }
    if (step === null) {
      throw new Error("analysis: model step row missing");
    }
    const attempts = (args.record as { attempts: Record<string, unknown>[] }).attempts;
    let index = 0;
    let highestAttemptNumber = args.turn * 100;
    for (const attempt of attempts) {
      index += 1;
      let attemptNumber = args.turn * 100 + index;
      // A retried action re-executes with the same turn numbers: allocate
      // the next free slot so every REAL provider call keeps its own row.
      while (
        (await ctx.db
          .query("processingAttempts")
          .withIndex("by_step_attempt", (q) =>
            q.eq("stepId", step._id).eq("attempt", attemptNumber),
          )
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
        stepId: step._id,
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
    // One sanitized completion event per provider call (route + observed
    // model + outcome only; deduped by run+turn identity).
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
      // The event dedups per turn AND retry epoch (the highest attempt
      // number this execution allocated).
      dedupKey: `integrations.modelCall:e3:${args.runId}:turn${args.turn}:a${highestAttemptNumber}`,
    });
  },
});

/** Marks the model step finished with its bounded summary. */
export const finalizeModelStep = internalMutation({
  args: { runId: v.id("processingRuns"), summary: v.any() },
  handler: async (ctx, args) => {
    await recordStep(ctx.db, args.runId, MODEL_ANALYSIS_SEQUENCE, "model_analysis", {
      state: "succeeded",
      output: args.summary,
    });
  },
});

/** The bounded agent loop: decoded tool calls accumulate, never execute. */
export const modelAnalysisStage = internalAction({
  args: {
    runId: v.id("processingRuns"),
    loaded: v.any(),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<PlanningState & { turns: number }> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error("analysis: provider_key_not_configured");
    }
    const credentials: OpenRouterCredentials = { apiKey };
    const loaded = args.loaded as LoadedStageResult;
    const context = loaded.context;
    const tools: AnyChatToolSpec[] = PLANNING_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: tool.input,
    }));
    let state = emptyPlanningState();
    const messages: {
      role: "user" | "assistant";
      content: { kind: "text"; text: string }[];
    }[] = [
      {
        role: "user",
        content: [{ kind: "text", text: sourceUserMessage(context) }],
      },
    ];
    let turns = 0;
    let finalText = "";
    const turnLog: {
      turn: number;
      text: string;
      calls: string[];
      results: string[];
    }[] = [];
    while (turns < MAX_MODEL_TURNS) {
      turns += 1;
      if (turns === MAX_MODEL_TURNS) {
        messages.push({
          role: "user",
          content: [{ kind: "text", text: finalTurnInstruction() }],
        });
      }
      const call: ChatCallResult = await runChatTurn(credentials, {
        messages,
        tools,
        systemPrompt: analysisSystemPrompt(),
      });
      await ctx.runMutation(internal.processing.text.analyze.recordModelCall, {
        runId: args.runId,
        turn: turns,
        record: call.record,
        companyId: loaded.companyId,
      });
      if (call.outcome.outcome === "failed") {
        const kind = call.outcome.failure.kind;
        const hasValidatedWork =
          state.proposals.length > 0 || state.clarifications.length > 0;
        if (
          (kind === "output_rejected" || kind === "unknown_tool") &&
          hasValidatedWork
        ) {
          // Malformed provider output after validated work: keep the
          // validated plan (the failed attempt stays recorded); publishing
          // it is safe because every surviving proposal was decoded and
          // context-validated. Partial completion stays visible.
          break;
        }
        throw new Error(`analysis: provider_failed:${kind}`);
      }
      const turn = call.outcome.value;
      finalText = turn.text.slice(0, 600);
      if (turn.toolCalls.length === 0) {
        const empty =
          state.proposals.length === 0 &&
          state.clarifications.length === 0 &&
          state.projectBindings.length === 0;
        if (empty && turns < MAX_MODEL_TURNS) {
          // A text-only turn with an empty plan gets exactly one nudge:
          // text is not a record; tools are the only channel.
          messages.push({
            role: "user",
            content: [{ kind: "text", text: emptyPlanNudge() }],
          });
          continue;
        }
        break; // the model finished its plan
      }
      messages.push({
        role: "assistant",
        content: [{ kind: "text", text: assistantToolCallsMessage(turn.toolCalls) }],
      });
      const turnResults: string[] = [];
      for (const toolCall of turn.toolCalls) {
        const outcome = applyDecodedCall(
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
            { kind: "text", text: toolResultMessage(toolCall.name, outcome.toolResult) },
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
    await ctx.runMutation(internal.processing.text.analyze.finalizeModelStep, {
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
// Stage 3a: clarifications (Sprawa do wyjaśnienia, source-backed).
// ---------------------------------------------------------------------------

export const raiseClarificationStage = internalMutation({
  args: {
    runId: v.id("processingRuns"),
    index: v.number(),
    clarification: v.any(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const run = await ctx.db.get(args.runId);
    if (run === null) {
      throw new Error("analysis: run row missing");
    }
    const source = await ctx.db.get(run.sourceId);
    if (source === null) {
      throw new Error("analysis: source row missing");
    }
    const draft = args.clarification as {
      question: string;
      quotes: { quote: string; startOffset: number; endOffset: number }[];
      scope: { kind: "company" | "project"; projectId: string | null };
    };
    const sequence = CLARIFICATION_SEQUENCE_BASE + args.index;
    const extractionId = await textExtractionOf(ctx.db, source._id);
    if (extractionId === null) {
      await recordStep(ctx.db, args.runId, sequence, "raise_clarification", {
        state: "failed",
        output: { error: "text_extraction_missing" },
      });
      return okResult({ outcome: "failed" });
    }
    const fragmentIds: Id<"sourceFragments">[] = [];
    for (const quote of draft.quotes) {
      fragmentIds.push(
        await ensureTextRangeFragment(
          ctx.db,
          source._id,
          extractionId,
          quote.startOffset,
          quote.endOffset,
        ),
      );
    }
    const session = await authorSessionId(ctx.db, source.authorUserId);
    if (session === null) {
      await recordStep(ctx.db, args.runId, sequence, "raise_clarification", {
        state: "failed",
        output: { error: "actor_session_unavailable" },
      });
      return okResult({ outcome: "failed" });
    }
    // The checked dispatch: the same path, policy and decodes as any boss
    // call; the clarification's conflicting evidence is fragment-typed.
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
    await recordStep(ctx.db, args.runId, sequence, "raise_clarification", outcome);
    return okResult({ outcome });
  },
});

// ---------------------------------------------------------------------------
// Stage 3b: one bounded publication group through C1 identification and
// C2's checked prepare/publish, atomically per group.
// ---------------------------------------------------------------------------

/** The wire shape of one proposal as the workflow hands the group over. */
export interface GroupProposalWire {
  readonly intent: "record" | "correct";
  readonly semanticKey: string;
  readonly evidence: { quote: string; startOffset: number; endOffset: number }[];
  readonly replacesFindingId: string | null;
  readonly derivesFromFindingIds: string[];
  readonly readConfidence: number;
  readonly valueWire: unknown;
}

/** One bounded group handed to the publish stage. */
export interface GroupStageInput {
  readonly key: { kind: "company" | "project"; projectId: string | null };
  readonly proposals: GroupProposalWire[];
  readonly analysisRevisions: { findingId: string; revision: number }[];
  /** The working name for a `new:N` handle (C1 identifies it here). */
  readonly bindingDisplayName?: string | null;
}

export const publishGroupStage = internalMutation({
  args: { runId: v.id("processingRuns"), index: v.number(), group: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const group = args.group as GroupStageInput;
    const sequence = GROUP_SEQUENCE_BASE + args.index;
    const run = await ctx.db.get(args.runId);
    if (run === null) {
      throw new Error("analysis: run row missing");
    }
    const source = await ctx.db.get(run.sourceId);
    if (source === null) {
      throw new Error("analysis: source row missing");
    }
    const finish = async (state: "succeeded" | "failed", output: unknown) => {
      await recordStep(ctx.db, args.runId, sequence, "publish_group", { state, output });
      return okResult({ outcome: output });
    };

    // The deterministic group-isolation proof hook: a recorded failure that
    // does NOT throw, so the workflow continues and independent groups
    // still commit (failed work stays explicit against the source).
    if (await analysisOutcomeFailureArmed(ctx.db, args.runId, sequence)) {
      return finish("failed", { outcome: "failed", error: "probe_injected_group_failure" });
    }

    // Defensive honesty: a group with no textual basis and no derivations
    // claims inspection of nothing — pending, never published.
    if (
      group.proposals.every(
        (proposal) =>
          proposal.evidence.length === 0 && proposal.derivesFromFindingIds.length === 0,
      )
    ) {
      return finish("succeeded", { outcome: "pending_segments", key: group.key });
    }

    // --- resolve the group's scope (C1 identification for `new:N`) -----
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

    // --- the mid-run staleness guard: analysis revisions vs CURRENT -----
    const currentRevisions: Record<string, number> = {};
    for (const expectation of group.analysisRevisions) {
      const findingId = ctx.db.normalizeId("findings", expectation.findingId);
      const finding = findingId === null ? null : await ctx.db.get(findingId);
      if (finding === null || finding.companyId !== source.companyId) {
        continue; // a vanished finding cannot be stale-addressed anyway
      }
      currentRevisions[finding._id] = finding.revisionCounter;
    }
    const decision = decideGroupPublish({
      analysisRevisions: group.analysisRevisions,
      currentRevisions,
    });
    if (decision.decision === "refuse") {
      // A newer correction landed between the analysis and the commit: the
      // plan analyzed a superseded world. Refuse honestly; a linked
      // reanalysis is the only recovery (issue #8 precedence).
      return finish("succeeded", {
        outcome: "stale_refused",
        key: group.key,
        code: decision.code,
      });
    }

    // --- build the source-linked planned revisions (wire form) ---------
    const extractionId = await textExtractionOf(ctx.db, source._id);
    if (extractionId === null) {
      return finish("failed", { outcome: "failed", error: "text_extraction_missing" });
    }
    const plannedRevisions: unknown[] = [];
    for (const proposal of group.proposals) {
      const evidence: {
        sourceId: string;
        fragmentId: string | null;
        supportKind: string;
        extractionId: string;
      }[] = [];
      for (const located of proposal.evidence) {
        const fragmentId = await ensureTextRangeFragment(
          ctx.db,
          source._id,
          extractionId,
          located.startOffset,
          located.endOffset,
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

    // --- C2 prepare + publish through the checked dispatch -------------
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
    // The caller expectations are the ANALYSIS's input revisions: C2's
    // stale-plan guard now protects this plan end-to-end.
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
      const stale =
        kind === "stale_plan" || kind === "caller_expectation_mismatch";
      return finish(stale ? "succeeded" : "failed", {
        outcome: stale ? "stale_refused" : "failed",
        key: group.key,
        error: kind,
      });
    }
    const receipt = published.value as { publishedRevisionIds: Id<"findingRevisions">[] };

    // --- crash-proof hook: the armed marker throws AFTER the writes ----
    if (await analysisFailureArmed(ctx.db, args.runId, sequence)) {
      throw new Error("analysis: injected failure after group publication");
    }
    return finish("succeeded", {
      outcome: "published",
      key: group.key,
      changeSetId: changeSet.changeSetId,
      revisions: receipt.publishedRevisionIds.length,
      ...(scopeProjectId !== null ? { projectId: scopeProjectId } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// The workflow and its executor registration.
// ---------------------------------------------------------------------------

/** The durable text-analysis workflow: resumable stages over one run. */
export const analysisWorkflow = workflow
  .define({
    args: {
      jobKey: v.string(),
      runId: v.id("processingRuns"),
      sourceId: v.id("sources"),
    },
    returns: v.object({ stagesCompleted: v.float64() }),
  })
  .handler(async (step, args) => {
    const loaded = await step.runMutation(internal.processing.text.analyze.loadContextStage, {
      runId: args.runId,
    });
    const plan = await step.runAction(
      internal.processing.text.analyze.modelAnalysisStage,
      {
        runId: args.runId,
        loaded: {
          context: loaded.context,
          companyId: loaded.companyId,
          companyDefaultCurrency: loaded.companyDefaultCurrency,
        },
      },
      // Bounded workflow-level retries over transient provider windows:
      // each retry re-executes the action (one fresh provider attempt per
      // turn), recorded honestly in processingAttempts.
      {
        retry: {
          maxAttempts: 3,
          initialBackoffMs: 15_000,
          base: 2,
        },
      },
    );
    // Pure, deterministic bounding over journaled values: a handler replay
    // recomputes the identical groups.
    const state: PlanningState = {
      proposals: plan.proposals,
      projectBindings: plan.projectBindings,
      clarifications: plan.clarifications,
    };
    const bounded = boundPublicationGroups(state, loaded.context);
    const bindingNames = new Map<string, string>();
    for (const binding of plan.projectBindings) {
      if (binding.displayName !== null) {
        bindingNames.set(binding.handle, binding.displayName);
      }
    }
    let stagesCompleted = 2;
    for (const [index, clarification] of bounded.clarifications.entries()) {
      await step.runMutation(internal.processing.text.analyze.raiseClarificationStage, {
        runId: args.runId,
        index,
        clarification,
      });
      stagesCompleted += 1;
    }
    for (const [index, group] of bounded.groups.entries()) {
      await step.runMutation(internal.processing.text.analyze.publishGroupStage, {
        runId: args.runId,
        index,
        group: {
          key: group.key,
          proposals: group.proposals,
          analysisRevisions: group.analysisRevisions,
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

/** Records the workflow's terminal outcome on the job and run. */
export const completeAnalysisRun = internalMutation({
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
    const succeeded = args.result.kind === "success";
    if (job !== null && job.state !== "succeeded" && job.state !== "cancelled") {
      await ctx.db.patch(job._id, {
        state: succeeded ? "succeeded" : "failed",
        ...(succeeded ? {} : { lastErrorKind: "analysis_workflow_failed" }),
        updatedAtMs: nowMs,
        finishedAtMs: nowMs,
      });
    }
    // The honest per-source outcome summary: committed groups, raised
    // clarifications and the run's segment completeness stay explicit.
    const runRow = await ctx.db.get(args.context.runId);
    const selected_checkpoint = runRow?.checkpoint;
    const steps = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.context.runId))
      .collect();
    const groupOutcomes = steps
      .filter((stepRow_) => stepRow_.stepKind === "publish_group")
      .map((stepRow_) => ({ sequence: stepRow_.sequence, state: stepRow_.state, output: stepRow_.outputRef }));
    const clarified = steps.filter((stepRow_) => stepRow_.stepKind === "raise_clarification").length;
    const loadOutput = steps.find((stepRow_) => stepRow_.stepKind === "load_context")?.outputRef;
    let workflowId: string | null = null;
    if (selected_checkpoint !== undefined) {
      try {
        const parsed = JSON.parse(selected_checkpoint) as { workflowId?: unknown };
        if (typeof parsed.workflowId === "string") {
          workflowId = parsed.workflowId;
        }
      } catch {
        // Non-JSON checkpoint (never produced by this lane); leave null.
      }
    }
    await ctx.db.patch(args.context.runId, {
      state: succeeded ? "succeeded" : "failed",
      checkpoint: JSON.stringify({
        ...(workflowId === null ? {} : { workflowId }),
        groups: groupOutcomes,
        clarified,
        load: loadOutput === undefined ? null : JSON.parse(loadOutput),
      }),
      finishedAtMs: nowMs,
    });
  },
});

/** The registered executor for `processing.analyze_change_plan`. */
export const analyzeChangePlanExecutor: JobExecutor = {
  jobKind: "processing.analyze_change_plan",
  execute: async (ctx, job, input) => {
    // Decode authority: the registry executor schema for this kind.
    const decoded = Schema.decodeUnknownSync(analyzeChangePlanInput)(input);
    const runId = ctx.db.normalizeId("processingRuns", decoded.processingRunId);
    if (runId === null) {
      return { outcome: "failed", errorKind: "processing_run_id_invalid", retryable: false };
    }
    const sourceId = ctx.db.normalizeId("sources", decoded.sourceId);
    if (sourceId === null) {
      return { outcome: "failed", errorKind: "source_id_invalid", retryable: false };
    }
    const workflowId = await start(
      ctx,
      internal.processing.text.analyze.analysisWorkflow,
      { jobKey: job.jobKey, runId, sourceId },
      {
        onComplete: internal.processing.text.analyze.completeAnalysisRun,
        context: { jobKey: job.jobKey, runId },
        startAsync: true,
      },
    );
    // The restart path (probe/GM) needs the workflow identity: record it on
    // the run's checkpoint; the completion summary preserves it.
    await ctx.db.patch(runId, { checkpoint: JSON.stringify({ workflowId }) });
    return { outcome: "delegated" };
  },
};

/**
 * Restarts a failed analysis workflow from its journal, re-executing from
 * the named stage ("model" for provider-window failures, with a fresh
 * bounded step-retry budget; "group" for the publication crash proofs,
 * where journaled earlier stages — including a completed provider action —
 * replay without re-execution). A3 restart semantics.
 */
export async function restartAnalysisWorkflow(
  ctx: MutationCtx,
  workflowId: WorkflowId,
  target: "model" | "group",
): Promise<void> {
  await workflow.restart(ctx, workflowId, {
    from:
      target === "model"
        ? internal.processing.text.analyze.modelAnalysisStage
        : internal.processing.text.analyze.publishGroupStage,
  });
}
