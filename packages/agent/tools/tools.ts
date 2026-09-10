/**
 * The agent's answer tool set (E6): typed evidence search, the structured
 * source-backed answer, clarification create/resolve, domain changes
 * (task/event) and extension-value validation — a small typed surface over
 * C2-C4's checked operations (issue #40).
 *
 * These Effect Schemas are the DECODE authority for tool arguments coming
 * back through E2's chat adapter: the adapter decodes accumulated argument
 * JSON against the schema the caller declares, so by the time a call
 * reaches the answer reducer its arguments are DECODED typed values, never
 * executed strings. Malformed arguments fail closed in the adapter
 * (`output_rejected`); what survives here is validated AGAIN against the
 * answer context by the reducer — an agent plan is untrusted input. The
 * EXECUTION of what survives happens only through the checked Convex
 * dispatches (convex/agent/execute.ts), with the resolved actor, company
 * and expected revisions; the model cannot call raw database,
 * access-management or arbitrary provider tools because no such tool is
 * declared, and undeclared names never decode.
 *
 * Deliberate wire-shape choices:
 *
 * - citations are LEDGER HANDLES (`ev3`), not free text: the reducer can
 *   mechanically refuse an ungrounded statement whose "source" does not
 *   resolve to evidence the run actually inspected;
 * - expected revisions are explicit on domain changes: a stale in-flight
 *   change rechecks current revisions and refuses instead of overwriting;
 * - `basis` distinguishes direct support, independent corroboration and
 *   AI inference ("Wniosek agenta" needs a derivation basis, never itself
 *   a witness).
 */

import { Schema } from "effect";
import { ExtensionValue } from "@kiero/contracts";
import {
  MAX_ANSWER_STATEMENTS,
  MAX_ANSWER_TEXT_CHARS,
  MAX_EVIDENCE_LEDGER,
  MAX_EVIDENCE_QUOTE_CHARS,
  MAX_EVIDENCE_SEARCH_RESULTS,
} from "./versions";

/** Tool name of the tenant-scoped evidence search. */
export const SEARCH_EVIDENCE_TOOL = "agent_search_evidence" as const;

/** Tool name of the structured source-backed answer. */
export const SUBMIT_ANSWER_TOOL = "agent_submit_answer" as const;

/** Tool name of the clarification question (Sprawa do wyjaśnienia). */
export const ASK_CLARIFICATION_TOOL = "agent_ask_clarification" as const;

/** Tool name of resolving an open clarification with a new basis. */
export const RESOLVE_CLARIFICATION_TOOL = "agent_resolve_clarification" as const;

/** Tool name of the task domain change (C4 `work.changeTask`). */
export const CHANGE_TASK_TOOL = "agent_change_task" as const;

/** Tool name of the event domain change (C4 `work.changeEvent`). */
export const CHANGE_EVENT_TOOL = "agent_change_event" as const;

/** Tool name of the extension-value validation (C3 validate-value). */
export const VALIDATE_EXTENSION_TOOL = "agent_validate_extension_value" as const;

/** Ledger handles: `ev` + positive counter. */
export const EvidenceHandlePattern = /^ev[1-9][0-9]*$/;

const evidenceHandle = Schema.String.pipe(
  Schema.check(Schema.isPattern(EvidenceHandlePattern)),
);

/** Provider-quirk tolerance (the E3 precedent): "null"/"" map to null. */
export function normalizeStringlyNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "null" ? null : value;
}

/** The input schema of `agent_search_evidence`. */
export const SearchEvidenceArgs = Schema.Struct({
  /** A Polish phrase to locate in the company's source texts. */
  query: Schema.String.pipe(
    Schema.check(Schema.isMinLength(2)),
    Schema.check(Schema.isMaxLength(120)),
  ),
  /** Optional project filter (a context project id); null = whole firm. */
  projectId: Schema.NullOr(Schema.NonEmptyString),
});
export type SearchEvidenceArgs = Schema.Schema.Type<typeof SearchEvidenceArgs>;

/** One statement's relation to its evidence. */
export const StatementBasis = Schema.Literals(["direct", "corroboration", "inference"]);

/** One structured statement of the answer. */
export const AnswerStatementArgs = Schema.Struct({
  /** The Polish sentence the boss reads. */
  text: Schema.NonEmptyString,
  basis: StatementBasis,
  /** Ledger handles this statement cites (required for direct/corroboration). */
  evidenceIds: Schema.Array(evidenceHandle),
  /** Inference basis: findings this conclusion derives from. */
  derivedFromFindingIds: Schema.Array(Schema.NonEmptyString),
});
export type AnswerStatementArgs = Schema.Schema.Type<typeof AnswerStatementArgs>;

/** The input schema of `agent_submit_answer` (the answer contract). */
export const SubmitAnswerArgs = Schema.Struct({
  /** The boss-facing Polish answer text (summary of the statements). */
  answerText: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(MAX_ANSWER_TEXT_CHARS)),
  ),
  statements: Schema.Array(AnswerStatementArgs).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(MAX_ANSWER_STATEMENTS)),
  ),
  /** Honest exclusions: updating findings and still-processing sources. */
  disclosures: Schema.Struct({
    updatingFindingIds: Schema.Array(Schema.NonEmptyString),
    processingSourceIds: Schema.Array(Schema.NonEmptyString),
  }),
});
export type SubmitAnswerArgs = Schema.Schema.Type<typeof SubmitAnswerArgs>;

/** The input schema of `agent_ask_clarification`. */
export const AskClarificationArgs = Schema.Struct({
  question: Schema.NonEmptyString,
  /** The conflicting evidence, as ledger handles (both/all sides). */
  evidenceIds: Schema.Array(evidenceHandle).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(MAX_EVIDENCE_LEDGER)),
  ),
  scopeKind: Schema.Literals(["company", "project"]),
  projectId: Schema.NullOr(Schema.NonEmptyString),
});
export type AskClarificationArgs = Schema.Schema.Type<typeof AskClarificationArgs>;

/** The input schema of `agent_resolve_clarification`. */
export const ResolveClarificationArgs = Schema.Struct({
  clarificationId: Schema.NonEmptyString,
  /** The resolution note, grounded in the cited NEW evidence. */
  resolutionNote: Schema.NonEmptyString,
  evidenceIds: Schema.Array(evidenceHandle).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(MAX_EVIDENCE_LEDGER)),
  ),
});
export type ResolveClarificationArgs = Schema.Schema.Type<
  typeof ResolveClarificationArgs
>;

/** The input schema of `agent_change_task` (C4 `work.changeTask`). */
export const ChangeTaskArgs = Schema.Struct({
  /** Null creates; otherwise must address a live task of this company. */
  taskId: Schema.NullOr(Schema.NonEmptyString),
  /** A context project id. */
  projectId: Schema.NonEmptyString,
  title: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(160)),
  ),
  /** Executor may be a contact without a Kiero account. */
  executorContactId: Schema.NullOr(Schema.NonEmptyString),
  /** Coordinator is a boss member of this company. */
  coordinatorMembershipId: Schema.NullOr(Schema.NonEmptyString),
  /** Binding to the temporal finding that carries the deadline, if any. */
  deadlineFindingId: Schema.NullOr(Schema.NonEmptyString),
  /** The CURRENT task revision (updates only; ignored on create). */
  expectedRevision: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
});
export type ChangeTaskArgs = Schema.Schema.Type<typeof ChangeTaskArgs>;

/** The input schema of `agent_change_event` (C4 `work.changeEvent`). */
export const ChangeEventArgs = Schema.Struct({
  eventId: Schema.NullOr(Schema.NonEmptyString),
  projectId: Schema.NonEmptyString,
  title: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(160)),
  ),
  /** Binding to the temporal finding that carries the known time, if any. */
  timeFindingId: Schema.NullOr(Schema.NonEmptyString),
  expectedRevision: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
});
export type ChangeEventArgs = Schema.Schema.Type<typeof ChangeEventArgs>;

/** The input schema of `agent_validate_extension_value` (C3). */
export const ValidateExtensionValueArgs = Schema.Struct({
  /** The extension definition version the value claims to fit. */
  versionId: Schema.NonEmptyString,
  value: ExtensionValue,
});
export type ValidateExtensionValueArgs = Schema.Schema.Type<
  typeof ValidateExtensionValueArgs
>;

/** One declared tool for E2's `ChatToolSpec` (name + description + codec). */
export interface AnswerToolSpec {
  readonly name:
    | typeof SEARCH_EVIDENCE_TOOL
    | typeof SUBMIT_ANSWER_TOOL
    | typeof ASK_CLARIFICATION_TOOL
    | typeof RESOLVE_CLARIFICATION_TOOL
    | typeof CHANGE_TASK_TOOL
    | typeof CHANGE_EVENT_TOOL
    | typeof VALIDATE_EXTENSION_TOOL;
  readonly description: string;
  readonly input:
    | typeof SearchEvidenceArgs
    | typeof SubmitAnswerArgs
    | typeof AskClarificationArgs
    | typeof ResolveClarificationArgs
    | typeof ChangeTaskArgs
    | typeof ChangeEventArgs
    | typeof ValidateExtensionValueArgs;
}

/** The Polish tool descriptions sent to the model (part of the prompt version). */
export const ANSWER_TOOL_DESCRIPTIONS = {
  searchEvidence: [
    "Szukaj dosłownych fragmentów w wiadomościach firmy (bez projektu albo w jednym projekcie).",
    "Wyniki to KANDYDACI źródłowi: trafność nie ustala prawdy, służy tylko do wskazania cytatu.",
    `Zwraca maksymalnie ${MAX_EVIDENCE_SEARCH_RESULTS} wyników z cytatami do ${MAX_EVIDENCE_QUOTE_CHARS} znaków; użyj uchwytów evN w odpowiedzi.`,
  ].join(" "),
  submitAnswer: [
    "Złóż ostateczną odpowiedź na pytanie szefa. Każde zdanie faktograficzne wymaga podstawy:",
    "basis=direct — cytat z jednego źródła (evidenceIds), basis=corroboration — co najmniej dwa NIEZALEŻNE źródła,",
    "basis=inference — wniosek z ustaleń (derivedFromFindingIds; „Wniosek agenta” nie jest świadkiem).",
    "Nie podawaj ustaleń „w trakcie aktualizacji” jako ustalonych — ujawnij je w disclosures.",
    "Kwota bez zapisanej podstawy netto/brutto pozostaje „nie określono” — nigdy nie zgaduj VAT.",
  ].join(" "),
  askClarification: [
    "Zadaj szefom wspólne pytanie (sprawę do wyjaśnienia), gdy źródła są sprzeczne lub niejednoznaczne.",
    "Zacytuj uchwytami evKONKRETNE fragmenty WSZYSTKICH sprzecznych wypowiedzi.",
    "Zamiast zgadywać wartości — zapytaj; pytanie zostaje dla uprawnionych szefów.",
  ].join(" "),
  resolveClarification: [
    "Rozstrzygnij otwartą sprawę do wyjaśnienia NOWĄ podstawą źródłową (evidenceIds) i notatką.",
    "Używaj tylko wtedy, gdy nowe źródło rzeczywiście rozstrzyga pytanie.",
  ].join(" "),
  changeTask: [
    "Utwórz albo zmień zadanie (projectId z kontekstu, tytuł, opcjonalnie wykonawca/koordynator/termin).",
    "executorContactId to id z sekcji KONTAKTY, coordinatorMembershipId to id z sekcji SZEFOWIE; użyj null, gdy nie przypisujesz.",
    "Dla istniejącego zadania podaj taskId i expectedRevision zgodne z kontekstem; null tworzy nowe.",
    "Zmiana przechodzi przez te same sprawdzone reguły co z aplikacji; odrzucenie zobaczysz w wyniku narzędzia.",
  ].join(" "),
  changeEvent: [
    "Utwórz albo zmień zdarzenie (dostawa, spotkanie): projectId z kontekstu, tytuł, opcjonalny termin.",
    "Dla istniejącego zdarzenia podaj eventId i expectedRevision zgodne z kontekstem; null tworzy nowe.",
  ].join(" "),
  validateExtensionValue: [
    "Sprawdź wartość dodatkowej informacji wobec zapisanej wersji definicji (versionId).",
    "Zwraca wynik walidacji; sama wartość nie zapisuje nic do pamięci.",
  ].join(" "),
} as const;

/** The declared tools, in declaration order. */
export const ANSWER_TOOLS: readonly AnswerToolSpec[] = [
  {
    name: SEARCH_EVIDENCE_TOOL,
    description: ANSWER_TOOL_DESCRIPTIONS.searchEvidence,
    input: SearchEvidenceArgs,
  },
  {
    name: SUBMIT_ANSWER_TOOL,
    description: ANSWER_TOOL_DESCRIPTIONS.submitAnswer,
    input: SubmitAnswerArgs,
  },
  {
    name: ASK_CLARIFICATION_TOOL,
    description: ANSWER_TOOL_DESCRIPTIONS.askClarification,
    input: AskClarificationArgs,
  },
  {
    name: RESOLVE_CLARIFICATION_TOOL,
    description: ANSWER_TOOL_DESCRIPTIONS.resolveClarification,
    input: ResolveClarificationArgs,
  },
  {
    name: CHANGE_TASK_TOOL,
    description: ANSWER_TOOL_DESCRIPTIONS.changeTask,
    input: ChangeTaskArgs,
  },
  {
    name: CHANGE_EVENT_TOOL,
    description: ANSWER_TOOL_DESCRIPTIONS.changeEvent,
    input: ChangeEventArgs,
  },
  {
    name: VALIDATE_EXTENSION_TOOL,
    description: ANSWER_TOOL_DESCRIPTIONS.validateExtensionValue,
    input: ValidateExtensionValueArgs,
  },
];
