/**
 * F1 notification-preference dev proofs (guarded by the deployment's
 * KIERO_PROBE_ENABLED variable; shared plumbing in
 * convex/sources/probe_shared.ts).
 *
 * - `probeChangeNotificationPreferences`: dispatches one preference patch
 *   through the checked path as the service identity (or a seeded session).
 * - `probeMyPreferences`: the effective-settings read for the same
 *   identity choices (round-trip proof).
 * - `probeEvaluatePersonalDelivery`: runs the live evaluation seam — the
 *   actor's REAL stored row, the REAL company timezone, a caller-chosen
 *   instant — so quiet-hour boundaries and DST transitions are provable
 *   against the deployed code path.
 */

import { v } from "convex/values";
import { action } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { ResultEnvelope } from "@kiero/contracts";
import {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../../sources/probe_shared";

/** Dispatches one preference patch as the service identity (guarded). */
export const probeChangeNotificationPreferences = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(
      internal.attention.preferences.commands.changeNotificationPreferencesTransaction,
      { envelope: args.envelope, serviceSessionId: sessionId },
    );
  },
});

/** The effective personal settings (guarded read, round-trip proof). */
export const probeMyPreferences = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.preferences.queries.myNotificationPreferencesFor, {
      serviceSessionId: sessionId,
    });
  },
});

/** The live evaluation seam at a chosen instant (guarded read). */
export const probeEvaluatePersonalDelivery = action({
  args: {
    sessionId: v.optional(v.string()),
    kind: v.union(
      v.literal("source_entry"),
      v.literal("clarification"),
      v.literal("task_reminder"),
    ),
    scope: v.union(v.literal("project"), v.literal("company")),
    projectIds: v.array(v.id("projects")),
    isAuthor: v.boolean(),
    read: v.boolean(),
    nowMs: v.float64(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.preferences.queries.evaluatePersonalDeliveryFor, {
      serviceSessionId: sessionId,
      request: {
        kind: args.kind,
        scope: args.scope,
        projectIds: args.projectIds,
        isAuthor: args.isAuthor,
        read: args.read,
        nowMs: args.nowMs,
      },
    });
  },
});
