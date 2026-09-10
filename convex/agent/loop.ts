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
 *
 * Before an answer is accepted, the staleness recheck compares the run's
 * load-time finding revisions against CURRENT counters: a mid-run
 * correction triggers one bounded refresh (the model re-reads the
 * refreshed state and narrows the answer or asks a clarification), never
 * an answer over a superseded world.
 *
 * The structured answer returns in the command result for company
 * conversation views (H1 renders it; J2/J3 qualify it). Durable
 * answer/tool-attempt record rows need a shared table family that the
 * closed contracts inventory does not declare yet — named prerequisite,
 * see the session report; the clarifications and domain changes this flow
 * produces ARE durable rows through their registered operations.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { runChatTurn, type AnyChatToolSpec, type OpenRouterCredentials } from "@kiero/providers";
import {
  ANSWER_TOOLS,
  MAX_ANSWER_REFRESHES,
  MAX_ANSWER_TURNS,
  ANSWER_PROMPT_VERSION,
  ANSWER_SCHEMA_VERSION,
  ANSWER_TOOLS_VERSION,
  answerRevisionSnapshotOf,
  answerSystemPrompt,
  applyAnswerToolCall,
  assistantToolCallsMessage,
  contextRefreshedNudge,
  emptyAnswerState,
  evidenceSearchResult,
  extendEvidenceLedger,
  finalTurnInstruction,
  noAnswerNudge,
  questionUserMessage,
  recordClarificationRaised,
  recordDomainChange,
  refreshedStateMessage,
  toolResultMessage,
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

/** The answer-flow pipeline version (loop shape, tool routing). */
export const ANSWER_FLOW_PIPELINE_VERSION = "e6.answer/2" as const;

/** The model-configuration version label recorded with every answer. */
export const ANSWER_MODEL_CONFIGURATION_VERSION = "e6.routing#chat_analysis" as const;

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
  readonly turnLog: readonly {
    turn: number;
    calls: string[];
    args: string[];
    results: string[];
  }[];
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
// Stage 2: the bounded answer loop (one action).
// ---------------------------------------------------------------------------

/** One routed tool execution's outcome as the loop sees it. */
interface ExecutionOutcome {
  readonly toolResult: string;
  readonly state: AnswerState;
  readonly done: boolean;
}

/**
 * Extracts text-encoded tool calls (the flash-model fallback shape): when
 * the model writes `{"narzedzie":...,"argumenty":...}` as PROSE instead of
 * a real tool call, the loop still decodes it through the DECLARED tool's
 * schema — the same decode authority, fail-closed on any malformed shape —
 * and hands it to the same reducer/checked paths. No gate is bypassed: an
 * undeclared name or undecodable arguments make this return nothing and the
 * turn stays plain text.
 */
function parseTextToolCalls(text: string): DecodedAnswerCall[] {
  const calls: DecodedAnswerCall[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const marker = text.indexOf('"narzedzie"', cursor);
    if (marker === -1) {
      break;
    }
    // Walk back to the nearest opening brace, forward to its match.
    let start = -1;
    for (let i = marker; i >= 0; i -= 1) {
      if (text[i] === "{") {
        start = i;
        break;
      }
      if (text[i] === "}") {
        break; // a closer before an opener: not an object start
      }
    }
    if (start === -1) {
      cursor = marker + 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) {
        continue;
      }
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      cursor = marker + 1;
      continue;
    }
    cursor = end + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const candidate = parsed as { narzedzie?: unknown; argumenty?: unknown };
    if (typeof candidate.narzedzie !== "string") {
      continue;
    }
    const spec = ANSWER_TOOLS.find((tool) => tool.name === candidate.narzedzie);
    if (spec === undefined) {
      continue; // undeclared name: stays text, never widens the surface
    }
    try {
      const arguments_ = Schema.decodeUnknownSync(spec.input)(candidate.argumenty);
      calls.push({ id: `text-${calls.length}`, name: spec.name, arguments: arguments_ });
    } catch {
      // Malformed arguments: the call stays unexecutable (fail closed).
    }
  }
  return calls;
}

/**
 * Runs one internal mutation defensively: a thrown technical error (id
 * validation, transient storage) becomes a REFUSAL tool result the model
 * can act on instead of failing the whole answer action. Checked-domain
 * refusals arrive as result envelopes and never throw here.
 */
async function tryMutation<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await run() };
  } catch {
    return { ok: false };
  }
}

/**
 * Unwraps one `ResultEnvelope` returned by a checked-execution mutation:
 * the envelope itself (not its fields) is what `runMutation` hands back.
 */
function envelopeValue<T>(result: unknown): { ok: true; value: T } | { ok: false } {
  if (
    typeof result === "object" &&
    result !== null &&
    "_tag" in result &&
    (result as { _tag: unknown })._tag === "ok" &&
    "value" in result
  ) {
    return { ok: true, value: (result as { value: T }).value };
  }
  return { ok: false };
}

/** Runs the search tool: tenant-scoped candidates, never truth. */
async function runEvidenceSearch(
  ctx: ActionCtx,
  context: AnswerContext,
  state: AnswerState,
  args: { query: string; projectId: string | null },
): Promise<ExecutionOutcome> {
  const result = await ctx.runQuery(internal.agent.evidence.searchEvidenceRows, {
    questionSourceId: context.question.sourceId as Id<"sources">,
    query: args.query,
    ...(args.projectId === null
      ? {}
      : { projectId: args.projectId as Id<"projects"> }),
  });
  const envelope = result as {
    value?: {
      hits?: {
        sourceId: string;
        sourceSentAtMs: number;
        startOffset: number;
        endOffset: number;
        quote: string;
        existingFragmentId: string | null;
      }[];
    };
  };
  const hits = envelope.value?.hits;
  const base = state.evidence.length;
  const entries: AnswerEvidenceEntry[] = (hits ?? []).map((hit, index) => ({
    evidenceId: `ev${base + index + 1}`,
    sourceId: hit.sourceId,
    sourceSentAtMs: hit.sourceSentAtMs,
    fragmentId: hit.existingFragmentId,
    quote: hit.quote,
    startOffset: hit.startOffset,
    endOffset: hit.endOffset,
    groundsFindingId: null,
    groundsUpdating: false,
  }));
  const extended = extendEvidenceLedger(state, entries);
  return {
    state: extended.state,
    toolResult: evidenceSearchResult(extended.accepted),
    done: false,
  };
}

/** Runs one write tool through its checked execution mutation. */
async function runCheckedExecution(
  ctx: ActionCtx,
  context: AnswerContext,
  state: AnswerState,
  call: DecodedAnswerCall,
): Promise<ExecutionOutcome> {
  const questionSourceId = context.question.sourceId as Id<"sources">;
  switch (call.name) {
    case "agent_ask_clarification": {
      const args = call.arguments as {
        question: string;
        evidenceIds: string[];
        scopeKind: "company" | "project";
        projectId: string | null;
      };
      const evidence = args.evidenceIds
        .map((evidenceId) =>
          state.evidence.find((entry) => entry.evidenceId === evidenceId),
        )
        .filter((entry): entry is AnswerEvidenceEntry => entry !== undefined)
        .map((entry) => ({
          sourceId: entry.sourceId as Id<"sources">,
          ...(entry.fragmentId === null
            ? {}
            : { fragmentId: entry.fragmentId as Id<"sourceFragments"> }),
          ...(entry.startOffset === null ? {} : { startOffset: entry.startOffset }),
          ...(entry.endOffset === null ? {} : { endOffset: entry.endOffset }),
        }));
      const executed = await tryMutation(() =>
        ctx.runMutation(internal.agent.execute.executeClarification, {
          questionSourceId,
          question: args.question,
          scopeKind: args.scopeKind,
          ...(args.scopeKind === "project" && args.projectId !== null
            ? { projectId: args.projectId as Id<"projects"> }
            : {}),
          evidence,
        }),
      );
      if (!executed.ok) {
        return {
          state,
          toolResult: "ODRZUCONO: wykonanie sprawy do wyjaśnienia nie powiodło się (błąd techniczny)",
          done: false,
        };
      }
      const unwrapped = envelopeValue<{
        outcome?: string;
        clarificationId?: string;
        error?: string;
      }>(executed.value);
      if (!unwrapped.ok) {
        return {
          state,
          toolResult: "ODRZUCONO: wykonanie sprawy do wyjaśnienia nie powiodło się (błąd techniczny)",
          done: false,
        };
      }
      const envelope = unwrapped.value;
      if (envelope.outcome !== "raised" || envelope.clarificationId === undefined) {
        return {
          state,
          toolResult: `ODRZUCONO: sprawa do wyjaśnienia nie została zapisana (${envelope.error ?? envelope.outcome ?? "nieznany błąd"})`,
          done: false,
        };
      }
      return {
        state: recordClarificationRaised(state, {
          clarificationId: envelope.clarificationId,
          question: args.question,
        }),
        toolResult: `SPRAWA DO WYJAŚNIENIA zapisana (${envelope.clarificationId}); wspólna dla uprawnionych szefów. Pytanie zastępuje odpowiedź — możesz zakończyć bez agent_submit_answer.`,
        done: false,
      };
    }
    case "agent_resolve_clarification": {
      const args = call.arguments as { clarificationId: string; resolutionNote: string };
      const executed = await tryMutation(() =>
        ctx.runMutation(internal.agent.execute.executeResolveClarification, {
          questionSourceId,
          clarificationId: args.clarificationId as Id<"clarifications">,
          resolutionNote: args.resolutionNote,
        }),
      );
      if (!executed.ok) {
        return {
          state,
          toolResult: "ODRZUCONO: wykonanie rozstrzygnięcia nie powiodło się (błąd techniczny)",
          done: false,
        };
      }
      const unwrapped = envelopeValue<{ outcome?: string; error?: string }>(executed.value);
      const envelope = unwrapped.ok ? unwrapped.value : { outcome: "technical_error" };
      return {
        state,
        toolResult:
          envelope.outcome === "resolved"
            ? "Sprawa rozstrzygnięta; notatka zapisana z autorem."
            : `ODRZUCONO: rozstrzygnięcie nie powiodło się (${envelope.error ?? envelope.outcome ?? "nieznany błąd"})`,
        done: false,
      };
    }
    case "agent_change_task":
    case "agent_change_event": {
      const kind = call.name === "agent_change_task" ? "task" : "event";
      const executed = await tryMutation(() =>
        ctx.runMutation(internal.agent.execute.executeWorkChange, {
          questionSourceId,
          kind,
          input: call.arguments,
        }),
      );
      if (!executed.ok) {
        return {
          state,
          toolResult: "ODRZUCONO: wykonanie zmiany nie powiodło się (błąd techniczny)",
          done: false,
        };
      }
      const unwrapped = envelopeValue<{
        outcome?: string;
        entityId?: string;
        revision?: number;
        error?: string;
      }>(executed.value);
      if (!unwrapped.ok) {
        return {
          state,
          toolResult: "ODRZUCONO: wykonanie zmiany nie powiodło się (błąd techniczny)",
          done: false,
        };
      }
      const envelope = unwrapped.value;
      if (envelope.outcome !== "changed" || envelope.entityId === undefined) {
        return {
          state,
          toolResult: `ODRZUCONO: zmiana odrzucona przez sprawdzone reguły (${envelope.error ?? envelope.outcome ?? "nieznany błąd"}); popraw argumenty albo zapytaj szefów`,
          done: false,
        };
      }
      return {
        state: recordDomainChange(state, {
          kind,
          operation: kind === "task" ? "work.changeTask" : "work.changeEvent",
          entityId: envelope.entityId,
          revision: envelope.revision ?? 1,
        }),
        toolResult: `WYKONANO: ${kind === "task" ? "zadanie" : "zdarzenie"} ${envelope.entityId} (rewizja ${envelope.revision ?? 1}) przez sprawdzone reguły.`,
        done: false,
      };
    }
    case "agent_validate_extension_value": {
      const args = call.arguments as { versionId: string; value: unknown };
      const executed = await tryMutation(() =>
        ctx.runMutation(internal.agent.execute.executeExtensionValidate, {
          questionSourceId,
          versionId: args.versionId as Id<"extensionVersions">,
          value: args.value,
        }),
      );
      if (!executed.ok) {
        return {
          state,
          toolResult: "ODRZUCONO: wykonanie walidacji nie powiodło się (błąd techniczny)",
          done: false,
        };
      }
      const unwrapped = envelopeValue<{ outcome?: string; error?: string }>(executed.value);
      const envelope = unwrapped.ok ? unwrapped.value : { outcome: "technical_error" };
      return {
        state,
        toolResult:
          envelope.outcome === "valid"
            ? "Wartość przechodzi walidację definicji."
            : `ODRZUCONO: wartość nie przechodzi walidacji (${envelope.error ?? envelope.outcome ?? "nieznany błąd"})`,
        done: false,
      };
    }
    default:
      return {
        state,
        toolResult: `ODRZUCONO: narzędzie ${call.name} nie jest wykonywalne`,
        done: false,
      };
  }
}

// ---------------------------------------------------------------------------
// The bounded answer loop (round-resumable core + driving wrappers).
// ---------------------------------------------------------------------------

/** One replayed message turn in the wire shape both halves understand. */
export interface AnswerMessageWire {
  readonly role: "user" | "assistant";
  readonly content: readonly { kind: "text"; text: string }[];
}

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
  readonly turnLog: readonly {
    turn: number;
    calls: string[];
    args: string[];
    results: string[];
  }[];
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("agent: provider_key_not_configured");
  }
  const credentials: OpenRouterCredentials = { apiKey };
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
  messages.push({
    role: "assistant",
    content: [
      { kind: "text", text: assistantToolCallsMessage(activeCalls) },
    ],
  });
  const results: string[] = [];
  let done = false;
  for (const toolCall of activeCalls) {
    const decoded: DecodedAnswerCall = {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    };
    let outcome: ExecutionOutcome;
    if (toolCall.name === "agent_search_evidence") {
      outcome = await runEvidenceSearch(
        ctx,
        context,
        state,
        toolCall.arguments as { query: string; projectId: string | null },
      );
    } else if (toolCall.name === "agent_submit_answer") {
      // The staleness recheck FIRST: an answer over a superseded world is
      // refused and the model re-reads the refreshed state (bounded once).
      const recheck = await tryMutation(() =>
        ctx.runMutation(internal.agent.execute.stalenessRecheck, {
          questionSourceId,
          loadRevisions: answerRevisionSnapshotOf(context).map((entry) => ({
            findingId: entry.findingId as Id<"findings">,
            revision: entry.revision,
          })),
        }),
      );
      const decision = recheck.ok
        ? (recheck.value as {
            decision: { decision: string; moved?: { findingId: string }[] };
          }).decision
        : { decision: "current" };
      if (decision.decision === "refresh" && refreshes < MAX_ANSWER_REFRESHES) {
        const refreshed = await ctx.runMutation(internal.agent.loop.loadAnswerStage, {
          questionSourceId,
          runId: current.runId,
        });
        const refreshedStage = refreshed as { context?: AnswerContext; error?: string };
        if (refreshedStage.context !== undefined) {
          context = refreshedStage.context;
          messages.push({
            role: "user",
            content: [
              {
                kind: "text",
                text: `${contextRefreshedNudge(
                  (decision.moved ?? []).map((moved) => moved.findingId),
                )}\n\n${refreshedStateMessage(context)}`,
              },
            ],
          });
          results.push(
            "ODRZUCONO: kontekst się zmienił — odświeżono stan, złóż odpowiedź ponownie.",
          );
          turnLog.push({
            turn: turns,
            calls: activeCalls.map((c) => c.name),
            args: activeCalls.map((c) => JSON.stringify(c.arguments).slice(0, 120)),
            results,
          });
          refreshes += 1;
          return { kind: "continue", next: nextState() };
        }
      }
      outcome = applyAnswerToolCall(state, context, decoded);
    } else {
      // Validation against the tenant-filtered context, then the checked
      // execution — an agent plan is untrusted input at both seams.
      const validated = applyAnswerToolCall(state, context, decoded);
      if (validated.toolResult.startsWith("ODRZUCONO")) {
        outcome = validated;
      } else {
        outcome = await runCheckedExecution(ctx, context, validated.state, decoded);
      }
    }
    state = outcome.state;
    results.push(outcome.toolResult.slice(0, 300));
    done = done || outcome.done;
    messages.push({
      role: "user",
      content: [
        { kind: "text", text: toolResultMessage(toolCall.name, outcome.toolResult) },
      ],
    });
  }
  turnLog.push({
    turn: turns,
    calls: activeCalls.map((c) => c.name),
    args: activeCalls.map((c) => JSON.stringify(c.arguments).slice(0, 120)),
    results,
  });
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
    turnLog: readonly { turn: number; calls: string[]; args: string[]; results: string[] }[];
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
