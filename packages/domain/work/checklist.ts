/**
 * Checklist rules (C4 domain half, pure).
 *
 * Vocabulary ("Checklista zadania", CONTEXT.md): a ONE-level list of points
 * inside a task, using the task's responsibility and deadline. The task's
 * state and the points' completion are independent: a task may be Wykonane
 * with unchecked points, which keep their own state and history.
 *
 * Rules encoded here (issue 9):
 *
 * - A point has a description, a completion mark, history and a change
 *   basis. Checking a point records progress of the LIST; it never reads
 *   or writes the parent task's state (there is no parent-state input or
 *   output in any decision below).
 * - "Odhaczenie całej checklisty nie kończy zadania, a zmiana punktu nie
 *   otwiera go ponownie": structural — the decisions here cannot express
 *   a parent transition.
 * - A point that needs its own owner or deadline PROMOTES to a separate,
 *   linked task ("można przekształcić go w osobne, powiązane zadanie").
 *   The point stays in the list with its real state and history plus the
 *   link; the obligation moves to the task, so a promoted point is frozen.
 *   A checked point needs nothing and is not promotable.
 */

import type { ChecklistItemState } from "@kiero/contracts";
import type { Validated } from "../projects/result";

/** Polish product rendering of the point completion mark. */
export const CHECKLIST_ITEM_STATE_LABELS: Readonly<Record<ChecklistItemState, string>> = {
  open: "Nieodhaczony",
  checked: "Odhaczony",
};

/** Bounded point description. */
export const MAX_CHECKLIST_DESCRIPTION_LENGTH = 300;

/** A point describes a step; whitespace-only is not a step. */
export function validateChecklistDescription(description: string): Validated<string> {
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "checklist_description_empty" };
  }
  if (trimmed.length > MAX_CHECKLIST_DESCRIPTION_LENGTH) {
    return { ok: false, code: "checklist_description_too_long" };
  }
  return { ok: true, value: trimmed };
}

/** The current point record, as the decisions see it. */
export interface ChecklistItemView {
  readonly description: string;
  readonly state: ChecklistItemState;
  /** Set once the point was converted into a linked task. */
  readonly promotedToTaskId: string | null;
}

/** The explicitly commanded point content. */
export interface ChecklistItemCommand {
  readonly description: string;
  readonly state: ChecklistItemState;
}

/**
 * What one explicit point command does.
 *
 * - `create`: no existing point; a new one is recorded with the commanded
 *   description and mark.
 * - `unchanged`: same description and mark; nothing changes.
 * - `update`: the description and/or the mark changed (recorded progress
 *   with its own history row).
 * - `rejected`: a promoted point is frozen — its obligation lives in the
 *   linked task now.
 */
export type ChecklistItemChangeDecision =
  | { readonly kind: "create"; readonly description: string }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "update";
      readonly description: string;
      readonly descriptionChanged: boolean;
      readonly stateChanged: boolean;
    }
  | { readonly kind: "rejected"; readonly code: "item_promoted" | "checklist_description_empty" | "checklist_description_too_long" };

/**
 * Decides one point command. Note the signature: the parent task's state
 * is not an input and no parent transition is an output — independence is
 * structural.
 */
export function decideChecklistItemChange(
  existing: ChecklistItemView | null,
  target: ChecklistItemCommand,
): ChecklistItemChangeDecision {
  const description = validateChecklistDescription(target.description);
  if (!description.ok) {
    return {
      kind: "rejected",
      code:
        description.code === "checklist_description_too_long"
          ? "checklist_description_too_long"
          : "checklist_description_empty",
    };
  }
  if (existing === null) {
    return { kind: "create", description: description.value };
  }
  if (existing.promotedToTaskId !== null) {
    return { kind: "rejected", code: "item_promoted" };
  }
  const descriptionChanged = existing.description !== description.value;
  const stateChanged = existing.state !== target.state;
  if (!descriptionChanged && !stateChanged) {
    return { kind: "unchanged" };
  }
  return { kind: "update", description: description.value, descriptionChanged, stateChanged };
}

/**
 * What promoting one point does: the new linked task takes the point's
 * description as its title (Do zrobienia); the point keeps its state and
 * gains the link. A point already promoted or already checked is refused.
 */
export type ChecklistPromotionDecision =
  | { readonly kind: "promote"; readonly title: string }
  | { readonly kind: "rejected"; readonly code: "item_promoted" | "item_checked" };

/** Decides whether one point may become a linked task. */
export function decideChecklistPromotion(item: ChecklistItemView): ChecklistPromotionDecision {
  if (item.promotedToTaskId !== null) {
    return { kind: "rejected", code: "item_promoted" };
  }
  if (item.state === "checked") {
    return { kind: "rejected", code: "item_checked" };
  }
  return { kind: "promote", title: item.description };
}

/**
 * Recorded list progress ("Częściowe wykonanie pozostaje zapisanym postępem
 * listy"): counts only, never a parent-state verdict. Promoted points are
 * excluded from the denominator — their obligation moved to a linked task.
 */
export function checklistProgress(
  items: readonly ChecklistItemView[],
): { readonly checked: number; readonly total: number } {
  const live = items.filter((item) => item.promotedToTaskId === null);
  return {
    checked: live.filter((item) => item.state === "checked").length,
    total: live.length,
  };
}
