/**
 * C5 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the A3 platform probes and the C2 findings probes;
 * shared plumbing from convex/sources/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the C5 evidence can
 * run against the REAL dev deployment without a development-auth shortcut:
 * the actor is always the service account's own session (the A3
 * service-bridge identity) or an explicitly seeded second-company session,
 * resolved through the SAME canonical resolution and authorization seam as
 * production calls. Sessions are created server-side here; no identity is
 * ever accepted from client input.
 *
 * - `probeSeedRecomputeFixtures`: idempotent witnessed sources (run + text
 *   extraction + whole-source fragment each) the live script publishes
 *   findings against through C2's REAL checked dispatch probes.
 * - `probeSeedRecomputeIsolation`: a whole second company with its own
 *   user, membership, session and witnessed source for tenant isolation.
 * - `probeWithdrawSource`: the REAL `sources.withdrawSource` dispatch (the
 *   guarded checked path — this is the operation under proof).
 * - `probeRecomputeState`: the tenant-scoped inspection read (markings,
 *   updating findings, durable recompute/analysis jobs, reanalysis runs,
 *   memory events) the evidence script asserts on, plus the automation
 *   gate verdict for one finding (C4's dueness gate agrees by
 *   construction: everything not `known` is excluded).
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import {
  SERVICE_EMAIL,
  bridgeContextForEmail,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../../sources/probe_shared";
import { dispatchSourcesCommand } from "../../sources/accept/dispatch";
import { knowledgeTagOf } from "../findings/semantics";

const PROOF_TZ = "Europe/Warsaw";
const PROOF_SENT_AT_MS = Date.parse("2026-09-08T16:30:00.000Z"); // 18:30 Warsaw
const PROOF_PIPELINE_VERSION = "c5.proof/1";

/** The C5 isolation fixture identity (its own company, never company A). */
const ISOLATION_EMAIL = "c5-isolation@kiero.invalid";
const ISOLATION_COMPANY = "Kiero Dev Proof C (C5 isolation)";

function probeGuardEnabled(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

function probeDisabled(): ResultEnvelope {
  return errorResult(unsupportedError("memory.recompute.probe", "probe_guard_disabled"));
}

// --- fixtures -------------------------------------------------------------------

interface SeededSource {
  readonly sourceId: string;
  readonly fragmentId: string;
  readonly extractionId: string;
}

/** Ensures one witnessed source (run + text extraction + whole-source fragment). */
async function ensureWitnessedSource(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  userId: Id<"users">,
  acceptanceKey: string,
  authorText: string,
): Promise<SeededSource> {
  const existing = await db
    .query("sources")
    .withIndex("by_company_acceptance_key", (q) =>
      q.eq("companyId", companyId).eq("acceptanceKey", acceptanceKey),
    )
    .first();
  if (existing !== null) {
    const fragment = await db
      .query("sourceFragments")
      .withIndex("by_source", (q) => q.eq("sourceId", existing._id))
      .first();
    const extraction = fragment === null ? null : await db.get(fragment.extractionId);
    return {
      sourceId: existing._id,
      fragmentId: fragment?._id ?? "",
      extractionId: extraction?._id ?? "",
    };
  }
  const nowMs = Date.now();
  const sourceId = await db.insert("sources", {
    companyId,
    authorUserId: userId,
    authorText,
    sentAtMs: PROOF_SENT_AT_MS,
    sentAtTimezone: PROOF_TZ,
    fullyAcceptedAtMs: nowMs,
    lifecycle: "active",
    acceptanceKey,
    acceptanceFingerprint: `c5-proof:${acceptanceKey}`,
  });
  const runId = await db.insert("processingRuns", {
    companyId,
    sourceId,
    kind: "initial_analysis",
    pipelineVersion: PROOF_PIPELINE_VERSION,
    promptVersion: "none",
    schemaVersion: "none",
    modelConfigurationVersion: "none",
    state: "succeeded",
    startedAtMs: nowMs,
  });
  const extractionId = await db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: PROOF_PIPELINE_VERSION,
    model: "author-text",
    provider: "kiero",
    processingRunId: runId,
    createdAtMs: nowMs,
  });
  const fragmentId = await db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor: { _tag: "whole_source" },
    createdAtMs: nowMs,
  });
  return { sourceId, fragmentId, extractionId };
}

/** Seeds the service company's seven witnessed proof sources (guarded). */
export const seedRecomputeFixtures = internalMutation({
  args: { runTag: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await bridgeContextForEmail(ctx.db, SERVICE_EMAIL);
    if (context === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    const userId = ctx.db.normalizeId("users", context.actor.userId);
    if (companyId === null || userId === null) {
      return serviceIdentityUnavailable();
    }
    // One withdrawal is one-shot per source: every proof run seeds its own
    // fixture set (idempotent within the run, fresh across runs).
    const tag = `c5-proof-${args.runTag.replace(/[^a-z0-9-]/gi, "")}`;
    const sole = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      `${tag}-sole`,
      "Termin dostawy na Baniewice — piątek.",
    );
    const witnessA = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      `${tag}-witA`,
      "Cena usługi to 10 tysięcy.",
    );
    const witnessB = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      `${tag}-witB`,
      "Potwierdzam cenę 10 tysięcy.",
    );
    const basis = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      `${tag}-basis`,
      "Dostawa płyt ma nastąpić w piątek rano.",
    );
    const derive = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      `${tag}-derive`,
      "Skoro termin jest ustalony, ryzyko kary jest niskie.",
    );
    const derive2 = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      `${tag}-derive2`,
      "Przy niskim ryzyku kary nie odkładamy zamówienia.",
    );
    const indep = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      `${tag}-indep`,
      "Klient przysłał nową wizytówkę.",
    );
    return okResult({
      companyId,
      sole,
      witnessA,
      witnessB,
      basis,
      derive,
      derive2,
      indep,
    });
  },
});

export const probeSeedRecomputeFixtures = action({
  args: { runTag: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.memory.recompute.probe.seedRecomputeFixtures, {
      runTag: args.runTag,
    });
  },
});

/** Ensures the second-company fixture (guarded, per proof run). */
export const seedRecomputeIsolation = internalMutation({
  args: { runTag: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", ISOLATION_EMAIL))
      .first();
    const userId =
      existingUser?._id ??
      (await ctx.db.insert("users", {
        email: ISOLATION_EMAIL,
        displayName: "C5 isolation proof",
        createdAtMs: Date.now(),
      }));
    const existingCompany = await ctx.db
      .query("companies")
      .filter((q) => q.eq(q.field("name"), ISOLATION_COMPANY))
      .first();
    const companyId =
      existingCompany?._id ??
      (await ctx.db.insert("companies", {
        name: ISOLATION_COMPANY,
        timezone: "Europe/Warsaw",
        defaultCurrency: "PLN",
        createdAtMs: Date.now(),
      }));
    const existingMembership = await ctx.db
      .query("memberships")
      .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
      .first();
    // `.first()` yields null (not undefined) when absent: the null check is
    // load-bearing (the C2 probe comment documents the same trap).
    if (existingMembership === null) {
      await ctx.db.insert("memberships", {
        companyId,
        userId,
        role: "admin",
        state: "active",
        createdAtMs: Date.now(),
      });
    }
    const existingSession = await ctx.db
      .query("sessions")
      .withIndex("by_user_started", (q) => q.eq("userId", userId))
      .order("desc")
      .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
      .first();
    const sessionId =
      existingSession?._id ??
      (await ctx.db.insert("sessions", {
        userId,
        startedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
        deviceLabel: "c5-isolation-bridge",
      }));
    const tag = `c5-proof-${args.runTag.replace(/[^a-z0-9-]/gi, "")}`;
    const source = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      `${tag}-isolation`,
      "Wiadomość drugiej firmy (dowód izolacji C5).",
    );
    return okResult({ companyId, userId, sessionId, ...source });
  },
});

export const probeSeedRecomputeIsolation = action({
  args: { runTag: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.memory.recompute.probe.seedRecomputeIsolation, {
      runTag: args.runTag,
    });
  },
});

// --- the operation under proof ---------------------------------------------------

/** Dispatches `sources.withdrawSource` through the REAL sources dispatch. */
export const withdrawTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchSourcesCommand(ctx, args.envelope, args.serviceSessionId),
});

export const probeWithdrawSource = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.memory.recompute.probe.withdrawTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

// --- inspection -------------------------------------------------------------------

/** Tenant-scoped recomputation state for the evidence script (guarded read). */
export const recomputeState = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
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
    const findings = await ctx.db
      .query("findings")
      .withIndex("by_company_scope_key", (q) => q.eq("companyId", companyId))
      .collect();
    const revisionRows = [];
    for (const finding of findings) {
      const revisions = await ctx.db
        .query("findingRevisions")
        .withIndex("by_finding_revision", (q) => q.eq("findingId", finding._id))
        .order("asc")
        .collect();
      for (const revision of revisions) {
        revisionRows.push({
          findingId: finding._id,
          revisionId: revision._id,
          revision: revision.revision,
          semanticKey: finding.semanticKey,
          value: revision.value,
          knowledgeTag: knowledgeTagOf(revision.knowledgeState),
          knowledgeState: revision.knowledgeState,
          origin: revision.origin,
          reason: revision.reason ?? null,
          provenanceSourceId: revision.provenance?.sourceId ?? null,
          withdrawnSourceId: revision.withdrawnSourceId ?? null,
          recordedByUserId: revision.recordedByUserId,
          supersedesRevisionId: revision.supersedesRevisionId ?? null,
        });
      }
    }
    const dependencies = await ctx.db
      .query("findingDependencies")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const recomputeJobs = await ctx.db
      .query("durableJobs")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .filter((q) =>
        q.or(
          q.eq(q.field("kind"), "memory.recompute_dependents"),
          q.eq(q.field("kind"), "processing.analyze_change_plan"),
        ),
      )
      .collect();
    const reanalysisRuns = await ctx.db
      .query("processingRuns")
      .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
      .filter((q) => q.eq(q.field("kind"), "reanalysis"))
      .collect();
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_company_order", (q) => q.eq("companyId", companyId))
      .collect();
    const memoryEvents = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return okResult({
      findings: findings.map((finding) => ({
        findingId: finding._id,
        semanticKey: finding.semanticKey,
        scopeKind: finding.scopeKind,
        currentRevisionId: finding.currentRevisionId ?? null,
        knowledgeTag: knowledgeTagOf(finding.knowledgeState),
        revisionCounter: finding.revisionCounter,
        /** The automation gate verdict (agrees with C4's dueness gate). */
        automationEligible: knowledgeTagOf(finding.knowledgeState) === "known",
      })),
      revisions: revisionRows,
      dependencies: dependencies.map((row) => ({
        dependentFindingId: row.dependentFindingId,
        dependsOnFindingId: row.dependsOnFindingId,
        cause: row.cause,
      })),
      recomputeJobs: recomputeJobs.map((job) => ({
        jobKey: job.jobKey,
        kind: job.kind,
        state: job.state,
        dedupKey: job.dedupKey ?? null,
        lastErrorKind: job.lastErrorKind ?? null,
        attempts: job.attempts,
      })),
      reanalysisRuns: reanalysisRuns.map((run) => ({
        runId: run._id,
        sourceId: run.sourceId,
        state: run.state,
        reanalysisOfRunId: run.reanalysisOfRunId ?? null,
      })),
      sources: sources.map((source) => ({
        sourceId: source._id,
        lifecycle: source.lifecycle,
        withdrawnReason: source.withdrawnReason ?? null,
        withdrawnAtMs: source.withdrawnAtMs ?? null,
        withdrawnByUserId: source.withdrawnByUserId ?? null,
      })),
      memoryEvents: memoryEvents
        .filter((row) => row.eventName.startsWith("memory.") || row.eventName === "sources.sourceWithdrawn")
        .map((row) => ({
          eventName: row.eventName,
          deliveryState: row.deliveryState,
          lastErrorKind: row.lastErrorKind ?? null,
        })),
    });
  },
});

export const probeRecomputeState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.memory.recompute.probe.recomputeState, {
      serviceSessionId: sessionId,
    });
  },
});
