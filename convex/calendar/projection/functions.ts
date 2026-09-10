/**
 * The G2 Convex function surface (generated-call APIs).
 *
 * `runProjectionPass` is the deterministic projection driver: for one (or
 * every) connection it rechecks the connection PER PASS — first G1's
 * credential capability (ONE bounded refresh attempt, whose `unknown`
 * outcome means "do not publish, do not retry blindly"), then the
 * transaction's own row/membership recheck — and only a healthy pass
 * writes desired states. Scheduling the pass (cron, outbox consumer or
 * G3's sync loop) is deliberately NOT owned here: one durable consumer
 * edge per event is the certified platform shape today and the work.* fan-out
 * question is flagged in C4's report, so the pass is an explicit seam G3
 * and the joins trigger.
 *
 * `dispatchCalendarProjection` carries the certified personal-hide
 * operation (`calendar.setCopyHidden`) and, since G5 (issue #107), the
 * personal project-selection write (`calendar.setSelection`); the reads
 * below expose the boss's EFFECTIVE selection. `calendar.reconcileCopy`
 * stays unimplemented here (G3's lane) and fails closed `unsupported`.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import {
  internalAction,
  internalQuery,
  mutation,
  query,
} from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError } from "@kiero/runtime";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  liveSessionIdentity,
  liveSessionStore,
  resolveLiveSession,
} from "../../access/identity/resolution";
import { resolveRequestContext } from "../../platform/context";
import { dispatchCalendarProjectionCommand } from "./dispatch";

/** The sanitized denial every protected read fails with. */
function denialError(reason: string): never {
  throw new ConvexError(unauthenticatedError(`no_live_session_${reason}`));
}

// ---------------------------------------------------------------------------
// The projection pass action.
// ---------------------------------------------------------------------------

/** One connection's sanitized pass outcome. */
export interface ConnectionPassResult {
  readonly connectionId: string;
  readonly outcome: "projected" | "suspended";
  readonly suspensionReason: string | null;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
}

/**
 * Runs ONE deterministic projection pass for one connection (or every
 * connection of the deployment when no id is given). Per pass, per
 * connection: ONE bounded credential refresh (the external leg lives in
 * the action, never in a mutation), then ONE atomic desired-state
 * transaction. A suspended connection contributes NO desired-state writes.
 */
export const runProjectionPass = internalAction({
  args: { connectionId: v.optional(v.id("calendarConnections")) },
  handler: async (ctx, args): Promise<ConnectionPassResult[]> => {
    const ids =
      args.connectionId === undefined
        ? await ctx.runQuery(internal.calendar.projection.functions.allConnectionIds, {})
        : [args.connectionId];
    const results: ConnectionPassResult[] = [];
    for (const connectionId of ids) {
      // The per-pass connection recheck: the refresh capability also
      // materializes the membership-loss stop durably (G1's lazy edge).
      const refresh = await ctx.runAction(
        internal.calendar.connection.functions.refreshCredentials,
        { connectionId },
      );
      const applied = await ctx.runMutation(
        internal.calendar.projection.operations.applyProjectionPassTransaction,
        { connectionId, refreshOutcome: refresh.outcome },
      );
      results.push({
        connectionId,
        outcome: applied.mode,
        suspensionReason: applied.suspensionReason,
        created: applied.created,
        updated: applied.updated,
        unchanged: applied.unchanged,
      });
    }
    return results;
  },
});

/** Every connection id (the all-connections pass input). */
export const allConnectionIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"calendarConnections">[]> => {
    const rows = await ctx.db.query("calendarConnections").collect();
    return rows.map((row) => row._id);
  },
});

// ---------------------------------------------------------------------------
// Typed command dispatch (the certified personal-hide operation).
// ---------------------------------------------------------------------------

/** The company-scoped typed command dispatch (client path). */
export const dispatchCalendarProjection = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchCalendarProjectionCommand(ctx, args.envelope),
});

// ---------------------------------------------------------------------------
// Reads: the actor's own projection state, and the G3 desired-state seam.
// ---------------------------------------------------------------------------

/**
 * The boss's EFFECTIVE selection view (G5): the stored column when present,
 * the all-projects default otherwise. Explicit selections always carry a
 * (possibly empty) list: an explicit row without ids reads as the honest
 * empty opt-out, the same shape `calendar.setSelection` returns.
 */
function effectiveSelection(
  row: Doc<"calendarSyncState"> | null,
): { mode: "all_projects" | "explicit"; projectIds: string[] | null } {
  const stored = row?.selectedProjects;
  if (stored === undefined || stored.mode === "all_projects") {
    return { mode: "all_projects", projectIds: null };
  }
  return { mode: "explicit", projectIds: stored.projectIds ?? [] };
}

/**
 * Authenticated: the actor's own copies and sync state — the honest
 * "pending changes / needs reconnect" signal, the personal-hide surface
 * and the effective project selection (G5) the settings screen and the
 * J4 interval consume.
 */
export const projectionOverview = query({
  args: {},
  handler: async (ctx) => {
    const live = await resolveLiveSession(liveSessionStore(ctx.db), ctx.auth, Date.now());
    if (live.tag === "denied") {
      denialError(live.reason);
    }
    const context = await resolveRequestContext(
      ctx.db,
      liveSessionIdentity(live.session, Date.now()),
    );
    if (context === null) {
      return { state: "unavailable_no_company", selection: null, copies: [], sync: null };
    }
    const connection = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user", (q) => q.eq("userId", live.session.userId))
      .first();
    if (connection === null) {
      return { state: "no_connection", selection: null, copies: [], sync: null };
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null || connection.companyId !== companyId) {
      return { state: "membership_lost", selection: null, copies: [], sync: null };
    }
    const copies = await ctx.db
      .query("calendarCopies")
      .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
      .collect();
    const sync = await ctx.db
      .query("calendarSyncState")
      .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
      .first();
    return {
      state: "connected",
      selection: effectiveSelection(sync),
      copies: copies.map((copy) => ({
        copyId: copy._id,
        subjectKind: copy.subjectKind,
        subjectId: copy.taskId ?? copy.eventId ?? null,
        semanticId: copy.semanticId,
        desiredState: copy.desiredState,
        withdrawReason: copy.withdrawReason ?? null,
        summary: copy.payload?.summary ?? null,
        hidden: copy.hidden,
        remoteOutcome: copy.remoteOutcome,
        googleEventId: copy.googleEventId ?? null,
      })),
      sync:
        sync === null
          ? null
          : {
              state: sync.state,
              suspendedReason: sync.suspendedReason ?? null,
              lastPassAtMs: sync.lastPassAtMs ?? null,
              lastSyncedAtMs: sync.lastSyncedAtMs ?? null,
            },
    };
  },
});

/**
 * The G3 consumption seam: one connection's complete desired-state rows
 * (managed payload, hide flag, remote ledger) — exactly the inputs G3's
 * reconciliation diffs against Google.
 */
export const desiredCopiesForConnection = internalQuery({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (connection === null) {
      return null;
    }
    const copies = await ctx.db
      .query("calendarCopies")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .collect();
    const sync = await ctx.db
      .query("calendarSyncState")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .first();
    return {
      connection: {
        state: connection.state,
        googleCalendarId: connection.googleCalendarId ?? null,
        googleAccountSubject: connection.googleAccountSubject ?? null,
        cleanupStatus: connection.cleanupStatus ?? null,
      },
      sync:
        sync === null
          ? null
          : {
              state: sync.state,
              suspendedReason: sync.suspendedReason ?? null,
              selectedProjects: sync.selectedProjects ?? null,
            },
      copies: copies.map((copy) => ({
        copyId: copy._id as Id<"calendarCopies">,
        subjectKind: copy.subjectKind,
        subjectId: copy.taskId ?? copy.eventId ?? null,
        semanticId: copy.semanticId,
        desiredState: copy.desiredState,
        withdrawReason: copy.withdrawReason ?? null,
        payload: copy.payload ?? null,
        hidden: copy.hidden,
        remoteOutcome: copy.remoteOutcome,
        googleEventId: copy.googleEventId ?? null,
        desiredRevisionId: copy.desiredRevisionId,
      })),
    };
  },
});
