/**
 * Project stage rules (C1 domain half, pure).
 *
 * Vocabulary ("Etap projektu", CONTEXT.md): the fixed stage set from the
 * accepted lifecycle decision (issue 9) — Zapytanie, Przygotowanie oferty,
 * Oczekiwanie na decyzję, Uzgodnione, W realizacji, Zakończone, Anulowane.
 * The machine tokens come from the certified contract surface
 * (`ProjectStage` in @kiero/contracts); this module owns their Polish
 * rendering and every rule over them.
 *
 * Rules encoded here:
 *
 * - No stage exists for a pause. "Wstrzymanie projektu" is a separate mark
 *   (see ./pause.ts); a stage decision can never produce or consume one.
 * - No sequencing is enforced: a project may appear at ANY stage, and a clear
 *   explicit statement may move it anywhere in one step ("Projekt może
 *   pojawić się w Kiero na dowolnym etapie"; issue 9). There is deliberately
 *   no inquiry-before-agreed order.
 * - Closure (Zakończone = agreed scope performed; Anulowane = resignation
 *   from the assignment, also after partial work) moves the project off the
 *   active lists; reopen is an explicit transition back to an active stage.
 * - Nothing here derives a transition from silence, an elapsed date or the
 *   absence of open tasks: the decision consumes ONLY the current and the
 *   explicitly commanded target stage. Automatic closure is unrepresentable
 *   in this signature — that is the load-bearing property, not an omission.
 */

import type { ProjectStage } from "@kiero/contracts";

/** Polish product rendering of every stage token (CONTEXT.md vocabulary). */
export const PROJECT_STAGE_LABELS: Readonly<Record<ProjectStage, string>> = {
  inquiry: "Zapytanie",
  offer_preparation: "Przygotowanie oferty",
  awaiting_decision: "Oczekiwanie na decyzję",
  agreed: "Uzgodnione",
  in_progress: "W realizacji",
  completed: "Zakończone",
  cancelled: "Anulowane",
};

/** The stages that leave the active lists (issue 9: "Widoki zamkniętych projektów"). */
export const CLOSED_STAGES: readonly ProjectStage[] = ["completed", "cancelled"];

/** True when the stage is one of the closed stages. */
export function isClosedStage(stage: ProjectStage): boolean {
  return stage === "completed" || stage === "cancelled";
}

/**
 * What one explicit stage command does to the project record.
 *
 * - `unchanged`: same stage commanded; nothing changes (idempotent, no
 *   revision bump, no event).
 * - `move`: active stage to another active stage.
 * - `close`: active to closed; the closure instant is recorded.
 * - `reopen`: closed back to an active stage ("Powrót do pracy"); the closure
 *   instant clears and the project returns to the active lists.
 * - `reclassify`: one closed stage to the other (an explicit correction of
 *   WHAT ended the project, not WHEN); the original closure instant stays.
 */
export type StageChangeDecision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "move" }
  | { readonly kind: "close" }
  | { readonly kind: "reopen" }
  | { readonly kind: "reclassify" };

/**
 * Decides one explicit stage transition over the fixed vocabulary.
 *
 * The inputs are exactly the current stage and the commanded target: there
 * is no parameter through which silence, an elapsed date or "no open tasks"
 * could close a project. Every pairing of the seven stages is total.
 */
export function decideStageChange(
  current: ProjectStage,
  target: ProjectStage,
): StageChangeDecision {
  if (current === target) {
    return { kind: "unchanged" };
  }
  if (isClosedStage(current) && isClosedStage(target)) {
    return { kind: "reclassify" };
  }
  if (isClosedStage(current)) {
    return { kind: "reopen" };
  }
  if (isClosedStage(target)) {
    return { kind: "close" };
  }
  return { kind: "move" };
}
