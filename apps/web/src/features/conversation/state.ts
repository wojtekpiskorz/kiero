/**
 * Conversation feature state (H1): Polish copy and the closed-error
 * classification for the conversation surface.
 *
 * The send-path copy and failure hints graduate from J1's core-text
 * feature (apps/web/src/features/core-text was the first text-to-memory
 * loop; H1 replaced that mount with the full conversation UI). The copy
 * renders exactly what is there: no hour is invented for a day, and a
 * conflicted or updating finding can never read as settled (those finding
 * renderers live in the memory feature's own state, ../memory/state.ts).
 *
 * This module also carries the pieces every company surface shares: the
 * `signInCopy` re-export, `instantLabel`, and the generic session hints
 * (composed into the memory feature's hints too).
 */

import { Schema } from "effect";
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
  checkingSession: "Sprawdzamy Twoją sesję…",
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
  // Agent answer (J2: E6's loop joined into this surface)
  answerRefused:
    "Agent nie mógł rozpocząć odpowiedzi (brak uprawnień albo sesja wygasła). Zaloguj się ponownie i spróbuj jeszcze raz.",
  answerMissingSource: "Ta wiadomość nie jest już dostępna — agent nie może o nią pytać.",
  answerUnavailable:
    "Nie udało się uzyskać odpowiedzi agenta. Pamięć nie została zmieniona — spróbuj ponownie.",
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

/**
 * Generic session-failure hints every company surface can meet (the memory
 * feature's hints compose these; conversation's own hints below do too).
 */
export const sessionFailureHints: Partial<Record<string, string>> = {
  no_verified_identity:
    "Sesja nie działa. Zaloguj się ponownie — wiadomość nie została wysłana.",
  session_inactive: "Sesja wygasła. Zaloguj się ponownie — wiadomość nie została wysłana.",
  network: signInCopy.failures.network,
};

/** Extra Polish context for the machine codes this surface can meet. */
const failureHints: Partial<Record<string, string>> = {
  ...sessionFailureHints,
  upload_not_owned_by_actor:
    "Szkic wysyłki należy do innej osoby. Zacznij wiadomość od nowa.",
  draft_expired_restart_required:
    "Szkic wysyłki wygasł. Wyślij wiadomość jeszcze raz — treść zachowana w formularzu.",
  stale_plan:
    "Ustalenie zmieniło się w międzyczasie. Odśwież pamięć i spróbuj ponownie.",
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

// ---------------------------------------------------------------------------
// The agent answer payload (J2: E6's askAgent result, decoded at the
// untrusted boundary and rendered with glossary-exact labels)
// ---------------------------------------------------------------------------

/**
 * The wire shape of `agent/loop:askAgent`'s AnswerRunResult this surface
 * renders. The rendering subset only: versions and the full turn log stay
 * with the GM processing inspector; what the boss reads is the outcome,
 * the structured answer with its evidence, the raised Sprawy do wyjaśnienia,
 * the domain changes and the honesty line about model work.
 */
export const AnswerRunWire = Schema.Struct({
  outcome: Schema.Literals(["answered", "clarified", "gave_up", "provider_failed"]),
  answer: Schema.NullOr(
    Schema.Struct({
      answerText: Schema.String,
      statements: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          basis: Schema.Literals(["direct", "corroboration", "inference"]),
          evidenceIds: Schema.Array(Schema.String),
          derivedFromFindingIds: Schema.Array(Schema.String),
        }),
      ),
      disclosures: Schema.Struct({
        updatingFindingIds: Schema.Array(Schema.String),
        processingSourceIds: Schema.Array(Schema.String),
      }),
    }),
  ),
  clarificationsRaised: Schema.Array(
    Schema.Struct({ clarificationId: Schema.String, question: Schema.String }),
  ),
  changes: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["task", "event"]),
      operation: Schema.String,
      entityId: Schema.String,
      revision: Schema.Number,
    }),
  ),
  evidence: Schema.Array(
    Schema.Struct({
      evidenceId: Schema.String,
      sourceId: Schema.String,
      quote: Schema.String,
      groundsUpdating: Schema.Boolean,
    }),
  ),
  turns: Schema.Number,
  refreshes: Schema.Number,
  observedModels: Schema.Array(Schema.String),
  finalText: Schema.String,
  failure: Schema.optional(Schema.String),
});
export type AnswerRunWire = Schema.Schema.Type<typeof AnswerRunWire>;

/** Copy for the agent-answer panel (J2; glossary terms exact). */
export const answerCopy = {
  askButton: "Zapytaj agenta o tę wiadomość",
  asking: "Agent szuka odpowiedzi w źródłach firmy…",
  heading: "Odpowiedź agenta",
  clarifiedHeading: "Sprawa do wyjaśnienia",
  clarifiedNote:
    "Agent nie mógł rozstrzygnąć pytania na podstawie źródeł. Sprawa jest wspólna dla szefów — rozstrzygnij ją w pamięci albo w Co teraz.",
  basisLabels: {
    direct: "bezpośrednio w źródle",
    corroboration: "potwierdzone niezależnie",
    inference: "wniosek agenta",
  } as const,
  disclosuresHeading: "Zastrzeżenia",
  disclosureUpdating: (count: number) =>
    `Dotyka ${count} ustaleń w trakcie zmiany — podanych informacji nie traktuj jako ustalonych.`,
  disclosureProcessing: (count: number) =>
    `${count} wiadomości źródłowych jest jeszcze w trakcie przetwarzania.`,
  changesHeading: "Zmiany wykonane przez agenta",
  changeLabels: { task: "zadanie", event: "zdarzenie" } as const,
  gaveUp:
    "Agent nie udzielił odpowiedzi. Wiadomości i pamięć nie zostały zniszczone — spróbuj zadać pytanie inaczej.",
  providerFailed: (kind: string) =>
    `Dostawca modelu nie odpowiedział (${kind}). Pytanie nie zmieniło pamięci — spróbuj ponownie.`,
  modelsLine: (models: readonly string[], turns: number, refreshes: number) =>
    `Modele: ${models.join(", ")}. Tur: ${turns}${refreshes > 0 ? `, odświeżeń kontekstu: ${refreshes}` : ""}.`,
  evidenceQuoteLabel: "Źródło:",
} as const;

/** The honest outcome heading/notice for one answer run. */
export function answerOutcomeLabel(run: AnswerRunWire): string {
  switch (run.outcome) {
    case "answered":
      return answerCopy.heading;
    case "clarified":
      return answerCopy.clarifiedHeading;
    case "gave_up":
      return answerCopy.gaveUp;
    case "provider_failed":
      return answerCopy.providerFailed(run.failure ?? "nieznany");
  }
}

/** One statement's basis label (glossary: Wniosek agenta stays marked). */
export function answerBasisLabel(basis: "direct" | "corroboration" | "inference"): string {
  return answerCopy.basisLabels[basis];
}

