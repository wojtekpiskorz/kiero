/**
 * Project pause rules (C1 domain half, pure).
 *
 * Vocabulary ("Wstrzymanie projektu", CONTEXT.md): a temporary break in work
 * with a stated reason and an optional proposed resume date. It is SEPARATE
 * from the project stage and by itself changes no agreed deadlines.
 *
 * Rules encoded here:
 *
 * - A pause is a mark beside the stage, never a stage value and never a
 *   stage change: the decision below consumes the stage only to refuse
 *   pausing a project that is no longer being worked on, and it never
 *   produces a stage.
 * - The resume date is a PROPOSAL (a local calendar day, calendar-verified
 *   by the contract's `LocalDate`). Its arrival implies nothing: actual
 *   resumption is an explicit clear by a boss or a clear statement (issue 9:
 *   "Nadejście planowanej daty wznowienia nie potwierdza, że prace ruszyły").
 *   No rule in this module reads the date.
 * - Deadlines live in findings and tasks, not in the pause mark; a pause
 *   decision cannot move them because it cannot see them.
 */

import type { ProjectPause, ProjectStage } from "@kiero/contracts";
import type { Validated } from "./result";

/** Bounded pause reason: a sentence, not a document. */
export const MAX_PAUSE_REASON_LENGTH = 500;

/** Pause reasons carry words; whitespace-only is not a reason. */
export function validatePauseReason(reason: string): Validated<string> {
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "pause_reason_empty" };
  }
  if (trimmed.length > MAX_PAUSE_REASON_LENGTH) {
    return { ok: false, code: "pause_reason_too_long" };
  }
  return { ok: true, value: trimmed };
}

/** What one pause command does to the project record. */
export type PauseChangeDecision =
  /** Explicitly clearing the mark (the only resume there is). */
  | { readonly kind: "clear" }
  /** Recording or replacing the reason (and optional proposed resume date). */
  | { readonly kind: "set" }
  /**
   * Pausing a closed project is meaningless: "czasowa przerwa w pracy"
   * presupposes work. The transaction maps this to a closed `conflict`.
   */
  | { readonly kind: "rejected_closed" };

/**
 * Decides one pause command against the CURRENT STAGE ONLY.
 *
 * Clearing is always allowed (harmless bookkeeping, also after closure);
 * setting is refused exactly when the project is closed. The stage is read,
 * never written: pause/stage separation is structural in this signature.
 */
export function decidePauseChange(
  currentStage: ProjectStage,
  pause: ProjectPause | null,
): PauseChangeDecision {
  if (pause === null) {
    return { kind: "clear" };
  }
  if (currentStage === "completed" || currentStage === "cancelled") {
    return { kind: "rejected_closed" };
  }
  return { kind: "set" };
}
