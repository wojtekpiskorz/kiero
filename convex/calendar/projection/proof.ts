/**
 * Guarded G2 proof fixtures (dev deployment only).
 *
 * Same pattern as the A3/B1/C4 probes: an ACTION checks the deployment
 * guard variable (`KIERO_G2_PROOF_ENABLED === "1"`) and runs internal
 * functions reachable only from this module. On any other deployment the
 * variable is absent and every entry fails closed.
 *
 * Why these exist (honest scope): the owner has not supplied Google OAuth
 * client credentials (the same owner action B1/G1 recorded), so no proof
 * can walk the real accounts.google.com consent. The live evidence runs
 * the REAL projection pipeline — G1's fake-Google connection flow (its
 * guarded proof endpoints), C2's real memory dispatch for the dated
 * findings, C4's real work dispatch for the tasks/events, and G2's own
 * real pass action — and these fixtures only READ state and invoke the
 * pass explicitly. The live Google legs stay BLOCKED-owner-action.
 *
 * Fixture values are constants, never secrets.
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { action, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";

function guardEnabled(): boolean {
  return process.env.KIERO_G2_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("calendar.g2Proof", "proof_guard_disabled"));
}

/**
 * Inspects one company's projection state (internal read): every
 * connection with its copies (semantic id, desired state and payload,
 * hide bookkeeping, remote ledger) and every sync row — the raw rows the
 * live evidence asserts on.
 */
export const projectionStateInternal = internalQuery({
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
      const sync = await ctx.db
        .query("calendarSyncState")
        .withIndex("by_connection", (q) => q.eq("connectionId", connection._id))
        .first();
      out.push({
        connectionId: connection._id,
        userId: connection.userId,
        state: connection.state,
        googleAccountSubject: connection.googleAccountSubject ?? null,
        googleCalendarId: connection.googleCalendarId ?? null,
        copies: copies.map((copy) => ({
          copyId: copy._id,
          subjectKind: copy.subjectKind,
          subjectId: copy.taskId ?? copy.eventId ?? null,
          semanticId: copy.semanticId,
          desiredState: copy.desiredState,
          withdrawReason: copy.withdrawReason ?? null,
          summary: copy.payload?.summary ?? null,
          start: copy.payload?.start ?? null,
          end: copy.payload?.end ?? null,
          description: copy.payload?.description ?? null,
          payloadFingerprint: copy.payloadFingerprint ?? null,
          hidden: copy.hidden,
          hiddenOrigin: copy.hiddenOrigin ?? null,
          remoteOutcome: copy.remoteOutcome,
          googleEventId: copy.googleEventId ?? null,
          desiredRevisionId: copy.desiredRevisionId,
          updatedAtMs: copy.updatedAtMs,
        })),
        sync:
          sync === null
            ? null
            : {
                state: sync.state,
                suspendedReason: sync.suspendedReason ?? null,
                lastPassAtMs: sync.lastPassAtMs ?? null,
                selectedProjects: sync.selectedProjects ?? null,
              },
      });
    }
    return okResult(out);
  },
});

/** The guarded inspection read for the live evidence (proof domain only). */
export const g2ProofProjectionState = action({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runQuery(internal.calendar.projection.proof.projectionStateInternal, {
      companyId: args.companyId,
    });
  },
});

/**
 * The guarded entry that runs the REAL projection pass action for one
 * connection (or every connection): the per-pass credential recheck and
 * the atomic desired-state transaction, exactly as G3 will trigger them.
 */
export const g2ProofRunPass = action({
  args: { connectionId: v.optional(v.id("calendarConnections")) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    const results = await ctx.runAction(
      internal.calendar.projection.functions.runProjectionPass,
      args.connectionId === undefined ? {} : { connectionId: args.connectionId },
    );
    return okResult(results);
  },
});
