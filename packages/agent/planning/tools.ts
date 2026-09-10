/**
 * The agent's tool surface for text analysis (E3): typed memory changes,
 * project identification and clarification questions (issue #37).
 *
 * These Effect Schemas are the DECODE authority for tool arguments coming
 * back through E2's chat adapter: the adapter decodes accumulated argument
 * JSON against the schema the caller declares (packages/providers/src/chat.ts
 * `ChatToolSpec.input`), so by the time a call reaches the planning reducer
 * its arguments are DECODED typed values, never executed strings. Malformed
 * arguments fail closed in the adapter (`output_rejected`); what survives
 * here is validated AGAIN against the analysis context by the reducer — an
 * agent plan is untrusted input.
 *
 * Deliberate wire-shape choices:
 *
 * - money amounts are plain decimal strings (BigDecimal objects never cross
 *   a provider boundary; `buildMoneyValue` converts through the contract
 *   schema);
 * - temporal values are either a RELATIVE EXPRESSION (the server resolves it
 *   against the source's `sentAt`/timezone; the model never does date
 *   arithmetic) or an EXPLICIT shape the source literally stated;
 * - `replacesFindingId` is the correction handle: null creates a new finding
 *   identity, a value must address a live finding from the context.
 */

import { Schema } from "effect";

/** Tool name of the typed memory-change proposal. */
export const UPSERT_FINDING_TOOL = "memory_upsert_finding" as const;

/** Tool name of the project identification/attribution proposal. */
export const IDENTIFY_PROJECT_TOOL = "projects_identify" as const;

/** Tool name of the clarification question (Sprawa do wyjaśnienia). */
export const ASK_CLARIFICATION_TOOL = "memory_ask_clarification" as const;

/** Semantic key vocabulary: stable lowercase snake_case identities. */
export const SemanticKeyPattern = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Provider-quirk tolerance: models serving strict JSON-schema tool calls
 * sometimes serialize a null as the STRING "null" (or an empty string).
 * The schemas stay plain nullable strings; `normalizeStringlyNull` (used
 * at the reducer entry) maps those forms to a REAL null before any rule
 * runs, so a literal "null" never masquerades as a project handle.
 */
export function normalizeStringlyNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "null" ? null : value;
}

/** How the model says a date, without doing any arithmetic itself. */
export const TemporalBasis = Schema.TaggedUnion({
  relative: { expression: Schema.NonEmptyString },
  day: { day: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))) },
  month: { month: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))) },
  year: { year: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}$/))) },
  datetime: { iso: Schema.NonEmptyString },
  range: {
    start: Schema.NullOr(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
        Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))),
      ]),
    ),
    end: Schema.NullOr(
      Schema.Union([
        Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
        Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/))),
      ]),
    ),
  },
});
export type TemporalBasis = Schema.Schema.Type<typeof TemporalBasis>;

/** The temporal proposal: the basis plus the speaker's original words. */
export const TemporalProposal = Schema.Struct({
  basis: TemporalBasis,
  /** The speaker's words, verbatim (kept as the finding's expression). */
  originalExpression: Schema.NonEmptyString,
  /** Meaning: proposed / internal / agreed / actual (issue 8). */
  role: Schema.Literals(["proposed", "internal", "agreed", "actual"]),
});
export type TemporalProposal = Schema.Schema.Type<typeof TemporalProposal>;

/** Exact-or-range amount, decimal strings only (never binary floats). */
export const MoneyProposalAmount = Schema.TaggedUnion({
  exact: { value: Schema.NonEmptyString },
  range: {
    min: Schema.NullOr(Schema.NonEmptyString),
    max: Schema.NullOr(Schema.NonEmptyString),
  },
});

/** The financial proposal in wire form. */
export const MoneyProposal = Schema.Struct({
  role: Schema.Literals([
    "price_proposal",
    "agreed_price",
    "material_cost",
    "deposit_received",
    "estimated_labor",
  ]),
  amount: MoneyProposalAmount,
  /** ISO 4217 code the speaker stated, or null for the company default. */
  currency: Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Z]{3}$/)))),
  /** Net/gross ONLY when the source states it; `not_specified` otherwise. */
  taxBasis: Schema.Literals(["net", "gross", "not_specified"]),
  certainty: Schema.Literals(["exact", "estimate"]),
});
export type MoneyProposal = Schema.Schema.Type<typeof MoneyProposal>;

/** The typed value proposal: exactly one payload kind. */
export const ValueProposal = Schema.TaggedUnion({
  temporal: { temporal: TemporalProposal },
  money: { money: MoneyProposal },
  text_note: { text: Schema.NonEmptyString },
});
export type ValueProposal = Schema.Schema.Type<typeof ValueProposal>;

/** The input schema of `memory_upsert_finding` (decoded, then re-validated). */
export const UpsertFindingArgs = Schema.Struct({
  /** `record` states new information; `correct` explicitly replaces a value. */
  intent: Schema.Literals(["record", "correct"]),
  semanticKey: Schema.String.pipe(Schema.check(Schema.isPattern(SemanticKeyPattern))),
  scopeKind: Schema.Literals(["company", "project"]),
  /** A context project id, or an in-run `projects_identify` handle (`new:1`). */
  projectId: Schema.NullOr(Schema.NonEmptyString),
  value: ValueProposal,
  /** The speaker's words grounding this proposal (server locates fragments). */
  quotes: Schema.Array(Schema.NonEmptyString).pipe(Schema.check(Schema.isMinLength(1))),
  /** Required (and required to match) when `intent` is `correct`. */
  replacesFindingId: Schema.NullOr(Schema.NonEmptyString),
  /** Findings this conclusion derives from ("Wniosek agenta" needs a basis). */
  derivesFromFindingIds: Schema.Array(Schema.NonEmptyString),
  /** How sure the model was about what it read (separate from knowledge). */
  readConfidence: Schema.Number.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
});
export type UpsertFindingArgs = Schema.Schema.Type<typeof UpsertFindingArgs>;

/** The input schema of `projects_identify`. */
export const IdentifyProjectArgs = Schema.Struct({
  /** An existing context project id, when the text clearly names one. */
  projectId: Schema.NullOr(Schema.NonEmptyString),
  /** A new project's working name, when nothing matches. */
  displayName: Schema.NullOr(Schema.NonEmptyString),
});
export type IdentifyProjectArgs = Schema.Schema.Type<typeof IdentifyProjectArgs>;

/** The input schema of `memory_ask_clarification`. */
export const AskClarificationArgs = Schema.Struct({
  question: Schema.NonEmptyString,
  /** The conflicting statements, verbatim, for both/all sides. */
  quotes: Schema.Array(Schema.NonEmptyString).pipe(Schema.check(Schema.isMinLength(1))),
  scopeKind: Schema.Literals(["company", "project"]),
  projectId: Schema.NullOr(Schema.NonEmptyString),
});
export type AskClarificationArgs = Schema.Schema.Type<typeof AskClarificationArgs>;

/** One declared tool for E2's `ChatToolSpec` (name + description + codec). */
export interface PlanningToolSpec {
  readonly name:
    | typeof UPSERT_FINDING_TOOL
    | typeof IDENTIFY_PROJECT_TOOL
    | typeof ASK_CLARIFICATION_TOOL;
  readonly description: string;
  readonly input:
    | typeof UpsertFindingArgs
    | typeof IdentifyProjectArgs
    | typeof AskClarificationArgs;
}

/** The Polish tool descriptions sent to the model (part of the prompt version). */
export const PLANNING_TOOL_DESCRIPTIONS: {
  readonly upsertFinding: string;
  readonly identifyProject: string;
  readonly askClarification: string;
} = {
  upsertFinding: [
    "Zaproponuj wpisanie lub zmianę jednego ustalenia w pamięci firmy albo projektu.",
    "Dla nowej informacji użyj intent=record i replacesFindingId=null.",
    "Dla wyraźnej zmiany wcześniejszej wartości (np. „zmieniamy na piątek”) użyj intent=correct i podaj replacesFindingId ustalenia z kontekstu.",
    "Jeśli nie potrafisz rozstrzygnąć sprzeczności, NIE zgaduj wartości — użyj narzędzia memory_ask_clarification.",
    "Daty względne (jutro, w piątek, za tydzień) podawaj wyłącznie jako basis={expression:...}; serwer wyliczy dzień.",
    "Kwota bez słów „netto”/„brutto” w cytacie musi mieć taxBasis=not_specified.",
  ].join(" "),
  identifyProject: [
    "Wskaz projekt, którego dotyczy wypowiedź: projectId istniejącego projektu z kontekstu,",
    "albo displayName nowego projektu (maksymalnie zwięzła nazwa robocza), gdy żaden nie pasuje.",
    "Odpowiedź zwróci uchwyt (new:N), którego używasz jako projectId w memory_upsert_finding.",
  ].join(" "),
  askClarification: [
    "Zadaj szefom wspólne pytanie (sprawę do wyjaśnienia), gdy informacja jest sprzeczna lub niejednoznaczna.",
    "Zacytuj dokładne fragmenty wszystkich sprzecznych wypowiedzi w `quotes`.",
    "Pytaj tylko, gdy brak blokuje ustalenie; nie pytaj o każde brakujące szczegóły.",
  ].join(" "),
};

/** The three declared tools, in declaration order. */
export const PLANNING_TOOLS: readonly PlanningToolSpec[] = [
  {
    name: UPSERT_FINDING_TOOL,
    description: PLANNING_TOOL_DESCRIPTIONS.upsertFinding,
    input: UpsertFindingArgs,
  },
  {
    name: IDENTIFY_PROJECT_TOOL,
    description: PLANNING_TOOL_DESCRIPTIONS.identifyProject,
    input: IdentifyProjectArgs,
  },
  {
    name: ASK_CLARIFICATION_TOOL,
    description: PLANNING_TOOL_DESCRIPTIONS.askClarification,
    input: AskClarificationArgs,
  },
];
