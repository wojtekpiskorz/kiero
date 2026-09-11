/**
 * Memory feature state (H1): Polish copy, the wire-value renderers for
 * finding rows, and the memory-specific error hints for the memory surface.
 *
 * Split from the conversation feature's state in review round 1: the copy,
 * renderers and hints here serve only "Pamięć", so the feature owns them
 * like every other feature owns its state. The renderers decode the
 * ENCODED (wire) forms the public reads carry through the exported
 * contract schemas at the boundary, then switch over the DECODED values:
 * every switch is exhaustiveness-checked and the label maps are typed by
 * the contract's closed vocabularies — a vocabulary change fails the
 * build instead of rendering a raw machine code. The copy renders exactly
 * what is there: an estimate never becomes an exact figure,
 * `not_specified` tax basis stays visible, and a conflicted or updating
 * finding can never read as settled.
 *
 * C5's `updating` knowledge state ("wymaga ponownego potwierdzenia —
 * podstawa się zmieniła") is rendered here with its reason: such a finding
 * is visibly NOT a settled fact and blocks affected automation.
 *
 * The genuinely shared pieces (the session-checking copy contract features
 * render, `instantLabel`, the generic session hints) stay in
 * ../conversation/state.ts, which this module composes.
 */

import { BigDecimal, Schema } from "effect";
import {
  FindingValue,
  KnowledgeState,
  type TemporalValue,
} from "@kiero/contracts";
import {
  MONEY_CERTAINTY_LABELS,
  MONEY_ROLE_LABELS,
  TAX_BASIS_LABELS,
  TEMPORAL_ROLE_LABELS,
  dateOnlyLabel,
} from "../../../../../packages/domain/findings/labels";
import { signInCopy } from "../sign-in/state";
import { sessionFailureHints } from "../conversation/state";

export { signInCopy };

// ---------------------------------------------------------------------------
// Polish copy (stable product text)
// ---------------------------------------------------------------------------

/** Copy for the memory surface (current findings, history, clarifications). */
export const memoryCopy = {
  title: "Pamięć",
  intro:
    "Aktualne ustalenia odczytane bez powtórnego czytania rozmowy. Każde ustalenie ma swoje źródło i historię zmian.",
  // The session-checking label every company surface renders while a gated
  // query resolves (NOT the sign-in-code copy; review round 1's drift fix).
  checkingSession: "Sprawdzamy Twoją sesję…",
  scopeLabel: "Zakres pamięci",
  scopeCompany: "Firma",
  noFindings: "Brak ustaleń w tym zakresie.",
  // Finding rows
  findingValueLabel: "Wartość",
  historyButton: "Historia i źródła",
  hideHistoryButton: "Ukryj historię",
  historyHeading: "Historia zmian (od najstarszej)",
  currentRevisionBadge: "aktualne",
  originLabels: {
    publication: "publikacja z wiadomości",
    correction: "korekta",
    withdrawal_marking: "oznaczenie po wycofaniu źródła",
    // E7 amendment (additive, flagged): a project reassignment's scope
    // re-assessment marking, rendered honestly (never as a withdrawal).
    reassignment_marking: "oznaczenie po przypisaniu źródła do innych projektów",
  } as const,
  revisionAuthorLabel: "zapisał",
  revisionReasonLabel: "powód",
  revisionSupersedesLabel: "zastępuje rewizję",
  evidenceHeading: "Dowody (źródła):",
  evidenceLabels: {
    support: "wprost z wiadomości",
    independent_corroboration: "niezależne potwierdzenie",
    derivation: "wniosek agenta",
    supersession: "następuje po",
  } as const,
  evidenceWholeSource: "cała wiadomość",
  noEvidence: "Brak dowodów źródłowych przy tej rewizji.",
  sourceLinkLabel: "wiadomość źródłowa",
  // Direct correction (C2's audited command)
  correctButton: "Korekta bezpośrednia",
  correctHeading: "Korekta bezpośrednia ustalenia",
  correctIntro:
    "Zapisuje nowe rozstrzygnięcie z autorem, czasem i powodem. Poprzednia wartość zostaje w historii.",
  correctValueLabel: "Nowa wartość (tekst)",
  correctValuePlaceholder: "np. Dowóz płytek w czwartek rano",
  correctReasonLabel: "Powód korekty",
  correctReasonPlaceholder: "np. Klient przesunął termin telefonicznie.",
  correctSubmit: "Zapisz korektę",
  correctSaving: "Zapisywanie…",
  correctDone: "Korekta zapisana. Historia zachowana.",
  correctConflict:
    "Ustalenie zmieniło się w międzyczasie (ktoś inny je poprawił). Odśwież historię i spróbuj ponownie.",
  cancel: "Anuluj",
  // Clarifications
  clarificationsHeading: "Sprawy do wyjaśnienia",
  clarificationsIntro:
    "Pytania agenta o sprzeczności i niejednoznaczności. Rozstrzygnięcie ma autora i zostaje w historii.",
  noClarifications: "Brak spraw do wyjaśnienia w tym zakresie.",
  clarificationOpen: "nierozstrzygnięte",
  clarificationResolved: "rozstrzygnięte",
  clarificationRaisedAt: "zadane",
  clarificationAnswerLabel: "Twoje rozstrzygnięcie",
  clarificationAnswerPlaceholder: "np. Obowiązuje kwota z czwartkowej rozmowy.",
  clarificationSubmit: "Odpowiedz",
  clarificationAnswering: "Zapisywanie…",
  clarificationResolvedBy: "rozstrzygnął",
  unknownResolverLabel: "nieznany autor",
  clarificationConflicting: "Sprzeczne źródła:",
} as const;

// ---------------------------------------------------------------------------
// Closed-error hints (load-bearing codes only; the server message shows else)
// ---------------------------------------------------------------------------

/** Extra Polish context for the machine codes this surface can meet. */
const failureHints: Partial<Record<string, string>> = {
  ...sessionFailureHints,
  revision_conflict:
    "Ustalenie zmieniło się w międzyczasie. Odśwież historię i spróbuj ponownie.",
  revision_mismatch:
    "Ustalenie zmieniło się w międzyczasie (ktoś inny je poprawił). Odśwież historię i spróbuj ponownie.",
  clarification_already_resolved:
    "Ta sprawa została już rozstrzygnięta. Odśwież widok.",
};

/** The notice text for one closed error code (hint or server message). */
export function failureHint(code: string | undefined, serverMessage: string): string {
  if (code === undefined) {
    return serverMessage;
  }
  return failureHints[code] ?? serverMessage;
}

// ---------------------------------------------------------------------------
// Wire-value renderers (contract-decoded -> plain Polish)
// ---------------------------------------------------------------------------

// The temporal-role, money-role, tax-basis and certainty renderings come
// from the findings domain's one label module
// (packages/domain/findings/labels.ts): the same Polish strings the work
// surface and the extension value editor render, from one source.

/** Renders one decoded temporal value WITH its role attribution (the finding
 * revision view); the plain rendering and the date-only bound live once in
 * the domain labels module. */
export function attributedTemporalLabel(temporal: TemporalValue): string {
  let when: string;
  switch (temporal.shape._tag) {
    case "day":
    case "month":
    case "year":
      when = dateOnlyLabel(temporal.shape);
      break;
    case "date_time":
      when = temporal.shape.value.toString();
      break;
    case "range": {
      const { start, end } = temporal.shape;
      when =
        start === null && end === null
          ? "zakres nieokreślony"
          : `od ${start === null ? "…" : dateOnlyLabel(start)} do ${end === null ? "…" : dateOnlyLabel(end)}`;
      break;
    }
  }
  return `${when} (${TEMPORAL_ROLE_LABELS[temporal.role]}; powiedziano: „${temporal.originalExpression}”)`;
}

/** Renders one decoded money value; estimates and tax basis stay visible. */
function moneyValueLabel(
  money: Extract<FindingValue, { _tag: "money" }>["money"],
): string {
  // BigDecimal.format is the plain decimal form (toString is a debug shape).
  const amount =
    money.amount._tag === "exact"
      ? `${BigDecimal.format(money.amount.value)} ${money.currency}`
      : `od ${money.amount.min === null ? "…" : BigDecimal.format(money.amount.min)} do ${
          money.amount.max === null ? "…" : BigDecimal.format(money.amount.max)
        } ${money.currency}`;
  return `${MONEY_ROLE_LABELS[money.role]}: ${amount}, ${TAX_BASIS_LABELS[money.taxBasis]}, ${MONEY_CERTAINTY_LABELS[money.certainty]}`;
}

/**
 * Renders one finding's value. The wire form decodes through the contract's
 * `FindingValue` first (the from-string leaf schemas accept the encoded
 * shapes the public read carries); malformed values throw instead of
 * rendering a guess.
 */
export function findingValueLabel(value: unknown): string {
  const decoded = Schema.decodeUnknownSync(FindingValue)(value);
  switch (decoded._tag) {
    case "temporal":
      return attributedTemporalLabel(decoded.temporal);
    case "money":
      return moneyValueLabel(decoded.money);
    case "text_note":
      return decoded.text;
    case "extension":
      return `dodatkowa informacja (${decoded.definitionVersionId})`;
  }
}

/**
 * Renders one finding's knowledge state; the wire form decodes through the
 * contract's `KnowledgeState` first. `conflicted` and `updating` (C5) are
 * the two states that must never read as settled facts — their labels say
 * so explicitly, with the recorded reason.
 */
export function knowledgeStateLabel(state: unknown): string {
  const decoded = Schema.decodeUnknownSync(KnowledgeState)(state);
  switch (decoded._tag) {
    case "known":
      return "ustalone";
    case "unknown":
      return `nieustalone (${decoded.reason})`;
    case "conflicted":
      return "sprzeczne — wymaga rozstrzygnięcia, nie jest ustaloną wartością";
    case "updating":
      return `wymaga ponownego potwierdzenia — podstawa się zmieniła (${decoded.reason}); nie steruje automatyzacjami`;
    case "not_applicable":
      return "nie dotyczy";
  }
}

/** Whether one knowledge state is a settled fact (drives the honest badge). */
export function isSettledKnowledgeState(state: unknown): boolean {
  const decoded = Schema.decodeUnknownSync(KnowledgeState)(state);
  return decoded._tag === "known";
}
