/**
 * Conversation feature state (H1): Polish copy, the wire-value renderers for
 * memory rows, and the closed-error classification for the conversation and
 * memory surfaces.
 *
 * The send-path copy, renderers and failure hints graduate from J1's
 * core-text feature (apps/web/src/features/core-text was the first
 * text-to-memory loop; H1 replaces that mount with the full conversation
 * UI). The renderers decode the ENCODED (wire) forms the public reads carry
 * through the exported contract schemas at the boundary, then switch over
 * the DECODED values: every switch is exhaustiveness-checked and the label
 * maps are typed by the contract's closed vocabularies — a vocabulary
 * change fails the build instead of rendering a raw machine code. The copy
 * renders exactly what is there: no hour is invented for a day, an estimate
 * never becomes an exact figure, `not_specified` tax basis stays visible,
 * and a conflicted or updating finding can never read as settled.
 *
 * C5's `updating` knowledge state ("wymaga ponownego potwierdzenia —
 * podstawa się zmieniła") is rendered here with its reason: such a finding
 * is visibly NOT a settled fact and blocks affected automation.
 */

import { BigDecimal, Schema } from "effect";
import {
  FindingValue,
  KnowledgeState,
  MoneyCertainty,
  MoneyRole,
  TaxBasis,
  TemporalRole,
  type DateOnly,
  type TemporalValue,
} from "@kiero/contracts";
import { signInCopy } from "../sign-in/state";
import type { SourceProcessingState as SourceProcessingType } from "../../../../../convex/sources/read/rows";
import type { SourceLifecycle as SourceLifecycleType } from "../../../../../convex/sources/read/rows";

export { signInCopy };

// ---------------------------------------------------------------------------
// Polish copy (stable product text)
// ---------------------------------------------------------------------------

/** Copy for the conversation surface (company + project projections). */
export const conversationCopy = {
  title: "Rozmowa firmy",
  projectTitle: "Rozmowa projektowa",
  intro:
    "Napisz, co się dzieje w firmie i w projektach. Agent zapamięta ustalenia wraz ze źródłem.",
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured:
    "Adres backendu jest nieprawidłowy — aplikacja działa bez połączenia.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  noCompanyHeading: "Nie należysz jeszcze do żadnej firmy",
  noCompanyIntro:
    "Aby wysyłać wiadomości, najpierw załóż firmę lub przyjmij zaproszenie na ekranie Firma.",
  noCompanyLink: "Przejdź do ekranu Firma",
  // Scope switch
  scopeCompanyLabel: "Widok: cała firma",
  scopeProjectLabel: "Widok: projekt",
  scopeSwitchHint:
    "Rozmowa projektowa to te same wiadomości — jeden oryginał, jeden autor, wszędzie.",
  // Send form
  sendHeading: "Wyślij wiadomość źródłową",
  sendTextLabel: "Treść wiadomości",
  sendTextPlaceholder: "np. Projekt Banan: dowóz płytek w środę rano, klient potwierdził odbiór.",
  sendProjectsLabel: "Projekty, których dotyczy (podpowiedzi dla agenta)",
  sendButton: "Wyślij",
  sending: "Wysyłanie…",
  savedNotice: "Wiadomość zapisana. Agent przetwarza…",
  processingNotice: "Agent przetwarza wiadomość…",
  processedNotice: "Pamięć zaktualizowana.",
  failedNotice:
    "Przetwarzanie nie udało się. Wiadomość jest zapisana: nic nie przepadło, a przetwarzanie można później ponowić.",
  partialNotice: "Część materiałów tej wiadomości czeka jeszcze na przetworzenie.",
  lostResponseNotice:
    "Odpowiedź zaginęła podczas wysyłania. Wiadomość mogła zostać zapisana — ponowne kliknięcie „Wyślij” nie utworzy duplikatu.",
  correctionNote:
    "Korekta ustalenia to jawne rozstrzygnięcie zmieniające informację w pamięci, z własnym autorem i czasem. Nie przepisuje wcześniejszej wiadomości źródłowej — napisz wyraźnie, co się zmienia, a agent zaktualizuje pamięć zachowując historię.",
  correctionButton: "Popraw tę wiadomość",
  correctionActiveNotice:
    " Piszesz korektę wcześniejszej wiadomości. Wyślij ją jako zwykłą wiadomość — poprzednia pozostaje w historii.",
  cancel: "Anuluj",
  // Conversation list
  conversationHeading: "Historia wiadomości",
  projectConversationHeading: "Wiadomości tego projektu",
  noMessages: "Brak wiadomości w tym widoku. Wyślij pierwszą powyżej.",
  messageAuthorLabel: "Wiadomość",
  unknownAuthorLabel: "Nieznany autor",
  unreadBadge: "nieprzeczytane",
  readBadge: "przeczytane",
  loadOlder: "Pokaż starsze wiadomości",
  deepLinkNotOnPage:
    "Ta wiadomość jest starsza niż obecnie wyświetlone. Załaduj starsze wiadomości, aby ją otworzyć.",
  projectCountSuffix: "projekty",
  // Source detail
  detailButton: "Szczegóły i źródło",
  detailHeading: "Jedna wiadomość źródłowa",
  detailSentAt: "Wysłano",
  detailAuthor: "Autor",
  detailProjects: "Projekty",
  detailNoProjects: "Brak powiązanych projektów (wiedza ogólna firmy).",
  detailState: "Stan przetwarzania",
  detailLinkLabel: "Bezpośredni odnośnik do tej wiadomości (działa w każdym widoku):",
  markReadFailure: "Nie udało się zapisać stanu przeczytania. Spróbuj ponownie.",
} as const;

/** Copy for the memory surface (current findings, history, clarifications). */
export const memoryCopy = {
  title: "Pamięć",
  intro:
    "Aktualne ustalenia odczytane bez powtórnego czytania rozmowy. Każde ustalenie ma swoje źródło i historię zmian.",
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
  // Connection gates (shared wording with the conversation surface)
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured:
    "Adres backendu jest nieprawidłowy — aplikacja działa bez połączenia.",
} as const;

/**
 * The processing-state vocabulary, derived from durable rows. The map is
 * TYPED by D1's `SourceProcessingState` (the producing schema), so the
 * authority flows from the schema to the copy: a state added or removed in
 * convex/sources/read/rows.ts fails this build, not a render.
 */
export const processingStateLabels: Record<SourceProcessingType, string> = {
  accepted: "przyjęta",
  processing: "przetwarzana",
  partial: "częściowo przetworzona",
  processed: "przetworzona",
  failed: "niepowodzenie przetwarzania",
};

export type ProcessingStateLabelKey = SourceProcessingType;

/** Source lifecycle labels (withdrawal keeps history, CONTEXT.md). */
export const lifecycleLabels: Partial<Record<SourceLifecycleType, string>> = {
  withdrawn: "wycofana (nie jest podstawą aktualnych ustaleń; historia zachowana)",
  purged: "trwale usunięta",
};

// ---------------------------------------------------------------------------
// Closed-error hints (load-bearing codes only; the server message shows else)
// ---------------------------------------------------------------------------

/** Extra Polish context for the machine codes these surfaces can meet. */
const failureHints: Partial<Record<string, string>> = {
  no_verified_identity:
    "Sesja nie działa. Zaloguj się ponownie — wiadomość nie została wysłana.",
  session_inactive: "Sesja wygasła. Zaloguj się ponownie — wiadomość nie została wysłana.",
  upload_not_owned_by_actor:
    "Szkic wysyłki należy do innej osoby. Zacznij wiadomość od nowa.",
  draft_expired_restart_required:
    "Szkic wysyłki wygasł. Wyślij wiadomość jeszcze raz — treść zachowana w formularzu.",
  stale_plan:
    "Ustalenie zmieniło się w międzyczasie. Odśwież pamięć i spróbuj ponownie.",
  revision_conflict:
    "Ustalenie zmieniło się w międzyczasie. Odśwież historię i spróbuj ponownie.",
  revision_mismatch:
    "Ustalenie zmieniło się w międzyczasie (ktoś inny je poprawił). Odśwież historię i spróbuj ponownie.",
  clarification_already_resolved:
    "Ta sprawa została już rozstrzygnięta. Odśwież widok.",
  network: signInCopy.failures.network,
};

/** The notice text for one closed error code (hint or server message). */
export function failureHint(code: string, serverMessage: string): string {
  return failureHints[code] ?? serverMessage;
}

/**
 * The just-sent notice for the source's derived processing state. Every
 * state is distinct: `partial` (some required segments of a multi-material
 * message still pending) must never read as the failed copy — the day D1
 * derives it, the boss is told part of the work succeeded.
 */
export function justSentNotice(state: SourceProcessingType): string {
  switch (state) {
    case "accepted":
    case "processing":
      return conversationCopy.processingNotice;
    case "partial":
      return conversationCopy.partialNotice;
    case "processed":
      return conversationCopy.processedNotice;
    case "failed":
      return conversationCopy.failedNotice;
  }
}

// ---------------------------------------------------------------------------
// Wire-value renderers (contract-decoded -> plain Polish)
// ---------------------------------------------------------------------------

/** Polish role names for temporal values (the contract's closed vocabulary). */
const temporalRoleLabels: Record<TemporalRole, string> = {
  proposed: "propozycja",
  internal: "plan wewnętrzny",
  agreed: "uzgodnione",
  actual: "stan faktyczny",
};

/** Polish role names for money values (the contract's closed vocabulary). */
const moneyRoleLabels: Record<MoneyRole, string> = {
  price_proposal: "wycena",
  agreed_price: "uzgodniona cena",
  material_cost: "koszt materiałów",
  deposit_received: "otrzymana zaliczka",
  estimated_labor: "szacunek robocizny",
};

const taxBasisLabels: Record<TaxBasis, string> = {
  net: "netto",
  gross: "brutto",
  not_specified: "podatek nieokreślony",
};

const certaintyLabels: Record<MoneyCertainty, string> = {
  exact: "kwota dokładna",
  estimate: "kwota szacunkowa",
};

/** Renders one decoded date-only bound; no component is invented. */
function dateOnlyLabel(bound: DateOnly): string {
  switch (bound._tag) {
    case "day":
      return bound.day;
    case "month":
      return `${bound.month} (do danego miesiąca)`;
    case "year":
      return `${bound.year} (do danego roku)`;
  }
}

/** Renders one decoded temporal value: calendar facts plus the original words. */
function temporalValueLabel(temporal: TemporalValue): string {
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
  return `${when} (${temporalRoleLabels[temporal.role]}; powiedziano: „${temporal.originalExpression}”)`;
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
  return `${moneyRoleLabels[money.role]}: ${amount}, ${taxBasisLabels[money.taxBasis]}, ${certaintyLabels[money.certainty]}`;
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
      return temporalValueLabel(decoded.temporal);
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

// ---------------------------------------------------------------------------
// Shared view helpers
// ---------------------------------------------------------------------------

/** Renders one instant in the firm's Polish locale (no invented precision). */
export function instantLabel(ms: number): string {
  return new Date(ms).toLocaleString("pl-PL");
}

// ---------------------------------------------------------------------------
// The F1 read-state projection shape (decoded at the untrusted boundary)
// ---------------------------------------------------------------------------

/**
 * The wire shape of `attention.read_state.queries.readStateForSources`'s
 * ok value: this person's state per canonical source id. Decoding here
 * keeps the same boundary discipline as the conversation page schema — a
 * drift in the projection's shape fails the decode, not a render.
 */
export const ReadStateProjection = Schema.Struct({
  userId: Schema.String,
  entries: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      read: Schema.Boolean,
      readAtMs: Schema.NullOr(Schema.Number),
    }),
  ),
});
export type ReadStateProjection = Schema.Schema.Type<typeof ReadStateProjection>;

/**
 * The correction prefill: a NEW message that references the old source
 * (CONTEXT.md "Korekta ustalenia" — the earlier message is never rewritten).
 * The reference quotes the original's own words and send time.
 */
export function correctionPrefill(originalText: string, sentAtMs: number): string {
  const quoted = originalText.length > 160 ? `${originalText.slice(0, 160)}…` : originalText;
  return `Poprawka do wiadomości z ${instantLabel(sentAtMs)}: „${quoted}”. Co się zmienia: `;
}
