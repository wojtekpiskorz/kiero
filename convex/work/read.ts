/**
 * The work read (C4): tasks with their checklists, events, and the DERIVED
 * facts consumers need — effective coordination and dueness.
 *
 * Nothing derived here is ever stored. "Zadanie po terminie" is computed
 * from the task's state, the bound finding's CURRENT revision, the
 * company timezone and the clock at read time; a planned event past its
 * date is reported `planned_elapsed_unconfirmed`, never occurred. The
 * effective coordinator is the assigned membership while active and null
 * once revoked (the stored assignment stays as history).
 *
 * Tasks of CLOSED projects are included: "Ich otwarte zadania nadal są w
 * 'Co teraz' i nadal przypominają" — the company queue does not shrink
 * when a project closes. Everything is read through company-scoped
 * indexes after the caller resolved the tenant; no other tenant's row can
 * appear.
 */

import type {
  ChecklistItemState,
  EventOccurrenceState,
  TaskState,
} from "@kiero/contracts";
import {
  CHECKLIST_ITEM_STATE_LABELS,
  EVENT_STATE_LABELS,
  TASK_STATE_LABELS,
  checklistProgress,
  deriveEffectiveCoordinator,
  deriveEventTiming,
  deriveTaskDueness,
  temporalValueOf,
  type EventTiming,
  type KnowledgeStateWire,
  type TaskDueness,
  type TemporalBindingView,
  type TemporalValueWire,
} from "@kiero/domain";
import type { Id } from "../_generated/dataModel";
import type { Db } from "./references";

/** One checklist point as the read shows it. */
export interface ChecklistItemView {
  readonly itemId: Id<"checklistItems">;
  readonly description: string;
  readonly state: ChecklistItemState;
  readonly stateLabel: string;
  readonly promotedToTaskId: Id<"tasks"> | null;
  readonly checkedAtMs: number | null;
  readonly createdAtMs: number;
}

/** The bound finding's current knowledge state and temporal value (wire). */
export interface TemporalBindingRead {
  readonly findingId: Id<"findings">;
  readonly knowledgeState: KnowledgeStateWire;
  readonly temporal: TemporalValueWire | null;
}

/** One task as the read shows it, with its derived facts. */
export interface TaskView {
  readonly taskId: Id<"tasks">;
  readonly projectId: Id<"projects">;
  readonly title: string;
  readonly state: TaskState;
  readonly stateLabel: string;
  readonly waitingReason: string | null;
  readonly executorContactId: Id<"contacts"> | null;
  readonly executorName: string | null;
  /** The stored assignment (history-bearing). */
  readonly coordinatorMembershipId: Id<"memberships"> | null;
  /** The assignment while its membership is active; null once revoked. */
  readonly effectiveCoordinatorMembershipId: Id<"memberships"> | null;
  readonly deadline: TemporalBindingRead | null;
  readonly dueness: TaskDueness;
  readonly linkedEventId: Id<"events"> | null;
  readonly parentTaskId: Id<"tasks"> | null;
  readonly revisionCounter: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly stateChangedAtMs: number;
  readonly checklist: readonly ChecklistItemView[];
  readonly checklistProgress: { readonly checked: number; readonly total: number };
}

/** One event as the read shows it, with its derived timing. */
export interface EventView {
  readonly eventId: Id<"events">;
  readonly projectId: Id<"projects">;
  readonly title: string;
  readonly state: EventOccurrenceState;
  readonly stateLabel: string;
  readonly time: TemporalBindingRead | null;
  readonly timing: EventTiming;
  readonly revisionCounter: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

/** The work overview of one company, all of it resolved company scope. */
export interface WorkOverview {
  readonly companyId: Id<"companies">;
  readonly companyTimezone: string;
  /** The instant the derived facts were computed at. */
  readonly nowMs: number;
  readonly tasks: readonly TaskView[];
  readonly events: readonly EventView[];
}

/** Reads one binding's current state (a dangling reference reads as unknown). */
async function readBinding(
  db: Db,
  findingId: Id<"findings">,
): Promise<TemporalBindingRead> {
  const finding = await db.get(findingId);
  const revision =
    finding === null || finding.currentRevisionId === undefined
      ? null
      : await db.get(finding.currentRevisionId);
  if (revision === null) {
    return {
      findingId,
      knowledgeState: { _tag: "unknown", reason: "finding_revision_missing" },
      temporal: null,
    };
  }
  return {
    findingId,
    knowledgeState: revision.knowledgeState,
    temporal: temporalValueOf(revision.value),
  };
}

function bindingView(read: TemporalBindingRead | null): TemporalBindingView | null {
  return read === null ? null : { knowledgeState: read.knowledgeState, temporal: read.temporal };
}

/**
 * Reads the whole work overview of one company at `nowMs` in its own
 * timezone. The company id must already be the RESOLVED tenant scope.
 */
export async function readWorkOverview(
  db: Db,
  companyId: Id<"companies">,
  nowMs: number,
): Promise<WorkOverview> {
  const company = await db.get(companyId);
  if (company === null) {
    throw new Error("work read: resolved company row missing");
  }
  const companyTimezone = company.timezone;

  const taskRows = await db
    .query("tasks")
    .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
    .collect();
  const contactNames = new Map<Id<"contacts">, string>();
  const membershipStates = new Map<Id<"memberships">, "active" | "revoked">();

  const tasks: TaskView[] = [];
  for (const task of taskRows) {
    if (task.executorContactId !== undefined && !contactNames.has(task.executorContactId)) {
      const contact = await db.get(task.executorContactId);
      contactNames.set(task.executorContactId, contact?.displayName ?? "");
    }
    if (
      task.coordinatorMembershipId !== undefined &&
      !membershipStates.has(task.coordinatorMembershipId)
    ) {
      const membership = await db.get(task.coordinatorMembershipId);
      // A missing membership row cannot coordinate anything: read as revoked.
      membershipStates.set(task.coordinatorMembershipId, membership?.state ?? "revoked");
    }
    const deadline =
      task.deadlineFindingId === undefined ? null : await readBinding(db, task.deadlineFindingId);
    const itemRows = await db
      .query("checklistItems")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    const checklist: ChecklistItemView[] = itemRows
      .slice()
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .map((item) => ({
        itemId: item._id,
        description: item.description,
        state: item.state,
        stateLabel: CHECKLIST_ITEM_STATE_LABELS[item.state],
        promotedToTaskId: item.promotedToTaskId ?? null,
        checkedAtMs: item.checkedAtMs ?? null,
        createdAtMs: item.createdAtMs,
      }));
    const coordinatorState =
      task.coordinatorMembershipId === undefined
        ? null
        : (membershipStates.get(task.coordinatorMembershipId) ?? "revoked");
    // The pure rule decides; the typed id is the stored one when it survives.
    const effectiveCoordinator = deriveEffectiveCoordinator(
      task.coordinatorMembershipId === undefined || coordinatorState === null
        ? null
        : { membershipId: task.coordinatorMembershipId, state: coordinatorState },
    );
    tasks.push({
      taskId: task._id,
      projectId: task.projectId,
      title: task.title,
      state: task.state,
      stateLabel: TASK_STATE_LABELS[task.state],
      waitingReason: task.waitingReason ?? null,
      executorContactId: task.executorContactId ?? null,
      executorName:
        task.executorContactId === undefined
          ? null
          : (contactNames.get(task.executorContactId) ?? null),
      coordinatorMembershipId: task.coordinatorMembershipId ?? null,
      effectiveCoordinatorMembershipId:
        effectiveCoordinator === null ? null : (task.coordinatorMembershipId ?? null),
      deadline,
      dueness: deriveTaskDueness({
        state: task.state,
        deadline: bindingView(deadline),
        nowMs,
        companyTimezone,
      }),
      linkedEventId: task.linkedEventId ?? null,
      parentTaskId: task.parentTaskId ?? null,
      revisionCounter: task.revisionCounter,
      createdAtMs: task.createdAtMs,
      updatedAtMs: task.updatedAtMs,
      stateChangedAtMs: task.stateChangedAtMs,
      checklist,
      checklistProgress: checklistProgress(
        checklist.map((item) => ({
          description: item.description,
          state: item.state,
          promotedToTaskId: item.promotedToTaskId,
        })),
      ),
    });
  }
  tasks.sort((a, b) => a.createdAtMs - b.createdAtMs);

  const eventRows = await db
    .query("events")
    .withIndex("by_project_state", (q) => q.eq("companyId", companyId))
    .collect();
  const events: EventView[] = [];
  for (const event of eventRows) {
    const time = event.timeFindingId === undefined ? null : await readBinding(db, event.timeFindingId);
    events.push({
      eventId: event._id,
      projectId: event.projectId,
      title: event.title,
      state: event.state,
      stateLabel: EVENT_STATE_LABELS[event.state],
      time,
      timing: deriveEventTiming({
        state: event.state,
        time: bindingView(time),
        nowMs,
        companyTimezone,
      }),
      revisionCounter: event.revisionCounter,
      createdAtMs: event.createdAtMs,
      updatedAtMs: event.updatedAtMs,
    });
  }
  events.sort((a, b) => a.createdAtMs - b.createdAtMs);

  return { companyId, companyTimezone, nowMs, tasks, events };
}
