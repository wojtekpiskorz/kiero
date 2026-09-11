/**
 * E7 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the sibling sources probes; shared plumbing lives
 * in convex/sources/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the E7 evidence can
 * run against the REAL dev deployment without a development-auth shortcut:
 * the actor is always the service account's own session (the A3
 * service-bridge identity) or an explicitly seeded second-company session,
 * resolved through the SAME canonical resolution and authorization seam as
 * production calls. Sessions are created server-side here; no identity is
 * ever accepted from client input.
 *
 * - `probeSeedReassignFixtures`: two fresh projects and witnessed,
 *   project-linked sources per proof run (the C5 fixture pattern, plus the
 *   project links whose movement is the operation under proof).
 * - `probeSeedReassignIsolation`: a whole second company with user,
 *   membership, session, project and a LINKED witnessed source, so the
 *   tenant-isolation proof can reassign B's own placement and refuse A's
 *   foreign attempt.
 * - `probeReassignSource`: the REAL `sources.reassignSource` dispatch
 *   through the checked sources path (the operation under proof).
 * - `probeReassignState`: the tenant-scoped inspection read the evidence
 *   script asserts on (sources with their CURRENT links, findings with
 *   every revision's origin and attribution, durable recomputation and
 *   re-analysis jobs, reanalysis runs, and the reassignment events).
 */

import { v } from "convex/values";
import { okResult, type ResultEnvelope } from "@kiero/contracts";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import { knowledgeTagOf } from "../../memory/findings/semantics";
import { dispatchSourcesCommand } from "../accept/dispatch";
import {
  SERVICE_EMAIL,
  bridgeContextForEmail,
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";

const PROOF_TZ = "Europe/Warsaw";
const PROOF_SENT_AT_MS = Date.parse("2026-09-10T09:00:00.000Z");
const PROOF_PIPELINE_VERSION = "e7.proof/1";

/** The E7 isolation fixture identity (its own company, never company A). */
const ISOLATION_EMAIL = "e7-isolation@kiero.invalid";
const ISOLATION_COMPANY = "Kiero Dev Proof E (E7 isolation)";

// --- fixtures -------------------------------------------------------------------

interface SeededSource {
  readonly sourceId: string;
  readonly fragmentId: string;
}

/** Ensures one witnessed source, linked to the given projects (guarded). */
async function ensureWitnessedLinkedSource(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  userId: Id<"users">,
  acceptanceKey: string,
  authorText: string,
  projectIds: readonly Id<"projects">[],
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
    return { sourceId: existing._id, fragmentId: fragment?._id ?? "" };
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
    acceptanceFingerprint: `e7-proof:${acceptanceKey}`,
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
  for (const projectId of projectIds) {
    await db.insert("sourceProjectLinks", {
      sourceId,
      projectId,
      assignedByUserId: userId,
      assignedAtMs: nowMs,
      sentAtMs: PROOF_SENT_AT_MS,
    });
  }
  return { sourceId, fragmentId };
}

/** Ensures one project in the service company (guarded; idempotent by name). */
async function ensureProject(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  displayName: string,
): Promise<Id<"projects">> {
  const existing = await db
    .query("projects")
    .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
    .filter((q) => q.eq(q.field("displayName"), displayName))
    .first();
  if (existing !== null) {
    return existing._id;
  }
  return db.insert("projects", {
    companyId,
    displayName,
    stage: "inquiry",
    stageRevision: 1,
    createdAtMs: Date.now(),
  });
}

/** Seeds the service company's E7 proof fixtures (guarded). */
export const seedReassignFixtures = internalMutation({
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
    const tag = args.runTag.replace(/[^a-z0-9-]/gi, "");
    const projectA = await ensureProject(ctx.db, companyId, `Projekt E7 A ${tag}`);
    const projectB = await ensureProject(ctx.db, companyId, `Projekt E7 B ${tag}`);
    // The moved source (its findings live in project A), the independent
    // placement witness (stays linked to A), the company-general source and
    // the derivation's own provenance source.
    const moved = await ensureWitnessedLinkedSource(
      ctx.db,
      companyId,
      userId,
      `e7-proof-${tag}-moved`,
      "Termin dostawy na Budowlanej, piątek.",
      [projectA],
    );
    const independent = await ensureWitnessedLinkedSource(
      ctx.db,
      companyId,
      userId,
      `e7-proof-${tag}-indep`,
      "Klient potwierdza dostawę w piątek na Budowlanej.",
      [projectA],
    );
    const general = await ensureWitnessedLinkedSource(
      ctx.db,
      companyId,
      userId,
      `e7-proof-${tag}-general`,
      "Zmieniamy dane do faktur na nowe.",
      [],
    );
    const derivation = await ensureWitnessedLinkedSource(
      ctx.db,
      companyId,
      userId,
      `e7-proof-${tag}-derive`,
      "Skoro termin płatności wiadomo, przygotuj przelew.",
      [],
    );
    return okResult({
      companyId,
      projectA,
      projectB,
      moved,
      independent,
      general,
      derivation,
    });
  },
});

export const probeSeedReassignFixtures = action({
  args: { runTag: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.reassign.probe.seedReassignFixtures, {
      runTag: args.runTag,
    });
  },
});

/** Ensures the second-company fixture (guarded, per proof run). */
export const seedReassignIsolation = internalMutation({
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
        displayName: "E7 isolation proof",
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
        deviceLabel: "e7-isolation-bridge",
      }));
    const tag = args.runTag.replace(/[^a-z0-9-]/gi, "");
    const project = await ensureProject(ctx.db, companyId, `Projekt E7 izolacja ${tag}`);
    const source = await ensureWitnessedLinkedSource(
      ctx.db,
      companyId,
      userId,
      `e7-proof-${tag}-isolation`,
      "Wiadomość drugiej firmy (dowód izolacji E7).",
      [project],
    );
    return okResult({ companyId, userId, sessionId, project, ...source });
  },
});

export const probeSeedReassignIsolation = action({
  args: { runTag: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.reassign.probe.seedReassignIsolation, {
      runTag: args.runTag,
    });
  },
});

// --- the operation under proof ---------------------------------------------------

/** Dispatches `sources.reassignSource` through the REAL sources dispatch. */
export const reassignTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchSourcesCommand(ctx, args.envelope, args.serviceSessionId),
});

export const probeReassignSource = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.sources.reassign.probe.reassignTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

// --- inspection ------------------------------------------------------------------

/** Tenant-scoped reassignment state for the evidence script (guarded read). */
export const reassignState = internalQuery({
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
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_company_order", (q) => q.eq("companyId", companyId))
      .collect();
    const sourceRows = [];
    for (const source of sources) {
      const links = await ctx.db
        .query("sourceProjectLinks")
        .withIndex("by_source", (q) => q.eq("sourceId", source._id))
        .collect();
      sourceRows.push({
        sourceId: source._id,
        lifecycle: source.lifecycle,
        withdrawnReason: source.withdrawnReason ?? null,
        projectIds: links.map((link) => link.projectId),
      });
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
          reassignedSourceId: revision.reassignedSourceId ?? null,
          withdrawnSourceId: revision.withdrawnSourceId ?? null,
          supersedesRevisionId: revision.supersedesRevisionId ?? null,
        });
      }
    }
    const jobs = await ctx.db
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
    const events = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return okResult({
      sources: sourceRows,
      findings: findings.map((finding) => ({
        findingId: finding._id,
        semanticKey: finding.semanticKey,
        scopeKind: finding.scopeKind,
        scopeProjectId: finding.scopeProjectId ?? null,
        knowledgeTag: knowledgeTagOf(finding.knowledgeState),
        revisionCounter: finding.revisionCounter,
        /** The automation gate verdict (agrees with C4's dueness gate). */
        automationEligible: knowledgeTagOf(finding.knowledgeState) === "known",
      })),
      revisions: revisionRows,
      jobs: jobs.map((job) => ({
        kind: job.kind,
        state: job.state,
        dedupKey: job.dedupKey ?? null,
        lastErrorKind: job.lastErrorKind ?? null,
        attempts: job.attempts,
      })),
      reanalysisRuns: reanalysisRuns.map((run) => ({
        sourceId: run.sourceId,
        state: run.state,
        reanalysisOfRunId: run.reanalysisOfRunId ?? null,
      })),
      events: events
        .filter(
          (row) =>
            row.eventName === "sources.sourceReassigned" ||
            row.eventName === "sources.sourceWithdrawn" ||
            row.eventName.startsWith("memory."),
        )
        .map((row) => ({
          eventName: row.eventName,
          deliveryState: row.deliveryState,
          lastErrorKind: row.lastErrorKind ?? null,
        })),
    });
  },
});

export const probeReassignState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.reassign.probe.reassignState, {
      serviceSessionId: sessionId,
    });
  },
});
