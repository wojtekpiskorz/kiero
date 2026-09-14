/**
 * The bounded answer loop and the public answer entry (E6): a boss's
 * question source routed through the agent with typed tools.
 *
 * Composition (issue #40): D1's accepted question source, C2-C4's checked
 * operations, C5's updating gate (applied by the context loader), E2's
 * chat adapter (`runChatTurn`, the application-owned model route with no
 * user or GM selector) and the E3 loop convention (decoded tool calls,
 * deterministic turn encoding, bounded turns).
 *
 * The loop is an ACTION (the external effect is the provider call); every
 * write tool executes through ONE internal mutation that runs the checked
 * domain path with the question author's server-resolved session — the
 * agent plan is untrusted input everywhere: decoded by the adapter,
 * re-validated against the tenant-filtered context by the pure reducer,
 * and finally executed by the same checked cores the UI dispatches.
 * `dispatchAnswerToolCall` (the tool-execution half, extracted to
 * ./toolExecution.ts by R14 behind its existing typed contracts) owns the
 * routing of every declared tool name through these halves; a tool
 * declared in the vocabulary but absent from that dispatch is dead and
 * fails the routing test.
 *
 * Before an answer is accepted, the staleness recheck compares the run's
 * load-time finding revisions against CURRENT counters: a mid-run
 * correction triggers one bounded refresh (the model re-reads the
 * refreshed state and narrows the answer or asks a clarification), never
 * an answer over a superseded world. The gate refuses by default: a
 * vanished question world, a recheck or reload that fails, and a spent
 * refresh budget all refuse the submit; accept only follows a recheck
 * that ran and said current.
 *
 * The structured answer returns in the command result for company
 * conversation views (H1 renders it; J2/J3 qualify it). Durable
 * answer/tool-attempt record rows need a shared table family that the
 * closed contracts inventory does not declare yet — named prerequisite,
 * see the session report; the clarifications and domain changes this flow
 * produces ARE durable rows through their registered operations.
 */

import { v } from "convex/values";
import {
  ROUTING_CONFIG_VERSION,
  runChatTurn,
  type AnyChatToolSpec,
  type ChatTurnCredentials,
} from "@kiero/providers";
import {
  ANSWER_TOOLS,
  MAX_ANSWER_TURNS,
  ANSWER_PROMPT_VERSION,
  ANSWER_SCHEMA_VERSION,
  ANSWER_TOOLS_VERSION,
  answerSystemPrompt,
  emptyAnswerState,
  finalTurnInstruction,
  noAnswerNudge,
  parseTextToolCalls,
  questionUserMessage,
  type AnswerContext,
  type AnswerEvidenceEntry,
  type AnswerState,
  type DecodedAnswerCall,
  type SubmittedAnswer,
} from "@kiero/agent/tools";
import { internal } from "../_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { resolveAccessContextFromConvexAuth } from "../access/identity/resolution";
import { loadAnswerContext } from "./context";
import { dispatchAnswerToolCall } from "./toolExecution";

// The tool-execution half keeps its loop.ts export surface (the routing
// tests and any sibling import the seam from here); the implementation
// moved to ./toolExecution.ts unchanged (R14, issue #187).
export {
  dispatchAnswerToolCall,
  type DispatchedAnswerCall,
  type ExecutionOutcome,
} from "./toolExecution";

/**
 * The answer-flow pipeline version (loop shape, tool routing). Bumped to
 * e6.answer/3 by the E8 coordinated lane: the loop's recorded wire
 * encoding changed from prose renderings to NATIVE tool rounds, which
 * changes how recorded runs are interpreted (versions promise
 * interpretability against the flow that produced each answer).
 */
export const ANSWER_FLOW_PIPELINE_VERSION = "e6.answer/3" as const;

/**
 * The model-configuration version label recorded with every answer,
 * composed exactly the way E3's analyze.ts composes its label: the routing
 * namespace plus the frozen routing configuration version, so the label
 * follows every routing change (E8 moved the chat route to direct
 * DeepSeek with the authorized fallback, e8.0) without a coordinated loop
 * edit.
 */
export const ANSWER_MODEL_CONFIGURATION_VERSION =
  `e2.routing/${ROUTING_CONFIG_VERSION}#chat_analysis` as const;

/** One turn's execution log entry: tool names, bounded args, results. */
export interface TurnLogEntry {
  readonly turn: number;
  readonly calls: string[];
  readonly args: string[];
  readonly results: string[];
}

/** The wire result of one answer run (v.any()-shaped on the boundary). */
export interface AnswerRunResult {
  readonly versions: {
    readonly pipeline: string;
    readonly tools: string;
    readonly prompt: string;
    readonly schema: string;
    readonly modelConfiguration: string;
  };
  readonly outcome: "answered" | "clarified" | "gave_up" | "provider_failed";
  readonly answer: SubmittedAnswer | null;
  readonly clarificationsRaised: readonly {
    clarificationId: string;
    question: string;
  }[];
  readonly changes: readonly {
    kind: "task" | "event";
    operation: string;
    entityId: string;
    revision: number;
  }[];
  readonly evidence: readonly AnswerEvidenceEntry[];
  readonly turns: number;
  readonly refreshes: number;
  readonly observedModels: readonly string[];
  readonly finalText: string;
  /** The E2 failure kind, recorded only on a provider_failed run. */
  readonly failure?: string;
  readonly turnLog: readonly TurnLogEntry[];
}

// ---------------------------------------------------------------------------
// Stage 1: load the tenant-filtered context (one mutation).
// ---------------------------------------------------------------------------

export const loadAnswerStage = internalMutation({
  args: { questionSourceId: v.id("sources"), runId: v.string() },
  returns: v.any(),
  handler: async (ctx, args): Promise<{ context: AnswerContext } | { error: string }> => {
    const source = await ctx.db.get(args.questionSourceId);
    if (source === null) {
      return { error: "question_source_missing" };
    }
    const context = await loadAnswerContext(ctx.db, {
      source,
      runId: args.runId,
      nowMs: Date.now(),
    });
    if (context === null) {
      return { error: "question_source_not_active" };
    }
    return { context };
  },
});

// ---------------------------------------------------------------------------
// Stage 2: the bounded answer loop (one action). The tool-execution half
// (ExecutionOutcome, the search/checked-execution runners, the staleness
// gate and dispatchAnswerToolCall) lives in ./toolExecution.ts since R14;
// this file keeps the round-resumable core and the driving wrappers.
// ---------------------------------------------------------------------------

/** Encodes one turn's log entry (the TurnLogEntry wire shape). */
function turnLogEntry(
  turn: number,
  calls: readonly DecodedAnswerCall[],
  results: readonly string[],
): TurnLogEntry {
  return {
    turn,
    calls: calls.map((call) => call.name),
    args: calls.map((call) => JSON.stringify(call.arguments).slice(0, 120)),
    results: [...results],
  };
}

/**
 * One replayed message turn in the wire shape both halves understand
 * (E8: native tool rounds instead of prose renderings, so a multi-turn
 * loop replays identically on the direct DeepSeek transport and the
 * OpenRouter fallback).
 */
export type AnswerMessageWire =
  | { readonly role: "user" | "assistant"; readonly content: readonly { kind: "text"; text: string }[] }
  | {
      readonly role: "assistant-tool-calls";
      readonly calls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[];
    }
  | {
      readonly role: "tool-result";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
    };

/** The JSON-serializable between-rounds state of one answer run. */
export interface AnswerRoundState {
  readonly runId: string;
  readonly context: AnswerContext;
  readonly state: AnswerState;
  readonly messages: readonly AnswerMessageWire[];
  readonly turns: number;
  readonly refreshes: number;
  readonly finalText: string;
  readonly observedModels: readonly string[];
  readonly turnLog: readonly TurnLogEntry[];
}

/** One round's outcome: the next resumable state, or the finished result. */
export type AnswerRoundOutcome =
  | { readonly kind: "continue"; readonly next: AnswerRoundState }
  | { readonly kind: "done"; readonly result: AnswerRunResult };

/** Loads the context and seeds the first round's state. */
export async function startAnswerRun(
  ctx: ActionCtx,
  questionSourceId: Id<"sources">,
): Promise<AnswerRoundState> {
  const runId = `e6-${questionSourceId}-${Date.now()}`;
  const loaded = await ctx.runMutation(internal.agent.loop.loadAnswerStage, {
    questionSourceId,
    runId,
  });
  const stage = loaded as { context?: AnswerContext; error?: string };
  if (stage.context === undefined) {
    throw new Error(`agent: ${stage.error ?? "context_load_failed"}`);
  }
  const context = stage.context;
  return {
    runId,
    context,
    state: emptyAnswerState(context),
    messages: [
      {
        role: "user",
        content: [{ kind: "text", text: questionUserMessage(context) }],
      },
    ],
    turns: 0,
    refreshes: 0,
    finalText: "",
    observedModels: [],
    turnLog: [],
  };
}

/**
 * Runs ONE model round of the answer loop: one provider turn through E2's
 * adapter, then every returned tool call executed through its checked path
 * (search query, reducer validation, checked executions, the staleness
 * recheck before an answer lands). Returns the next resumable state, or the
 * finished result. The production loop drives this until done; the guarded
 * proof path may drive it round-by-round so no single synchronous action
 * outlives the transport window (the production shape's honest limit until
 * a durable answer-record family exists — a named prerequisite).
 */
export async function runAnswerRound(
  ctx: ActionCtx,
  questionSourceId: Id<"sources">,
  current: AnswerRoundState,
): Promise<AnswerRoundOutcome> {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey === undefined || openRouterKey === "") {
    throw new Error("agent: provider_key_not_configured:OPENROUTER_API_KEY");
  }
  // E8 split: the answer loop runs on the direct DeepSeek primary route
  // with the authorized OpenRouter fallback, so BOTH keys are required
  // configuration. Names only are reported, never values; a missing key
  // fails fast instead of burning a provider attempt that is doomed to a
  // terminal unauthenticated classification.
  const deepSeekKey = process.env.DEEPSEEK_API_KEY;
  if (deepSeekKey === undefined || deepSeekKey === "") {
    throw new Error("agent: provider_key_not_configured:DEEPSEEK_API_KEY");
  }
  const credentials: ChatTurnCredentials = {
    apiKey: openRouterKey,
    deepseekApiKey: deepSeekKey,
  };
  const tools: AnyChatToolSpec[] = ANSWER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input: tool.input,
  }));
  let context = current.context;
  let state = current.state;
  const messages: AnswerMessageWire[] = [...current.messages];
  const observedModels = [...current.observedModels];
  const turnLog = [...current.turnLog];
  // The turn counter this round runs as (current.turns + 1 once past the
  // budget check; the budget-exhausted finish reports the spent count).
  let turns = current.turns;
  let refreshes = current.refreshes;
  let finalText = current.finalText;

  const finish = (
    forced: AnswerRunResult["outcome"] | null,
    meta: { failure?: string },
  ): AnswerRoundOutcome => ({
    kind: "done",
    result: answerResult(
      forced ??
        (state.submitted !== null
          ? "answered"
          : state.clarificationsRaised.length > 0
            ? "clarified"
            : "gave_up"),
      state,
      {
        turns,
        refreshes,
        observedModels,
        finalText,
        turnLog,
        ...meta,
      },
    ),
  });

  if (current.turns >= MAX_ANSWER_TURNS) {
    return finish(null, {});
  }
  turns = current.turns + 1;
  if (turns === MAX_ANSWER_TURNS) {
    messages.push({
      role: "user",
      content: [{ kind: "text", text: finalTurnInstruction() }],
    });
  }
  const call = await runChatTurn(credentials, {
    messages,
    tools,
    systemPrompt: answerSystemPrompt(),
  });
  if (call.outcome.outcome === "failed") {
    const kind = call.outcome.failure.kind;
    if (
      (kind === "output_rejected" || kind === "unknown_tool") &&
      state.submitted !== null
    ) {
      // Malformed provider output after an accepted answer: the accepted
      // answer stands (the failed attempt is reported in the result).
      return finish(null, {});
    }
    return finish("provider_failed", { failure: kind });
  }
  const turn = call.outcome.value;
  const observed = call.record.attempts.at(-1)?.observedModel;
  if (typeof observed === "string") {
    observedModels.push(observed);
  }
  finalText = turn.text.slice(0, 600);
  const nextState = (): AnswerRoundState => ({
    runId: current.runId,
    context,
    state,
    messages,
    turns,
    refreshes,
    finalText,
    observedModels,
    turnLog,
  });
  // The turn's calls: real tool calls when the model made them, else any
  // text-encoded calls rescued through the same decode authority.
  const activeCalls: DecodedAnswerCall[] =
    turn.toolCalls.length > 0
      ? turn.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        }))
      : parseTextToolCalls(turn.text);
  if (activeCalls.length === 0) {
    if (
      state.submitted === null &&
      state.clarificationsRaised.length === 0 &&
      turns < MAX_ANSWER_TURNS
    ) {
      // Text is not an answer: the nudge repeats until the model uses a
      // tool or the turn budget's final instruction lands (E3 precedent).
      // After a clarification the question REPLACES the answer (prompt
      // rule 8), so a text finish there is a legitimate end.
      messages.push({
        role: "user",
        content: [{ kind: "text", text: noAnswerNudge() }],
      });
      return { kind: "continue", next: nextState() };
    }
    return finish(null, {}); // the model finished after submitting (or the budget is spent)
  }
  // Native tool round: the assistant's calls replay as the provider's own
  // function_call items (not prose), keeping the loop's history portable
  // across the direct and fallback transports (E8).
  messages.push({
    role: "assistant-tool-calls",
    calls: activeCalls.map((call) => ({
      id: call.id,
      name: call.name,
      // Schema-valid by construction: re-serialized from the decoded turn.
      arguments: JSON.stringify(call.arguments),
    })),
  });
  const results: string[] = [];
  let done = false;
  for (const toolCall of activeCalls) {
    const decoded: DecodedAnswerCall = {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    };
    const dispatched = await dispatchAnswerToolCall(
      ctx,
      questionSourceId,
      current.runId,
      context,
      state,
      refreshes,
      decoded,
    );
    if (dispatched.kind === "refresh") {
      // The gate refreshed the context mid-turn: hand the model the
      // refreshed state and continue the run (bounded by the budget).
      context = dispatched.context;
      messages.push({
        role: "user",
        content: [{ kind: "text", text: dispatched.nudge }],
      });
      results.push(dispatched.refreshResult);
      turnLog.push(turnLogEntry(turns, activeCalls, results));
      refreshes += 1;
      return { kind: "continue", next: nextState() };
    }
    const outcome = dispatched.result;
    state = outcome.state;
    results.push(outcome.toolResult.slice(0, 300));
    done = done || outcome.done;
    messages.push({
      role: "tool-result",
      toolCallId: toolCall.id,
      name: toolCall.name,
      content: outcome.toolResult,
    });
  }
  turnLog.push(turnLogEntry(turns, activeCalls, results));
  if (done) {
    return finish(null, {});
  }
  return { kind: "continue", next: nextState() };
}

/**
 * The full bounded answer run over one question source: drives the round
 * core until it finishes (the production shape — one synchronous action).
 */
export async function runAnswerLoop(
  ctx: ActionCtx,
  questionSourceId: Id<"sources">,
): Promise<AnswerRunResult> {
  let current = await startAnswerRun(ctx, questionSourceId);
  for (;;) {
    const outcome = await runAnswerRound(ctx, questionSourceId, current);
    if (outcome.kind === "done") {
      return outcome.result;
    }
    current = outcome.next;
  }
}

/** Assembles the run result envelope. */
function answerResult(
  outcome: AnswerRunResult["outcome"],
  state: AnswerState,
  meta: {
    turns: number;
    refreshes: number;
    observedModels: readonly string[];
    finalText: string;
    turnLog: readonly TurnLogEntry[];
    failure?: string;
  },
): AnswerRunResult {
  return {
    versions: {
      pipeline: ANSWER_FLOW_PIPELINE_VERSION,
      tools: ANSWER_TOOLS_VERSION,
      prompt: ANSWER_PROMPT_VERSION,
      schema: ANSWER_SCHEMA_VERSION,
      modelConfiguration: ANSWER_MODEL_CONFIGURATION_VERSION,
    },
    outcome,
    answer: state.submitted,
    clarificationsRaised: [...state.clarificationsRaised],
    changes: [...state.changes],
    evidence: [...state.evidence],
    turns: meta.turns,
    refreshes: meta.refreshes,
    observedModels: [...meta.observedModels],
    finalText: meta.finalText,
    turnLog: [...meta.turnLog],
    ...(meta.failure === undefined ? {} : { failure: meta.failure }),
  };
}

/** The internal answer-loop action (the guarded proof path calls this). */
export const answerLoopAction = internalAction({
  args: { questionSourceId: v.id("sources") },
  returns: v.any(),
  handler: async (ctx, args) => runAnswerLoop(ctx, args.questionSourceId),
});

// ---------------------------------------------------------------------------
// The public entry: a signed-in boss asks about a source of THEIR company.
// ---------------------------------------------------------------------------

/** The tenant check for the public entry (read-only, Convex Auth identity). */
export const askPermission = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<{ outcome: "ok" | "unauthenticated" | "forbidden" | "missing" }> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) {
      return { outcome: "missing" };
    }
    const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
    if (context === null) {
      return { outcome: "unauthenticated" };
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null || companyId !== source.companyId) {
      return { outcome: "forbidden" };
    }
    return { outcome: "ok" };
  },
});

/**
 * Runs the answer flow for one question source. The caller must be a
 * signed-in member of the source's company (the tenant check); the model
 * route stays application-owned (E2's frozen order, no user or GM
 * selector), and every write the flow performs runs through the checked
 * domain path under the question author's server-resolved firm scope.
 */
export const askAgent = action({
  args: { sourceId: v.id("sources") },
  returns: v.any(),
  handler: async (
    ctx,
    args,
  ): Promise<AnswerRunResult | { outcome: "unauthenticated" | "forbidden" | "missing" }> => {
    const permission = (await ctx.runQuery(internal.agent.loop.askPermission, {
      sourceId: args.sourceId,
    })) as { outcome: "ok" | "unauthenticated" | "forbidden" | "missing" };
    if (permission.outcome !== "ok") {
      return { outcome: permission.outcome };
    }
    return runAnswerLoop(ctx, args.sourceId);
  },
});
