/**
 * The G3 Convex function surface (generated-call APIs).
 *
 * `runCalendarSyncPass` is the reconciliation driver G2's module docs name
 * ("an explicit seam G3 and the joins trigger"): per connection it runs
 * G2's REAL projection pass first (one bounded credential refresh + one
 * atomic desired-state transaction), then reconciles every copy with ONE
 * bounded Google leg each (the A3 echo template: prepare -> external leg
 * -> record). Suspended connections (refresh unknown/lost, membership
 * stopped) contribute ZERO Google legs — the honest suspension G2 already
 * wrote stays authoritative.
 *
 * `runReconcileOutcomeAttempt` is the durable `calendar.reconcile_outcome`
 * executor's action half: ONE copy, ONE bounded leg, uncertain outcomes
 * recorded and never retried blindly.
 *
 * `syncOverview` is the status export the issue names (last success,
 * pending, failed, reconnect-needed, possible-cleanup-remains) and the
 * timing basis for J4's 95%-within-60-seconds evaluation — recorded, never
 * claimed here.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalAction, internalQuery, mutation, query } from "../../_generated/server";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { type ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError } from "@kiero/runtime";
import {
  liveSessionIdentity,
  liveSessionStore,
  resolveLiveSession,
} from "../../access/identity/resolution";
import { resolveRequestContext } from "../../platform/context";
import { calendarApiBase } from "../connection/functions";
import { openCredential } from "../connection/credentialStore";
import { earliestActiveCompanyId } from "../connection/operations";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listEventsBySemanticId,
  observeEventById,
  updateCalendarEvent,
} from "./protocol";
import {
  attemptOutcomeOfMutation,
  attemptOutcomeOfObservation,
} from "./cores";
import type { LegResult } from "./operations";
import { dispatchCalendarSyncCommand } from "./dispatch";

/** The sanitized denial every protected read fails with. */
function denialError(reason: string): never {
  throw new ConvexError(unauthenticatedError(`no_live_session_${reason}`));
}

// ---------------------------------------------------------------------------
// The credential capability seam (G1's refresh, reused per leg batch).
// ---------------------------------------------------------------------------

/** The sealed credential read the sync actions open in memory. */
export const sealedCredentialForSync = internalQuery({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row === null || row.state !== "connected") {
      return null;
    }
    return {
      companyId: row.companyId,
      userId: row.userId,
      activeCompanyId: await earliestActiveCompanyId(ctx.db, row.userId),
      accessTokenExpiresAtMs: row.accessTokenExpiresAtMs ?? null,
      ...(row.credentialStorage === undefined ||
      row.credentialStorage === "none" ||
      row.credentialCiphertext === undefined
        ? { sealed: null }
        : { sealed: { storage: row.credentialStorage, ciphertext: row.credentialCiphertext } }),
    };
  },
});

/** Why a leg could not obtain a working access token. */
export type TokenBarrier =
  | "not_connected"
  | "membership_or_firm_changed"
  | "no_credential"
  | "refresh_unknown"
  | "refresh_lost";

/** The margin before expiry at which a refresh is still skipped. */
const TOKEN_FRESHNESS_MARGIN_MS = 60_000;

/**
 * Obtains a working access token for one connection: the SEALED bundle
 * while it is comfortably fresh, otherwise G1's ONE bounded refresh
 * attempt first (its `unknown` outcome means "do not publish, do not
 * retry" — handed back as `refresh_unknown`). Sealed material only ever
 * opens in the action's memory, exactly like G1's refresh capability.
 */
async function freshAccessToken(
  ctx: ActionCtx,
  connectionId: Id<"calendarConnections">,
): Promise<{ token: string } | { barrier: TokenBarrier }> {
  const first = await ctx.runQuery(internal.calendar.sync.functions.sealedCredentialForSync, {
    connectionId,
  });
  if (first === null) {
    return { barrier: "not_connected" };
  }
  if (first.activeCompanyId === null || first.activeCompanyId !== first.companyId) {
    return { barrier: "membership_or_firm_changed" };
  }
  if (
    first.accessTokenExpiresAtMs !== null &&
    first.accessTokenExpiresAtMs > Date.now() + TOKEN_FRESHNESS_MARGIN_MS
  ) {
    if (first.sealed === null) {
      return { barrier: "no_credential" };
    }
    const bundle = await openCredential(first.sealed.storage, first.sealed.ciphertext, process.env);
    if (bundle !== null) {
      return { token: bundle.accessToken };
    }
    return { barrier: "no_credential" };
  }
  const refresh = await ctx.runAction(
    internal.calendar.connection.functions.refreshCredentials,
    { connectionId },
  );
  if (refresh.outcome !== "refreshed") {
    return { barrier: refresh.outcome === "unknown" ? "refresh_unknown" : "refresh_lost" };
  }
  const second = await ctx.runQuery(internal.calendar.sync.functions.sealedCredentialForSync, {
    connectionId,
  });
  if (second === null || second.sealed === null) {
    return { barrier: "no_credential" };
  }
  const bundle = await openCredential(second.sealed.storage, second.sealed.ciphertext, process.env);
  if (bundle === null) {
    return { barrier: "no_credential" };
  }
  return { token: bundle.accessToken };
}

// ---------------------------------------------------------------------------
// The ONE leg runner (shared by the pass and the durable executor).
// ---------------------------------------------------------------------------

/** The attempt-outcome vocabulary the job completion consumes. */
type AttemptOutcomeWord = "succeeded" | "failed" | "timeout" | "unknown" | null;

/** What one copy's reconciliation attempt concluded. */
export interface OneAttemptOutcome {
  readonly kind: "none" | "suspend" | "copy_missing" | "leg_done" | "barrier";
  readonly reason: string | null;
  readonly accessLost: boolean;
  readonly remoteOutcome: string | null;
  readonly attemptOutcome: AttemptOutcomeWord;
}

/**
 * Runs ONE copy's reconciliation: prepare (decide + durably open the
 * attempt), the ONE bounded external leg, complete (record + transition +
 * publish). A token barrier suspends honestly — the attempt row keeps its
 * uncertain `unknown` outcome so nothing is assumed and nothing retries
 * blindly.
 */
async function runOneAttempt(
  ctx: ActionCtx,
  copyId: Id<"calendarCopies">,
  forceObservation = false,
): Promise<OneAttemptOutcome> {
  const prepared = await ctx.runMutation(internal.calendar.sync.operations.prepareCopyAttempt, {
    copyId,
    forceObservation,
  });
  if (prepared.kind === "none") {
    return { kind: "none", reason: prepared.reason, accessLost: false, remoteOutcome: null, attemptOutcome: null };
  }
  if (prepared.kind === "suspend") {
    return { kind: "suspend", reason: prepared.reason, accessLost: false, remoteOutcome: null, attemptOutcome: null };
  }
  if (prepared.kind === "copy_missing") {
    return { kind: "copy_missing", reason: null, accessLost: false, remoteOutcome: null, attemptOutcome: null };
  }
  const credential = await freshAccessToken(ctx, prepared.connectionId);
  if ("barrier" in credential) {
    await ctx.runMutation(internal.calendar.sync.operations.completeCopyAttempt, {
      attemptDedupKey: prepared.attemptDedupKey,
      outcome: "failed",
      errorKind: `credential_${credential.barrier}`,
      result: { kind: "observation", observation: { kind: "unknown" } },
    });
    return { kind: "barrier", reason: credential.barrier, accessLost: false, remoteOutcome: null, attemptOutcome: "failed" };
  }
  const leg = prepared.leg;
  const base = {
    apiBase: calendarApiBase(process.env),
    accessToken: credential.token,
    calendarId: leg.calendarId,
  };
  switch (leg.leg) {
    case "create": {
      const report = await createCalendarEvent({ ...base, body: leg.body });
      return await finishAttempt(ctx, prepared.attemptDedupKey, {
        kind: "mutation",
        report,
        ...(report.kind === "applied" && report.eventId !== undefined
          ? { eventId: report.eventId }
          : {}),
      });
    }
    case "update": {
      const report = await updateCalendarEvent({ ...base, eventId: leg.eventId, body: leg.body });
      return await finishAttempt(ctx, prepared.attemptDedupKey, { kind: "mutation", report });
    }
    case "delete": {
      const report = await deleteCalendarEvent({ ...base, eventId: leg.eventId });
      return await finishAttempt(ctx, prepared.attemptDedupKey, { kind: "mutation", report });
    }
    case "observe_get": {
      // The 404 ambiguity (event gone vs calendar gone) is resolved inside
      // the protocol by ONE bounded disambiguating list read.
      const observation = await observeEventById({
        ...base,
        eventId: leg.eventId,
        semanticId: prepared.semanticId,
      });
      return await finishAttempt(ctx, prepared.attemptDedupKey, {
        kind: "observation",
        observation,
      });
    }
    case "observe_list": {
      const observation = await listEventsBySemanticId({
        ...base,
        semanticId: leg.semanticId,
      });
      return await finishAttempt(ctx, prepared.attemptDedupKey, {
        kind: "observation",
        observation,
      });
    }
  }
}

/**
 * Records one leg's outcome: the attempt-outcome word comes from the
 * cores' exhaustive mappers, and an uncertain leg carries its sanitized
 * error kind (the platform's blind-retry block reads the row).
 */
async function finishAttempt(
  ctx: ActionCtx,
  attemptDedupKey: string,
  result: LegResult,
): Promise<OneAttemptOutcome> {
  const outcome =
    result.kind === "mutation"
      ? attemptOutcomeOfMutation(result.report)
      : attemptOutcomeOfObservation(result.observation);
  const completion = await ctx.runMutation(internal.calendar.sync.operations.completeCopyAttempt, {
    attemptDedupKey,
    outcome,
    ...(outcome === "unknown" ? { errorKind: "external_uncertain" } : {}),
    result,
  });
  return {
    kind: "leg_done",
    reason: null,
    accessLost: completion?.accessLost ?? false,
    remoteOutcome: completion?.remoteOutcome ?? null,
    attemptOutcome: outcome,
  };
}

// ---------------------------------------------------------------------------
// The sync pass (cron-scheduled safety net + explicit seam).
// ---------------------------------------------------------------------------

/** One connection's sanitized sync-pass outcome. */
export interface ConnectionSyncResult {
  readonly connectionId: string;
  readonly outcome: "synced" | "suspended" | "no_connection";
  readonly suspensionReason: string | null;
  readonly attempted: number;
  readonly converged: number;
  readonly suspended: number;
  readonly barriers: number;
  readonly accessLost: boolean;
}

/** Every connection id (the all-connections pass input). */
export const allConnectionIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"calendarConnections">[]> => {
    const rows = await ctx.db.query("calendarConnections").collect();
    return rows.map((row) => row._id);
  },
});

/** The copies of one connection (the pass input). */
export const copyIdsOfConnection = internalQuery({
  args: { connectionId: v.id("calendarConnections") },
  handler: async (ctx, args): Promise<Id<"calendarCopies">[]> => {
    const rows = await ctx.db
      .query("calendarCopies")
      .withIndex("by_connection", (q) => q.eq("connectionId", args.connectionId))
      .collect();
    return rows.map((row) => row._id);
  },
});

/**
 * Runs ONE reconciliation pass for one connection (or every connection of
 * the deployment). Per connection: G2's REAL projection pass (credential
 * recheck + desired state), then ONE bounded leg per copy. Convergence is
 * across passes: a converged copy answers `none` and issues no call, so
 * repeated passes over unchanged state make ZERO external calls.
 */
export const runCalendarSyncPass = internalAction({
  args: { connectionId: v.optional(v.id("calendarConnections")) },
  handler: async (ctx, args): Promise<ConnectionSyncResult[]> => {
    const ids =
      args.connectionId === undefined
        ? await ctx.runQuery(internal.calendar.sync.functions.allConnectionIds, {})
        : [args.connectionId];
    const results: ConnectionSyncResult[] = [];
    for (const connectionId of ids) {
      const projection = await ctx.runAction(
        internal.calendar.projection.functions.runProjectionPass,
        { connectionId },
      );
      const pass = projection[0];
      if (pass === undefined || pass.outcome === "suspended") {
        results.push({
          connectionId,
          outcome: pass === undefined ? "no_connection" : "suspended",
          suspensionReason: pass?.suspensionReason ?? null,
          attempted: 0,
          converged: 0,
          suspended: 0,
          barriers: 0,
          accessLost: false,
        });
        continue;
      }
      await ctx.runMutation(internal.calendar.sync.operations.beginSyncPassTransaction, {
        connectionId,
      });
      const copyIds = await ctx.runQuery(internal.calendar.sync.functions.copyIdsOfConnection, {
        connectionId,
      });
      let attempted = 0;
      let converged = 0;
      let suspended = 0;
      let barriers = 0;
      let accessLost = false;
      let exhausted = false;
      for (const copyId of copyIds) {
        const one = await runOneAttempt(ctx, copyId);
        if (one.kind === "none") {
          converged += 1;
        } else if (one.kind === "suspend") {
          suspended += 1;
          if (
            one.reason === "create_attempts_exhausted" ||
            one.reason === "update_attempts_exhausted" ||
            one.reason === "delete_attempts_exhausted"
          ) {
            exhausted = true;
          }
        } else if (one.kind === "barrier") {
          barriers += 1;
        } else if (one.kind === "leg_done") {
          attempted += 1;
          accessLost = accessLost || one.accessLost;
        }
      }
      const allConverged = converged === copyIds.length;
      await ctx.runMutation(internal.calendar.sync.operations.finishSyncPassTransaction, {
        connectionId,
        state: allConverged ? "idle" : "needs_reconcile",
        ...(allConverged
          ? {}
          : {
              suspendedReason: accessLost
                ? "calendar_access_lost"
                : exhausted
                  ? "attempts_exhausted"
                  : barriers > 0
                    ? "credential_barrier"
                    : "legs_pending",
            }),
      });
      results.push({
        connectionId,
        outcome: "synced",
        suspensionReason: null,
        attempted,
        converged,
        suspended,
        barriers,
        accessLost,
      });
    }
    return results;
  },
});

// ---------------------------------------------------------------------------
// The durable executor action half (calendar.reconcile_outcome).
// ---------------------------------------------------------------------------

/**
 * ONE copy's reconciliation as the `calendar.reconcile_outcome` job's
 * external action: prepare -> leg -> record, then the job row's terminal
 * state. An UNCERTAIN leg fails the job with `externalOutcome:
 * timeout/unknown` — the platform's blind-retry block applies; only a
 * later observation (the sync pass, or a fresh outcome event) moves the
 * copy again. A converged or definitely-failed leg completes the job.
 */
export const runReconcileOutcomeAttempt = internalAction({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.calendar.sync.functions.jobInputForReconcile, {
      jobKey: args.jobKey,
    });
    if (job === null) {
      return;
    }
    const one = await runOneAttempt(ctx, job.copyId);
    const succeeded =
      one.kind === "none" || (one.kind === "leg_done" && one.attemptOutcome === "succeeded");
    // An uncertain leg fails the job WITH its uncertain external outcome,
    // so the platform's blind-retry block owns any replay.
    const jobOutcome: "succeeded" | "failed" = succeeded ? "succeeded" : "failed";
    const externalOutcome: "unknown" | "timeout" | undefined =
      one.attemptOutcome === "unknown"
        ? "unknown"
        : one.attemptOutcome === "timeout"
          ? "timeout"
          : undefined;
    await ctx.runMutation(internal.calendar.sync.operations.completeReconcileJob, {
      jobKey: args.jobKey,
      outcome: jobOutcome,
      ...(externalOutcome === undefined ? {} : { externalOutcome }),
      errorKind: succeeded ? "" : (one.reason ?? "reconcile_not_possible"),
    });
  },
});

/**
 * ONE copy's reconciliation as an explicit internal action (the guarded
 * proof entry and the typed `calendar.reconcileCopy` command's durable
 * follow-up both run this; the executor job runs it with its own job
 * completion).
 */
export const runOneAttemptPublic = internalAction({
  args: { copyId: v.id("calendarCopies"), forceObservation: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<OneAttemptOutcome> =>
    await runOneAttempt(ctx, args.copyId, args.forceObservation ?? false),
});

/** The job-row read the executor action starts from. */
export const jobInputForReconcile = internalQuery({  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null || job.state !== "running") {
      return null;
    }
    let input: { copyId?: unknown } = {};
    try {
      input = JSON.parse(job.inputJson) as typeof input;
    } catch {
      return null;
    }
    const copyId =
      typeof input.copyId === "string"
        ? (ctx.db.normalizeId("calendarCopies", input.copyId) as Id<"calendarCopies"> | null)
        : null;
    if (copyId === null) {
      return null;
    }
    return { copyId };
  },
});

// ---------------------------------------------------------------------------
// Status export (G4/H4/I2/I4/I6 consumption; the boss's own view).
// ---------------------------------------------------------------------------

/**
 * Authenticated: the actor's own sync status — last success, pending,
 * failed, reconnect-needed and possible-cleanup-remains, plus the timing
 * basis J4 will evaluate (save-to-Google acceptance latency, recorded per
 * attempt, never claimed as the 95% target here).
 */
export const syncOverview = query({
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
      return { state: "unavailable_no_company" };
    }
    const connection = await ctx.db
      .query("calendarConnections")
      .withIndex("by_user", (q) => q.eq("userId", live.session.userId))
      .first();
    if (connection === null) {
      return { state: "no_connection" };
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null || connection.companyId !== companyId) {
      return { state: "membership_lost" };
    }
    const copies = await ctx.db
      .query("calendarCopies")
      .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
      .collect();
    const attempts = await ctx.db
      .query("calendarSyncAttempts")
      .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
      .collect();
    let confirmed = 0;
    let pending = 0;
    let absentWhileProjected = 0;
    for (const copy of copies) {
      if (copy.desiredState === "projected" && !copy.hidden) {
        if (copy.remoteOutcome === "confirmed") {
          confirmed += 1;
        } else if (copy.remoteOutcome === "unknown") {
          pending += 1;
        } else {
          absentWhileProjected += 1;
        }
      }
    }
    const uncertainAttempts = attempts.filter((attempt) => attempt.outcome === "unknown").length;
    const failedAttempts = attempts.filter((attempt) => attempt.outcome === "failed").length;
    const lastConfirmedAtMs = attempts.reduce<number | null>((best, attempt) => {
      if (attempt.outcome !== "succeeded" || attempt.completedAtMs === undefined) {
        return best;
      }
      return best === null || attempt.completedAtMs > best ? attempt.completedAtMs : best;
    }, null);
    const lastAcceptanceMs = attempts.reduce<number | null>((best, attempt) => {
      if (attempt.outcome !== "succeeded" || attempt.completedAtMs === undefined) {
        return best;
      }
      const latency = attempt.completedAtMs - attempt.desiredAtMs;
      return best === null || latency > best ? latency : best;
    }, null);
    return {
      state: connection.state,
      connectionId: connection._id,
      reconnectNeeded: connection.state === "error" || connection.state === "disconnected",
      reconnectReason: connection.reconnectReason ?? null,
      cleanupRemains: connection.cleanupStatus === "unconfirmed",
      copies: { total: copies.length, confirmed, pending, absentWhileProjected },
      attempts: {
        recorded: attempts.length,
        uncertain: uncertainAttempts,
        failed: failedAttempts,
      },
      lastConfirmedAtMs,
      /** J4's basis: the widest recorded save-to-Google acceptance window. */
      lastSaveToGoogleAcceptanceMs: lastAcceptanceMs,
    };
  },
});

// ---------------------------------------------------------------------------
// Typed command dispatch (calendar.reconcileCopy).
// ---------------------------------------------------------------------------

/** The company-scoped typed command dispatch (client path). */
export const dispatchCalendarSync = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchCalendarSyncCommand(ctx, args.envelope),
});
