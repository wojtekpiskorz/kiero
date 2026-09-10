/**
 * F2 notification-delivery dev proofs (guarded by the deployment's
 * KIERO_PROBE_ENABLED variable; shared plumbing in
 * convex/attention/probe_shared.ts).
 *
 * - `probeEvaluateDueIntents`: dispatches one evaluation sweep through the
 *   checked path as the service identity (or a seeded session) at a
 *   CALLER-CHOSEN instant — the fake-clock surface for 60-second window
 *   boundaries, overnight quiet hours and the Europe/Warsaw DST night.
 * - `probeDeliveryState` / `probeDeliveryStateForSource`: the
 *   tenant-scoped inspection reads the evidence script asserts on.
 * - `probeRepublishSourceAccepted`: duplicate-event injection — republishes
 *   the canonical acceptance event under its ORIGINAL dedup identity (row
 *   dedup) or a fresh one (drains; the derived job identity then collapses
 *   it onto the one set of semantic intents).
 * - `probeReregisterIntentsJob`: worker-retry injection — re-registers the
 *   attention-intents job under its derived dedup identity.
 * - `probeScheduleEvaluation`: duplicate-scheduling injection — schedules
 *   one extra evaluator hop directly.
 * - `probeForceRunFailed`: the terminal-analysis-failure fixture flip (the
 *   revokeFixtureMembership precedent: a dev fixture flip, production
 *   failure is E3's honest state).
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery, type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, notFoundError } from "@kiero/runtime";
import type { Id } from "../../_generated/dataModel";
import {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";
import { resolveBridgeQueryScope } from "../context";
import { publishEvent, registerDurableJob } from "../../platform/publish";

/** Dispatches one evaluation sweep at a chosen instant (guarded). */
export const probeEvaluateDueIntents = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.delivery.commands.evaluateDueIntentsTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/** The company-wide delivery-intent state (guarded read). */
export const probeDeliveryState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.delivery.queries.dueDeliveryIntentsFor, {
      serviceSessionId: sessionId,
    });
  },
});

/** The per-source delivery-intent state (guarded, tenant-checked read). */
export const probeDeliveryStateForSource = action({
  args: { sessionId: v.optional(v.string()), sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.delivery.queries.deliveryStateForSource, {
      serviceSessionId: sessionId,
      sourceId: args.sourceId,
    });
  },
});

/** The actor's company scope (guarded helper read for tenant checks). */
export const scopeFor = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    return okResult({ companyId: scope.companyId, userId: scope.userId });
  },
});

/** One source's company id (guarded helper read for tenant checks). */
export const sourceCompany = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) {
      return errorResult(notFoundError("sources", "source_not_found"));
    }
    return okResult({ companyId: source.companyId });
  },
});

/** The duplicate-event injection core (same transaction, real seam). */
export const republishSourceAccepted = internalMutation({
  args: {
    sourceId: v.id("sources"),
    companyId: v.id("companies"),
    freshDedupKey: v.boolean(),
    dedupKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // An explicit key reproduces the ORIGINAL publication's identity (the
    // acceptance used a client idempotency key, so the canonical row key is
    // not derivable from the source id alone); absent means fresh identity.
    const dedupKey =
      args.dedupKey ??
      (args.freshDedupKey
        ? `sources.acceptSource:probe:${args.sourceId}:${Date.now()}`
        : `sources.acceptSource:${args.companyId}:${args.sourceId}`);
    return okResult(
      await publishEvent(ctx, {
        companyId: args.companyId,
        eventName: "sources.sourceAccepted",
        payload: { sourceId: args.sourceId, attachmentIds: [] },
        dedupKey,
      }),
    );
  },
});

export const probeRepublishSourceAccepted = action({
  args: {
    sessionId: v.optional(v.string()),
    sourceId: v.id("sources"),
    freshDedupKey: v.boolean(),
    dedupKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = await resolveCompanyIdFor(ctx, sessionId, args.sourceId);
    if (companyId._tag !== "ok") {
      return companyId;
    }
    return ctx.runMutation(internal.attention.delivery.probe.republishSourceAccepted, {
      sourceId: args.sourceId,
      companyId: (companyId.value as { companyId: Id<"companies"> }).companyId,
      freshDedupKey: args.freshDedupKey,
      ...(args.dedupKey === undefined ? {} : { dedupKey: args.dedupKey }),
    });
  },
});

/** Shared guarded tenant resolution for the injection probes. */
async function resolveCompanyIdFor(
  ctx: ActionCtx,
  sessionId: string,
  sourceId: Id<"sources">,
): Promise<ResultEnvelope> {
  const scope = await ctx.runQuery(internal.attention.delivery.probe.scopeFor, {
    serviceSessionId: sessionId,
  });
  if (scope._tag !== "ok") {
    return scope;
  }
  const source = await ctx.runQuery(internal.attention.delivery.probe.sourceCompany, {
    sourceId,
  });
  if (source._tag !== "ok") {
    return source;
  }
  const scopeCompanyId = (scope.value as { companyId: Id<"companies"> }).companyId;
  const sourceCompanyId = (source.value as { companyId: Id<"companies"> }).companyId;
  if (scopeCompanyId !== sourceCompanyId) {
    return errorResult(forbiddenError("tenant_scope_mismatch", "sources"));
  }
  return okResult({ companyId: sourceCompanyId });
}

/** The worker-retry injection core (same transaction, real seam). */
export const reregisterIntentsJob = internalMutation({
  args: { sourceId: v.id("sources"), companyId: v.id("companies") },
  handler: async (ctx, args) => {
    return okResult(
      await registerDurableJob(ctx, {
        kind: "attention.evaluate_due_intents",
        input: {
          trigger: "source_accepted",
          sourceId: args.sourceId,
          clarificationId: null,
          changeSetId: null,
        },
        companyId: args.companyId,
        policy: { maxAttempts: 3, backoffBaseMs: 2_000 },
        dedupKey: `attention.evaluate_due_intents:source:${args.sourceId}`,
      }),
    );
  },
});

export const probeReregisterIntentsJob = action({
  args: { sessionId: v.optional(v.string()), sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = await resolveCompanyIdFor(ctx, sessionId, args.sourceId);
    if (companyId._tag !== "ok") {
      return companyId;
    }
    return ctx.runMutation(internal.attention.delivery.probe.reregisterIntentsJob, {
      sourceId: args.sourceId,
      companyId: (companyId.value as { companyId: Id<"companies"> }).companyId,
    });
  },
});

/** The duplicate-scheduling injection core (the real scheduled seam). */
export const scheduleEvaluation = internalMutation({
  args: { atMs: v.float64() },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(
      Math.max(0, args.atMs - Date.now()),
      internal.attention.delivery.evaluate.evaluateDueIntents,
      { nowMs: args.atMs },
    );
    return okResult({ scheduledAtMs: args.atMs });
  },
});

export const probeScheduleEvaluation = action({
  args: { atMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.attention.delivery.probe.scheduleEvaluation, { atMs: args.atMs });
  },
});

/** The terminal-analysis-failure fixture flip (guarded dev fixture). */
export const forceRunFailed = internalMutation({
  args: { runId: v.id("processingRuns") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, { state: "failed", finishedAtMs: Date.now() });
    return okResult({ runId: args.runId, state: "failed" });
  },
});

export const probeForceRunFailed = action({
  args: { sessionId: v.optional(v.string()), runId: v.id("processingRuns") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.delivery.probe.forceRunFailed, { runId: args.runId });
  },
});

/**
 * The terminal-analysis-success fixture flip (guarded dev fixture, the
 * same precedent): this deployment has no model key, so analysis honestly
 * fails; the proof needs the other terminal branch too.
 */
export const forceRunSucceeded = internalMutation({
  args: { runId: v.id("processingRuns") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.runId, { state: "succeeded", finishedAtMs: Date.now() });
    return okResult({ runId: args.runId, state: "succeeded" });
  },
});

export const probeForceRunSucceeded = action({
  args: { sessionId: v.optional(v.string()), runId: v.id("processingRuns") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.delivery.probe.forceRunSucceeded, { runId: args.runId });
  },
});
