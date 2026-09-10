/**
 * The answer-contract reducer (E6): validation of the structured answer
 * and its citations against the tenant-filtered answer context — decoded,
 * never trusted.
 *
 * E2's chat adapter hands each tool call back with its arguments DECODED
 * against the declared schema; this reducer then validates the decoded
 * arguments against the answer context and the run's evidence ledger. The
 * load-bearing rules (issue #40 acceptance):
 *
 * - GROUNDED VS UNGROUNDED: every factual statement (`direct`,
 *   `corroboration`) must cite at least one ledger handle that resolves;
 *   an `inference` must derive from established findings. An invented
 *   citation, an updating basis or a self-derivation is refused with a
 *   Polish tool result the model can act on.
 * - CORROBORATION IS A SECOND WITNESS: `corroboration` needs at least two
 *   citations from DIFFERENT sources — one source stated twice is not
 *   independent confirmation.
 * - THE UPDATING GATE (C5): evidence grounding an updating finding never
 *   grounds an established statement; the finding is disclosed, not
 *   asserted. The same gate covers conflicted findings — a contradiction
 *   the model cannot resolve in context is a clarification, not a guess.
 * - AMBIGUITY → CLARIFICATION: a clarification must cite the conflicting
 *   evidence; and a direct statement resting on a conflicted finding is
 *   refused so the model asks instead of picking a side.
 *
 * Domain changes (`agent_change_task`/`agent_change_event`) are validated
 * against the context (project exists, expected revision matches the
 * load-time counter, bindings reference real findings) before the checked
 * Convex dispatch executes them; the dispatch itself re-validates and
 * re-resolves everything server-side. Nothing here writes.
 */

import {
  MAX_ANSWER_CLARIFICATIONS,
  MAX_ANSWER_REFRESHES,
  MAX_EVIDENCE_LEDGER,
} from "./versions";
// The canonical provider-quirk tolerance (the planning surface owns it,
// like locateQuote; the extraction reducer reuses it the same way).
import { normalizeStringlyNull } from "../planning/tools";
import {
  findAnswerClarification,
  findAnswerContact,
  findAnswerEvent,
  findAnswerFinding,
  findAnswerMembership,
  findAnswerProject,
  findAnswerTask,
  isEstablishedFinding,
  owedDisclosures,
  type AnswerContext,
  type AnswerEvidenceEntry,
  type AnswerFinding,
} from "./context";
import type {
  AskClarificationArgs,
  ChangeEventArgs,
  ChangeTaskArgs,
  ResolveClarificationArgs,
  SubmitAnswerArgs,
} from "./tools";

/** The mutable-by-replacement run state the loop threads. */
export interface AnswerState {
  /** The evidence ledger: initial witnesses + accepted search results. */
  readonly evidence: readonly AnswerEvidenceEntry[];
  /** The accepted structured answer, once the contract passes. */
  readonly submitted: SubmittedAnswer | null;
  /** Clarification receipts from checked `memory.raiseClarification`. */
  readonly clarificationsRaised: readonly ClarificationReceipt[];
  /** Receipts from checked domain changes. */
  readonly changes: readonly DomainChangeReceipt[];
}

/** The empty run state over the context's initial ledger. */
export function emptyAnswerState(context: AnswerContext): AnswerState {
  return {
    evidence: context.evidence,
    submitted: null,
    clarificationsRaised: [],
    changes: [],
  };
}

/** The accepted answer in wire form (journal/result-safe). */
export interface SubmittedAnswer {
  readonly answerText: string;
  readonly statements: readonly {
    readonly text: string;
    readonly basis: "direct" | "corroboration" | "inference";
    readonly evidenceIds: readonly string[];
    readonly derivedFromFindingIds: readonly string[];
  }[];
  readonly disclosures: {
    readonly updatingFindingIds: readonly string[];
    readonly processingSourceIds: readonly string[];
  };
}

/** Receipt of one clarification raised through the checked dispatch. */
export interface ClarificationReceipt {
  readonly clarificationId: string;
  readonly question: string;
}

/** Receipt of one executed domain change through the checked dispatch. */
export interface DomainChangeReceipt {
  readonly kind: "task" | "event";
  readonly operation: "work.changeTask" | "work.changeEvent";
  readonly entityId: string;
  readonly revision: number;
}

/** One decoded tool call as the loop consumes it. */
export interface DecodedAnswerCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

/** The reducer's answer for one call: the next state plus a tool result. */
export interface AnswerReducerOutcome {
  readonly state: AnswerState;
  /** The Polish tool-result text shown to the model for this call. */
  readonly toolResult: string;
  /** Marks the terminal accepted answer (the loop stops after it). */
  readonly done: boolean;
}

function refuse(state: AnswerState, message: string): AnswerReducerOutcome {
  return { state, toolResult: `ODRZUCONO: ${message}`, done: false };
}

function resolveEvidence(
  state: AnswerState,
  evidenceId: string,
): AnswerEvidenceEntry | undefined {
  return state.evidence.find((entry) => entry.evidenceId === evidenceId);
}

/** The finding an evidence entry grounds, when it belongs to one. */
function groundedFinding(
  context: AnswerContext,
  entry: AnswerEvidenceEntry,
): AnswerFinding | undefined {
  return entry.groundsFindingId === null
    ? undefined
    : findAnswerFinding(context, entry.groundsFindingId);
}

// ---------------------------------------------------------------------------
// agent_submit_answer: the answer contract.
// ---------------------------------------------------------------------------

/** Validates one statement's citations; returns the refusal reason or null. */
function statementRefusal(
  context: AnswerContext,
  state: AnswerState,
  statement: SubmitAnswerArgs["statements"][number],
): string | null {
  const resolved = statement.evidenceIds.map((id) => ({
    id,
    entry: resolveEvidence(state, id),
  }));
  const missing = resolved.filter((r) => r.entry === undefined);
  if (missing.length > 0) {
    return `cytowanie ${missing.map((r) => r.id).join(", ")} nie wskazuje dowodu z tej tury (evN)`;
  }
  const entries = resolved.map((r) => r.entry) as AnswerEvidenceEntry[];

  if (statement.basis === "direct" && entries.length < 1) {
    return "zdanie faktograficzne (direct) wymaga co najmniej jednego cytatu evN";
  }
  if (statement.basis === "corroboration") {
    const distinctSources = new Set(entries.map((entry) => entry.sourceId));
    if (entries.length < 2 || distinctSources.size < 2) {
      return "porównanie (corroboration) wymaga co najmniej dwóch NIEZALEŻNYCH źródeł — jedno źródło nie potwierdza samo siebie";
    }
  }

  // The updating gate and the conflict rule: no established statement may
  // rest on evidence whose finding is updating or conflicted.
  for (const entry of entries) {
    const finding = groundedFinding(context, entry);
    if (finding === undefined) {
      continue;
    }
    if (entry.groundsUpdating || finding.updating) {
      return `cytat ${entry.evidenceId} opiera się na ustaleniu w trakcie aktualizacji (${finding.semanticKey}) — ujawnij je w disclosures, nie podawaj jako ustalonego`;
    }
    if (finding.knowledgeTag === "conflicted") {
      return `cytat ${entry.evidenceId} dotyczy sprzecznego ustalenia (${finding.semanticKey}) — zacytuj obie strony i użyj agent_ask_clarification zamiast wybierać wartość`;
    }
  }

  if (statement.basis === "inference") {
    if (statement.derivedFromFindingIds.length < 1) {
      return "wniosek (inference) wymaga podstawy: derivedFromFindingIds ustaleń z kontekstu";
    }
    for (const findingId of statement.derivedFromFindingIds) {
      const finding = findAnswerFinding(context, findingId);
      if (finding === undefined) {
        return `podstawa wniosku ${findingId} nie jest ustaleniem z kontekstu`;
      }
      if (!isEstablishedFinding(finding)) {
        const recordedText =
          typeof finding.value === "object" &&
          finding.value !== null &&
          "text" in finding.value &&
          typeof (finding.value as { text: unknown }).text === "string"
            ? (finding.value as { text: string }).text.slice(0, 80)
            : "…";
        return [
          `podstawa wniosku ${findingId} (${finding.semanticKey}) nie jest ustalona — wniosek z nieustalonej podstawy jest niedopuszczalny.`,
          "Zamiast wniosku złóż zdanie direct o tym, CO zapisano w źródle: np.",
          `{"text":"Zapisano: «${recordedText}»","basis":"direct","evidenceIds":["evN z wyników agent_search_evidence"]}`,
          `— a ustalenie wskaż w disclosures.updatingFindingIds=[${findingId}].`,
        ].join(" ");
      }
    }
  }
  return null;
}

/** Applies one decoded `agent_submit_answer` call. */
function applySubmitAnswer(
  state: AnswerState,
  context: AnswerContext,
  args: SubmitAnswerArgs,
): AnswerReducerOutcome {
  if (state.submitted !== null) {
    return refuse(state, "odpowiedź została już złożona w tym uruchomieniu");
  }
  for (const statement of args.statements) {
    const refusal = statementRefusal(context, state, statement);
    if (refusal !== null) {
      return refuse(state, refusal);
    }
  }
  // Disclosures must name real updating findings / processing sources —
  // an invented disclosure is as dishonest as an invented citation.
  const disclosableFindings = owedDisclosures(context).updatingFindingIds;
  for (const findingId of args.disclosures.updatingFindingIds) {
    const finding = findAnswerFinding(context, findingId);
    if (finding === undefined || !finding.updating) {
      return refuse(
        state,
        [
          `ujawnienie ${findingId} nie wskazuje ustalenia w trakcie aktualizacji z kontekstu.`,
          `Do ujawnienia nadają się wyłącznie: ${disclosableFindings.length === 0 ? "(brak)" : disclosableFindings.join(", ")}.`,
        ].join(" "),
      );
    }
  }
  const processingIds = new Set(
    context.sources
      .filter((source) => source.processing === "processing")
      .map((source) => source.sourceId),
  );
  for (const sourceId of args.disclosures.processingSourceIds) {
    if (!processingIds.has(sourceId)) {
      return refuse(
        state,
        `ujawnienie ${sourceId} nie wskazuje źródła w trakcie przetwarzania z kontekstu`,
      );
    }
  }
  const submitted: SubmittedAnswer = {
    answerText: args.answerText,
    statements: args.statements.map((statement) => ({
      text: statement.text,
      basis: statement.basis,
      evidenceIds: [...statement.evidenceIds],
      derivedFromFindingIds: [...statement.derivedFromFindingIds],
    })),
    disclosures: {
      updatingFindingIds: [...args.disclosures.updatingFindingIds],
      processingSourceIds: [...args.disclosures.processingSourceIds],
    },
  };
  return {
    state: { ...state, submitted },
    toolResult: `ODPOWIEDŹ PRZYJĘTA: ${args.statements.length} zdań, ujawnienia: ${args.disclosures.updatingFindingIds.length} aktualizowanych, ${args.disclosures.processingSourceIds.length} przetwarzanych.`,
    done: true,
  };
}

// ---------------------------------------------------------------------------
// agent_ask_clarification: ambiguity is a question, never a guess.
// ---------------------------------------------------------------------------

function applyAskClarification(
  state: AnswerState,
  context: AnswerContext,
  rawArgs: AskClarificationArgs,
): AnswerReducerOutcome {
  const args: AskClarificationArgs = {
    ...rawArgs,
    projectId: normalizeStringlyNull(rawArgs.projectId),
  };
  if (state.clarificationsRaised.length >= MAX_ANSWER_CLARIFICATIONS) {
    return refuse(state, `limit ${MAX_ANSWER_CLARIFICATIONS} spraw w jednym uruchomieniu`);
  }
  if (args.scopeKind === "project" && findAnswerProject(context, args.projectId ?? "") === undefined) {
    return refuse(state, "projectId nie wskazuje projektu tej firmy z kontekstu");
  }
  const entries: AnswerEvidenceEntry[] = [];
  for (const evidenceId of args.evidenceIds) {
    const entry = resolveEvidence(state, evidenceId);
    if (entry === undefined) {
      return refuse(state, `cytowanie ${evidenceId} nie wskazuje dowodu z tej tury (evN)`);
    }
    entries.push(entry);
  }
  // The schema enforces at least one evidenceId and every entry resolved
  // above, so at least one distinct source always stands; no dead
  // emptiness check is needed here.
  const distinctSources = new Set(entries.map((entry) => entry.sourceId));
  // The execution half (checked memory.raiseClarification) runs in the
  // Convex layer; the reducer only admits the validated question into the
  // plan and forbids a simultaneous value guess.
  return {
    state,
    toolResult: `PYTANIE PRZYJĘTE DO WYKONANIU (${entries.length} cytaty, ${distinctSources.size} źródeł); nie podawaj jednocześnie wartości rozstrzygającej.`,
    done: false,
  };
}

// ---------------------------------------------------------------------------
// agent_resolve_clarification: a new source-backed response.
// ---------------------------------------------------------------------------

function applyResolveClarification(
  state: AnswerState,
  context: AnswerContext,
  args: ResolveClarificationArgs,
): AnswerReducerOutcome {
  const clarification = findAnswerClarification(context, args.clarificationId);
  if (clarification === undefined) {
    return refuse(state, "clarificationId nie wskazuje otwartej sprawy tej firmy z kontekstu");
  }
  for (const evidenceId of args.evidenceIds) {
    if (resolveEvidence(state, evidenceId) === undefined) {
      return refuse(state, `cytowanie ${evidenceId} nie wskazuje dowodu z tej tury (evN)`);
    }
  }
  return {
    state,
    toolResult: "ROZSTRZYGNIĘCIE PRZYJĘTE DO WYKONANIA; notatka zostanie zapisana z autorem.",
    done: false,
  };
}

// ---------------------------------------------------------------------------
// Domain changes: context validation before the checked dispatch.
// ---------------------------------------------------------------------------

function applyChangeTask(
  state: AnswerState,
  context: AnswerContext,
  rawArgs: ChangeTaskArgs,
): AnswerReducerOutcome {
  const args: ChangeTaskArgs = {
    ...rawArgs,
    taskId: normalizeStringlyNull(rawArgs.taskId),
    executorContactId: normalizeStringlyNull(rawArgs.executorContactId),
    coordinatorMembershipId: normalizeStringlyNull(rawArgs.coordinatorMembershipId),
    deadlineFindingId: normalizeStringlyNull(rawArgs.deadlineFindingId),
  };
  if (findAnswerProject(context, args.projectId) === undefined) {
    return refuse(state, "projectId nie wskazuje projektu tej firmy z kontekstu");
  }
  if (args.executorContactId !== null && findAnswerContact(context, args.executorContactId) === undefined) {
    return refuse(state, "executorContactId nie wskazuje kontaktu tej firmy z kontekstu (wykonawcą może być kontakt z katalogu albo null)");
  }
  if (
    args.coordinatorMembershipId !== null &&
    findAnswerMembership(context, args.coordinatorMembershipId) === undefined
  ) {
    return refuse(state, "coordinatorMembershipId nie wskazuje członkostwa szefa tej firmy z kontekstu");
  }
  if (args.taskId !== null) {
    const task = findAnswerTask(context, args.taskId);
    if (task === undefined) {
      return refuse(state, "taskId nie wskazuje zadania tej firmy z kontekstu");
    }
    if (task.projectId !== args.projectId) {
      return refuse(state, "zadanie należy do innego projektu — przypisanie nie jest edycją pola");
    }
    if (args.expectedRevision !== task.revisionCounter) {
      return refuse(
        state,
        `expectedRevision=${args.expectedRevision} nie zgadza się z kontekstem (rewizja ${task.revisionCounter}) — kontekst mógł się zmienić`,
      );
    }
  }
  if (args.deadlineFindingId !== null) {
    const finding = findAnswerFinding(context, args.deadlineFindingId);
    if (finding === undefined) {
      return refuse(state, "deadlineFindingId nie wskazuje ustalenia z kontekstu");
    }
    if (finding.updating) {
      return refuse(
        state,
        "termin pochodzi z ustalenia w trakcie aktualizacji — zmiana czeka na ponowne ustalenie",
      );
    }
  }
  return {
    state,
    toolResult: "ZMIANA ZADANIA PRZYJĘTA DO WYKONANIA przez sprawdzone reguły; wynik zobaczysz dalej.",
    done: false,
  };
}

function applyChangeEvent(
  state: AnswerState,
  context: AnswerContext,
  rawArgs: ChangeEventArgs,
): AnswerReducerOutcome {
  const args: ChangeEventArgs = {
    ...rawArgs,
    eventId: normalizeStringlyNull(rawArgs.eventId),
    timeFindingId: normalizeStringlyNull(rawArgs.timeFindingId),
  };
  if (findAnswerProject(context, args.projectId) === undefined) {
    return refuse(state, "projectId nie wskazuje projektu tej firmy z kontekstu");
  }
  if (args.eventId !== null) {
    const event = findAnswerEvent(context, args.eventId);
    if (event === undefined) {
      return refuse(state, "eventId nie wskazuje zdarzenia tej firmy z kontekstu");
    }
    if (event.projectId !== args.projectId) {
      return refuse(state, "zdarzenie należy do innego projektu — przypisanie nie jest edycją pola");
    }
    if (args.expectedRevision !== event.revisionCounter) {
      return refuse(
        state,
        `expectedRevision=${args.expectedRevision} nie zgadza się z kontekstem (rewizja ${event.revisionCounter}) — kontekst mógł się zmienić`,
      );
    }
  }
  if (args.timeFindingId !== null) {
    const finding = findAnswerFinding(context, args.timeFindingId);
    if (finding === undefined) {
      return refuse(state, "timeFindingId nie wskazuje ustalenia z kontekstu");
    }
    if (finding.updating) {
      return refuse(
        state,
        "termin pochodzi z ustalenia w trakcie aktualizacji — zmiana czeka na ponowne ustalenie",
      );
    }
  }
  return {
    state,
    toolResult: "ZMIANA ZDARZENIA PRZYJĘTA DO WYKONANIA przez sprawdzone reguły; wynik zobaczysz dalej.",
    done: false,
  };
}

// ---------------------------------------------------------------------------
// The dispatch entry.
// ---------------------------------------------------------------------------

/**
 * Applies one decoded answer-flow call. Arguments must already be DECODED
 * (E2's adapter guarantees this); a call whose arguments fail the deeper
 * context validation is refused with a Polish tool result the model can
 * correct in a later turn. Unknown tool names are refused — though E2's
 * adapter already fails those closed.
 *
 * Note: `agent_search_evidence` and `agent_validate_extension_value` are
 * handled by the Convex layer (they execute checked reads); they reach
 * this reducer only on wiring mistakes and are refused here.
 */
export function applyAnswerToolCall(
  state: AnswerState,
  context: AnswerContext,
  call: DecodedAnswerCall,
): AnswerReducerOutcome {
  switch (call.name) {
    case "agent_submit_answer":
      return applySubmitAnswer(state, context, call.arguments as SubmitAnswerArgs);
    case "agent_ask_clarification":
      return applyAskClarification(state, context, call.arguments as AskClarificationArgs);
    case "agent_resolve_clarification":
      return applyResolveClarification(state, context, call.arguments as ResolveClarificationArgs);
    case "agent_change_task":
      return applyChangeTask(state, context, call.arguments as ChangeTaskArgs);
    case "agent_change_event":
      return applyChangeEvent(state, context, call.arguments as ChangeEventArgs);
    default:
      return refuse(state, `narzędzie ${call.name} wykonuje się po stronie serwera`);
  }
}

// ---------------------------------------------------------------------------
// The staleness recheck decision (the in-flight answer/change guard).
// ---------------------------------------------------------------------------

/** What the staleness recheck compared. */
export interface AnswerFreshnessInput {
  /** The load-time revision counters (the context the run reasoned over). */
  readonly loadRevisions: readonly { findingId: string; revision: number }[];
  /** The CURRENT counters read at recheck time (same order not required). */
  readonly currentRevisions: ReadonlyMap<string, number>;
}

/**
 * Why the world a submit was computed against is gone or unknowable: the
 * question source row vanished or stopped being active mid-run, the
 * mandated context refresh could not reload, or the staleness recheck
 * itself failed so no comparison ever ran.
 */
export type AnswerAbortReason =
  | "question_source_missing"
  | "question_source_not_active"
  | "context_reload_failed"
  | "staleness_recheck_failed";

/**
 * The recheck decision: current; refreshed with the moved findings; or
 * ABORT, the honest third variant for a world that vanished mid-run,
 * which REFUSES the submit (the answer must not land).
 */
export type AnswerFreshnessDecision =
  | { readonly decision: "current" }
  | {
      readonly decision: "refresh";
      readonly moved: readonly {
        findingId: string;
        loadRevision: number;
        currentRevision: number;
      }[];
    }
  | { readonly decision: "abort"; readonly reason: AnswerAbortReason };

/**
 * Compares the run's input-revision version against CURRENT counters. A
 * finding that moved (was corrected or re-marked between load and the
 * answer/change landing) forces a refresh: the run re-reads the current
 * state and either narrows the answer or asks a clarification — it never
 * lands a change computed against a superseded world. Findings that
 * vanished are not "moved" (nothing stale-addresses them). This function
 * never decides "abort": a vanished QUESTION world is the Convex
 * sentinel's call, an honest input this type carries instead of
 * fabricating a fake refresh shape.
 */
export function decideAnswerFreshness(
  input: AnswerFreshnessInput,
): AnswerFreshnessDecision {
  const moved: {
    findingId: string;
    loadRevision: number;
    currentRevision: number;
  }[] = [];
  for (const expectation of input.loadRevisions) {
    const current = input.currentRevisions.get(expectation.findingId);
    if (current !== undefined && current !== expectation.revision) {
      moved.push({
        findingId: expectation.findingId,
        loadRevision: expectation.revision,
        currentRevision: current,
      });
    }
  }
  return moved.length === 0
    ? { decision: "current" }
    : { decision: "refresh", moved };
}

/** The Polish explanation of one abort reason (product text). */
function abortReasonText(reason: AnswerAbortReason): string {
  switch (reason) {
    case "question_source_missing":
      return "źródło pytania zniknęło w trakcie uruchomienia";
    case "question_source_not_active":
      return "źródło pytania nie jest już aktywne";
    case "context_reload_failed":
      return "odświeżenie kontekstu nie powiodło się";
    case "staleness_recheck_failed":
      return "sprawdzenie aktualności kontekstu nie powiodło się";
  }
}

/**
 * The refusal a submit earns when the world it was computed against is
 * gone or unknowable: the answer must not land, so the model is told to
 * finish WITHOUT `agent_submit_answer` (the honest end of a run whose
 * question world vanished, whose recheck or refresh could not run, or
 * whose refresh could not reload).
 */
export function vanishedSubmitRefusal(reason: AnswerAbortReason): string {
  return `ODRZUCONO: ${abortReasonText(reason)}. Odpowiedź nie może zostać przyjęta; zakończ bez agent_submit_answer`;
}

/**
 * The refusal a submit earns when the recheck says the world moved but
 * the bounded refresh budget is already spent: the answer must not land
 * over a superseded state, so the model is told to finish WITHOUT
 * `agent_submit_answer` (the run's honest `gave_up` end).
 */
export function refreshBudgetSpentSubmitRefusal(): string {
  return `ODRZUCONO: kontekst się zmienił ponownie, a limit odświeżeń (${MAX_ANSWER_REFRESHES}) został już wykorzystany. Odpowiedź nie może zostać przyjęta na nieaktualnym stanie; zakończ bez agent_submit_answer`;
}

/** The loop's plan for one submit after the staleness recheck decided. */
export type SubmitFreshnessPlan =
  | { readonly kind: "accept" }
  | { readonly kind: "refresh"; readonly movedFindingIds: readonly string[] }
  | { readonly kind: "refuse"; readonly toolResult: string };

/**
 * Plans the handling of one submit from a staleness decision, refusing
 * by default: an ABORT (the question source vanished mid-run, or the
 * recheck itself failed) REFUSES the submit, so the answer never lands
 * over a world that is gone or unknowable; a refresh decision past the
 * spent budget refuses too, never accepting over a superseded world; a
 * refresh within the bounded budget plans the one reload; only a
 * decision of CURRENT accepts into the answer contract reducer.
 */
export function planSubmitFreshness(
  decision: AnswerFreshnessDecision,
  refreshes: number,
): SubmitFreshnessPlan {
  if (decision.decision === "abort") {
    return { kind: "refuse", toolResult: vanishedSubmitRefusal(decision.reason) };
  }
  if (decision.decision === "refresh") {
    return refreshes < MAX_ANSWER_REFRESHES
      ? {
          kind: "refresh",
          movedFindingIds: decision.moved.map((moved) => moved.findingId),
        }
      : { kind: "refuse", toolResult: refreshBudgetSpentSubmitRefusal() };
  }
  return { kind: "accept" };
}

/**
 * Reads one refreshed-context reload's stage envelope: a stage that
 * reloaded hands the refreshed context through; a stage WITHOUT one (the
 * reload refused the source or failed technically) REFUSES the submit,
 * never a fall-through that accepts the answer over the stale in-memory
 * context the run still holds.
 */
export function refreshedSubmitStage(
  stage: { readonly context?: AnswerContext; readonly error?: string },
):
  | { readonly kind: "refreshed"; readonly context: AnswerContext }
  | { readonly kind: "refused"; readonly toolResult: string } {
  if (stage.context === undefined) {
    const reason: AnswerAbortReason =
      stage.error === "question_source_missing" ||
      stage.error === "question_source_not_active"
        ? stage.error
        : "context_reload_failed";
    return { kind: "refused", toolResult: vanishedSubmitRefusal(reason) };
  }
  return { kind: "refreshed", context: stage.context };
}

/** Appends search results to the ledger, bounded (the loop calls this). */
export function extendEvidenceLedger(
  state: AnswerState,
  entries: readonly AnswerEvidenceEntry[],
): { readonly state: AnswerState; readonly accepted: readonly AnswerEvidenceEntry[] } {
  const known = new Set(state.evidence.map((entry) => entry.evidenceId));
  const accepted: AnswerEvidenceEntry[] = [];
  for (const entry of entries) {
    if (known.has(entry.evidenceId) || state.evidence.length + accepted.length >= MAX_EVIDENCE_LEDGER) {
      continue;
    }
    known.add(entry.evidenceId);
    accepted.push(entry);
  }
  return {
    state: { ...state, evidence: [...state.evidence, ...accepted] },
    accepted,
  };
}

/** Records an executed clarification receipt (the loop calls this). */
export function recordClarificationRaised(
  state: AnswerState,
  receipt: ClarificationReceipt,
): AnswerState {
  return {
    ...state,
    clarificationsRaised: [...state.clarificationsRaised, receipt],
  };
}

/** Records an executed domain-change receipt (the loop calls this). */
export function recordDomainChange(
  state: AnswerState,
  receipt: DomainChangeReceipt,
): AnswerState {
  return { ...state, changes: [...state.changes, receipt] };
}
