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
  memoryScopeProjectPlaceholder: "Projekt…",
  memoryNoProjectSelected: "Wybierz zakres: cała firma albo jeden projekt.",
  noFindings: "Brak ustaleń w tym zakresie.",
} as const;

/** The honest processing-state vocabulary (derived from durable rows). */
export const processingStateLabels = {
  accepted: "przyjęta",
  processing: "przetwarzana",
  partial: "częściowo przetworzona",
  processed: "przetworzona",
  failed: "niepowodzenie przetwarzania",
} as const;

export type ProcessingStateLabelKey = keyof typeof processingStateLabels;

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

/** Renders one date-only wire bound; no component is invented. */
function dateOnlyLabel(bound: { readonly _tag: string } & Record<string, unknown>): string {
  switch (bound._tag) {
    case "day":
      return String(bound.day);
    case "month":
      return `${String(bound.month)} (do danego miesiąca)`;
    case "year":
      return `${String(bound.year)} (do danego roku)`;
    default:
      return "nieznana data";
  }
}

/** Renders a temporal wire value: resolved calendar facts plus the original words. */
export function temporalValueLabel(temporal: {
  readonly shape: { readonly _tag: string } & Record<string, unknown>;
  readonly originalExpression: string;
  readonly role: string;
}): string {
  const shape = temporal.shape;
  let when: string;
  switch (shape._tag) {
    case "day":
    case "month":
    case "year":
      when = dateOnlyLabel(shape);
      break;
    case "date_time":
      when = String(shape.value);
      break;
    case "range": {
      const start = shape.start === null ? null : dateOnlyLabel(shape.start as never);
      const end = shape.end === null ? null : dateOnlyLabel(shape.end as never);
      when = start === null && end === null
        ? "zakres nieokreślony"
        : `od ${start ?? "…"} do ${end ?? "…"}`;
      break;
    }
    default:
      when = "nieznana data";
  }
  const role = temporalRoleLabels[temporal.role] ?? temporal.role;
  return `${when} (${role}; powiedziano: „${temporal.originalExpression}”)`;
}

/** Renders a money wire value; estimates and tax basis stay visible. */
export function moneyValueLabel(money: {
  readonly role: string;
  readonly amount: { readonly _tag: string } & Record<string, unknown>;
  readonly currency: string;
  readonly taxBasis: string;
  readonly certainty: string;
}): string {
  const amount =
    money.amount._tag === "exact"
      ? `${String(money.amount.value)} ${money.currency}`
      : `od ${money.amount.min === null ? "…" : String(money.amount.min)} do ${
          money.amount.max === null ? "…" : String(money.amount.max)
        } ${money.currency}`;
  const role = moneyRoleLabels[money.role] ?? money.role;
  const tax = taxBasisLabels[money.taxBasis] ?? money.taxBasis;
  const certainty = certaintyLabels[money.certainty] ?? money.certainty;
  return `${role}: ${amount}, ${tax}, ${certainty}`;
}

/** Renders one finding's ENCODED value (the public read's wire form). */
export function findingValueLabel(value: { readonly _tag: string } & Record<string, unknown>): string {
  switch (value._tag) {
    case "temporal":
      return temporalValueLabel(value.temporal as never);
    case "money":
      return moneyValueLabel(value.money as never);
    case "text_note":
      return String(value.text);
    case "extension":
      return `dodatkowa informacja (${String(value.definitionVersionId)})`;
    default:
      return "wartość nieznanej postaci";
  }
}

/** Renders one finding's ENCODED knowledge state. */
export function knowledgeStateLabel(state: { readonly _tag: string } & Record<string, unknown>): string {
  switch (state._tag) {
    case "known":
      return "ustalone";
    case "unknown":
      return `nieustalone (${String(state.reason)})`;
    case "conflicted":
      return "sprzeczne — wymaga rozstrzygnięcia";
    case "not_applicable":
      return "nie dotyczy";
    default:
      return "stan nieznany";
  }
}
