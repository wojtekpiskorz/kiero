/**
 * Task state rules (C4 domain half, pure).
 *
 * Vocabulary ("Stan zadania", CONTEXT.md): Do zrobienia, W toku, Czeka,
 * Wykonane, Anulowane. The machine tokens come from the certified contract
 * surface (`TaskState` in @kiero/contracts); this module owns their Polish
 * rendering and every rule over them.
 *
 * Rules encoded here (issue 9, "Checklista i niezależne zakończenie
 * zadania"):
 *
 * - "Czeka" is a KNOWN obstacle with a SAVED reason: entering it without a
 *   reason is refused, and a reason outside of it is refused too (the
 *   contract already binds the field to that one state).
 * - No sequencing is enforced: "Zadanie nie musi przechodzić przez
 *   wszystkie stany" — a clear statement moves a task from Do zrobienia
 *   straight to Wykonane, and a mistaken closure is corrected by an
 *   explicit reopen (the same task, never a hiding duplicate).
 * - The decision consumes ONLY the current record and the explicitly
 *   commanded target. There is no parameter for checklist progress, an
 *   elapsed date or silence: a completion derived from "3/3 points
 *   checked" or from time passing is unrepresentable in this signature.
 *   That is the load-bearing property, not an omission.
 */

import type { TaskState } from "@kiero/contracts";
import type { Validated } from "../projects/result";

/** Polish product rendering of every task state token. */
export const TASK_STATE_LABELS: Readonly<Record<TaskState, string>> = {
  todo: "Do zrobienia",
  in_progress: "W toku",
  waiting: "Czeka",
  done: "Wykonane",
  cancelled: "Anulowane",
};

/** The states that end a task's obligation (reminders stop; still history). */
export const CLOSED_TASK_STATES: readonly TaskState[] = ["done", "cancelled"];

/** True when the state is Wykonane or Anulowane. */
export function isClosedTaskState(state: TaskState): boolean {
  return state === "done" || state === "cancelled";
}

/** True when the task still carries an obligation ("Co teraz" candidates). */
export function isOpenTaskState(state: TaskState): boolean {
  return !isClosedTaskState(state);
}

/** Bounded obstacle reason ("Czeka oznacza znaną przeszkodę z zapisanym powodem"). */
export const MAX_WAITING_REASON_LENGTH = 500;

/** A waiting reason carries words; whitespace-only is not an obstacle. */
export function validateWaitingReason(reason: string | undefined): Validated<string> {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: false, code: "waiting_reason_required" };
  }
  if (trimmed.length > MAX_WAITING_REASON_LENGTH) {
    return { ok: false, code: "waiting_reason_too_long" };
  }
  return { ok: true, value: trimmed };
}

/** The current state-bearing part of a task record, as the decision sees it. */
export interface TaskStateView {
  readonly state: TaskState;
  readonly waitingReason: string | null;
}

/** The explicitly commanded target. */
export interface TaskStateCommand {
  readonly state: TaskState;
  /** Present only when the caller supplied one (the contract binds it to `waiting`). */
  readonly waitingReason: string | undefined;
}

/**
 * What one explicit state command does to the task record.
 *
 * - `unchanged`: same state (and, for Czeka, same reason) commanded; nothing
 *   changes (idempotent, no revision bump, no event).
 * - `reason_changed`: Czeka to Czeka with a different reason — the obstacle
 *   was re-described; the state itself did not move.
 * - `transition`: a state move. `close` marks entering Wykonane/Anulowane
 *   (reminders stop), `reopen` marks leaving them ("Powrót do pracy": the
 *   earlier deadline binding stays; nothing here moves it). The waiting
 *   reason is the saved obstacle when entering Czeka and null otherwise.
 * - `rejected`: the command violates the Czeka-reason rule.
 */
export type TaskStateChangeDecision =
  | { readonly kind: "unchanged" }
  | { readonly kind: "reason_changed"; readonly waitingReason: string }
  | {
      readonly kind: "transition";
      readonly from: TaskState;
      readonly to: TaskState;
      readonly waitingReason: string | null;
      readonly close: boolean;
      readonly reopen: boolean;
    }
  | {
      readonly kind: "rejected";
      readonly code: "waiting_reason_required" | "waiting_reason_too_long" | "waiting_reason_only_for_waiting";
    };

/**
 * Decides one explicit task state command over the fixed vocabulary.
 *
 * The inputs are exactly the current record and the commanded target:
 * there is no parameter through which checklist ticks, an elapsed deadline
 * or the absence of activity could complete or reopen a task. Every pairing
 * of the five states is total.
 */
export function decideTaskStateChange(
  current: TaskStateView,
  target: TaskStateCommand,
): TaskStateChangeDecision {
  if (target.state !== "waiting" && target.waitingReason !== undefined) {
    return { kind: "rejected", code: "waiting_reason_only_for_waiting" };
  }
  let waitingReason: string | null = null;
  if (target.state === "waiting") {
    const reason = validateWaitingReason(target.waitingReason);
    if (!reason.ok) {
      return {
        kind: "rejected",
        code: reason.code === "waiting_reason_too_long" ? "waiting_reason_too_long" : "waiting_reason_required",
      };
    }
    waitingReason = reason.value;
  }
  if (current.state === target.state) {
    if (target.state === "waiting" && waitingReason !== null && waitingReason !== current.waitingReason) {
      return { kind: "reason_changed", waitingReason };
    }
    return { kind: "unchanged" };
  }
  return {
    kind: "transition",
    from: current.state,
    to: target.state,
    waitingReason,
    close: !isClosedTaskState(current.state) && isClosedTaskState(target.state),
    reopen: isClosedTaskState(current.state) && !isClosedTaskState(target.state),
  };
}
