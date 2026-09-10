/**
 * Calendar projection transactions (G2): the write halves of the pure
 * projection rules, each inside ONE Convex mutation.
 *
 * One projection pass per connection: recheck the connection (the durable
 * revocation stop from the access lane is still a lazy prerequisite, so
 * EVERY pass re-reads the row and re-resolves the user's active firm),
 * derive the desired copies from the CURRENT revisions of the bound
 * findings (never stored copies of dates), diff against the copies the
 * connection already has, and apply the idempotent create/update/withdraw
 * actions atomically. A suspended pass (lost or refresh-unknown
 * connection, absent credential) writes ONLY its honest sync-state row —
 * no partial desired-state writes are possible because the suspend
 * decision precedes every copy read.
 *
 * The Google legs are NOT here: `googleEventId`/`remoteOutcome` stay G3's
 * remote ledger. G2 only ever sets the initial `unknown` and resets it
 * when the semantic id is re-minted under a different Google account (the
 * old calendar's linkage honestly stops being knowable; G3 reconciles).
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { notFoundError, type RequestContext } from "@kiero/runtime";
import {
  decideProjectionMode,
  decideSyncStateTransition,
  desiredCopyForSubject,
  diffDesiredCopies,
  payloadFingerprint,
  type CopyAction,
  type DesiredGoogleEvent,
  type ExistingCopy,
  type PersonalScope,
  type ProjectSelection,
  type TermBindingView,
  type WorkSubjectView,
} from "@kiero/domain";
import { temporalValueOf } from "@kiero/domain";
import { internalMutation } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import { earliestActiveCompanyId } from "../connection/operations";
import { WITHDRAW_REASONS } from "./schema";

/** The refresh outcome literals G1's credential capability reports. */
const refreshOutcomeValue = v.union(
  v.literal("refreshed"),
  v.literal("definitely_lost"),
  v.literal("unknown"),
  v.literal("membership_lost"),
  v.literal("no_connection"),
  v.literal("no_credential"),
);

// ---------------------------------------------------------------------------
// Row plumbing.
// ---------------------------------------------------------------------------

async function copiesOfConnection(
  db: MutationCtx["db"],
  connectionId: Id<"calendarConnections">,
): Promise<Doc<"calendarCopies">[]> {
  return await db
    .query("calendarCopies")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .collect();
}

async function syncStateOf(
  db: MutationCtx["db"],
  connectionId: Id<"calendarConnections">,
): Promise<Doc<"calendarSyncState"> | null> {
  return await db
    .query("calendarSyncState")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .first();
}

/** The personal project selection of one sync row (default: all projects). */
function projectSelectionOf(row: Doc<"calendarSyncState"> | null): ProjectSelection {
  const stored = row?.selectedProjects;
  if (stored === undefined || stored.mode === "all_projects") {
    return { mode: "all_projects" };
  }
  return { mode: "explicit", projectIds: new Set<string>(stored.projectIds ?? []) };
}

/** The existing-copy view the pure diff consumes. */
function existingCopyView(row: Doc<"calendarCopies">): ExistingCopy {
  return {
    copyId: row._id,
    subjectKind: row.subjectKind,
    subjectId: (row.taskId ?? row.eventId) as string,
    semanticId: row.semanticId,
    hidden: row.hidden,
    derivationRevisionId: row.desiredRevisionId,
    desiredState: row.desiredState,
    payload: (row.payload as DesiredGoogleEvent | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Desired-state derivation (loading + the pure module).
// ---------------------------------------------------------------------------

/** The term binding view of one bound finding's CURRENT revision. */
async function termBindingOf(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  findingId: Id<"findings"> | undefined,
): Promise<TermBindingView | null> {
  if (findingId === undefined) {
    return null;
  }
  const finding = await db.get(findingId);
  if (finding === null || finding.companyId !== companyId || finding.currentRevisionId === undefined) {
    return null;
  }
  const revision = await db.get(finding.currentRevisionId);
  if (revision === null) {
    return null;
  }
  return {
    knowledgeState: revision.knowledgeState,
    temporal: temporalValueOf(revision.value),
    revisionId: revision._id,
  };
}

/** Loads every task of the firm as a subject view (closed ones keep rows to withdraw). */
async function taskSubjectsOf(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
): Promise<WorkSubjectView[]> {
  const tasks = await db
    .query("tasks")
    .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
    .collect();
  const subjects: WorkSubjectView[] = [];
  for (const task of tasks) {
    subjects.push({
      kind: "task",
      taskId: task._id,
      projectId: task.projectId,
      title: task.title,
      state: task.state,
      ...(task.waitingReason !== undefined ? { waitingReason: task.waitingReason } : {}),
      coordinatorMembershipId: task.coordinatorMembershipId ?? null,
      deadline: await termBindingOf(db, companyId, task.deadlineFindingId),
    });
  }
  return subjects;
}

/** Loads every event of the firm as a subject view (all states). */
async function eventSubjectsOf(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
): Promise<WorkSubjectView[]> {
  const events = await db
    .query("events")
    .withIndex("by_project_state", (q) => q.eq("companyId", companyId))
    .collect();
  const subjects: WorkSubjectView[] = [];
  for (const event of events) {
    subjects.push({
      kind: "event",
      eventId: event._id,
      projectId: event.projectId,
      title: event.title,
      state: event.state,
      time: await termBindingOf(db, companyId, event.timeFindingId),
    });
  }
  return subjects;
}

/** The app base URL the authenticated copy link points at (name only). */
function appBaseUrl(env: { KIERO_CALENDAR_APP_BASE_URL?: string; CONVEX_SITE_URL?: string }): string {
  const explicit = env.KIERO_CALENDAR_APP_BASE_URL;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  const site = env.CONVEX_SITE_URL;
  return typeof site === "string" && site.length > 0 ? site : "";
}

// ---------------------------------------------------------------------------
// The projection pass transaction.
// ---------------------------------------------------------------------------

/** What one applied pass reports (sanitized; the proof reads rows itself). */
export interface ProjectionPassResult {
  readonly mode: "projected" | "suspended";
  readonly suspensionReason: string | null;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

/**
 * Applies ONE projection pass for one connection atomically: the
 * connection is rechecked here again (state + active firm), the mode is
 * re-decided from the recheck plus the credential capability's outcome,
 * and only a `project` mode touches copy rows. Every create/update write
 * is accompanied by the canonical `calendar.copyProjected` event.
 */
export const applyProjectionPassTransaction = internalMutation({
  args: {
    connectionId: v.id("calendarConnections"),
    refreshOutcome: refreshOutcomeValue,
  },
  handler: async (ctx, args): Promise<ProjectionPassResult> => {
    const nowMs = Date.now();
    const connection = await ctx.db.get(args.connectionId);
    const activeCompanyId =
      connection === null ? null : await earliestActiveCompanyId(ctx.db, connection.userId);
    const recheck =
      connection === null
        ? null
        : {
            state: connection.state,
            firmStillActive: activeCompanyId !== null && activeCompanyId === connection.companyId,
          };
    const mode = decideProjectionMode(recheck, args.refreshOutcome);
    const syncRow = connection === null ? null : await syncStateOf(ctx.db, connection._id);
    const transition = decideSyncStateTransition(mode);

    if (mode.kind === "suspend") {
      // NO desired-state writes: the suspension is recorded honestly and
      // the decision belongs to reconciliation (G3).
      const reason = mode.reason;
      if (syncRow === null && connection !== null) {
        await ctx.db.insert("calendarSyncState", {
          connectionId: connection._id,
          state: transition.state,
          suspendedReason: reason,
          lastPassAtMs: nowMs,
          updatedAtMs: nowMs,
        });
      } else if (syncRow !== null) {
        await ctx.db.patch(syncRow._id, {
          state: transition.state,
          suspendedReason: reason,
          lastPassAtMs: nowMs,
          updatedAtMs: nowMs,
        });
      }
      return { mode: "suspended", suspensionReason: reason, created: 0, updated: 0, unchanged: 0 };
    }
    if (connection === null) {
      // Unreachable (a null connection suspends above); kept fail-closed.
      return { mode: "suspended", suspensionReason: "no_connection", created: 0, updated: 0, unchanged: 0 };
    }

    // --- project: derive the desired state from CURRENT revisions --------
    const company = await ctx.db.get(connection.companyId);
    const timezone = company?.timezone ?? "Europe/Warsaw";
    const base = appBaseUrl(process.env);
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_company_stage", (q) => q.eq("companyId", connection.companyId))
      .collect();
    const projectNames = new Map<string, string>(
      projects.map((project) => [project._id, project.displayName]),
    );
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", connection.userId))
      .collect();
    const ownMembershipIds = new Set<string>(
      memberships
        .filter((m) => m.companyId === connection.companyId && m.state === "active")
        .map((m) => m._id),
    );
    const scope: PersonalScope = {
      projectSelection: projectSelectionOf(syncRow),
      ownMembershipIds,
    };
    const subjects = [
      ...(await taskSubjectsOf(ctx.db, connection.companyId)),
      ...(await eventSubjectsOf(ctx.db, connection.companyId)),
    ];
    const desired = subjects.map((subject) =>
      desiredCopyForSubject(subject, scope, {
        companyId: connection.companyId,
        userId: connection.userId,
        googleAccountSubject: connection.googleAccountSubject ?? null,
        projectName: projectNames.get(subject.projectId) ?? "Projekt",
        companyTimezone: timezone,
        appBaseUrl: base,
      }),
    );
    const existing = await copiesOfConnection(ctx.db, connection._id);
    const actions = diffDesiredCopies(existing.map(existingCopyView), desired);

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    for (const action of actions) {
      const outcome = await applyCopyAction(
        ctx,
        action,
        connection.companyId,
        connection._id,
        connection.userId,
        nowMs,
      );
      if (outcome === "created") {
        created += 1;
      } else if (outcome === "updated") {
        updated += 1;
      } else {
        unchanged += 1;
      }
    }

    if (syncRow === null) {
      await ctx.db.insert("calendarSyncState", {
        connectionId: connection._id,
        state: transition.state,
        lastPassAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    } else {
      await ctx.db.patch(syncRow._id, {
        state: transition.state,
        suspendedReason: undefined,
        lastPassAtMs: nowMs,
        updatedAtMs: nowMs,
      });
    }
    return { mode: "projected", suspensionReason: null, created, updated, unchanged };
  },
});

/** Narrows a diff withdraw reason to the schema vocabulary (no blind cast). */
function isWithdrawReason(reason: string): reason is (typeof WITHDRAW_REASONS)[number] {
  return (WITHDRAW_REASONS as readonly string[]).includes(reason);
}

/** Applies one diff action; returns which counter it moved. */
async function applyCopyAction(
  ctx: MutationCtx,
  action: CopyAction,
  companyId: Id<"companies">,
  connectionId: Id<"calendarConnections">,
  userId: Id<"users">,
  nowMs: number,
): Promise<"created" | "updated" | "unchanged"> {
  if (action.action === "none") {
    return "unchanged";
  }
  // Subject ids come from this pass's own row loads; the cast re-brands
  // the pure module's plain string back to its Convex id at the seam.
  const isTask = action.desired.subjectKind === "task";

  if (action.action === "create" && action.desired.desired.state === "projected") {
    const payload = action.desired.desired.payload;
    if (action.desired.derivationRevisionId === null) {
      // Unreachable (a projected desire always has a revision); fail-closed.
      return "unchanged";
    }
    const copyId = await ctx.db.insert("calendarCopies", {
      connectionId,
      userId,
      subjectKind: action.desired.subjectKind,
      ...(isTask
        ? { taskId: action.desired.subjectId as Id<"tasks"> }
        : { eventId: action.desired.subjectId as Id<"events"> }),
      semanticId: action.desired.semanticId,
      desiredState: "projected",
      payload,
      payloadFingerprint: payloadFingerprint(payload),
      desiredRevisionId: action.desired.derivationRevisionId as Id<"findingRevisions">,
      hidden: false,
      remoteOutcome: "unknown",
      updatedAtMs: nowMs,
    });
    await publishEvent(ctx, {
      companyId,
      eventName: "calendar.copyProjected",
      payload: {
        copyId,
        subject: isTask
          ? { _tag: "task", taskId: action.desired.subjectId }
          : { _tag: "event", eventId: action.desired.subjectId },
        desiredRevisionId: action.desired.derivationRevisionId,
      },
      dedupKey: `calendar.copy-projected:${copyId}:${nowMs}`,
    });
    return "created";
  }

  if (action.action === "update") {
    const row = await ctx.db.get(action.copyId as Id<"calendarCopies">);
    if (row === null) {
      return "unchanged";
    }
    const desired = action.desired.desired;
    const semanticRebound = row.semanticId !== action.desired.semanticId;
    await ctx.db.patch(row._id, {
      semanticId: action.desired.semanticId,
      desiredState: desired.state,
      withdrawReason:
        desired.state === "withdrawn" && isWithdrawReason(desired.reason) ? desired.reason : undefined,
      payload: desired.state === "projected" ? desired.payload : undefined,
      payloadFingerprint:
        desired.state === "projected" ? payloadFingerprint(desired.payload) : undefined,
      ...(action.desired.derivationRevisionId !== null
        ? { desiredRevisionId: action.desired.derivationRevisionId as Id<"findingRevisions"> }
        : {}),
      // An account switch re-mints the semantic id: the old calendar's
      // linkage honestly stops being knowable (G3 reconciles the new one).
      ...(semanticRebound ? { googleEventId: undefined, remoteOutcome: "unknown" as const } : {}),
      updatedAtMs: nowMs,
    });
    await publishEvent(ctx, {
      companyId,
      eventName: "calendar.copyProjected",
      payload: {
        copyId: row._id,
        subject: isTask
          ? { _tag: "task", taskId: action.desired.subjectId }
          : { _tag: "event", eventId: action.desired.subjectId },
        desiredRevisionId: row.desiredRevisionId,
      },
      dedupKey: `calendar.copy-projected:${row._id}:${nowMs}`,
    });
    return "updated";
  }
  return "unchanged";
}

// ---------------------------------------------------------------------------
// Personal hide (calendar.setCopyHidden).
// ---------------------------------------------------------------------------

/**
 * `calendar.setCopyHidden`: the actor's OWN personal decision about ONE
 * copy — hide (with origin) or explicit restore. Ownership is the actor's
 * own connection; a foreign copy is not_found, no existence leak. The
 * underlying subject, its desired state and other bosses' copies are
 * untouched ("Ukrycie kopii kalendarzowej", CONTEXT.md).
 */
export async function performSetCopyHidden(
  ctx: MutationCtx,
  context: RequestContext,
  input: { readonly copyId: string; readonly hidden: boolean },
): Promise<ResultEnvelope> {
  const id = ctx.db.normalizeId("calendarCopies", input.copyId);
  if (id === null) {
    return errorResult(notFoundError("calendarCopies"));
  }
  const copy = await ctx.db.get(id);
  if (copy === null) {
    return errorResult(notFoundError("calendarCopies"));
  }
  const connection = await ctx.db.get(copy.connectionId);
  const actorUserId = ctx.db.normalizeId("users", context.actor.userId);
  const actorCompanyId = ctx.db.normalizeId("companies", context.actor.companyId);
  if (
    connection === null ||
    actorUserId === null ||
    actorCompanyId === null ||
    connection.userId !== actorUserId ||
    connection.companyId !== actorCompanyId
  ) {
    // Not the actor's own copy in the actor's own firm: not_found.
    return errorResult(notFoundError("calendarCopies"));
  }
  if (copy.hidden === input.hidden) {
    return okResult({ copyId: id });
  }
  await ctx.db.patch(copy._id, {
    hidden: input.hidden,
    ...(input.hidden
      ? { hiddenOrigin: "user_request" as const, hiddenAtMs: Date.now() }
      : { hiddenOrigin: undefined, hiddenAtMs: undefined }),
    updatedAtMs: Date.now(),
  });
  return okResult({ copyId: id });
}
