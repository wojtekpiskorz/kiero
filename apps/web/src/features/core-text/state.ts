/**
 * Core-text feature state (J1): Polish copy, the wire-value renderers for
 * current memory, and the closed-error classification for the first
 * text-to-memory surface.
 *
 * The renderers decode the ENCODED (wire) forms the public reads carry
 * (`convex/memory/findings/read.ts` returns encoded rows by contract)
 * through the exported contract schemas at the boundary, then switch over
 * the DECODED values: the leaf schemas are the from-string variants, so the
 * wire forms decode straight through, every switch is
 * exhaustiveness-checked, and the label maps are typed by the contract's
 * closed vocabularies — a vocabulary change fails the build instead of
 * rendering a raw machine code. The copy renders exactly what is there: no
 * hour is invented for a day, an estimate never becomes an exact figure,
 * and `not_specified` tax basis stays visible.
 *
 * Operation results arrive as `ResultEnvelope`s; closed errors map to the
 * server's Polish message plus hints for the load-bearing machine codes,
 * exactly like the membership surface.
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

export { signInCopy };

// ---------------------------------------------------------------------------
// Polish copy (stable product text)
// ---------------------------------------------------------------------------

/** Copy for the core-text conversation surface. */
export const coreTextCopy = {
  title: "Rozmowa firmy",
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
  partialNotice:
    "Część materiałów tej wiadomości czeka jeszcze na przetworzenie.",
  lostResponseNotice:
    "Odpowiedź zaginęła podczas wysyłania. Wiadomość mogła zostać zapisana — ponowne kliknięcie „Wyślij” nie utworzy duplikatu.",
  // The glossary term and definition (CONTEXT.md "Korekta ustalenia"),
  // followed by the actionable instruction for this surface.
  correctionNote:
    "Korekta ustalenia to jawne rozstrzygnięcie zmieniające informację w pamięci, z własnym autorem i czasem. Nie przepisuje wcześniejszej wiadomości źródłowej — napisz wyraźnie, co się zmienia, a agent zaktualizuje pamięć zachowując historię.",
  // Conversation list
  conversationHeading: "Historia wiadomości",
  noMessages: "Brak wiadomości. Wyślij pierwszą powyżej.",
  messageAuthorLabel: "Wiadomość",
  // Memory
  memoryHeading: "Pamięć",
  memoryIntro:
    "Aktualne ustalenia odczytane bez powtórnego czytania rozmowy. Każde ustalenie ma swoje źródło i historię zmian.",
  memoryScopeCompany: "Firma",
  noFindings: "Brak ustaleń w tym zakresie.",
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

// ---------------------------------------------------------------------------
// Closed-error hints (load-bearing codes only; the server message shows else)
// ---------------------------------------------------------------------------

/** Extra Polish context for the machine codes this surface can meet. */
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
      return coreTextCopy.processingNotice;
    case "partial":
      return coreTextCopy.partialNotice;
    case "processed":
      return coreTextCopy.processedNotice;
    case "failed":
      return coreTextCopy.failedNotice;
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
 * contract's `KnowledgeState` first.
 */
export function knowledgeStateLabel(state: unknown): string {
  const decoded = Schema.decodeUnknownSync(KnowledgeState)(state);
  switch (decoded._tag) {
    case "known":
      return "ustalone";
    case "unknown":
      return `nieustalone (${decoded.reason})`;
    case "conflicted":
      return "sprzeczne — wymaga rozstrzygnięcia";
    case "updating":
      return `w trakcie ponownej oceny (${decoded.reason})`;
    case "not_applicable":
      return "nie dotyczy";
  }
}
