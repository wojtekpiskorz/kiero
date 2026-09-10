/**
 * Work module surface (architecture "Deep modules": Projects and work, the
 * work half). Implements lanes: C4, F4 (reminders read side).
 *
 * Separate task and event semantics, independent parent/checklist completion,
 * executor/coordinator split, temporal findings bound by reference: a task
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
import { RevisionCounter } from "../actor";
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

/**
 * C4 amendment (flagged, additive; C2 precedent): the evidence basis of one
 * work change. Every change records actor and time from the resolved
 * context; when the agent (or a boss) acts FROM a source message, the
 * source is the basis ("Każda zmiana zachowuje autora, czas i podstawę").
 * Optional key: envelopes without it decode unchanged (direct boss change).
 */
const basisSourceId = Schema.optionalKey(tableIdSchema("sources"));

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
      /**
       * C4 amendment (flagged, additive): the event this task is deliberately
       * linked to ("Może mieć powiązane zadania"), e.g. the receiving task of
       * a delivery. The link is explicit; sharing the event's dated finding
       * remains a separate explicit binding (`deadlineFindingId`).
       */
      linkedEventId: Schema.optionalKey(Schema.NullOr(tableIdSchema("events"))),
      expectedRevision: RevisionCounter,
      basisSourceId,
    }),
    result: Schema.Struct({ taskId: tableIdSchema("tasks") }),
    errorKinds: ["forbidden", "not_found", "validation", "conflict"],
  }),
  "work.changeTaskState": operationEntry({
    kind: "operation",
    name: "work.changeTaskState",
    input: Schema.Struct({
      taskId: tableIdSchema("tasks"),
      expectedRevision: RevisionCounter,
      state: TaskState,
      /** Required when (and only when) the new state is `waiting`. */
      waitingReason: Schema.optionalKey(Schema.NonEmptyString),
      basisSourceId,
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
      /** The TASK's revision: the checklist is the task's sub-resource. */
      expectedRevision: RevisionCounter,
      basisSourceId,
    }),
    result: Schema.Struct({ itemId: tableIdSchema("checklistItems") }),
    errorKinds: ["forbidden", "not_found", "validation", "conflict"],
  }),
  /**
   * C4 amendment (flagged, additive): converts one checklist point into a
   * separate, linked task ("Jeśli punkt wymaga własnego odpowiedzialnego
   * lub terminu, można przekształcić go w osobne, powiązane zadanie"). The
   * point keeps its state and history and gains the link; the new task is
   * born Do zrobienia with the explicitly commanded responsibility and
   * deadline. The certified surface had the `parentTaskId` column but no
   * operation producing it.
   */
  "work.promoteChecklistItem": operationEntry({
    kind: "operation",
    name: "work.promoteChecklistItem",
    input: Schema.Struct({
      taskId: tableIdSchema("tasks"),
      itemId: tableIdSchema("checklistItems"),
      /** The parent TASK's revision. */
      expectedRevision: RevisionCounter,
      executorContactId: Schema.NullOr(tableIdSchema("contacts")),
      coordinatorMembershipId: Schema.NullOr(tableIdSchema("memberships")),
      deadlineFindingId: Schema.NullOr(tableIdSchema("findings")),
      basisSourceId,
    }),
    result: Schema.Struct({ taskId: tableIdSchema("tasks") }),
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
      expectedRevision: RevisionCounter,
      basisSourceId,
    }),
    result: Schema.Struct({ eventId: tableIdSchema("events") }),
    errorKinds: ["forbidden", "not_found", "validation", "conflict"],
  }),
  "work.changeEventState": operationEntry({
    kind: "operation",
    name: "work.changeEventState",
    input: Schema.Struct({
      eventId: tableIdSchema("events"),
      expectedRevision: RevisionCounter,
      state: EventOccurrenceState,
      basisSourceId,
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
  /**
   * C4 amendment (flagged, additive): an event's title or time binding
   * changed without a state change — the Calendar projection (G2) must
   * learn about a re-bound time the same way it learns about a state move.
   */
  "work.eventChanged": eventEntry({
    kind: "event",
    name: "work.eventChanged",
    payload: Schema.Struct({ eventId: tableIdSchema("events") }),
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
