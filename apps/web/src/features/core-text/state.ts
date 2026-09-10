/**
 * Core-text feature state (J1): Polish copy, the wire-value renderers for
 * current memory, and the closed-error classification for the first
 * text-to-memory surface.
 *
 * The renderers translate the ENCODED (wire) forms the public reads carry
 * (`convex/memory/findings/read.ts` returns encoded rows by contract) into
 * plain Polish product text. They render exactly what is there: no hour is
 * invented for a day, an estimate never becomes an exact figure, and
 * `not_specified` tax basis stays visible (the value contracts' rules, as
 * product copy).
 *
 * Operation results arrive as `ResultEnvelope`s; closed errors map to the
 * server's Polish message plus hints for the load-bearing machine codes,
 * exactly like the membership surface.
 */

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
  lostResponseNotice:
    "Odpowiedź zaginęła podczas wysyłania. Wiadomość mogła zostać zapisana — ponowne kliknięcie „Wyślij” nie utworzy duplikatu.",
  correctionNote:
    "Poprawka ustalenia to nowa wiadomość: napisz wyraźnie, co się zmienia, a agent zaktualizuje pamięć zachowując historię.",
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

// ---------------------------------------------------------------------------
// Wire-value renderers (encoded shapes -> plain Polish)
// ---------------------------------------------------------------------------

/** Polish role names for temporal values (issue 8 vocabulary). */
const temporalRoleLabels: Record<string, string> = {
  proposed: "propozycja",
  internal: "plan wewnętrzny",
  agreed: "uzgodnione",
  actual: "stan faktyczny",
};

/** Polish role names for money values (issue 8 vocabulary). */
const moneyRoleLabels: Record<string, string> = {
  price_proposal: "wycena",
  agreed_price: "uzgodniona cena",
  material_cost: "koszt materiałów",
  deposit_received: "otrzymana zaliczka",
  estimated_labor: "szacunek robocizny",
};

const taxBasisLabels: Record<string, string> = {
  net: "netto",
  gross: "brutto",
  not_specified: "podatek nieokreślony",
};

const certaintyLabels: Record<string, string> = {
  exact: "kwota dokładna",
  estimate: "kwota szacunkowa",
};

/**
 * Narrows one untrusted wire object to a record; null otherwise. The public
 * reads carry `value`/`knowledgeState` as `unknown` (their wire forms are
 * the ENCODED contract shapes), so the renderers narrow at the boundary
 * instead of trusting a hand-declared structural type.
 */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** The discriminant of one narrowed wire record, when it is a string. */
function tagOf(value: Record<string, unknown>): string | null {
  return typeof value._tag === "string" ? value._tag : null;
}

/** Renders one date-only wire bound; no component is invented. */
function dateOnlyLabel(bound: unknown): string {
  const shape = record(bound);
  const tag = shape === null ? null : tagOf(shape);
  if (shape === null || tag === null) {
    return "nieznana data";
  }
  switch (tag) {
    case "day":
      return String(shape.day);
    case "month":
      return `${String(shape.month)} (do danego miesiąca)`;
    case "year":
      return `${String(shape.year)} (do danego roku)`;
    default:
      return "nieznana data";
  }
}

/** Renders a temporal wire value: resolved calendar facts plus the original words. */
export function temporalValueLabel(wire: unknown): string {
  const temporal = record(wire);
  const shape = temporal === null ? null : record(temporal.shape);
  if (
    temporal === null ||
    shape === null ||
    typeof temporal.originalExpression !== "string" ||
    typeof temporal.role !== "string"
  ) {
    return "wartość nieznanej postaci";
  }
  const shapeTag = tagOf(shape);
  let when: string;
  if (shapeTag === null) {
    when = "nieznana data";
  } else {
    switch (shapeTag) {
      case "day":
      case "month":
      case "year":
        when = dateOnlyLabel(shape);
        break;
      case "date_time":
        when = String(shape.value);
        break;
      case "range": {
        const start = shape.start === null ? null : dateOnlyLabel(shape.start);
        const end = shape.end === null ? null : dateOnlyLabel(shape.end);
        when = start === null && end === null
          ? "zakres nieokreślony"
          : `od ${start ?? "…"} do ${end ?? "…"}`;
        break;
      }
      default:
        when = "nieznana data";
    }
  }
  const role = temporalRoleLabels[temporal.role] ?? temporal.role;
  return `${when} (${role}; powiedziano: „${temporal.originalExpression}”)`;
}

/** Renders a money wire value; estimates and tax basis stay visible. */
export function moneyValueLabel(wire: unknown): string {
  const money = record(wire);
  const amount = money === null ? null : record(money.amount);
  if (
    money === null ||
    amount === null ||
    tagOf(amount) === null ||
    typeof money.currency !== "string" ||
    typeof money.role !== "string" ||
    typeof money.taxBasis !== "string" ||
    typeof money.certainty !== "string"
  ) {
    return "wartość nieznanej postaci";
  }
  const exact = tagOf(amount) === "exact";
  const rendered = exact
    ? `${String(amount.value)} ${money.currency}`
    : `od ${amount.min === null ? "…" : String(amount.min)} do ${
        amount.max === null ? "…" : String(amount.max)
      } ${money.currency}`;
  const role = moneyRoleLabels[money.role] ?? money.role;
  const tax = taxBasisLabels[money.taxBasis] ?? money.taxBasis;
  const certainty = certaintyLabels[money.certainty] ?? money.certainty;
  return `${role}: ${rendered}, ${tax}, ${certainty}`;
}

/** Renders one finding's ENCODED value (the public read's wire form). */
export function findingValueLabel(value: unknown): string {
  const wire = record(value);
  const tag = wire === null ? null : tagOf(wire);
  if (wire === null || tag === null) {
    return "wartość nieznanej postaci";
  }
  switch (tag) {
    case "temporal":
      return temporalValueLabel(wire.temporal);
    case "money":
      return moneyValueLabel(wire.money);
    case "text_note":
      return String(wire.text);
    case "extension":
      return `dodatkowa informacja (${String(wire.definitionVersionId)})`;
    default:
      return "wartość nieznanej postaci";
  }
}

/** Renders one finding's ENCODED knowledge state. */
export function knowledgeStateLabel(state: unknown): string {
  const wire = record(state);
  const tag = wire === null ? null : tagOf(wire);
  if (wire === null || tag === null) {
    return "stan nieznany";
  }
  switch (tag) {
    case "known":
      return "ustalone";
    case "unknown":
      return `nieustalone (${String(wire.reason)})`;
    case "conflicted":
      return "sprzeczne — wymaga rozstrzygnięcia";
    case "not_applicable":
      return "nie dotyczy";
    default:
      return "stan nieznany";
  }
}
