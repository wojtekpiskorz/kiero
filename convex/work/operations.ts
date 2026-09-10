/**
 * Work transactions (C4): the write halves of the pure domain rules in
 * `packages/domain/work`, each inside ONE Convex mutation.
 *
 * Every entry runs through the typed command dispatch (./dispatch.ts):
 * envelope decode -> registry -> B1 identity resolution -> the C4 policy ->
 * contract input decode -> handler. The company scope always comes from the
 * RESOLVED context; a cross-company task/event/project/contact/membership/
 * finding/source reference is indistinguishable from a missing one
 * (`not_found`, no existence leak).
 *
 * ATOMICITY (the B3/C2 discipline): every step that can refuse (validation,
 * row loads, domain decisions) runs BEFORE the first insert/patch. Task and
 * event changes are split into a PREPARE half (reads, decisions, a plan)
 * and a COMMIT half (only pre-validated writes), so a delivery event and
 * its deliberately linked receiving task can be prepared together and
 * committed together in one transaction (`performRecordEventWithTask`):
 * either both exist or neither does ("dependent event/task creation
 * commits atomically when they share one agreement").
 *
 * HISTORY: every write records one immutable `workRevisions` row (actor,
 * via, evidence basis, time, full snapshot after the change) in the same
 * transaction as the current-row patch, and publishes its canonical
 * `work.*` event atomically.
 *
 * REVISION discipline: `tasks.revisionCounter` is the optimistic counter of
 * the task AGGREGATE — task fields, task state and its checklist points all
 * advance it and all verify it. Item edits never read or write the task's
 * STATE (structural independence); they only serialize through its counter.
 * `events.revisionCounter` is the event's own counter.
 *
 * There is deliberately no input through which checklist progress, an
 * elapsed deadline or a passed event date could change a task or event
 * state: the ONLY way in is an explicit target state commanded by the
 * resolved boss (or the agent acting through the same checked operation).
 */

import { Schema } from "effect";
import {
  errorResult,
  okResult,
  workOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  checkCoordinatorMembership,
  checkTemporalBinding,
  decideChecklistItemChange,
  decideChecklistPromotion,
  decideEventStateChange,
  decideTaskStateChange,
  validateEventTitle,
  validateTaskTitle,
  type TemporalBindingKind,
} from "@kiero/domain";
import {
  companyScopeOf,
  eventSnapshotOf,
  itemSnapshotOf,
  loadCompanyContact,
  loadCompanyEvent,
  loadCompanyMembership,
  loadCompanyProject,
  loadCompanySource,
  loadCompanyTask,
  loadCurrentFinding,
  loadTaskItem,
  publishWorkEvent,
  recordWorkRevision,
  requireRow,
  taskSnapshotOf,
  type CompanyScope,
} from "./references";

// The contract entries these transactions implement (decode authority).
export const changeTaskEntry = workOperations["work.changeTask"];
export const changeTaskStateEntry = workOperations["work.changeTaskState"];
export const changeChecklistItemEntry = workOperations["work.changeChecklistItem"];
export const promoteChecklistItemEntry = workOperations["work.promoteChecklistItem"];
export const changeEventEntry = workOperations["work.changeEvent"];
export const changeEventStateEntry = workOperations["work.changeEventState"];

/** Typed decoded inputs of the implemented operations. */
export type ChangeTaskInput = Schema.Schema.Type<typeof changeTaskEntry.input>;
export type ChangeTaskStateInput = Schema.Schema.Type<typeof changeTaskStateEntry.input>;
export type ChangeChecklistItemInput = Schema.Schema.Type<typeof changeChecklistItemEntry.input>;
export type PromoteChecklistItemInput = Schema.Schema.Type<typeof promoteChecklistItemEntry.input>;
export type ChangeEventInput = Schema.Schema.Type<typeof changeEventEntry.input>;
export type ChangeEventStateInput = Schema.Schema.Type<typeof changeEventStateEntry.input>;

type Refusal = { readonly ok: false; readonly error: ResultEnvelope };
const refuse = (error: ResultEnvelope): Refusal => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Reference resolution (all refusals happen here, before any write)
// ---------------------------------------------------------------------------

/** The evidence basis: an ACTIVE source of this company, or none. */
async function resolveBasis(
  tx: MutationCtx,
  scope: CompanyScope,
  ref: string | undefined,
): Promise<{ readonly ok: true; readonly sourceId: Id<"sources"> | undefined } | Refusal> {
  if (ref === undefined) {
    return { ok: true, sourceId: undefined };
  }
  const source = await loadCompanySource(tx.db, scope.companyId, ref);
  if (source === null) {
    return refuse(errorResult(notFoundError("sources", "basis_source_not_found")));
  }
  if (source.lifecycle !== "active") {
    // A withdrawn source is no basis for a new change ("Źródło wycofane").
    return refuse(errorResult(conflictError("basis_source_not_active", "sources", source._id)));
  }
  return { ok: true, sourceId: source._id };
}

/** The executor: a catalog contact of this company (no account needed), or none. */
async function resolveExecutor(
  tx: MutationCtx,
  scope: CompanyScope,
  ref: string | null,
): Promise<{ readonly ok: true; readonly contactId: Id<"contacts"> | undefined } | Refusal> {
  if (ref === null) {
    return { ok: true, contactId: undefined };
  }
  const contact = await loadCompanyContact(tx.db, scope.companyId, ref);
  if (contact === null) {
    return refuse(errorResult(notFoundError("contacts", "executor_contact_not_found")));
  }
  return { ok: true, contactId: contact._id };
}

/** The coordinator: an ACTIVE membership of this company, or none. */
async function resolveCoordinator(
  tx: MutationCtx,
  scope: CompanyScope,
  ref: string | null,
): Promise<{ readonly ok: true; readonly membershipId: Id<"memberships"> | undefined } | Refusal> {
  if (ref === null) {
    return { ok: true, membershipId: undefined };
  }
  const membership = await loadCompanyMembership(tx.db, scope.companyId, ref);
  if (membership === null) {
    return refuse(errorResult(notFoundError("memberships", "coordinator_membership_not_found")));
  }
  const check = checkCoordinatorMembership(membership.state);
  if (!check.ok) {
    // No recordTable: "memberships" is outside the closed conflict
    // vocabulary; the machine code is the load-bearing detail.
    return refuse(errorResult(conflictError(check.code)));
  }
  return { ok: true, membershipId: membership._id };
}

/**
 * A temporal binding: a finding of this company whose CURRENT revision is
 * temporal (and, for a deadline, not an `actual` date), scoped to the firm
 * or to the same project. Bound by reference only: nothing is copied.
 */
async function resolveTemporalBinding(
  tx: MutationCtx,
  scope: CompanyScope,
  kind: TemporalBindingKind,
  projectId: Id<"projects">,
  ref: string | null,
): Promise<{ readonly ok: true; readonly findingId: Id<"findings"> | undefined } | Refusal> {
  if (ref === null) {
    return { ok: true, findingId: undefined };
  }
  const current = await loadCurrentFinding(tx.db, scope.companyId, ref);
  if (current === null) {
    return refuse(
      errorResult(
        notFoundError(
          "findings",
          kind === "task_deadline" ? "deadline_finding_not_found" : "time_finding_not_found",
        ),
      ),
    );
  }
  if (current.finding.scopeKind === "project" && current.finding.scopeProjectId !== projectId) {
    return refuse(errorResult(validationError("finding_project_mismatch")));
  }
  const check = checkTemporalBinding(kind, current.revision.value);
  if (!check.ok) {
    return refuse(errorResult(validationError(check.code)));
  }
  return { ok: true, findingId: current.finding._id };
}

// ---------------------------------------------------------------------------
// Tasks: prepare / commit
// ---------------------------------------------------------------------------

/** The linked-event decision of one task plan. */
type LinkedEventPlan =
  | { readonly kind: "keep" }
  | { readonly kind: "none" }
  | { readonly kind: "resolved"; readonly eventId: Id<"events"> }
  /** The event is created in the same transaction; commit receives its id. */
  | { readonly kind: "pending" };

/** The validated, not-yet-written outcome of one task change command. */
export interface TaskChangePlan {
  readonly scope: CompanyScope;
  readonly nowMs: number;
  readonly basisSourceId: Id<"sources"> | undefined;
  /** Null for a creation. */
  readonly existing: Doc<"tasks"> | null;
  readonly projectId: Id<"projects">;
  readonly title: string;
  readonly executorContactId: Id<"contacts"> | undefined;
  readonly coordinatorMembershipId: Id<"memberships"> | undefined;
  readonly deadlineFindingId: Id<"findings"> | undefined;
  readonly linkedEvent: LinkedEventPlan;
  /** Set when the task is born from a checklist point. */
  readonly parentTaskId: Id<"tasks"> | undefined;
  /** True when an update commands exactly the current values (no write). */
  readonly unchanged: boolean;
}

export interface PrepareTaskOptions {
  /** The linked event is being created in this transaction (the atomic pair). */
  readonly linkedEventPending?: boolean;
}

/**
 * Prepares one task change: resolves every reference inside the company
 * scope, verifies the aggregate revision for updates and decides what the
 * commit will write. Refuses before any write.
 */
export async function prepareChangeTask(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangeTaskInput,
  options: PrepareTaskOptions = {},
): Promise<{ readonly ok: true; readonly plan: TaskChangePlan } | Refusal> {
  const nowMs = Date.now();
  const scoped = companyScopeOf(tx.db, context);
  if (!scoped.ok) {
    return refuse(scoped.error);
  }
  const { scope } = scoped;
  const title = validateTaskTitle(input.title);
  if (!title.ok) {
    return refuse(errorResult(validationError(title.code)));
  }
  const basis = await resolveBasis(tx, scope, input.basisSourceId);
  if (!basis.ok) {
    return basis;
  }

  let existing: Doc<"tasks"> | null = null;
  if (input.taskId !== null) {
    existing = await loadCompanyTask(tx.db, scope.companyId, input.taskId);
    if (existing === null) {
      return refuse(errorResult(notFoundError("tasks")));
    }
    if (input.expectedRevision !== existing.revisionCounter) {
      return refuse(errorResult(conflictError("revision_mismatch", "tasks", existing._id)));
    }
  }
  const project = await loadCompanyProject(tx.db, scope.companyId, input.projectId);
  if (project === null) {
    return refuse(errorResult(notFoundError("projects")));
  }
  if (existing !== null && existing.projectId !== project._id) {
    // A task belongs to the project it arose in; re-attribution is not a
    // field edit (it would silently move every binding's scope).
    return refuse(errorResult(validationError("task_project_change_unsupported")));
  }

  const executor = await resolveExecutor(tx, scope, input.executorContactId);
  if (!executor.ok) {
    return executor;
  }
  const coordinator = await resolveCoordinator(tx, scope, input.coordinatorMembershipId);
  if (!coordinator.ok) {
    return coordinator;
  }
  const deadline = await resolveTemporalBinding(
    tx,
    scope,
    "task_deadline",
    project._id,
    input.deadlineFindingId,
  );
  if (!deadline.ok) {
    return deadline;
  }

  let linkedEvent: LinkedEventPlan;
  if (options.linkedEventPending === true) {
    linkedEvent = { kind: "pending" };
  } else if (input.linkedEventId === undefined) {
    linkedEvent = existing === null ? { kind: "none" } : { kind: "keep" };
  } else if (input.linkedEventId === null) {
    linkedEvent = { kind: "none" };
  } else {
    const event = await loadCompanyEvent(tx.db, scope.companyId, input.linkedEventId);
    if (event === null) {
      return refuse(errorResult(notFoundError("events", "linked_event_not_found")));
    }
    if (event.projectId !== project._id) {
      return refuse(errorResult(validationError("linked_event_project_mismatch")));
    }
    linkedEvent = { kind: "resolved", eventId: event._id };
  }

  const unchanged =
    existing !== null &&
    existing.title === title.value &&
    existing.executorContactId === executor.contactId &&
    existing.coordinatorMembershipId === coordinator.membershipId &&
    existing.deadlineFindingId === deadline.findingId &&
    (linkedEvent.kind === "keep" ||
      (linkedEvent.kind === "none" && existing.linkedEventId === undefined) ||
      (linkedEvent.kind === "resolved" && existing.linkedEventId === linkedEvent.eventId));

  return {
    ok: true,
    plan: {
      scope,
      nowMs,
      basisSourceId: basis.sourceId,
      existing,
      projectId: project._id,
      title: title.value,
      executorContactId: executor.contactId,
      coordinatorMembershipId: coordinator.membershipId,
      deadlineFindingId: deadline.findingId,
      linkedEvent,
      parentTaskId: undefined,
      unchanged,
    },
  };
}

/** The linked event id a plan resolves to at commit time. */
function linkedEventIdOf(
  plan: TaskChangePlan,
  pendingEventId: Id<"events"> | undefined,
): Id<"events"> | undefined {
  switch (plan.linkedEvent.kind) {
    case "keep":
      return plan.existing?.linkedEventId;
    case "none":
      return undefined;
    case "resolved":
      return plan.linkedEvent.eventId;
    case "pending":
      if (pendingEventId === undefined) {
        throw new Error("work transaction: pending linked event was never created");
      }
      return pendingEventId;
  }
}

/**
 * Commits one prepared task change: only pre-validated writes, the history
 * row and the canonical event, all in the caller's transaction.
 */
export async function commitChangeTask(
  tx: MutationCtx,
  plan: TaskChangePlan,
  pendingEventId?: Id<"events">,
): Promise<Id<"tasks">> {
  const { scope, nowMs } = plan;
  const linkedEventId = linkedEventIdOf(plan, pendingEventId);

  if (plan.existing === null) {
    const taskId = await tx.db.insert("tasks", {
      companyId: scope.companyId,
      projectId: plan.projectId,
      title: plan.title,
      // A task is born Do zrobienia; any other state is an explicit command.
      state: "todo",
      ...(plan.executorContactId !== undefined && { executorContactId: plan.executorContactId }),
      ...(plan.coordinatorMembershipId !== undefined && {
        coordinatorMembershipId: plan.coordinatorMembershipId,
      }),
      ...(plan.deadlineFindingId !== undefined && { deadlineFindingId: plan.deadlineFindingId }),
      ...(linkedEventId !== undefined && { linkedEventId }),
      ...(plan.parentTaskId !== undefined && { parentTaskId: plan.parentTaskId }),
      revisionCounter: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      stateChangedAtMs: nowMs,
    });
    await recordWorkRevision(tx, {
      scope,
      subjectKind: "task",
      taskId,
      revision: 1,
      change: "created",
      snapshot: taskSnapshotOf(await requireRow(tx, taskId)),
      basisSourceId: plan.basisSourceId,
      nowMs,
    });
    await publishWorkEvent(tx, scope.companyId, "work.taskChanged", { taskId }, `work.taskChanged:${taskId}:1`);
    return taskId;
  }

  if (plan.unchanged) {
    return plan.existing._id;
  }
  const revision = plan.existing.revisionCounter + 1;
  // Patching to undefined clears a field (Convex deletes undefined keys).
  await tx.db.patch(plan.existing._id, {
    title: plan.title,
    executorContactId: plan.executorContactId,
    coordinatorMembershipId: plan.coordinatorMembershipId,
    deadlineFindingId: plan.deadlineFindingId,
    linkedEventId,
    revisionCounter: revision,
    updatedAtMs: nowMs,
  });
  await recordWorkRevision(tx, {
    scope,
    subjectKind: "task",
    taskId: plan.existing._id,
    revision,
    change: "changed",
    snapshot: taskSnapshotOf(await requireRow(tx, plan.existing._id)),
    basisSourceId: plan.basisSourceId,
    nowMs,
  });
  await publishWorkEvent(
    tx,
    scope.companyId,
    "work.taskChanged",
    { taskId: plan.existing._id },
    `work.taskChanged:${plan.existing._id}:${revision}`,
  );
  return plan.existing._id;
}

/**
 * Creates or updates one task's identity, responsibility and bindings.
 * Creation never sets a state other than Do zrobienia and never assigns
 * the command's author as coordinator: responsibility is an explicit
 * input or nothing ("zadanie pozostaje we wspólnej kolejce").
 */
export async function performChangeTask(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangeTaskInput,
): Promise<ResultEnvelope> {
  const prepared = await prepareChangeTask(tx, context, input);
  if (!prepared.ok) {
    return prepared.error;
  }
  const taskId = await commitChangeTask(tx, prepared.plan);
  return okResult(Schema.decodeUnknownSync(changeTaskEntry.result)({ taskId }));
}

// ---------------------------------------------------------------------------
// Task state
// ---------------------------------------------------------------------------

/**
 * Changes the task state by explicit command. The decision consumes only
 * the current record and the commanded target (Czeka needs its reason);
 * the checklist is never read here, so 3/3 checked points cannot complete
 * a task and Wykonane with 2/3 stays exactly that. A reopen keeps the
 * deadline binding as it is: nothing here moves a term.
 */
export async function performChangeTaskState(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangeTaskStateInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scoped = companyScopeOf(tx.db, context);
  if (!scoped.ok) {
    return scoped.error;
  }
  const { scope } = scoped;
  const basis = await resolveBasis(tx, scope, input.basisSourceId);
  if (!basis.ok) {
    return basis.error;
  }
  const task = await loadCompanyTask(tx.db, scope.companyId, input.taskId);
  if (task === null) {
    return errorResult(notFoundError("tasks"));
  }
  if (input.expectedRevision !== task.revisionCounter) {
    return errorResult(conflictError("revision_mismatch", "tasks", task._id));
  }
  const decision = decideTaskStateChange(
    { state: task.state, waitingReason: task.waitingReason ?? null },
    { state: input.state, waitingReason: input.waitingReason },
  );
  if (decision.kind === "rejected") {
    return errorResult(validationError(decision.code));
  }
  const receipt = okResult(Schema.decodeUnknownSync(changeTaskStateEntry.result)({ taskId: task._id }));
  if (decision.kind === "unchanged") {
    return receipt;
  }

  // --- the atomic commit: state/reason + revision + history + event --------
  const revision = task.revisionCounter + 1;
  if (decision.kind === "reason_changed") {
    await tx.db.patch(task._id, {
      waitingReason: decision.waitingReason,
      revisionCounter: revision,
      updatedAtMs: nowMs,
      stateChangedAtMs: nowMs,
    });
    await recordWorkRevision(tx, {
      scope,
      subjectKind: "task",
      taskId: task._id,
      revision,
      change: "changed",
      snapshot: taskSnapshotOf(await requireRow(tx, task._id)),
      basisSourceId: basis.sourceId,
      nowMs,
    });
    await publishWorkEvent(
      tx,
      scope.companyId,
      "work.taskChanged",
      { taskId: task._id },
      `work.taskChanged:${task._id}:${revision}`,
    );
    return receipt;
  }

  await tx.db.patch(task._id, {
    state: decision.to,
    waitingReason: decision.waitingReason ?? undefined,
    revisionCounter: revision,
    updatedAtMs: nowMs,
    stateChangedAtMs: nowMs,
  });
  await recordWorkRevision(tx, {
    scope,
    subjectKind: "task",
    taskId: task._id,
    revision,
    change: "state_changed",
    snapshot: taskSnapshotOf(await requireRow(tx, task._id)),
    basisSourceId: basis.sourceId,
    nowMs,
  });
  await publishWorkEvent(
    tx,
    scope.companyId,
    "work.taskStateChanged",
    { taskId: task._id, fromState: decision.from, toState: decision.to },
    `work.taskStateChanged:${task._id}:${revision}`,
  );
  return receipt;
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

/**
 * Creates or updates one checklist point. The parent task's STATE is
 * neither read nor written anywhere in this function — a point may be
 * checked under a Wykonane task without reopening it, and checking the last
 * point completes nothing. Only the aggregate revision serializes it.
 */
export async function performChangeChecklistItem(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangeChecklistItemInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scoped = companyScopeOf(tx.db, context);
  if (!scoped.ok) {
    return scoped.error;
  }
  const { scope } = scoped;
  const basis = await resolveBasis(tx, scope, input.basisSourceId);
  if (!basis.ok) {
    return basis.error;
  }
  const task = await loadCompanyTask(tx.db, scope.companyId, input.taskId);
  if (task === null) {
    return errorResult(notFoundError("tasks"));
  }
  if (input.expectedRevision !== task.revisionCounter) {
    return errorResult(conflictError("revision_mismatch", "tasks", task._id));
  }
  let existing: Doc<"checklistItems"> | null = null;
  if (input.itemId !== null) {
    existing = await loadTaskItem(tx.db, task._id, input.itemId);
    if (existing === null) {
      return errorResult(notFoundError("checklistItems"));
    }
  }
  const decision = decideChecklistItemChange(
    existing === null
      ? null
      : {
          description: existing.description,
          state: existing.state,
          promotedToTaskId: existing.promotedToTaskId ?? null,
        },
    { description: input.description, state: input.state },
  );
  if (decision.kind === "rejected") {
    if (decision.code === "item_promoted") {
      return errorResult(conflictError("item_promoted", "checklistItems", existing?._id));
    }
    return errorResult(validationError(decision.code));
  }
  if (decision.kind === "unchanged") {
    if (existing === null) {
      throw new Error("work transaction: unchanged decision without an existing point");
    }
    return okResult(
      Schema.decodeUnknownSync(changeChecklistItemEntry.result)({ itemId: existing._id }),
    );
  }

  // --- the atomic commit: point + aggregate revision + history + event -----
  const taskRevision = task.revisionCounter + 1;
  let itemId: Id<"checklistItems">;
  if (decision.kind === "create") {
    itemId = await tx.db.insert("checklistItems", {
      taskId: task._id,
      description: decision.description,
      state: input.state,
      revisionCounter: 1,
      ...(input.state === "checked" && { checkedAtMs: nowMs }),
      createdAtMs: nowMs,
    });
  } else {
    if (existing === null) {
      throw new Error("work transaction: update decision without an existing point");
    }
    itemId = existing._id;
    await tx.db.patch(itemId, {
      description: decision.description,
      state: input.state,
      ...(decision.stateChanged && {
        checkedAtMs: input.state === "checked" ? nowMs : undefined,
      }),
      revisionCounter: existing.revisionCounter + 1,
      updatedAtMs: nowMs,
    });
  }
  // The task row: ONLY its aggregate counter moves. Its state is untouched.
  await tx.db.patch(task._id, { revisionCounter: taskRevision, updatedAtMs: nowMs });
  await recordWorkRevision(tx, {
    scope,
    subjectKind: "checklist_item",
    taskId: task._id,
    itemId,
    revision: taskRevision,
    change: decision.kind === "create" ? "created" : "changed",
    snapshot: itemSnapshotOf(await requireRow(tx, itemId)),
    basisSourceId: basis.sourceId,
    nowMs,
  });
  await publishWorkEvent(
    tx,
    scope.companyId,
    "work.checklistItemChanged",
    { taskId: task._id, itemId, state: input.state },
    `work.checklistItemChanged:${itemId}:${taskRevision}`,
  );
  return okResult(Schema.decodeUnknownSync(changeChecklistItemEntry.result)({ itemId }));
}

/**
 * Converts one checklist point into a separate, linked task: the new task
 * is born Do zrobienia in the parent's project with the point's description
 * as its title and the EXPLICITLY commanded responsibility and deadline;
 * the point keeps its state and history and gains the link (frozen from
 * then on: its obligation lives in the task). Both rows, both history rows
 * and both events commit together.
 */
export async function performPromoteChecklistItem(
  tx: MutationCtx,
  context: RequestContext,
  input: PromoteChecklistItemInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scoped = companyScopeOf(tx.db, context);
  if (!scoped.ok) {
    return scoped.error;
  }
  const { scope } = scoped;
  const basis = await resolveBasis(tx, scope, input.basisSourceId);
  if (!basis.ok) {
    return basis.error;
  }
  const parent = await loadCompanyTask(tx.db, scope.companyId, input.taskId);
  if (parent === null) {
    return errorResult(notFoundError("tasks"));
  }
  if (input.expectedRevision !== parent.revisionCounter) {
    return errorResult(conflictError("revision_mismatch", "tasks", parent._id));
  }
  const item = await loadTaskItem(tx.db, parent._id, input.itemId);
  if (item === null) {
    return errorResult(notFoundError("checklistItems"));
  }
  const decision = decideChecklistPromotion({
    description: item.description,
    state: item.state,
    promotedToTaskId: item.promotedToTaskId ?? null,
  });
  if (decision.kind === "rejected") {
    return errorResult(conflictError(decision.code, "checklistItems", item._id));
  }
  const executor = await resolveExecutor(tx, scope, input.executorContactId);
  if (!executor.ok) {
    return executor.error;
  }
  const coordinator = await resolveCoordinator(tx, scope, input.coordinatorMembershipId);
  if (!coordinator.ok) {
    return coordinator.error;
  }
  const deadline = await resolveTemporalBinding(
    tx,
    scope,
    "task_deadline",
    parent.projectId,
    input.deadlineFindingId,
  );
  if (!deadline.ok) {
    return deadline.error;
  }

  // --- the atomic commit: new task + link + parent revision + history ------
  const plan: TaskChangePlan = {
    scope,
    nowMs,
    basisSourceId: basis.sourceId,
    existing: null,
    projectId: parent.projectId,
    title: decision.title,
    executorContactId: executor.contactId,
    coordinatorMembershipId: coordinator.membershipId,
    deadlineFindingId: deadline.findingId,
    linkedEvent: { kind: "none" },
    parentTaskId: parent._id,
    unchanged: false,
  };
  const taskId = await commitChangeTask(tx, plan);
  const parentRevision = parent.revisionCounter + 1;
  await tx.db.patch(item._id, {
    promotedToTaskId: taskId,
    revisionCounter: item.revisionCounter + 1,
    updatedAtMs: nowMs,
  });
  await tx.db.patch(parent._id, { revisionCounter: parentRevision, updatedAtMs: nowMs });
  await recordWorkRevision(tx, {
    scope,
    subjectKind: "checklist_item",
    taskId: parent._id,
    itemId: item._id,
    revision: parentRevision,
    change: "promoted",
    snapshot: itemSnapshotOf(await requireRow(tx, item._id)),
    basisSourceId: basis.sourceId,
    nowMs,
  });
  await publishWorkEvent(
    tx,
    scope.companyId,
    "work.taskChanged",
    { taskId: parent._id },
    `work.taskChanged:${parent._id}:${parentRevision}`,
  );
  return okResult(Schema.decodeUnknownSync(promoteChecklistItemEntry.result)({ taskId }));
}

// ---------------------------------------------------------------------------
// Events: prepare / commit
// ---------------------------------------------------------------------------

/** The validated, not-yet-written outcome of one event change command. */
export interface EventChangePlan {
  readonly scope: CompanyScope;
  readonly nowMs: number;
  readonly basisSourceId: Id<"sources"> | undefined;
  readonly existing: Doc<"events"> | null;
  readonly projectId: Id<"projects">;
  readonly title: string;
  readonly timeFindingId: Id<"findings"> | undefined;
  readonly unchanged: boolean;
}

/** Prepares one event change (same shape and discipline as tasks). */
export async function prepareChangeEvent(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangeEventInput,
): Promise<{ readonly ok: true; readonly plan: EventChangePlan } | Refusal> {
  const nowMs = Date.now();
  const scoped = companyScopeOf(tx.db, context);
  if (!scoped.ok) {
    return refuse(scoped.error);
  }
  const { scope } = scoped;
  const title = validateEventTitle(input.title);
  if (!title.ok) {
    return refuse(errorResult(validationError(title.code)));
  }
  const basis = await resolveBasis(tx, scope, input.basisSourceId);
  if (!basis.ok) {
    return basis;
  }
  let existing: Doc<"events"> | null = null;
  if (input.eventId !== null) {
    existing = await loadCompanyEvent(tx.db, scope.companyId, input.eventId);
    if (existing === null) {
      return refuse(errorResult(notFoundError("events")));
    }
    if (input.expectedRevision !== existing.revisionCounter) {
      return refuse(errorResult(conflictError("revision_mismatch", "events", existing._id)));
    }
  }
  const project = await loadCompanyProject(tx.db, scope.companyId, input.projectId);
  if (project === null) {
    return refuse(errorResult(notFoundError("projects")));
  }
  if (existing !== null && existing.projectId !== project._id) {
    return refuse(errorResult(validationError("event_project_change_unsupported")));
  }
  const time = await resolveTemporalBinding(tx, scope, "event_time", project._id, input.timeFindingId);
  if (!time.ok) {
    return time;
  }
  const unchanged =
    existing !== null && existing.title === title.value && existing.timeFindingId === time.findingId;
  return {
    ok: true,
    plan: {
      scope,
      nowMs,
      basisSourceId: basis.sourceId,
      existing,
      projectId: project._id,
      title: title.value,
      timeFindingId: time.findingId,
      unchanged,
    },
  };
}

/** Commits one prepared event change (only pre-validated writes). */
export async function commitChangeEvent(tx: MutationCtx, plan: EventChangePlan): Promise<Id<"events">> {
  const { scope, nowMs } = plan;
  if (plan.existing === null) {
    const eventId = await tx.db.insert("events", {
      companyId: scope.companyId,
      projectId: plan.projectId,
      title: plan.title,
      // An event is born Planowane; occurrence is always an explicit fact.
      state: "planned",
      ...(plan.timeFindingId !== undefined && { timeFindingId: plan.timeFindingId }),
      revisionCounter: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    await recordWorkRevision(tx, {
      scope,
      subjectKind: "event",
      eventId,
      revision: 1,
      change: "created",
      snapshot: eventSnapshotOf(await requireRow(tx, eventId)),
      basisSourceId: plan.basisSourceId,
      nowMs,
    });
    await publishWorkEvent(tx, scope.companyId, "work.eventChanged", { eventId }, `work.eventChanged:${eventId}:1`);
    return eventId;
  }
  if (plan.unchanged) {
    return plan.existing._id;
  }
  const revision = plan.existing.revisionCounter + 1;
  await tx.db.patch(plan.existing._id, {
    title: plan.title,
    timeFindingId: plan.timeFindingId,
    revisionCounter: revision,
    updatedAtMs: nowMs,
  });
  await recordWorkRevision(tx, {
    scope,
    subjectKind: "event",
    eventId: plan.existing._id,
    revision,
    change: "changed",
    snapshot: eventSnapshotOf(await requireRow(tx, plan.existing._id)),
    basisSourceId: plan.basisSourceId,
    nowMs,
  });
  await publishWorkEvent(
    tx,
    scope.companyId,
    "work.eventChanged",
    { eventId: plan.existing._id },
    `work.eventChanged:${plan.existing._id}:${revision}`,
  );
  return plan.existing._id;
}

/**
 * Creates or updates one event: a dated element of the work's course. It
 * has no executor, coordinator or checklist by construction — a date in a
 * statement yields exactly this record and nothing that obliges anyone.
 */
export async function performChangeEvent(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangeEventInput,
): Promise<ResultEnvelope> {
  const prepared = await prepareChangeEvent(tx, context, input);
  if (!prepared.ok) {
    return prepared.error;
  }
  const eventId = await commitChangeEvent(tx, prepared.plan);
  return okResult(Schema.decodeUnknownSync(changeEventEntry.result)({ eventId }));
}

/**
 * Changes the event state by explicit command (planned / occurred /
 * cancelled). The decision has no time input: an elapsed planned date
 * cannot enter it, so occurrence is always explicit evidence.
 */
export async function performChangeEventState(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangeEventStateInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scoped = companyScopeOf(tx.db, context);
  if (!scoped.ok) {
    return scoped.error;
  }
  const { scope } = scoped;
  const basis = await resolveBasis(tx, scope, input.basisSourceId);
  if (!basis.ok) {
    return basis.error;
  }
  const event = await loadCompanyEvent(tx.db, scope.companyId, input.eventId);
  if (event === null) {
    return errorResult(notFoundError("events"));
  }
  if (input.expectedRevision !== event.revisionCounter) {
    return errorResult(conflictError("revision_mismatch", "events", event._id));
  }
  const decision = decideEventStateChange(event.state, input.state);
  const receipt = okResult(
    Schema.decodeUnknownSync(changeEventStateEntry.result)({ eventId: event._id }),
  );
  if (decision.kind === "unchanged") {
    return receipt;
  }

  // --- the atomic commit: state + revision + history + event ---------------
  const revision = event.revisionCounter + 1;
  await tx.db.patch(event._id, {
    state: decision.to,
    revisionCounter: revision,
    updatedAtMs: nowMs,
  });
  await recordWorkRevision(tx, {
    scope,
    subjectKind: "event",
    eventId: event._id,
    revision,
    change: "state_changed",
    snapshot: eventSnapshotOf(await requireRow(tx, event._id)),
    basisSourceId: basis.sourceId,
    nowMs,
  });
  await publishWorkEvent(
    tx,
    scope.companyId,
    "work.eventStateChanged",
    { eventId: event._id, fromState: decision.from, toState: decision.to },
    `work.eventStateChanged:${event._id}:${revision}`,
  );
  return receipt;
}

// ---------------------------------------------------------------------------
// The atomic pair: one agreement, one event, one deliberately linked task
// ---------------------------------------------------------------------------

export interface EventWithTaskInput {
  /** A NEW event (`eventId` null). */
  readonly event: ChangeEventInput;
  /** A NEW task (`taskId` null); its link is the event created here. */
  readonly task: ChangeTaskInput;
}

/**
 * Records a dated event and its deliberately linked task in ONE transaction:
 * both halves are PREPARED (every refusal happens here) before either is
 * COMMITTED, so a refusal of the task leaves no orphan event and vice
 * versa. The two records share whatever dated finding the caller binds to
 * both (`timeFindingId` / `deadlineFindingId`) by reference — one
 * agreement, no divergent copies. Composable inside a publication
 * transaction (E3): call it from the same MutationCtx.
 */
export async function performRecordEventWithTask(
  tx: MutationCtx,
  context: RequestContext,
  input: EventWithTaskInput,
): Promise<ResultEnvelope> {
  if (input.event.eventId !== null || input.task.taskId !== null) {
    return errorResult(validationError("event_with_task_requires_new_records"));
  }
  if (input.event.projectId !== input.task.projectId) {
    return errorResult(validationError("linked_event_project_mismatch"));
  }
  const event = await prepareChangeEvent(tx, context, input.event);
  if (!event.ok) {
    return event.error;
  }
  const task = await prepareChangeTask(tx, context, input.task, { linkedEventPending: true });
  if (!task.ok) {
    return task.error;
  }
  // --- both prepared: commit both -----------------------------------------
  const eventId = await commitChangeEvent(tx, event.plan);
  const taskId = await commitChangeTask(tx, task.plan, eventId);
  return okResult({ eventId, taskId });
}
