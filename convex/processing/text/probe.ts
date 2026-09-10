/**
 * E3 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable; shared plumbing from convex/sources/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the E3 evidence
 * runs against the REAL dev deployment without a development-auth
 * shortcut, through the same guarded-action pattern A3/D1/C2 use:
 *
 * - `probeAnalysisState`: the tenant-scoped inspection read the evidence
 *   script asserts on — run (with versions and checkpoint), steps (the
 *   resumable stage status), attempts (observed model/latency/outcome),
 *   change sets, clarifications and current findings.
 * - `probeKickReanalysis`: creates a linked NEW run for a source and
 *   publishes `operations.reanalysisRequested` (the drain's registered
 *   consumer edge registers the analyze job — the cross-module path).
 * - `probeArmAnalysisFailure` / `probeDisarmAnalysisFailure`: the A3
 *   failure-marker pattern over one stage sequence (the crash proofs).
 * - `probeRestartAnalysis`: restarts a failed analysis workflow from its
 *   journal, proving replay without duplicate revisions.
 * - `probeCompanyDefaults`: the service company's currency/timezone facts
 *   the evidence script records alongside observed model behavior.
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import {
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { notFoundError } from "@kiero/runtime";
import {
  bridgeIdentity,
  resolveRequestContext,
} from "../../platform/context";
import { publishEvent } from "../../platform/publish";
import {
  SERVICE_EMAIL,
  bridgeContextForEmail,
  probeDisabled,
  probeGuardEnabled,
  serviceIdentityUnavailable,
  serviceSessionId,
} from "../../sources/probe_shared";

import { restartAnalysisWorkflow } from "./analyze";
import {
  FAILURE_MARKER_BASE,
  OUTCOME_MARKER_BASE,
  failureMarkerArmed,
  outcomeMarkerArmed,
  stepRow,
} from "./journal";
import { vWorkflowId } from "@convex-dev/workflow";

// --- inspection ------------------------------------------------------------

/** The tenant-scoped analysis state for the evidence scripts (guarded). */
export const analysisState = internalQuery({
  args: { serviceSessionId: v.string(), runId: v.optional(v.id("processingRuns")) },
  handler: async (ctx, args) => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      return serviceIdentityUnavailable();
    }
    const runs = await ctx.db
      .query("processingRuns")
      .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
      .order("desc")
      .take(10);
    const maybeSelected =
      args.runId === undefined ? runs[0] : await ctx.db.get(args.runId);
    if (maybeSelected === null || maybeSelected === undefined) {
      return errorResult(notFoundError("processingRuns"));
    }
    const selected = maybeSelected;
    const steps = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) => q.eq("runId", selected._id))
      .collect();
    const modelStep = steps.find((step) => step.stepKind === "model_analysis");
    const attempts =
      modelStep === undefined
        ? []
        : (
            await ctx.db
              .query("processingAttempts")
              .withIndex("by_step_attempt", (q) => q.eq("stepId", modelStep._id))
              .collect()
          ).map((attempt) => ({
            attempt: attempt.attempt,
            outcome: attempt.outcome,
            provider: attempt.provider ?? null,
            model: attempt.model ?? null,
            errorKind: attempt.errorKind ?? null,
            startedAtMs: attempt.startedAtMs,
            finishedAtMs: attempt.finishedAtMs ?? null,
          }));
    const changeSets = await ctx.db
      .query("changeSets")
      .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
      .order("desc")
      .take(10);
    const clarifications = await ctx.db
      .query("clarifications")
      .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
      .collect();
    const findings = await ctx.db
      .query("findings")
      .withIndex("by_company_scope_key", (q) => q.eq("companyId", companyId))
      .collect();
    const findingValues = await Promise.all(
      findings.map(async (finding) => {
        if (finding.currentRevisionId === undefined) {
          return null;
        }
        const revision = await ctx.db.get(finding.currentRevisionId);
        return revision === null ? null : revision.value;
      }),
    );
    const fragments = await ctx.db
      .query("sourceFragments")
      .withIndex("by_source", (q) => q.eq("sourceId", selected.sourceId))
      .collect();
    const fragmentExtractions = await Promise.all(
      fragments.map(async (fragment) => {
        const extraction = await ctx.db.get(fragment.extractionId);
        return extraction === null
          ? null
          : {
              extractionId: extraction._id,
              kind: extraction.kind,
              provider: extraction.provider,
            };
      }),
    );
    return okResult({
      run: {
        runId: selected._id,
        sourceId: selected.sourceId,
        kind: selected.kind,
        state: selected.state,
        pipelineVersion: selected.pipelineVersion,
        promptVersion: selected.promptVersion,
        schemaVersion: selected.schemaVersion,
        modelConfigurationVersion: selected.modelConfigurationVersion,
        checkpoint: selected.checkpoint ?? null,
      },
      steps: steps
        .filter((step) => step.stepKind !== "failure_marker")
        .map((step) => ({
          sequence: step.sequence,
          stepKind: step.stepKind,
          state: step.state,
          outputRef: step.outputRef ?? null,
        }))
        .sort((a, b) => a.sequence - b.sequence),
      failureMarkers: steps.filter((step) => step.stepKind === "failure_marker").length,
      attempts,
      changeSets: changeSets.map((changeSet) => ({
        changeSetId: changeSet._id,
        sourceId: changeSet.sourceId,
        state: changeSet.state,
        failedReason: changeSet.failedReason ?? null,
      })),
      clarifications: clarifications.map((row) => ({
        clarificationId: row._id,
        question: row.question,
        state: row.state,
        scopeKind: row.scopeKind,
      })),
      findings: findings.map((finding, index) => ({
        findingId: finding._id,
        semanticKey: finding.semanticKey,
        scopeKind: finding.scopeKind,
        scopeProjectId: finding.scopeProjectId ?? null,
        revisionCounter: finding.revisionCounter,
        knowledgeState: finding.knowledgeState,
        value: findingValues[index] ?? null,
      })),
      fragments: fragments.map((fragment, index) => ({
        fragmentId: fragment._id,
        anchor: fragment.anchor,
        extraction: fragmentExtractions[index],
      })),
    });
  },
});

export const probeAnalysisState = action({
  args: { runId: v.optional(v.id("processingRuns")), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const session = args.sessionId ?? (await serviceSessionId(ctx));
    if (session === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.processing.text.probe.analysisState, {
      serviceSessionId: session,
      ...(args.runId === undefined ? {} : { runId: args.runId }),
    });
  },
});

// --- reanalysis (the linked new run) ----------------------------------------

/** Creates a linked reanalysis run and publishes the registered event. */
export const kickReanalysis = internalMutation({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) {
      return errorResult(notFoundError("sources"));
    }
    const previous = await ctx.db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", args.sourceId))
      .order("desc")
      .first();
    const runId = await ctx.db.insert("processingRuns", {
      companyId: source.companyId,
      sourceId: args.sourceId,
      kind: "reanalysis",
      ...(previous === null ? {} : { reanalysisOfRunId: previous._id }),
      pipelineVersion: "pending-e3",
      promptVersion: "none",
      schemaVersion: "none",
      modelConfigurationVersion: "none",
      state: "running",
      startedAtMs: Date.now(),
    });
    const publication = await publishEvent(ctx, {
      companyId: source.companyId,
      eventName: "operations.reanalysisRequested",
      payload: {
        sourceId: args.sourceId,
        newRunId: runId,
        reanalysisOfRunId: previous?._id ?? null,
      },
      dedupKey: `operations.reanalysisRequested:${runId}`,
    });
    return okResult({
      runId,
      eventId: publication.eventId,
      reanalysisOfRunId: previous?._id ?? null,
    });
  },
});

export const probeKickReanalysis = action({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.text.probe.kickReanalysis, {
      sourceId: args.sourceId,
    });
  },
});

// --- failure markers and restart (the crash proofs) -------------------------

/** Arms the deterministic failure marker for one stage sequence. */
export const armAnalysisFailure = internalMutation({
  args: { runId: v.id("processingRuns"), sequence: v.number() },
  handler: async (ctx, args) => {
    const armed = await failureMarkerArmed(ctx.db, args.runId, args.sequence);
    if (armed) {
      return okResult({ armed: true });
    }
    await ctx.db.insert("processingSteps", {
      runId: args.runId,
      stepKind: "failure_marker",
      sequence: FAILURE_MARKER_BASE + args.sequence,
      state: "failed",
      outputRef: "armed",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    return okResult({ armed: true });
  },
});

export const probeArmAnalysisFailure = action({
  args: { runId: v.id("processingRuns"), sequence: v.number() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.text.probe.armAnalysisFailure, {
      runId: args.runId,
      sequence: args.sequence,
    });
  },
});

/** Arms the RECORDED-outcome failure marker (no exception; isolation proof). */
export const armAnalysisOutcomeFailure = internalMutation({
  args: { runId: v.id("processingRuns"), sequence: v.number() },
  handler: async (ctx, args) => {
    const armed = await outcomeMarkerArmed(ctx.db, args.runId, args.sequence);
    if (armed) {
      return okResult({ armed: true });
    }
    await ctx.db.insert("processingSteps", {
      runId: args.runId,
      stepKind: "outcome_failure_marker",
      sequence: OUTCOME_MARKER_BASE + args.sequence,
      state: "failed",
      outputRef: "armed",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    return okResult({ armed: true });
  },
});

export const probeArmAnalysisOutcomeFailure = action({
  args: { runId: v.id("processingRuns"), sequence: v.number() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.text.probe.armAnalysisOutcomeFailure, {
      runId: args.runId,
      sequence: args.sequence,
    });
  },
});

/** Disarms the marker (the "operator fixed it" action). */
export const disarmAnalysisFailure = internalMutation({
  args: { runId: v.id("processingRuns"), sequence: v.number() },
  handler: async (ctx, args) => {
    const marker = await stepRow(ctx.db, args.runId, FAILURE_MARKER_BASE + args.sequence);
    if (marker !== null) {
      await ctx.db.delete(marker._id);
    }
    return okResult({ armed: false });
  },
});

export const probeDisarmAnalysisFailure = action({
  args: { runId: v.id("processingRuns"), sequence: v.number() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.text.probe.disarmAnalysisFailure, {
      runId: args.runId,
      sequence: args.sequence,
    });
  },
});

/** Restarts a failed analysis workflow from its journal (guarded). */
export const restartAnalysis = internalMutation({
  args: { workflowId: vWorkflowId, from: v.string(), runId: v.optional(v.id("processingRuns")) },
  handler: async (ctx, args) => {
    const target = args.from === "model" ? "model" : "group";
    // The analysis runs again: reflect it on the run row so inspection (and
    // the evidence scripts' polling) never mistake a restarted run for a
    // terminal failure.
    if (args.runId !== undefined) {
      await ctx.db.patch(args.runId, { state: "running", finishedAtMs: undefined });
    }
    await restartAnalysisWorkflow(ctx, args.workflowId, target);
    return okResult({ restarted: args.workflowId, from: target });
  },
});

export const probeRestartAnalysis = action({
  args: { workflowId: vWorkflowId, from: v.string(), runId: v.optional(v.id("processingRuns")) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.text.probe.restartAnalysis, {
      workflowId: args.workflowId,
      from: args.from,
      ...(args.runId === undefined ? {} : { runId: args.runId }),
    });
  },
});

// --- company facts fixture ---------------------------------------------------

/** Reads the service company's default facts (guarded). */
export const companyDefaults = internalQuery({
  args: {},
  handler: async (ctx) => {
    const context = await bridgeContextForEmail(ctx.db, SERVICE_EMAIL);
    if (context === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      return serviceIdentityUnavailable();
    }
    const company = await ctx.db.get(companyId);
    return okResult({
      companyId,
      defaultCurrency: company?.defaultCurrency ?? "PLN",
      timezone: company?.timezone ?? "Europe/Warsaw",
    });
  },
});

export const probeCompanyDefaults = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.processing.text.probe.companyDefaults, {});
  },
});


// --- latest run of one source (the evidence scripts' fast handle) ---------

/** The latest processing run id of one source (guarded read). */
export const latestRunForSource = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", args.sourceId))
      .order("desc")
      .first();
    if (run === null) {
      return errorResult(notFoundError("processingRuns"));
    }
    return okResult({ runId: run._id, state: run.state, kind: run.kind });
  },
});

export const probeLatestRunForSource = action({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.processing.text.probe.latestRunForSource, {
      sourceId: args.sourceId,
    });
  },
});


// --- fresh proof company (deterministic evidence passes) ---------------------

/** Seeds a fresh proof company with its own user, session and projects. */
export const seedE3Company = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const email = `e3-${args.nonce}@kiero.invalid`;
    const companyName = `Kiero E3 proof (${args.nonce})`;
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (existingUser !== null) {
      return errorResult(notFoundError("users", "nonce_already_seeded"));
    }
    const nowMs = Date.now();
    const userId = await ctx.db.insert("users", {
      email,
      displayName: `E3 proof ${args.nonce}`,
      createdAtMs: nowMs,
    });
    const companyId = await ctx.db.insert("companies", {
      name: companyName,
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
      createdAtMs: nowMs,
    });
    await ctx.db.insert("memberships", {
      companyId,
      userId,
      role: "admin",
      state: "active",
      createdAtMs: nowMs,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      startedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      deviceLabel: "e3-proof-bridge",
    });
    const bananId = await ctx.db.insert("projects", {
      companyId,
      displayName: "Banan (E3)",
      stage: "inquiry",
      stageRevision: 1,
      createdAtMs: nowMs,
    });
    const kaczmarekId = await ctx.db.insert("projects", {
      companyId,
      displayName: "Kaczmarek (E3)",
      stage: "inquiry",
      stageRevision: 1,
      createdAtMs: nowMs,
    });
    return okResult({ companyId, userId, sessionId, bananId, kaczmarekId });
  },
});

export const probeSeedE3Company = action({
  args: { nonce: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.text.probe.seedE3Company, {
      nonce: args.nonce,
    });
  },
});


/** Seeds a draft upload for the fresh proof company's user (guarded). */
export const seedE3Upload = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const sessionId = ctx.db.normalizeId("sessions", args.sessionId);
    const session = sessionId === null ? null : await ctx.db.get(sessionId);
    if (session === null) {
      return serviceIdentityUnavailable();
    }
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", session.userId))
      .filter((q) => q.eq(q.field("state"), "active"))
      .first();
    if (membership === null) {
      return serviceIdentityUnavailable();
    }
    const uploadId = await ctx.db.insert("uploads", {
      companyId: membership.companyId,
      userId: session.userId,
      stage: "draft",
      partCount: 0,
      createdAtMs: Date.now(),
    });
    return okResult({ uploadId });
  },
});

export const probeSeedE3Upload = action({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.text.probe.seedE3Upload, {
      sessionId: args.sessionId,
    });
  },
});
