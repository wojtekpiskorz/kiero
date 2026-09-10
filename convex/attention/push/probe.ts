/**
 * F3 web-push dev proofs (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable; shared plumbing in convex/attention/probe_shared.ts, the F2
 * probe precedent).
 *
 * - `probeRegisterSubscription` / `probeRevokeSubscription`: the two
 *   client commands dispatched through the CHECKED path as the service
 *   identity (or a seeded session). The subscription keys are
 *   client-supplied by protocol definition - that IS the Push API's shape
 *   (the browser hands its p256dh/auth keys to the application server) -
 *   and the proof script's listener generates the pair so it can decrypt
 *   the real POST.
 * - `probePushState`: the settings screen's server read.
 * - `probeDeliverIntent`: ONE intent's delivery pass, directly (the
 *   focused verification driver for timeout/gone/retry scenarios whose
 *   endpoints the local listener controls).
 * - `probePublishIntentDelivered`: duplicate-event injection - republishes
 *   the canonical delivered event under a FRESH dedup identity so the
 *   real drain -> job -> executor -> action chain runs end to end.
 * - `probeRevokeFixtureSession`: the session-revocation flip (the
 *   revokeFixtureMembership precedent: a dev fixture flip; production
 *   revocation is B1/B2's audited operation).
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";
import { publishEvent } from "../../platform/publish";

/** Registers a subscription through the checked path (guarded). */
export const probeRegisterSubscription = action({
  args: {
    sessionId: v.optional(v.string()),
    endpoint: v.string(),
    p256dhKeyBase64: v.string(),
    authKeyBase64: v.string(),
    deviceLabel: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.push.commands.dispatchPushTransaction, {
      envelope: {
        operation: "attention.registerPushSubscription",
        input: {
          endpoint: args.endpoint,
          p256dhKeyBase64: args.p256dhKeyBase64,
          authKeyBase64: args.authKeyBase64,
          ...(args.deviceLabel === undefined ? {} : { deviceLabel: args.deviceLabel }),
        },
        expectedRevisions: [],
      },
      serviceSessionId: sessionId,
    });
  },
});

/** Revokes a subscription through the checked path (guarded). */
export const probeRevokeSubscription = action({
  args: { sessionId: v.optional(v.string()), pushSubscriptionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.push.commands.dispatchPushTransaction, {
      envelope: {
        operation: "attention.revokePushSubscription",
        input: { pushSubscriptionId: args.pushSubscriptionId },
        expectedRevisions: [],
      },
      serviceSessionId: sessionId,
    });
  },
});

/** The settings screen's server read (guarded). */
export const probePushState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    const state = await ctx.runQuery(internal.attention.push.queries.pushStateForSession, {
      serviceSessionId: sessionId,
    });
    if (state === null) {
      return serviceIdentityUnavailable();
    }
    return okResult(state);
  },
});

/** ONE intent's delivery pass, directly (guarded). */
export const probeDeliverIntent = action({
  args: { sessionId: v.optional(v.string()), intentId: v.id("notificationIntents") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    const pass = await ctx.runAction(internal.attention.push.functions.runOneIntentDelivery, {
      intentId: args.intentId,
    });
    return okResult(pass);
  },
});

/** Republishes the delivered event under a fresh dedup identity (guarded). */
export const republishIntentDelivered = internalMutation({
  args: { intentId: v.id("notificationIntents"), companyId: v.id("companies") },
  handler: async (ctx, args) => {
    return okResult(
      await publishEvent(ctx, {
        companyId: args.companyId,
        eventName: "attention.intentDelivered",
        payload: { notificationIntentId: args.intentId, outcome: "delivered" },
        dedupKey: `attention.intentDelivered:probe:${args.intentId}:${Date.now()}`,
      }),
    );
  },
});

export const probePublishIntentDelivered = action({
  args: { sessionId: v.optional(v.string()), intentId: v.id("notificationIntents") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    const intent = await ctx.runQuery(internal.attention.push.probe.intentCompany, {
      intentId: args.intentId,
    });
    if (intent === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.push.probe.republishIntentDelivered, {
      intentId: args.intentId,
      companyId: intent.companyId,
    });
  },
});

/** One intent's company id (guarded helper read). */
export const intentCompany = internalQuery({
  args: { intentId: v.id("notificationIntents") },
  handler: async (ctx, args) => {
    const intent = await ctx.db.get(args.intentId);
    return intent === null ? null : { companyId: intent.companyId };
  },
});

/** The session-revocation fixture flip (guarded dev fixture). */
export const revokeFixtureSession = internalMutation({
  args: { targetSessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.targetSessionId);
    if (session === null) {
      return okResult({ alreadyRevoked: true });
    }
    if (session.revokedAtMs === undefined) {
      await ctx.db.patch(args.targetSessionId, { revokedAtMs: Date.now() });
    }
    return okResult({ alreadyRevoked: false });
  },
});

export const probeRevokeFixtureSession = action({
  args: { sessionId: v.optional(v.string()), targetSessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.push.probe.revokeFixtureSession, {
      targetSessionId: args.targetSessionId,
    });
  },
});
