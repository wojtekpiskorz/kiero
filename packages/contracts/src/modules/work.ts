/**
 * Work module surface (architecture "Deep modules": Projects and work — the
 * work half). Implements lanes: C4, F4 (reminders read side).
 *
 * Separate task and event semantics, independent parent/checklist completion,
 * executor/coordinator split, temporal findings bound by reference — a task
 * and an event may share one dated finding without owning divergent copies.
 *
 * State vocabularies from issue 9:
 * - Task ("Stan zadania"): Do zrobienia, W toku, Czeka, Wykonane, Anulowane;
 *   "Czeka" carries a saved reason.
 * - Event ("Stan zdarzenia"): Planowane, Odbyło się, Anulowane; a passed
 *   date never proves occurrence.
 * - Checklist: one level; item completion is recorded progress, never
 *   computed from or into the parent task state.
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { operationEntry, eventEntry } from "./registration";

export const TaskState = Schema.Literals([
  "todo",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
]);
export type TaskState = Schema.Schema.Type<typeof TaskState>;

export const EventOccurrenceState = Schema.Literals([
  "planned",
  "occurred",
  "cancelled",
]);
export type EventOccurrenceState = Schema.Schema.Type<typeof EventOccurrenceState>;

/** Checklist item completion mark: present/absent with its own history. */
export const ChecklistItemState = Schema.Literals(["open", "checked"]);
export type ChecklistItemState = Schema.Schema.Type<typeof ChecklistItemState>;

export const workOperations = {
  "work.changeTask": operationEntry({
    kind: "operation",
    name: "work.changeTask",
    input: Schema.Struct({
      taskId: Schema.NullOr(tableIdSchema("tasks")),
      projectId: tableIdSchema("projects"),
      title: Schema.NonEmptyString,
      /** Executor may be a contact without a Kiero account ("Wykonawca zadania"). */
      executorContactId: Schema.NullOr(tableIdSchema("contacts")),
      /** Coordinator is a boss member ("Koordynator zadania"). */
      coordinatorMembershipId: Schema.NullOr(tableIdSchema("memberships")),
      /** Binding to the temporal finding that carries the deadline, if any. */
      deadlineFindingId: Schema.NullOr(tableIdSchema("findings")),
      expectedRevision: Schema.Number,
    }),
    result: Schema.Struct({ taskId: tableIdSchema("tasks") }),
    errorKinds: ["forbidden", "not_found", "validation", "conflict"],
  }),
  "work.changeTaskState": operationEntry({
    kind: "operation",
    name: "work.changeTaskState",
    input: Schema.Struct({
      taskId: tableIdSchema("tasks"),
      expectedRevision: Schema.Number,
      state: TaskState,
      /** Required when (and only when) the new state is `waiting`. */
      waitingReason: Schema.optionalKey(Schema.NonEmptyString),
    }),
    result: Schema.Struct({ taskId: tableIdSchema("tasks") }),
    errorKinds: ["forbidden", "not_found", "conflict", "validation"],
  }),
  "work.changeChecklistItem": operationEntry({
    kind: "operation",
    name: "work.changeChecklistItem",
    input: Schema.Struct({
      taskId: tableIdSchema("tasks"),
      itemId: Schema.NullOr(tableIdSchema("checklistItems")),
      description: Schema.NonEmptyString,
      state: ChecklistItemState,
      expectedRevision: Schema.Number,
    }),
    result: Schema.Struct({ itemId: tableIdSchema("checklistItems") }),
    errorKinds: ["forbidden", "not_found", "validation", "conflict"],
  }),
  "work.changeEvent": operationEntry({
    kind: "operation",
    name: "work.changeEvent",
    input: Schema.Struct({
      eventId: Schema.NullOr(tableIdSchema("events")),
      projectId: tableIdSchema("projects"),
      title: Schema.NonEmptyString,
      /** Binding to the temporal finding that carries the known time, if any. */
      timeFindingId: Schema.NullOr(tableIdSchema("findings")),
      expectedRevision: Schema.Number,
    }),
    result: Schema.Struct({ eventId: tableIdSchema("events") }),
    errorKinds: ["forbidden", "not_found", "validation", "conflict"],
  }),
  "work.changeEventState": operationEntry({
    kind: "operation",
    name: "work.changeEventState",
    input: Schema.Struct({
      eventId: tableIdSchema("events"),
      expectedRevision: Schema.Number,
      state: EventOccurrenceState,
    }),
    result: Schema.Struct({ eventId: tableIdSchema("events") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
} as const;

export const workEvents = {
  "work.taskChanged": eventEntry({
    kind: "event",
    name: "work.taskChanged",
    payload: Schema.Struct({ taskId: tableIdSchema("tasks") }),
  }),
  "work.taskStateChanged": eventEntry({
    kind: "event",
    name: "work.taskStateChanged",
    payload: Schema.Struct({
      taskId: tableIdSchema("tasks"),
      fromState: TaskState,
      toState: TaskState,
    }),
  }),
  "work.checklistItemChanged": eventEntry({
    kind: "event",
    name: "work.checklistItemChanged",
    payload: Schema.Struct({
      taskId: tableIdSchema("tasks"),
      itemId: tableIdSchema("checklistItems"),
      state: ChecklistItemState,
    }),
  }),
  "work.eventStateChanged": eventEntry({
    kind: "event",
    name: "work.eventStateChanged",
    payload: Schema.Struct({
      eventId: tableIdSchema("events"),
      fromState: EventOccurrenceState,
      toState: EventOccurrenceState,
    }),
  }),
} as const;
