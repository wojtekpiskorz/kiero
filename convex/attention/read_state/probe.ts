/**
 * F1 read-state dev proofs (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the A3 platform and D1 lane probes; the lane's
 * shared people fixtures live in convex/attention/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the F1 evidence can
 * run against the REAL dev deployment without a development-auth shortcut:
 * every actor is a server-seeded session resolved through the SAME
 * canonical resolution and authorization seam as production calls, and no
 * identity is ever accepted from client input.
 *
 * - `probeMarkSourceRead`: dispatches one mark envelope through the checked
 *   path as the service identity (or an explicitly seeded session).
 * - `probeReadState`: the unread projection over canonical source ids for
 *   the same identity choices.
 * - `probeGmReadStateOverview`: the audited-GM inspection read of one
 *   company's read states (strictly read-only).
 * - `probeAttentionState`: the tenant-scoped inspection the evidence
 *   scripts assert on (read-state rows plus `attention.sourceReadChanged`
 *   outbox events, proving one event per actual transition).
 * - `probeCrashMarkSourceRead`: runs the FULL mark through the lane's own
 *   dispatch and then THROWS before commit, proving rollback of row and
 *   event together.
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError } from "@kiero/runtime";
import { resolveBridgeQueryScope } from "../context";
import { dispatchReadStateCommand } from "./dispatch";
import {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";

// --- command + read probes -----------------------------------------------------

/** Dispatches one mark envelope as the service identity (guarded). */
export const probeMarkSourceRead = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.read_state.commands.markSourceReadTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/** The unread projection for the service or seeded identity (guarded). */
export const probeReadState = action({
  args: { sourceIds: v.array(v.id("sources")), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.read_state.queries.readStateForSourcesFor, {
      serviceSessionId: sessionId,
      sourceIds: args.sourceIds,
    });
  },
});

/** The audited-GM inspection read of one company (guarded, read-only). */
export const probeGmReadStateOverview = action({
  args: { gmSessionId: v.string(), companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.attention.read_state.queries.gmReadStateOverview, {
      gmSessionId: args.gmSessionId,
      companyId: args.companyId,
    });
  },
});

// --- the crash proof ------------------------------------------------------------

/**
 * The guarded crash mutation (the memory lane's crashPublish shape): the
 * FULL mark runs through the LANE'S OWN dispatch — no parallel re-spelling
 * of decode/context/authorization — and a deliberate throw after the
 * returned ok aborts the whole transaction, rolling the read-state row and
 * the canonical event back together (the no-partial-commit proof). The
 * throw lands after dispatch RETURNS, so dispatchCommand's in-handler
 * sanitization does not absorb it; the mutation itself throws.
 */
export const crashMarkRead = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const result = await dispatchReadStateCommand(ctx, args.envelope, args.serviceSessionId);
    if (result._tag === "error") {
      return result; // the mark itself refused; nothing was committed
    }
    throw new Error("probe: deliberate failure after read-state registration");
  },
});

/** Runs the crash-proof mark (guarded action wrapper). */
export const probeCrashMarkSourceRead = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    // The internal mutation throws by design; Convex surfaces it as a
    // thrown error from runMutation, which the evidence script expects.
    await ctx.runMutation(internal.attention.read_state.probe.crashMarkRead, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
    return errorResult(forbiddenError("crash_proof_did_not_throw"));
  },
});

// --- inspection --------------------------------------------------------------------

/** Tenant-scoped read-state + event inspection for the evidence scripts. */
export const attentionState = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    // The lane's shared bridge-scope helper (../context.ts): the same
    // chain every internal query uses, not a probe-local re-spelling.
    // (crashMarkRead above deliberately resolves the FULL RequestContext:
    // the crash transaction runs the real dispatch path.)
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const companyId = scope.companyId;
    const rows = await ctx.db
      .query("readStates")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const events = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .filter((q) => q.eq(q.field("eventName"), "attention.sourceReadChanged"))
      .collect();
    return okResult({
      companyId,
      readStates: rows.map((row) => ({
        userId: row.userId,
        sourceId: row.sourceId,
        read: row.read,
        readAtMs: row.readAtMs,
      })),
      readChangedEvents: events.map((row) => ({
        eventId: row.eventId,
        deliveryState: row.deliveryState,
      })),
    });
  },
});

export const probeAttentionState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.read_state.probe.attentionState, {
      serviceSessionId: sessionId,
    });
  },
});
