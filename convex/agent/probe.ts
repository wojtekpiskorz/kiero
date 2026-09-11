/**
 * E6 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable; shared plumbing from convex/sources/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the E6 evidence
 * runs against the REAL dev deployment without a development-auth
 * shortcut, through the same guarded-action pattern E3/C5 use:
 *
 * - `probeSeedE6Company`: a fresh proof company per nonce with its own
 *   user, admin membership, live bridge session and the Banan project
 *   (deterministic answer context);
 * - `probeSeedE6Source`: one witnessed source (run + text extraction +
 *   whole-source fragment) with a per-run acceptance key — the fixture
 *   findings the script publishes through C2's REAL checked dispatch, and
 *   the question sources the answer loop consumes;
 * - `probeAskAgent`: runs the REAL bounded answer loop over one question
 *   source (the operation under proof);
 * - `probeAgentState`: the tenant-scoped inspection read (findings with
 *   knowledge states and updating flags, tasks, events, clarifications,
 *   source processing states) the evidence script asserts on.
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { notFoundError, unsupportedError } from "@kiero/runtime";
import {
  action,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  probeDisabled,
  probeGuardEnabled,
  serviceIdentityUnavailable,
} from "../sources/probe_shared";
import { runAnswerLoop, runAnswerRound, startAnswerRun } from "./loop";

const PROOF_TZ = "Europe/Warsaw";
const PROOF_PIPELINE_VERSION = "e6.proof/1";

// --- fixtures -------------------------------------------------------------------

/** Seeds a fresh proof company with its user, session and Banan project. */
export const seedE6Company = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const email = `e6-${args.nonce}@kiero.invalid`;
    const companyName = `Kiero E6 proof (${args.nonce})`;
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
      displayName: `E6 proof ${args.nonce}`,
      createdAtMs: nowMs,
    });
    const companyId = await ctx.db.insert("companies", {
      name: companyName,
      timezone: PROOF_TZ,
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
      deviceLabel: "e6-proof-bridge",
    });
    const bananId = await ctx.db.insert("projects", {
      companyId,
      displayName: `Banan (E6 ${args.nonce})`,
      stage: "inquiry",
      stageRevision: 1,
      createdAtMs: nowMs,
    });
    return okResult({ companyId, userId, sessionId, bananId });
  },
});

export const probeSeedE6Company = action({
  args: { nonce: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.agent.probe.seedE6Company, { nonce: args.nonce });
  },
});

/** Ensures one witnessed source (run + text extraction + whole-source fragment). */
async function ensureWitnessedSource(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  userId: Id<"users">,
  acceptanceKey: string,
  authorText: string,
  sentAtMs: number,
): Promise<{ sourceId: Id<"sources">; fragmentId: Id<"sourceFragments"> }> {
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
    if (fragment !== null) {
      return { sourceId: existing._id, fragmentId: fragment._id };
    }
  }
  const nowMs = Date.now();
  const inserted = await db.insert("sources", {
    companyId,
    authorUserId: userId,
    authorText,
    sentAtMs,
    sentAtTimezone: PROOF_TZ,
    fullyAcceptedAtMs: nowMs,
    lifecycle: "active",
    acceptanceKey,
    acceptanceFingerprint: `e6-proof:${acceptanceKey}`,
  });
  const runId = await db.insert("processingRuns", {
    companyId,
    sourceId: inserted,
    kind: "initial_analysis",
    pipelineVersion: PROOF_PIPELINE_VERSION,
    promptVersion: "none",
    schemaVersion: "none",
    modelConfigurationVersion: "none",
    state: "succeeded",
    startedAtMs: nowMs,
    finishedAtMs: nowMs,
  });
  const extractionId = await db.insert("extractions", {
    sourceId: inserted,
    kind: "text",
    pipelineVersion: PROOF_PIPELINE_VERSION,
    model: "author-text",
    provider: "kiero",
    processingRunId: runId,
    createdAtMs: nowMs,
  });
  const fragmentId = await db.insert("sourceFragments", {
    extractionId,
    sourceId: inserted,
    anchor: { _tag: "whole_source" },
    createdAtMs: nowMs,
  });
  return { sourceId: inserted, fragmentId };
}

/** Resolves the seeded session's company and user (null on any broken chain). */
async function sessionCompany(
  db: MutationCtx["db"],
  sessionId: string,
): Promise<{ companyId: Id<"companies">; userId: Id<"users"> } | null> {
  const normalized = db.normalizeId("sessions", sessionId);
  const session = normalized === null ? null : await db.get(normalized);
  if (session === null) {
    return null;
  }
  const membership = await db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", session.userId))
    .filter((q) => q.eq(q.field("state"), "active"))
    .first();
  return membership === null ? null : { companyId: membership.companyId, userId: session.userId };
}

/** Seeds (idempotently) one witnessed source for the session's company. */
export const seedE6Source = internalMutation({
  args: {
    sessionId: v.string(),
    acceptanceKey: v.string(),
    authorText: v.string(),
    sentAtIso: v.string(),
    /** Optional project link (the project pill's row; enables scoped search). */
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await sessionCompany(ctx.db, args.sessionId);
    if (resolved === null) {
      return serviceIdentityUnavailable();
    }
    if (args.projectId !== undefined) {
      const project = await ctx.db.get(args.projectId);
      if (project === null || project.companyId !== resolved.companyId) {
        return errorResult(notFoundError("projects", "project_not_in_company"));
      }
    }
    const seeded = await ensureWitnessedSource(
      ctx.db,
      resolved.companyId,
      resolved.userId,
      args.acceptanceKey,
      args.authorText,
      Date.parse(args.sentAtIso),
    );
    if (args.projectId !== undefined) {
      const linked = await ctx.db
        .query("sourceProjectLinks")
        .withIndex("by_source", (q) => q.eq("sourceId", seeded.sourceId))
        .filter((q) => q.eq(q.field("projectId"), args.projectId))
        .first();
      if (linked === null) {
        await ctx.db.insert("sourceProjectLinks", {
          sourceId: seeded.sourceId,
          projectId: args.projectId,
          assignedByUserId: resolved.userId,
          assignedAtMs: Date.now(),
          sentAtMs: Date.parse(args.sentAtIso),
        });
      }
    }
    return okResult(seeded);
  },
});

export const probeSeedE6Source = action({
  args: {
    sessionId: v.string(),
    acceptanceKey: v.string(),
    authorText: v.string(),
    sentAtIso: v.string(),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.agent.probe.seedE6Source, args);
  },
});

// --- the operation under proof ----------------------------------------------------

/** Runs the REAL answer loop for one question source (guarded). */
export const probeAskAgent = action({
  args: { questionSourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return errorResult(unsupportedError("agent.probe", "probe_guard_disabled"));
    }
    const result = await runAnswerLoop(ctx, args.questionSourceId);
    return okResult(result as unknown as Record<string, unknown>);
  },
});

/**
 * The round-wise proof driver (guarded): starts one answer run and returns
 * its resumable round state, or runs ONE more round when handed a state the
 * driver echoes back. This is the SAME round core the production loop
 * drives; the split exists so a live proof does not need one synchronous
 * action to outlive the transport window (the production shape's honest
 * limit until a durable answer-record family exists — a named prerequisite
 * for J2/J3). The echoed state is untrusted input exactly like a plan: the
 * round re-validates every tool call against the context it carries.
 */
export const probeStartAnswerRun = action({
  args: { questionSourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const started = await startAnswerRun(ctx, args.questionSourceId);
    return okResult({ kind: "continue", next: started } as unknown as Record<string, unknown>);
  },
});

/** One more round of a started answer run (guarded; see probeStartAnswerRun). */
export const probeAnswerRound = action({
  args: { questionSourceId: v.id("sources"), roundState: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const outcome = await runAnswerRound(
      ctx,
      args.questionSourceId,
      args.roundState as Parameters<typeof runAnswerRound>[2],
    );
    return okResult(outcome as unknown as Record<string, unknown>);
  },
});

/** Runs the evidence search directly (guarded diagnostics for proofs). */
export const probeSearchEvidence = action({
  args: {
    questionSourceId: v.id("sources"),
    query: v.string(),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.agent.evidence.searchEvidenceRows, {
      questionSourceId: args.questionSourceId,
      query: args.query,
      ...(args.projectId === undefined ? {} : { projectId: args.projectId }),
    });
  },
});

// --- inspection -------------------------------------------------------------------

/** The tenant-scoped agent state for the evidence scripts (guarded). */
export const agentState = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const resolved = await sessionCompanyRead(ctx, args.sessionId);
    if (resolved === null) {
      return serviceIdentityUnavailable();
    }
    const findings = await ctx.db
      .query("findings")
      .withIndex("by_company_scope_key", (q) => q.eq("companyId", resolved.companyId))
      .collect();
    const findingRows = await Promise.all(
      findings.map(async (finding) => {
        if (finding.currentRevisionId === undefined) {
          return null;
        }
        const revision = await ctx.db.get(finding.currentRevisionId);
        return {
          findingId: finding._id,
          semanticKey: finding.semanticKey,
          scopeKind: finding.scopeKind,
          scopeProjectId: finding.scopeProjectId ?? null,
          revisionCounter: finding.revisionCounter,
          knowledgeState: revision?.knowledgeState ?? null,
          value: revision?.value ?? null,
        };
      }),
    );
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_company_state", (q) => q.eq("companyId", resolved.companyId))
      .collect();
    const events = await ctx.db
      .query("events")
      .withIndex("by_project_state", (q) => q.eq("companyId", resolved.companyId))
      .collect();
    const clarifications = await ctx.db
      .query("clarifications")
      .withIndex("by_company_state", (q) => q.eq("companyId", resolved.companyId))
      .collect();
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_company_order", (q) => q.eq("companyId", resolved.companyId))
      .order("desc")
      .take(20);
    return okResult({
      findings: findingRows.filter((row) => row !== null),
      tasks: tasks.map((task) => ({
        taskId: task._id,
        projectId: task.projectId,
        title: task.title,
        state: task.state,
        revisionCounter: task.revisionCounter,
      })),
      events: events.map((event) => ({
        eventId: event._id,
        projectId: event.projectId,
        title: event.title,
        state: event.state,
        revisionCounter: event.revisionCounter,
      })),
      clarifications: clarifications.map((row) => ({
        clarificationId: row._id,
        question: row.question,
        state: row.state,
        conflictingFragmentIds: row.conflictingFragmentIds,
        scopeKind: row.scopeKind,
      })),
      sources: sources.map((source) => ({
        sourceId: source._id,
        lifecycle: source.lifecycle,
        sentAtMs: source.sentAtMs,
      })),
    });
  },
});

/** The read-only twin of the session company resolution. */
async function sessionCompanyRead(
  ctx: QueryCtx,
  sessionId: string,
): Promise<{ companyId: Id<"companies"> } | null> {
  const normalized = ctx.db.normalizeId("sessions", sessionId);
  const session = normalized === null ? null : await ctx.db.get(normalized);
  if (session === null) {
    return null;
  }
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", session.userId))
    .filter((q) => q.eq(q.field("state"), "active"))
    .first();
  return membership === null ? null : { companyId: membership.companyId };
}

export const probeAgentState = action({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.agent.probe.agentState, { sessionId: args.sessionId });
  },
});
