/**
 * The A3 proof function surface (guarded by the KIERO_PROBE_ENABLED
 * deployment variable).
 *
 * Everything here is platform mechanics for the composition proof, no
 * business work:
 *
 * - `probeEcho`: the checked command through the full dispatch path; its
 *   transaction publishes the canonical event and registers the durable
 *   echo job atomically. Callable directly (fails `unauthenticated` until
 *   B1 ships auth, and that failure is itself a proof row) and via the bridge.
 * - `probeSeed`: idempotent dev fixtures (proof company/user/session and a
 *   source row for pipeline runs).
 * - `probeKickAnalysis`: transaction creates the processing run row and
 *   publishes `operations.reanalysisRequested`; the drain's registered
 *   consumer edge registers the durable analyze job (the cross-module
 *   reaction path), which runs the mechanical workflow pipeline.
 * - `probeKickCrashPipeline` / `probeRestartWorkflow`: the workflow
 *   crash/restart proof with a deterministic post-commit stage failure.
 * - `probeReconcileDelivery`: drives reconciliation of one uncertain
 *   external delivery.
 * - `probeDrainNow`: runs the outbox drain synchronously (evidence scripts
 *   do not depend on scheduler timing).
 *
 * Guards: queries/mutations cannot read deployment variables in Convex, so
 * every guarded entry is an ACTION that checks the variable and then runs
 * its internal mutation (the mutation itself is only reachable from this
 * module's code).
 */

import { v } from "convex/values";
import {
  mutation,
  query,
  action,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { errorResult, newDurableJobKey, okResult, type ResultEnvelope } from "@kiero/contracts";
import { notFoundError, unsupportedError } from "@kiero/runtime";
import { dispatchMutationCommand } from "./dispatch";
import { publishEvent } from "./publish";
import { restartProofPipeline, startProofPipeline } from "./pipeline";
import { vWorkflowId } from "@convex-dev/workflow";
import { workflow } from "./pipeline";
import { drainBatch } from "./outbox";

const SERVICE_EMAIL = "platform-service@kiero.invalid";

/** The checked probe command (client path: Convex Auth identity only). */
export const probeEcho = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchMutationCommand(ctx, args.envelope, undefined),
});

/** The bridge path's transactional entry (service identity, same dispatch). */
export const echoTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => dispatchMutationCommand(ctx, args.envelope, args.serviceSessionId),
});

function probeGuardEnabled(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

function probeDisabled() {
  return errorResult(unsupportedError("platform.probe", "probe_guard_disabled"));
}

// --- Seeding -----------------------------------------------------------------

/** Idempotent proof fixtures (guarded action). */
export const probeSeed = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.platform.probe.seedFixtures, {});
  },
});

export const seedFixtures = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", SERVICE_EMAIL))
      .first();
    const userId =
      existingUser?._id ??
      (await ctx.db.insert("users", {
        email: SERVICE_EMAIL,
        displayName: "Platform proof service",
        createdAtMs: Date.now(),
      }));
    const companyRow = await ctx.db.query("companies").first();
    const company =
      companyRow?._id ??
      (await ctx.db.insert("companies", {
        name: "Kiero Dev Proof",
        timezone: "Europe/Warsaw",
        defaultCurrency: "PLN",
        createdAtMs: Date.now(),
      }));
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_company_user", (q) => q.eq("companyId", company).eq("userId", userId))
      .first();
    const membershipId =
      membership?._id ??
      (await ctx.db.insert("memberships", {
        companyId: company,
        userId,
        role: "admin",
        state: "active",
        createdAtMs: Date.now(),
      }));
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_user_started", (q) => q.eq("userId", userId))
      .order("desc")
      .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
      .first();
    const sessionId =
      session?._id ??
      (await ctx.db.insert("sessions", {
        userId,
        startedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
        deviceLabel: "service-bridge",
      }));
    const source = await ctx.db
      .query("sources")
      .withIndex("by_company_order", (q) => q.eq("companyId", company))
      .order("desc")
      .filter((q) => q.eq(q.field("lifecycle"), "active"))
      .first();
    const sourceId =
      source?._id ??
      (await ctx.db.insert("sources", {
        companyId: company,
        authorUserId: userId,
        authorText: "Platform proof fixture source",
        sentAtMs: Date.now(),
        sentAtTimezone: "Europe/Warsaw",
        fullyAcceptedAtMs: Date.now(),
        lifecycle: "active",
      }));
    return okResult({ companyId: company, userId, membershipId, sessionId, sourceId });
  },
});

/**
 * The service session lookup for the bridge (by service email). Returns the
 * session id directly (null when unseeded); the HTTP boundary maps null to
 * the sanitized forbidden error.
 */
export const serviceSession = query({
  args: {},
  handler: async (ctx): Promise<{ sessionId: string } | null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", SERVICE_EMAIL))
      .first();
    if (user === null) {
      return null;
    }
    const session = await ctx.db
      .query("sessions")
      .withIndex("by_user_started", (q) => q.eq("userId", user._id))
      .order("desc")
      .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
      .first();
    if (session === null) {
      return null;
    }
    return { sessionId: session._id };
  },
});

// --- Pipeline proofs ----------------------------------------------------------

/** Cross-module reaction path: run row + reanalysis event (drain registers the job). */
export const probeKickAnalysis = action({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.platform.probe.kickAnalysis, { sourceId: args.sourceId });
  },
});

export const kickAnalysis = internalMutation({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) {
      return errorResult(notFoundError("sources"));
    }
    const runId = await ctx.db.insert("processingRuns", {
      companyId: source.companyId,
      sourceId: args.sourceId,
      kind: "reanalysis",
      pipelineVersion: "a3-mechanical-1",
      promptVersion: "a3-none",
      schemaVersion: "a3-1",
      modelConfigurationVersion: "a3-none",
      state: "running",
      checkpoint: `probe-analysis-${newDurableJobKey()}`,
      startedAtMs: Date.now(),
    });
    const publication = await publishEvent(ctx, {
      companyId: source.companyId,
      eventName: "operations.reanalysisRequested",
      payload: { sourceId: args.sourceId, newRunId: runId, reanalysisOfRunId: null },
      dedupKey: `operations.reanalysisRequested:${runId}`,
    });
    return okResult({ runId, eventId: publication.eventId });
  },
});

/** Workflow crash/restart proof entries (guarded). */
export const probeKickCrashPipeline = action({
  args: {
    sourceId: v.id("sources"),
    stageCount: v.number(),
    failAtStage: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.platform.probe.kickCrashPipeline, {
      ...(args.failAtStage === undefined
        ? { sourceId: args.sourceId, stageCount: args.stageCount }
        : { sourceId: args.sourceId, stageCount: args.stageCount, failAtStage: args.failAtStage }),
    });
  },
});

export const kickCrashPipeline = internalMutation({
  args: {
    sourceId: v.id("sources"),
    stageCount: v.number(),
    failAtStage: v.optional(v.number()),
  },
  handler: async (ctx, args) =>
    startProofPipeline(ctx, {
      sourceId: args.sourceId,
      stageCount: args.stageCount,
      ...(args.failAtStage === undefined ? {} : { failAtStage: args.failAtStage }),
    }),
});

export const probeRestartWorkflow = action({
  args: { workflowId: vWorkflowId, runId: v.id("processingRuns"), stage: v.number() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.platform.probe.restartWorkflow, {
      workflowId: args.workflowId,
      runId: args.runId,
      stage: args.stage,
    });
  },
});

export const restartWorkflow = internalMutation({
  args: { workflowId: vWorkflowId, runId: v.id("processingRuns"), stage: v.number() },
  handler: async (ctx, args) => {
    await restartProofPipeline(ctx, args.workflowId, args.runId, args.stage);
    return okResult({ restarted: args.workflowId });
  },
});

/** Run state for the workflow proof scripts (guarded action -> internal query). */
export const probeRunState = action({
  args: { runId: v.id("processingRuns") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.platform.probe.runState, { runId: args.runId });
  },
});

export const runState = internalQuery({
  args: { runId: v.id("processingRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (run === null) {
      return errorResult(notFoundError("processingRuns"));
    }
    const steps = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) => q.eq("runId", args.runId))
      .collect();
    const stageRows = steps
      .filter((step) => step.stepKind === "mechanical_stage")
      .map((step) => ({ sequence: step.sequence, output: step.outputRef ?? "" }))
      .sort((a, b) => a.sequence - b.sequence);
    return okResult({
      run: { state: run.state, kind: run.kind, checkpoint: run.checkpoint },
      steps: stageRows,
      failureMarkers: steps.filter((step) => step.stepKind === "failure_marker").length,
    });
  },
});

/** Workflow engine status for the proof scripts (guarded). */
export const probeWorkflowStatus = action({
  args: { workflowId: vWorkflowId },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const status = await workflow.status(ctx, args.workflowId);
    return okResult({ workflowState: status.type });
  },
});

/**
 * The no-orphan proof: this guarded mutation publishes the canonical event
 * and registers the durable job, then THROWS before the transaction can
 * commit. Convex atomicity must roll back the event, the job registration
 * AND the scheduled work together, proving "fail after registration"
 * cannot leave an accepted orphan.
 */
export const probeFailPublication = action({
  args: { message: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.platform.probe.failPublication, { message: args.message });
  },
});

export const failPublication = internalMutation({
  args: { message: v.string() },
  handler: async (ctx, args) => {
    const { publishEvent, registerDurableJob } = await import("./publish");
    const company = await ctx.db.query("companies").first();
    if (company === null) {
      throw new Error("probe: no company fixture");
    }
    const dedupKey = `platform.probe.echo:fail-after-registration:${args.message}`;
    await publishEvent(ctx, {
      companyId: company._id,
      eventName: "platform.echoRequested",
      payload: { message: args.message },
      dedupKey,
    });
    await registerDurableJob(ctx, {
      kind: "platform.echo_delivery",
      input: { dedupKey, message: args.message },
      policy: { maxAttempts: 3, backoffBaseMs: 2_000 },
      dedupKey,
    });
    // Registration happened inside THIS transaction; throwing aborts it all.
    throw new Error("probe: deliberate failure after durable registration");
  },
});

/**
 * Publishes one registry event with a fresh dedup key (guarded). Used by
 * the evidence scripts to exercise drain behavior for events whose consumer
 * edge has no projection yet (the loud-failure proof).
 */
export const probePublishEvent = action({
  args: { eventName: v.string(), payload: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.platform.probe.publishRegistryEvent, {
      eventName: args.eventName,
      payload: args.payload,
    });
  },
});

export const publishRegistryEvent = internalMutation({
  args: { eventName: v.string(), payload: v.any() },
  handler: async (ctx, args) => {
    const company = await ctx.db.query("companies").first();
    if (company === null) {
      return errorResult(notFoundError("companies", "fixture_company_missing"));
    }
    const publication = await publishEvent(ctx, {
      companyId: company._id,
      eventName: args.eventName,
      payload: args.payload,
      dedupKey: `probe.event:${args.eventName}:${newDurableJobKey()}`,
    });
    return okResult({ eventId: publication.eventId, deduplicated: publication.deduplicated });
  },
});

// --- Delivery and drain drivers -----------------------------------------------

/** Reconciliation driver for one uncertain external delivery (guarded). */
export const probeReconcileDelivery = action({
  args: { jobKey: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const reconciled = await ctx.runMutation(internal.platform.echo.reconcileDelivery, {
      jobKey: args.jobKey,
    });
    return okResult(reconciled);
  },
});

/** Synchronous drain for evidence scripts (guarded action -> internal mutation). */
export const probeDrainNow = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.platform.probe.drainNow, {});
  },
});

export const drainNow = internalMutation({
  args: {},
  handler: async (ctx) => {
    await drainBatch(ctx);
    return okResult({ drained: true });
  },
});
