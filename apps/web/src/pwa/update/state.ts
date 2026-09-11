/**
 * The PWA update surface's Polish copy (I7): the update prompt shown only
 * at a safe point, and the closed vocabulary the update flow reports.
 *
 * Product text follows CONTEXT.md exactly: the composer's local state is
 * the "szkic" (a draft that is local until the server confirms), and the
 * thing being updated is the Kiero application the boss is looking at.
 * The copy never claims more safety than the mechanism provides: what is
 * promised is that the szkic stays recoverable on this device, which is
 * exactly what the incremental draft store plus the pre-update
 * persist/migrate step guarantee.
 */

/** Copy for the update prompt (barebones, semantic, no styling). */
export const updateCopy = {
  /** region landmark label for the injected prompt. */
  regionLabel: "Aktualizacja Kiero",
  availableHeading: "Dostępna jest nowa wersja Kiero",
  availableBody:
    "Nowa wersja aplikacji jest gotowa. Twój szkic wpisu jest zachowany na tym urządzeniu i wróci po odświeżeniu strony.",
  availableButton: "Odśwież teraz",
  requiredHeading: "Wymagana aktualizacja Kiero",
  requiredBody:
    "Ta wersja aplikacji nie jest już obsługiwana przez serwer. Odśwież stronę, aby dalej korzystać z Kiero. Twój szkic pozostaje dostępny na tym urządzeniu.",
  requiredButton: "Zaktualizuj teraz",
} as const;

/** Which prompt the flow is allowed to show right now. */
export type UpdatePromptKind = "available" | "required";

/** The update flow's observable state (diagnostics and tests read this). */
export interface UpdateFlowState {
  /** The strongest detected update: none, a waiting worker, or an unsupported client. */
  readonly detected: "none" | "waiting-worker" | "unsupported-client";
  /** Why the prompt is currently not shown (empty string when shown). */
  readonly deferredReason: "" | "held-by-work" | "recent-input" | "not-visible";
  readonly promptShown: false | UpdatePromptKind;
  /** Urgent signals arrived (session revocation and friends); never gated. */
  readonly urgentSignals: readonly string[];
  /** What the pre-update draft migration concluded (null when not yet run). */
  readonly draftMigration: string | null;
  /** How many times the user-triggered reload ran (0 until confirmed). */
  readonly reloads: number;
}
