/**
 * Work tables: tasks, checklists, events (A2 candidate, certified by A3).
 *
 * Owning implementer: C4 (tasks, independent checklists, dated events).
 * Task completion is independent of checklist completion (a done task may
 * keep unchecked items, which retain their own state and history). Event
 * occurrence and task deadlines are distinct unless they explicitly share a
 * dated finding; both bind to temporal findings by reference, never by
 * copying values.
 *
 * Tables: tasks, checklistItems, events.
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
    /** Set when this task was split out of a checklist item. */
    parentTaskId: v.optional(shared.taskId),
    revisionCounter: shared.counter,
    createdAtMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
    stateChangedAtMs: shared.tsMs,
  })
    .index("by_project_state", ["companyId", "projectId", "state"])
    .index("by_company_state", ["companyId", "state", "stateChangedAtMs"]),

  /** One-level checklist inside a task; item state is independent of task state. */
  checklistItems: defineTable({
    taskId: shared.taskId,
    description: v.string(),
    state: checklistItemState,
    revisionCounter: shared.counter,
    checkedAtMs: v.optional(shared.tsMs),
    createdAtMs: shared.tsMs,
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
} as const;
