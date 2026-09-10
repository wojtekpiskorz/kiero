/**
 * Guarded G3 proof fixtures (dev deployment only).
 *
 * Same pattern as G2's projection proof (and B1's probe before it): an
 * ACTION checks the deployment guard variable
 * (`KIERO_G3_PROOF_ENABLED === "1"`) and runs internal functions reachable
 * only from this module. On any other deployment the variable is absent
 * and every entry fails closed.
 *
 * Why these exist (honest scope): the owner has not supplied Google OAuth
 * client credentials (the same owner action B1/G1/G2 recorded), so no
 * proof can walk the real accounts.google.com consent or the real
 * Calendar API. The live evidence runs the REAL sync engine — G2's
 * projection pass, G1's credential capability, and G3's own prepare ->
 * bounded leg -> record loop — against the deployment's clearly-labeled
 * fake Google Calendar events API (./proofHttp.ts, G1's guarded fake
 * extended with events). These fixtures only READ state and invoke the
 * pass explicitly. The live REAL-Google legs stay BLOCKED-owner-action.
 *
 * Fixture values are constants, never secrets.
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { action, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { parseObservedJson } from "./operations";

function guardEnabled(): boolean {
  return process.env.KIERO_G3_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("calendar.g3Proof", "proof_guard_disabled"));
}

/**
 * Inspects one company's FULL sync state (internal read): every connection
 * with its copies (desired state, remote ledger, hide bookkeeping), every
 * recorded attempt leg (the timing/outcome ledger), the sync rows, the
 * durable reconcile jobs, and the fake Google's own event store — the raw
 * rows the live evidence asserts on.
 */
export const syncStateInternal = internalQuery({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args) => {
    const connections = await ctx.db
      .query("calendarConnections")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .collect();
    const out = [];
    for (const connection of connections) {
      const copies = await ctx.db
        .query("calendarCopies")
        .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
        .collect();
      const attempts = await ctx.db
        .query("calendarSyncAttempts")
        .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
        .collect();
      const sync = await ctx.db
        .query("calendarSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
        .first();
      out.push({
        connectionId: connection._id,
        userId: connection.userId,
        state: connection.state,
        reconnectReason: connection.reconnectReason ?? null,
        cleanupStatus: connection.cleanupStatus ?? null,
        googleAccountSubject: connection.googleAccountSubject ?? null,
        googleCalendarId: connection.googleCalendarId ?? null,
        copies: copies.map((copy) => ({
          copyId: copy._id,
          subjectId: copy.taskId ?? copy.eventId ?? null,
          semanticId: copy.semanticId,
          desiredState: copy.desiredState,
          hidden: copy.hidden,
          hiddenOrigin: copy.hiddenOrigin ?? null,
          summary: copy.payload?.summary ?? null,
          remoteOutcome: copy.remoteOutcome,
          googleEventId: copy.googleEventId ?? null,
          updatedAtMs: copy.updatedAtMs,
        })),
        attempts: attempts
          .map((attempt) => ({
            attemptId: attempt._id,
            copyId: attempt.copyId,
            legKind: attempt.legKind,
            decisionReason: attempt.decisionReason,
            outcome: attempt.outcome,
            errorKind: attempt.errorKind ?? null,
            googleEventId: attempt.googleEventId ?? null,
            desiredAtMs: attempt.desiredAtMs,
            startedAtMs: attempt.startedAtMs,
            completedAtMs: attempt.completedAtMs ?? null,
            // The parsed observation cache (the drift comparator's input).
            observed: parseObservedJson(attempt.observedJson),
          }))
          .sort((a, b) => a.startedAtMs - b.startedAtMs),
        sync:
          sync === null
            ? null
            : {
                state: sync.state,
                suspendedReason: sync.suspendedReason ?? null,
                lastPassAtMs: sync.lastPassAtMs ?? null,
                lastSyncedAtMs: sync.lastSyncedAtMs ?? null,
              },
      });
    }
    const jobs = await ctx.db
      .query("durableJobs")
      .filter((q) => q.eq(q.field("kind"), "calendar.reconcile_outcome"))
      .collect();
    const fakeEvents = await ctx.db.query("calendarProofEvents").order("desc").collect();
    return okResult({
      connections: out,
      reconcileJobs: jobs.map((job) => ({
        jobKey: job.jobKey,
        state: job.state,
        attempts: job.attempts,
        externalOutcome: job.externalOutcome ?? null,
        lastErrorKind: job.lastErrorKind ?? null,
      })),
      fakeGoogleEvents: fakeEvents.map((row) => ({
        eventId: row.eventId,
        accountSubject: row.accountSubject,
        kieroSemanticId: row.kieroSemanticId,
        status: row.status,
        eventJson: row.eventJson,
      })),
    });
  },
});

/** The guarded inspection read for the live evidence (proof domain only). */
export const g3ProofSyncState = action({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runQuery(internal.calendar.sync.proof.syncStateInternal, {
      companyId: args.companyId,
    });
  },
});

/**
 * The guarded entry that runs the REAL sync pass action for one connection
 * (or every connection): G2's projection pass plus G3's per-copy bounded
 * legs, exactly as the cron safety net and the joins will trigger it.
 */
export const g3ProofRunSyncPass = action({
  args: { connectionId: v.optional(v.id("calendarConnections")) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return okResult(
      await ctx.runAction(
        internal.calendar.sync.functions.runCalendarSyncPass,
        args.connectionId === undefined ? {} : { connectionId: args.connectionId },
      ),
    );
  },
});

/** The guarded entry that runs ONE copy's reconciliation explicitly. */
export const g3ProofReconcileCopy = action({
  args: { copyId: v.id("calendarCopies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return okResult(
      await ctx.runAction(internal.calendar.sync.functions.runOneAttemptPublic, {
        copyId: args.copyId,
        forceObservation: true,
      }),
    );
  },
});

/** One explicit reconciliation attempt through the REAL runner (proof). */
export const runOneForProof = action({
  args: { copyId: v.id("calendarCopies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return okResult(
      await ctx.runAction(internal.calendar.sync.functions.runOneAttemptPublic, {
        copyId: args.copyId,
        forceObservation: true,
      }),
    );
  },
});
