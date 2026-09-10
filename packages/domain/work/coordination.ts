/**
 * Task identity, executor and coordinator rules (C4 domain half, pure).
 *
 * Vocabulary (CONTEXT.md): "Wykonawca zadania" — the person doing the work,
 * also a subcontractor WITHOUT a Kiero account (a catalog contact);
 * "Koordynator zadania" — the boss responsible for following the task up
 * in Kiero (a company membership). They may be the same person; they are
 * different records.
 *
 * Rules encoded here (issue 9, "Wykonawca, koordynator i zmiana dostępu"):
 *
 * - The executor is a CONTACT reference and the coordinator a MEMBERSHIP
 *   reference. Naming an external executor grants nothing: no access, no
 *   notifications (structural — a contact is not an identity).
 * - The coordinator comes from a statement or a firm rule. Without a basis
 *   the task stays in the shared queue: nothing here assigns the command's
 *   author ("Nie przypisujemy automatycznie autorowi odpowiedzialności za
 *   cudzą pracę") — the decision has no actor input.
 * - Only an ACTIVE membership may be assigned as coordinator.
 * - When a coordinator's membership is revoked, the task's EFFECTIVE
 *   coordination ends immediately and structurally (the same argument the
 *   access lane makes for access itself): the stored assignment stays as
 *   history ("Historia zachowuje wcześniejszą odpowiedzialność"), the
 *   effective coordinator becomes null (reminders go to the remaining
 *   bosses), and an explicit successor is a boss command through the
 *   ordinary task change. Closed tasks are untouched by any of this.
 */

import type { Validated } from "../projects/result";

/** Bounded task title. */
export const MAX_TASK_TITLE_LENGTH = 200;

/** A task title names the action; whitespace-only is not one. */
export function validateTaskTitle(
  title: string,
): Validated<string, "task_title_empty" | "task_title_too_long"> {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "task_title_empty" };
  }
  if (trimmed.length > MAX_TASK_TITLE_LENGTH) {
    return { ok: false, code: "task_title_too_long" };
  }
  return { ok: true, value: trimmed };
}

/** Membership lifecycle as the coordination rules see it. */
export type MembershipLifecycle = "active" | "revoked";

/** Outcome of checking a commanded coordinator membership. */
export type CoordinatorCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "coordinator_membership_not_active" };

/** Only an active boss may be made responsible for following a task up. */
export function checkCoordinatorMembership(state: MembershipLifecycle): CoordinatorCheck {
  return state === "active" ? { ok: true } : { ok: false, code: "coordinator_membership_not_active" };
}

/** The stored coordinator assignment joined with its membership's lifecycle. */
export interface CoordinatorAssignmentView {
  readonly membershipId: string;
  readonly state: MembershipLifecycle;
}

/**
 * The effective coordinator of a task: the assigned membership while it is
 * active, null once it is revoked (unassigned: "jego otwarte zadania stają
 * się nieprzypisane"). The assignment itself is not an input to change —
 * this derives, it never rewrites history.
 */
export function deriveEffectiveCoordinator(
  assignment: CoordinatorAssignmentView | null,
): string | null {
  if (assignment === null) {
    return null;
  }
  return assignment.state === "active" ? assignment.membershipId : null;
}
