/**
 * Work tables: tasks, checklists, events (A2 candidate, certified by A3;
 * completed by C4 for the tasks / independent checklists / dated events
 * lane).
 *
 * Owning implementer: C4 (tasks, independent checklists, dated events).
 * Task completion is independent of checklist completion (a done task may
 * keep unchecked items, which retain their own state and history). Event
 * occurrence and task deadlines are distinct unless they explicitly share a
 * dated finding; both bind to temporal findings by reference, never by
 * copying values.
 *
 * C4 amendments (the owning lane completes the candidate fragment):
 * - `tasks.linkedEventId`: the explicit link from a task to the event it
 *   serves (the receiving task of a delivery); sharing the event's dated
 *   finding stays a separate explicit binding.
 * - `checklistItems.promotedToTaskId` (+ `updatedAtMs`): a point converted
 *   into a linked task keeps its row, state and history and gains the link;
 *   the linked task carries `parentTaskId` (the certified column that had no
 *   producer).
 * - `workRevisions`: the immutable change history of tasks, points and
 *   events — one row per change with the subject's full state AFTER the
 *   change, the resolved actor, whether the agent acted for them, the
 *   source that is the evidence basis (when the change came from one) and
 *   trusted system time. Never patched; the current rows are projections
 *   only ever written in the same transaction as their history row.
 * - Indexes `tasks.by_coordinator` and `tasks.by_linked_event` for the
 *   reads this lane and the reminders/Calendar consumers make.
 *
 * Tables: tasks, checklistItems, events, workRevisions.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../schema/shared";
import {
  ChecklistItemState,
  EventOccurrenceState,
  TaskState,
} from "@kiero/contracts";

// Vocabulary pins: each closed union must equal its contracts-side schema's
// encoded literals exactly, or this file fails typecheck.

const taskState: ValueValidator<Encoded<typeof TaskState>> = v.union(
  v.literal("todo"),
  v.literal("in_progress"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("cancelled"),
);

const checklistItemState: ValueValidator<Encoded<typeof ChecklistItemState>> =
  v.union(v.literal("open"), v.literal("checked"));

const eventOccurrenceState: ValueValidator<Encoded<typeof EventOccurrenceState>> =
  v.union(v.literal("planned"), v.literal("occurred"), v.literal("cancelled"));

/** A task's full recorded state (the immutable per-change snapshot shape). */
const taskSnapshot = v.object({
  kind: v.literal("task"),
  projectId: shared.projectId,
  title: v.string(),
  state: taskState,
  waitingReason: v.optional(v.string()),
  executorContactId: v.optional(shared.contactId),
  coordinatorMembershipId: v.optional(shared.membershipId),
  deadlineFindingId: v.optional(shared.findingId),
  linkedEventId: v.optional(shared.workEventId),
  parentTaskId: v.optional(shared.taskId),
});

/** A checklist point's full recorded state. */
const checklistItemSnapshot = v.object({
  kind: v.literal("checklist_item"),
  description: v.string(),
  state: checklistItemState,
  promotedToTaskId: v.optional(shared.taskId),
});

/** An event's full recorded state. */
const eventSnapshot = v.object({
  kind: v.literal("event"),
  projectId: shared.projectId,
  title: v.string(),
  state: eventOccurrenceState,
  timeFindingId: v.optional(shared.findingId),
});

export const workTables = {
  /** Action to do ("Zadanie", CONTEXT.md); arises from findings or boss input. */
  tasks: defineTable({
    companyId: shared.companyId,
    projectId: shared.projectId,
    title: v.string(),
    /** Do zrobienia / W toku / Czeka / Wykonane / Anulowane (issue 9). */
    state: taskState,
    /** Saved obstacle reason; required when state is `waiting`. */
    waitingReason: v.optional(v.string()),
    /** Executor may be a subcontractor without a Kiero account. */
    executorContactId: v.optional(shared.contactId),
    /** Coordinator is the boss member responsible for following it up. */
    coordinatorMembershipId: v.optional(shared.membershipId),
    /** Reference to the temporal finding that carries the deadline, if known. */
    deadlineFindingId: v.optional(shared.findingId),
    /** The event this task deliberately serves, if any ("powiązane zadania"). */
    linkedEventId: v.optional(shared.workEventId),
    /** Set when this task was split out of a checklist item. */
    parentTaskId: v.optional(shared.taskId),
    revisionCounter: shared.counter,
    createdAtMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
    stateChangedAtMs: shared.tsMs,
  })
    .index("by_project_state", ["companyId", "projectId", "state"])
    .index("by_company_state", ["companyId", "state", "stateChangedAtMs"])
    .index("by_coordinator", ["coordinatorMembershipId", "state"])
    .index("by_linked_event", ["linkedEventId"]),

  /** One-level checklist inside a task; item state is independent of task state. */
  checklistItems: defineTable({
    taskId: shared.taskId,
    description: v.string(),
    state: checklistItemState,
    /** Set once the point was converted into a separate, linked task. */
    promotedToTaskId: v.optional(shared.taskId),
    revisionCounter: shared.counter,
    checkedAtMs: v.optional(shared.tsMs),
    createdAtMs: shared.tsMs,
    updatedAtMs: v.optional(shared.tsMs),
  }).index("by_task", ["taskId"]),

  /** Delivery, meeting or other work occurrence ("Zdarzenie", CONTEXT.md). */
  events: defineTable({
    companyId: shared.companyId,
    projectId: shared.projectId,
    title: v.string(),
    /** Planowane / Odbyło się / Anulowane; a passed date never implies occurrence. */
    state: eventOccurrenceState,
    /** Reference to the temporal finding that carries the known time, if any. */
    timeFindingId: v.optional(shared.findingId),
    revisionCounter: shared.counter,
    createdAtMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
  })
    // by_company (companyId) is intentionally absent: it is a strict prefix
    // of by_project_state.
    .index("by_project_state", ["companyId", "projectId", "state"]),

  /**
   * Immutable change history of tasks, checklist points and events: one row
   * per change, never patched. `revision` is the subject's counter after
   * the change (1 = creation); `snapshot` is its full state after it.
   */
  workRevisions: defineTable({
    companyId: shared.companyId,
    subjectKind: v.union(
      v.literal("task"),
      v.literal("checklist_item"),
      v.literal("event"),
    ),
    /** The task (or the point's parent task) this row is about. */
    taskId: v.optional(shared.taskId),
    itemId: v.optional(shared.checklistItemId),
    eventId: v.optional(shared.workEventId),
    revision: shared.counter,
    change: v.union(
      v.literal("created"),
      v.literal("changed"),
      v.literal("state_changed"),
      v.literal("promoted"),
    ),
    snapshot: v.union(taskSnapshot, checklistItemSnapshot, eventSnapshot),
    /** Resolved actor (never client input). */
    actorUserId: shared.userId,
    /** Direct boss change, or the agent acting for that boss. */
    via: v.union(v.literal("user"), v.literal("agent")),
    /** The source message that is the evidence basis, when there is one. */
    basisSourceId: v.optional(shared.sourceId),
    recordedAtMs: shared.tsMs,
  })
    .index("by_task", ["taskId", "recordedAtMs"])
    .index("by_event", ["eventId", "recordedAtMs"])
    .index("by_company", ["companyId", "recordedAtMs"]),
} as const;
