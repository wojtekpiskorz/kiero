/**
 * The answer loop's tool-execution half (extracted from loop.ts
 * as a pure move behind the existing typed contracts): running
 * ONE decoded tool call the loop received from the provider.
 *
 * Three shapes exist and every declared tool must live on one of them (a
 * declared-but-dead tool is a wiring bug the routing test catches):
 *
 * - `agent_search_evidence` and `agent_validate_extension_value` go
 *   STRAIGHT to their Convex executors: the reducer has nothing to
 *   validate them against (the search extends the ledger from query
 *   results; `AnswerContext` carries no extension versions), so reaching
 *   the reducer would be the wiring mistake its default case refuses.
 * - `agent_submit_answer` passes the staleness gate first (refuse,
 *   refresh, or accept), and only an accepted gate hands the call to the
 *   answer-contract reducer.
 * - every checked write is validated by the reducer against the
 *   tenant-filtered context and then executes through its checked Convex
 *   dispatch (an agent plan is untrusted input at both seams). The branch
 *   is on the reducer's structured `refusal` FIELD, never on the
 *   tool-result prose, so a reworded refusal cannot fork the routing.
 *
 * `dispatchAnswerToolCall` is the seam the routing test drives; the loop
 * (./loop.ts) owns the round-state machinery and calls into this module
 * once per decoded call. No logic changed in the extraction.
 */

import {
  SEARCH_EVIDENCE_TOOL,
  SUBMIT_ANSWER_TOOL,
  VALIDATE_EXTENSION_TOOL,
  answerRevisionSnapshotOf,
  applyAnswerToolCall,
  contextRefreshedNudge,
  evidenceSearchResult,
  extendEvidenceLedger,
  planSubmitFreshness,
  recordClarificationRaised,
  recordDomainChange,
  refreshedStateMessage,
  refreshedSubmitStage,
  type AnswerContext,
  type AnswerEvidenceEntry,
  type AnswerFreshnessDecision,
  type AnswerState,
  type DecodedAnswerCall,
} from "@kiero/agent/tools";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { resolveEvidenceHandles } from "./execute";

/** One routed tool execution's outcome as the loop sees it. */
export interface ExecutionOutcome {
  readonly toolResult: string;
  readonly state: AnswerState;
  readonly done: boolean;
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
  // The one mid-run QUERY runs as defensively as every write and both
  // gate mutations: a transient failure becomes the shared technical
  // refusal the model can retry, never a thrown action after durable
  // changes may already have landed.
  const result = await tryMutation(() =>
    ctx.runQuery(internal.agent.evidence.searchEvidenceRows, {
      questionSourceId: context.question.sourceId as Id<"sources">,
      query: args.query,
      ...(args.projectId === null
        ? {}
        : { projectId: args.projectId as Id<"projects"> }),
    }),
  );
  if (!result.ok) {
    return { state, toolResult: technicalExecutionRefusal("wyszukiwania"), done: false };
  }
  const envelope = result.value as {
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

/**
 * The shared technical refusal for one checked execution that never
 * produced an outcome envelope (a thrown technical error, or a malformed
 * envelope the loop cannot read).
 */
function technicalExecutionRefusal(what: string): string {
  return `ODRZUCONO: wykonanie ${what} nie powiodło się (błąd techniczny)`;
}

/**
 * Runs one checked execution and unwraps its result envelope: a thrown
 * technical error (id validation, transient storage) or a malformed
 * envelope becomes the shared technical refusal the model can act on
 * instead of failing the whole answer action; a well-formed envelope
 * reaches the caller for its case-specific outcome check.
 */
async function runExecution<T extends object>(
  run: () => Promise<unknown>,
  what: string,
): Promise<{ ok: true; envelope: T } | { ok: false; toolResult: string }> {
  const executed = await tryMutation(run);
  if (!executed.ok) {
    return { ok: false, toolResult: technicalExecutionRefusal(what) };
  }
  const unwrapped = envelopeValue<T>(executed.value);
  if (!unwrapped.ok) {
    return { ok: false, toolResult: technicalExecutionRefusal(what) };
  }
  return { ok: true, envelope: unwrapped.value };
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
      const executed = await runExecution<{
        outcome?: string;
        clarificationId?: string;
        error?: string;
      }>(
        () =>
          ctx.runMutation(internal.agent.execute.executeClarification, {
            questionSourceId,
            question: args.question,
            scopeKind: args.scopeKind,
            ...(args.scopeKind === "project" && args.projectId !== null
              ? { projectId: args.projectId as Id<"projects"> }
              : {}),
            evidence,
          }),
        "sprawy do wyjaśnienia",
      );
      if (!executed.ok) {
        return { state, toolResult: executed.toolResult, done: false };
      }
      const envelope = executed.envelope;
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
      const args = call.arguments as { clarificationId: string; resolutionNote: string; evidenceIds: string[] };
      // Resolve the cited handles against the run's current
      // evidence ledger — deduplicated, wire-shaped once (the pure mapping
      // lives beside the executor's input type). The reducer already refused
      // unresolved handles; one that vanished anyway refuses honestly.
      const cited = resolveEvidenceHandles(state.evidence, args.evidenceIds);
      if (cited.missingHandle !== null) {
        return {
          state,
          toolResult: `ODRZUCONO: cytowanie ${cited.missingHandle} nie wskazuje dowodu z tej tury (evN)`,
          done: false,
        };
      }
      const executed = await runExecution<{ outcome?: string; error?: string }>(
        () =>
          ctx.runMutation(internal.agent.execute.executeResolveClarification, {
            questionSourceId,
            clarificationId: args.clarificationId as Id<"clarifications">,
            resolutionNote: args.resolutionNote,
            evidence: cited.references,
          }),
        "rozstrzygnięcia",
      );
      if (!executed.ok) {
        return { state, toolResult: executed.toolResult, done: false };
      }
      const envelope = executed.envelope;
      return {
        state,
        toolResult:
          envelope.outcome === "resolved"
            ? "Sprawa rozstrzygnięta; notatka i podstawa źródłowa zapisane z autorem."
            : `ODRZUCONO: rozstrzygnięcie nie powiodło się (${envelope.error ?? envelope.outcome ?? "nieznany błąd"})`,
        done: false,
      };
    }
    case "agent_change_task":
    case "agent_change_event": {
      const kind = call.name === "agent_change_task" ? "task" : "event";
      const executed = await runExecution<{
        outcome?: string;
        entityId?: string;
        revision?: number;
        error?: string;
      }>(
        () =>
          ctx.runMutation(internal.agent.execute.executeWorkChange, {
            questionSourceId,
            kind,
            input: call.arguments,
          }),
        "zmiany",
      );
      if (!executed.ok) {
        return { state, toolResult: executed.toolResult, done: false };
      }
      const envelope = executed.envelope;
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
      const executed = await runExecution<{ outcome?: string; error?: string }>(
        () =>
          ctx.runMutation(internal.agent.execute.executeExtensionValidate, {
            questionSourceId,
            versionId: args.versionId as Id<"extensionVersions">,
            value: args.value,
          }),
        "walidacji",
      );
      if (!executed.ok) {
        return { state, toolResult: executed.toolResult, done: false };
      }
      const envelope = executed.envelope;
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

/** The staleness gate's verdict over one submit attempt. */
type SubmitGate =
  | { readonly kind: "accept" }
  | { readonly kind: "refused"; readonly toolResult: string }
  | {
      readonly kind: "refreshed";
      readonly context: AnswerContext;
      readonly nudge: string;
      readonly refreshResult: string;
    };

/**
 * The staleness gate over one `agent_submit_answer` (the pure decision
 * work lives in @kiero/agent/tools): the recheck runs FIRST, and its
 * decision is handled honestly, refusing by default: a world that
 * vanished mid-run, a recheck that throws (no comparison ever ran), a
 * mandated refresh whose reload fails or throws, and a spent refresh
 * budget all REFUSE the submit so the answer never lands over a missing,
 * unknowable or superseded world; a refresh within the bounded budget
 * reloads the context and hands the model the refreshed state to answer
 * against; only a recheck that ran and said current accepts into the
 * answer-contract reducer.
 */
async function gateSubmitFreshness(
  ctx: ActionCtx,
  questionSourceId: Id<"sources">,
  runId: string,
  context: AnswerContext,
  refreshes: number,
): Promise<SubmitGate> {
  const recheck = await tryMutation(() =>
    ctx.runMutation(internal.agent.execute.stalenessRecheck, {
      questionSourceId,
      loadRevisions: answerRevisionSnapshotOf(context).map((entry) => ({
        findingId: entry.findingId as Id<"findings">,
        revision: entry.revision,
      })),
    }),
  );
  // A recheck that throws never said current: the gate fails closed.
  const decision: AnswerFreshnessDecision = recheck.ok
    ? (recheck.value as { decision: AnswerFreshnessDecision }).decision
    : { decision: "abort", reason: "staleness_recheck_failed" };
  const plan = planSubmitFreshness(decision, refreshes);
  if (plan.kind === "refuse") {
    return { kind: "refused", toolResult: plan.toolResult };
  }
  if (plan.kind === "accept") {
    return { kind: "accept" };
  }
  const reloaded = await tryMutation(() =>
    ctx.runMutation(internal.agent.loop.loadAnswerStage, {
      questionSourceId,
      runId,
    }),
  );
  const stage = refreshedSubmitStage(
    reloaded.ok
      ? (reloaded.value as { context?: AnswerContext; error?: string })
      : {},
  );
  if (stage.kind === "refused") {
    return stage;
  }
  return {
    kind: "refreshed",
    context: stage.context,
    nudge: `${contextRefreshedNudge(plan.movedFindingIds)}\n\n${refreshedStateMessage(stage.context)}`,
    refreshResult:
      "ODRZUCONO: kontekst się zmienił — odświeżono stan, złóż odpowiedź ponownie.",
  };
}

/** One dispatched tool call: its execution, or a gate-mandated refresh. */
export type DispatchedAnswerCall =
  | { readonly kind: "executed"; readonly result: ExecutionOutcome }
  | {
      /** The gate reloaded the context: the round continues refreshed. */
      readonly kind: "refresh";
      readonly context: AnswerContext;
      readonly nudge: string;
      readonly refreshResult: string;
    };

/**
 * Routes ONE decoded tool call through the loop's halves — the seam the
 * routing test drives. Three shapes exist and every declared tool must
 * live on one of them (a declared-but-dead tool is a wiring bug):
 *
 * - `agent_search_evidence` and `agent_validate_extension_value` go
 *   STRAIGHT to their Convex executors: the reducer has nothing to
 *   validate them against (the search extends the ledger from query
 *   results; `AnswerContext` carries no extension versions), so reaching
 *   the reducer would be the wiring mistake its default case refuses.
 * - `agent_submit_answer` passes the staleness gate first (refuse,
 *   refresh, or accept), and only an accepted gate hands the call to the
 *   answer-contract reducer.
 * - every checked write is validated by the reducer against the
 *   tenant-filtered context and then executes through its checked Convex
 *   dispatch — an agent plan is untrusted input at both seams. The
 *   branch is on the reducer's structured `refusal` FIELD, never on the
 *   tool-result prose, so a reworded refusal cannot fork the routing.
 */
export async function dispatchAnswerToolCall(
  ctx: ActionCtx,
  questionSourceId: Id<"sources">,
  runId: string,
  context: AnswerContext,
  state: AnswerState,
  refreshes: number,
  call: DecodedAnswerCall,
): Promise<DispatchedAnswerCall> {
  if (call.name === SEARCH_EVIDENCE_TOOL) {
    return {
      kind: "executed",
      result: await runEvidenceSearch(
        ctx,
        context,
        state,
        call.arguments as { query: string; projectId: string | null },
      ),
    };
  }
  if (call.name === VALIDATE_EXTENSION_TOOL) {
    return {
      kind: "executed",
      result: await runCheckedExecution(ctx, context, state, call),
    };
  }
  if (call.name === SUBMIT_ANSWER_TOOL) {
    // The staleness gate FIRST: an answer over a superseded world is
    // refused and the model re-reads the refreshed state (bounded
    // once); a world that vanished mid-run REFUSES the submit outright.
    const gate = await gateSubmitFreshness(
      ctx,
      questionSourceId,
      runId,
      context,
      refreshes,
    );
    if (gate.kind === "refused") {
      return {
        kind: "executed",
        result: { state, toolResult: gate.toolResult, done: false },
      };
    }
    if (gate.kind === "refreshed") {
      return {
        kind: "refresh",
        context: gate.context,
        nudge: gate.nudge,
        refreshResult: gate.refreshResult,
      };
    }
    return { kind: "executed", result: applyAnswerToolCall(state, context, call) };
  }
  // Checked writes: reducer validation against the tenant-filtered
  // context, then the checked execution. A refused plan stops at the
  // refusal (the structured verdict, not the prose) — nothing executes.
  const validated = applyAnswerToolCall(state, context, call);
  if (validated.refusal !== null) {
    return { kind: "executed", result: validated };
  }
  return {
    kind: "executed",
    result: await runCheckedExecution(ctx, context, validated.state, call),
  };
}
