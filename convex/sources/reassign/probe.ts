/**
 * E7 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the sibling sources probes). Shared plumbing
 * lives in convex/sources/probe_shared.ts, whose fixture and inspection
 * bodies this lane's deltas ride: review round 1 replaced a verbatim
 * transcription of C5's probe with those shared pieces, keeping only the
 * lane-specific fixtures and wire-row mapping below.
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
 *   through the checked sources path (the operation under proof), riding
 *   the accept lane's transaction entry exactly like the withdrawal proof
 *   and the dossier's WithdrawControl (ONE dispatch table; the envelope
 *   carries the operation).
 * - `probeReassignState`: the tenant-scoped inspection read the evidence
 *   script asserts on (sources with their CURRENT links, findings with
 *   every revision's origin and attribution, durable recomputation and
 *   re-analysis jobs, reanalysis runs, and the reassignment events) over
 *   the shared walks.
 */

import { v } from "convex/values";
import { okResult, type ResultEnvelope } from "@kiero/contracts";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import { knowledgeTagOf } from "../../memory/findings/semantics";
import {
  SERVICE_EMAIL,
  bridgeContextForEmail,
  companyFindingRevisions,
  companyMemoryJobs,
  companyOutboxEvents,
  companyReanalysisRuns,
  companySourcesWithLinks,
  ensureIsolationIdentity,
  ensureProject,
  ensureWitnessedSource,
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";

/** The E7 proof stamp every fixture row carries. */
const PROOF_STAMP = {
  timezone: "Europe/Warsaw",
  sentAtMs: Date.parse("2026-09-10T09:00:00.000Z"),
  pipelineVersion: "e7.proof/1",
  fingerprintPrefix: "e7-proof:",
} as const;

/** The E7 isolation fixture identity (its own company, never company A). */
const ISOLATION = {
  email: "e7-isolation@kiero.invalid",
  companyName: "Kiero Dev Proof E (E7 isolation)",
  displayName: "E7 isolation proof",
  deviceLabel: "e7-isolation-bridge",
} as const;

/** The tag characters a run tag keeps (the sibling probes' sanitizer). */
function sanitizedTag(runTag: string): string {
  return runTag.replace(/[^a-z0-9-]/gi, "");
}

// --- fixtures -------------------------------------------------------------------

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
    const tag = sanitizedTag(args.runTag);
    const projectA = await ensureProject(ctx.db, companyId, `Projekt E7 A ${tag}`);
    const projectB = await ensureProject(ctx.db, companyId, `Projekt E7 B ${tag}`);
    // The moved source (its findings live in project A), the independent
    // placement witness (stays linked to A), the company-general source and
    // the derivation's own provenance source.
    const source = (acceptanceKey: string, authorText: string, projectIds: readonly Id<"projects">[]) =>
      ensureWitnessedSource(ctx.db, {
        companyId,
        userId,
        acceptanceKey,
        authorText,
        stamp: PROOF_STAMP,
        projectIds,
      });
    const moved = await source(`e7-proof-${tag}-moved`, "Termin dostawy na Budowlanej, piątek.", [
      projectA,
    ]);
    const independent = await source(
      `e7-proof-${tag}-indep`,
      "Klient potwierdza dostawę w piątek na Budowlanej.",
      [projectA],
    );
    const general = await source(`e7-proof-${tag}-general`, "Zmieniamy dane do faktur na nowe.", []);
    const derivation = await source(
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
    const { userId, companyId, sessionId } = await ensureIsolationIdentity(
      ctx.db,
      ISOLATION,
    );
    const tag = sanitizedTag(args.runTag);
    const project = await ensureProject(ctx.db, companyId, `Projekt E7 izolacja ${tag}`);
    const source = await ensureWitnessedSource(ctx.db, {
      companyId,
      userId,
      acceptanceKey: `e7-proof-${tag}-isolation`,
      authorText: "Wiadomość drugiej firmy (dowód izolacji E7).",
      stamp: PROOF_STAMP,
      projectIds: [project],
    });
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

/**
 * Dispatches `sources.reassignSource` through the REAL sources dispatch,
 * riding the accept lane's transaction entry (the withdrawal-proof
 * precedent: one operation-agnostic dispatch table, the envelope carries
 * the operation; review round 1 deleted this lane's duplicate pair).
 */
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
    return ctx.runMutation(internal.sources.accept.commands.acceptSourceTransaction, {
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
    // The shared tenant-scoped walks; this lane maps its own wire rows.
    const sourceRows = (await companySourcesWithLinks(ctx.db, companyId)).map(
      ({ source, links }) => ({
        sourceId: source._id,
        lifecycle: source.lifecycle,
        withdrawnReason: source.withdrawnReason ?? null,
        projectIds: links.map((link) => link.projectId),
      }),
    );
    const findingRows = await companyFindingRevisions(ctx.db, companyId);
    const revisionRows = findingRows.flatMap(({ finding, revisions }) =>
      revisions.map((revision) => ({
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
      })),
    );
    const jobs = await companyMemoryJobs(ctx.db, companyId);
    const reanalysisRuns = await companyReanalysisRuns(ctx.db, companyId);
    const events = await companyOutboxEvents(ctx.db, companyId);
    return okResult({
      sources: sourceRows,
      findings: findingRows.map(({ finding }) => ({
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
