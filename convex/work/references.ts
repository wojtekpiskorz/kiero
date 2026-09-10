/**
 * Shared tenant-scoped reference checks, history recording and event
 * publication for the work lane (C4).
 *
 * The resolved company is the only company any row may belong to: every
 * load* helper normalizes the id, reads the row and returns null when the
 * row is missing OR belongs to another company — without saying which, so
 * the refusal leaks no existence information across the tenant boundary
 * (the C1/C2 discipline). `recordWorkRevision` is the ONLY writer of
 * `workRevisions`, and every current-row patch in ./operations.ts is made
 * in the same transaction as its history row.
 */

import { Schema } from "effect";
import { events, errorResult, type ResultEnvelope } from "@kiero/contracts";
import { validationError, type RequestContext } from "@kiero/runtime";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { publishEvent } from "../platform/publish";

/** The DB reader surface the reference checks need (mutation or query). */
export type Db = MutationCtx["db"] | QueryCtx["db"];

/** The resolved scope every transaction starts from (never client input). */
export interface CompanyScope {
  readonly companyId: Id<"companies">;
  readonly actorUserId: Id<"users">;
  readonly via: "user" | "agent";
}

/**
 * Resolves the Convex-normalized company and actor ids from the RESOLVED
 * request context. An unresolvable reference fails closed before any read
 * or write.
 */
export function companyScopeOf(
  db: Db,
  context: RequestContext,
): { readonly ok: true; readonly scope: CompanyScope } | {
  readonly ok: false;
  readonly error: ResultEnvelope;
} {
  const companyId = db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return { ok: false, error: errorResult(validationError("company_scope_unresolved")) };
  }
  const actorUserId = db.normalizeId("users", context.actor.userId);
  if (actorUserId === null) {
    return { ok: false, error: errorResult(validationError("actor_user_unresolved")) };
  }
  return { ok: true, scope: { companyId, actorUserId, via: context.actor.via } };
}

/** One company-scoped row loader over a company-carrying table. */
async function loadScoped<T extends "projects" | "contacts" | "memberships" | "findings" | "tasks" | "events" | "sources">(
  db: Db,
  table: T,
  companyId: Id<"companies">,
  ref: string,
): Promise<Doc<T> | null> {
  const id = db.normalizeId(table, ref);
  if (id === null) {
    return null;
  }
  const row = await db.get(id);
  if (row === null || row.companyId !== companyId) {
    return null;
  }
  return row;
}

export const loadCompanyProject = (db: Db, companyId: Id<"companies">, ref: string) =>
  loadScoped(db, "projects", companyId, ref);
export const loadCompanyContact = (db: Db, companyId: Id<"companies">, ref: string) =>
  loadScoped(db, "contacts", companyId, ref);
export const loadCompanyMembership = (db: Db, companyId: Id<"companies">, ref: string) =>
  loadScoped(db, "memberships", companyId, ref);
export const loadCompanyFinding = (db: Db, companyId: Id<"companies">, ref: string) =>
  loadScoped(db, "findings", companyId, ref);
export const loadCompanyTask = (db: Db, companyId: Id<"companies">, ref: string) =>
  loadScoped(db, "tasks", companyId, ref);
export const loadCompanyEvent = (db: Db, companyId: Id<"companies">, ref: string) =>
  loadScoped(db, "events", companyId, ref);
export const loadCompanySource = (db: Db, companyId: Id<"companies">, ref: string) =>
  loadScoped(db, "sources", companyId, ref);

/** One checklist point of one task, or null when missing/malformed/foreign. */
export async function loadTaskItem(
  db: Db,
  taskId: Id<"tasks">,
  ref: string,
): Promise<Doc<"checklistItems"> | null> {
  const id = db.normalizeId("checklistItems", ref);
  if (id === null) {
    return null;
  }
  const row = await db.get(id);
  if (row === null || row.taskId !== taskId) {
    return null;
  }
  return row;
}

/** A finding together with its CURRENT revision (the only place its value lives). */
export interface CurrentFinding {
  readonly finding: Doc<"findings">;
  readonly revision: Doc<"findingRevisions">;
}

/** Loads one company finding and its current revision, or null. */
export async function loadCurrentFinding(
  db: Db,
  companyId: Id<"companies">,
  ref: string,
): Promise<CurrentFinding | null> {
  const finding = await loadCompanyFinding(db, companyId, ref);
  if (finding === null || finding.currentRevisionId === undefined) {
    return null;
  }
  const revision = await db.get(finding.currentRevisionId);
  if (revision === null) {
    return null;
  }
  return { finding, revision };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** The immutable per-change snapshot shapes (typed by the schema fragment). */
export type WorkSnapshot = Doc<"workRevisions">["snapshot"];
export type WorkChangeKind = Doc<"workRevisions">["change"];

export interface WorkRevisionRecord {
  readonly scope: CompanyScope;
  readonly subjectKind: Doc<"workRevisions">["subjectKind"];
  readonly taskId?: Id<"tasks">;
  readonly itemId?: Id<"checklistItems">;
  readonly eventId?: Id<"events">;
  readonly revision: number;
  readonly change: WorkChangeKind;
  readonly snapshot: WorkSnapshot;
  readonly basisSourceId: Id<"sources"> | undefined;
  readonly nowMs: number;
}

/** Writes one immutable history row (the only writer of `workRevisions`). */
export async function recordWorkRevision(
  tx: MutationCtx,
  record: WorkRevisionRecord,
): Promise<Id<"workRevisions">> {
  return await tx.db.insert("workRevisions", {
    companyId: record.scope.companyId,
    subjectKind: record.subjectKind,
    ...(record.taskId !== undefined && { taskId: record.taskId }),
    ...(record.itemId !== undefined && { itemId: record.itemId }),
    ...(record.eventId !== undefined && { eventId: record.eventId }),
    revision: record.revision,
    change: record.change,
    snapshot: record.snapshot,
    actorUserId: record.scope.actorUserId,
    via: record.scope.via,
    ...(record.basisSourceId !== undefined && { basisSourceId: record.basisSourceId }),
    recordedAtMs: record.nowMs,
  });
}

/** The task snapshot of one task row as it is NOW (after the caller's patch). */
export function taskSnapshotOf(task: Doc<"tasks">): WorkSnapshot {
  return {
    kind: "task",
    projectId: task.projectId,
    title: task.title,
    state: task.state,
    ...(task.waitingReason !== undefined && { waitingReason: task.waitingReason }),
    ...(task.executorContactId !== undefined && { executorContactId: task.executorContactId }),
    ...(task.coordinatorMembershipId !== undefined && {
      coordinatorMembershipId: task.coordinatorMembershipId,
    }),
    ...(task.deadlineFindingId !== undefined && { deadlineFindingId: task.deadlineFindingId }),
    ...(task.linkedEventId !== undefined && { linkedEventId: task.linkedEventId }),
    ...(task.parentTaskId !== undefined && { parentTaskId: task.parentTaskId }),
  };
}

/** The point snapshot of one checklist row as it is NOW. */
export function itemSnapshotOf(item: Doc<"checklistItems">): WorkSnapshot {
  return {
    kind: "checklist_item",
    description: item.description,
    state: item.state,
    ...(item.promotedToTaskId !== undefined && { promotedToTaskId: item.promotedToTaskId }),
  };
}

/** The event snapshot of one event row as it is NOW. */
export function eventSnapshotOf(event: Doc<"events">): WorkSnapshot {
  return {
    kind: "event",
    projectId: event.projectId,
    title: event.title,
    state: event.state,
    ...(event.timeFindingId !== undefined && { timeFindingId: event.timeFindingId }),
  };
}

/** Re-reads one row after a patch (the snapshot must be the committed state). */
export async function requireRow<T extends "tasks" | "checklistItems" | "events">(
  tx: MutationCtx,
  id: Id<T>,
): Promise<Doc<T>> {
  const row = await tx.db.get(id);
  if (row === null) {
    throw new Error("work transaction: row vanished inside its own transaction");
  }
  return row;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Publishes one work event (payload pre-decoded against the registry). */
export async function publishWorkEvent(
  tx: MutationCtx,
  companyId: Id<"companies">,
  eventName: string,
  payload: unknown,
  dedupKey: string,
): Promise<void> {
  const entry = events[eventName];
  if (entry === undefined) {
    // The composed registry guarantees existence at import time; this keeps
    // the transaction honest even under future composition drift.
    throw new Error(`work transaction: unknown event ${eventName}`);
  }
  Schema.decodeUnknownSync(entry.payload)(payload);
  await publishEvent(tx, { companyId, eventName, payload, dedupKey });
}
