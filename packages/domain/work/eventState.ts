/**
 * Event state rules (C4 domain half, pure).
 *
 * Vocabulary ("Zdarzenie", "Stan zdarzenia", CONTEXT.md): a delivery,
 * meeting or other element of the work's course, for which known dates and
 * facts are recorded. An event may have linked tasks, but by itself it
 * assigns nobody an action. Its state is Planowane, Odbyło się or
 * Anulowane, and "Upływ planowanej daty nie potwierdza, że zdarzenie
 * nastąpiło".
 *
 * Rules encoded here (issue 9, "Zadanie i zdarzenie"):
 *
 * - An event is NOT a task: no executor, no coordinator, no checklist, no
 *   overdue obligation. A date in a statement creates an event; only an
 *   explicit obligation ("Piotrek ma odebrać dostawę") creates a task,
 *   which may be linked to the event and share its dated finding.
 * - Occurrence and cancellation are explicit facts (a source message or a
 *   boss's direct change with author, time and history). The decision
 *   consumes ONLY the current and the commanded state: there is no date
 *   or clock parameter, so "the planned date passed, therefore it
 *   occurred" is unrepresentable here.
 */

import type { EventOccurrenceState } from "@kiero/contracts";
import type { Validated } from "../projects/result";

/** Polish product rendering of every event state token. */
export const EVENT_STATE_LABELS: Readonly<Record<EventOccurrenceState, string>> = {
  planned: "Planowane",
  occurred: "Odbyło się",
  cancelled: "Anulowane",
};

/** Bounded event title. */
export const MAX_EVENT_TITLE_LENGTH = 200;

/** An event title names the occurrence; whitespace-only is not one. */
export function validateEventTitle(
  title: string,
): Validated<string, "event_title_empty" | "event_title_too_long"> {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "event_title_empty" };
  }
  if (trimmed.length > MAX_EVENT_TITLE_LENGTH) {
    return { ok: false, code: "event_title_too_long" };
  }
  return { ok: true, value: trimmed };
}

/**
 * What one explicit event state command does.
 *
 * - `unchanged`: same state commanded; nothing changes.
 * - `transition`: an explicit move between the three states. Every pairing
 *   is total: a cancelled delivery may be corrected back to planned, an
 *   occurred one may be corrected — explicit corrections keep history.
 */
export type EventStateChangeDecision =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "transition";
      readonly from: EventOccurrenceState;
      readonly to: EventOccurrenceState;
    };

/**
 * Decides one explicit event state command. The signature carries no
 * time: elapsed planned dates cannot enter this decision.
 */
export function decideEventStateChange(
  current: EventOccurrenceState,
  target: EventOccurrenceState,
): EventStateChangeDecision {
  if (current === target) {
    return { kind: "unchanged" };
  }
  return { kind: "transition", from: current, to: target };
}
