/**
 * D1 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the A3 platform probes).
 *
 * No business work happens here; these entries exist so the D1 evidence can
 * run against the REAL dev deployment without a development-auth shortcut:
 * the actor is always the service account's own session (the A3
 * service-bridge identity) or an explicitly seeded second-company session,
 * resolved through the SAME canonical resolution and authorization seam as
 * production calls. Sessions are created server-side here; no identity is
 * ever accepted from client input.
 *
 * - `probeAcceptSource`: dispatches one accept envelope through the checked
 *   path with the service identity (or a seeded session).
 * - `probeCrashAcceptance`: performs the FULL acceptance transaction and
 *   then THROWS before commit (the A3 no-orphan failure pattern), proving
 *   rollback of source, links, run, extraction, event and job together.
 * - `probeSeedProject` / `probeSeedUpload` / `probeSeedIsolation`: idempotent
 *   fixtures (a project or draft upload in the service company; a whole
 *   second company with user, session, project and upload for tenant
 *   isolation proofs).
 * - `probeAcceptanceState`: the tenant-scoped inspection read the evidence
 *   scripts assert on (sources, links, runs, outbox events, durable jobs).
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { api, internal } from "../../_generated/api";
import {
  CommandEnvelope,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { forbiddenError, unsupportedError, membershipPolicy, type RequestContext } from "@kiero/runtime";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import { acceptSourceEntry, performAcceptance } from "./acceptance";
import type { ActionCtx } from "../../_generated/server";

const SERVICE_EMAIL = "platform-service@kiero.invalid";
const ISOLATION_EMAIL = "d1-isolation@kiero.invalid";
const ISOLATION_COMPANY = "Kiero Dev Proof B (D1 isolation)";

function probeGuardEnabled(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

function probeDisabled(): ResultEnvelope {
  return errorResult(unsupportedError("sources.probe", "probe_guard_disabled"));
}

function unavailable(): ResultEnvelope {
  return errorResult(forbiddenError("service_identity_unavailable"));
}

/** Resolves the service session (the A3 fixture) for the default actor. */
async function serviceSessionId(ctx: ActionCtx): Promise<string | null> {
  const session = await ctx.runQuery(api.platform.probe.serviceSession, {});
  return session === null ? null : session.sessionId;
}

// --- acceptance probes ---------------------------------------------------------

/** Dispatches one accept envelope as the service identity (guarded). */
export const probeAcceptSource = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = args.sessionId ?? (await serviceSessionId(ctx));
    if (sessionId === null) {
      return unavailable();
    }
    return ctx.runMutation(internal.sources.accept.commands.acceptSourceTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/**
 * The guarded crash mutation: FULL acceptance, then a deliberate throw so
 * the whole transaction rolls back (source, links, run, extraction, event,
 * durable job and scheduled work together — the no-accepted-orphan proof).
 */
export const crashAcceptance = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const command = Schema.decodeUnknownSync(CommandEnvelope)(args.envelope);
    const context: RequestContext | null = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const decision = await membershipPolicy.authorize(context, { intent: "write" });
    if (!decision.allowed) {
      return errorResult(decision.error);
    }
    const input = Schema.decodeUnknownSync(acceptSourceEntry.input)(command.input);
    const result = await performAcceptance(ctx, context, input, command.idempotencyKey);
    if (result._tag === "error") {
      return result; // the acceptance itself failed; nothing was registered
    }
    // Registration happened inside THIS transaction; throwing aborts it all.
    throw new Error("probe: deliberate failure after acceptance registration");
  },
});

/** Runs the crash-proof acceptance (guarded action wrapper). */
export const probeCrashAcceptance = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = args.sessionId ?? (await serviceSessionId(ctx));
    if (sessionId === null) {
      return unavailable();
    }
    return ctx.runMutation(internal.sources.accept.probe.crashAcceptance, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

// --- fixtures -------------------------------------------------------------------

/** Resolves the service account's session-based request context, or null. */
async function serviceContext(
  db: Parameters<typeof resolveRequestContext>[0],
): Promise<{ context: RequestContext } | null> {
  const user = await db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", SERVICE_EMAIL))
    .first();
  if (user === null) {
    return null;
  }
  const session = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", user._id))
    .order("desc")
    .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
    .first();
  if (session === null) {
    return null;
  }
  const context = await resolveRequestContext(db, bridgeIdentity(session._id, Date.now()));
  return context === null ? null : { context };
}

/** Ensures one project in the service company (guarded; idempotent by name). */
export const seedProject = internalMutation({
  args: { displayName: v.string() },
  handler: async (ctx, args) => {
    const resolved = await serviceContext(ctx.db);
    if (resolved === null) {
      return unavailable();
    }
    const companyId = ctx.db.normalizeId("companies", resolved.context.actor.companyId);
    if (companyId === null) {
      return unavailable();
    }
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
      .filter((q) => q.eq(q.field("displayName"), args.displayName))
      .first();
    if (existing !== null) {
      return okResult({ projectId: existing._id, companyId });
    }
    const projectId = await ctx.db.insert("projects", {
      companyId,
      displayName: args.displayName,
      stage: "inquiry",
      stageRevision: 1,
      createdAtMs: Date.now(),
    });
    return okResult({ projectId, companyId });
  },
});

export const probeSeedProject = action({
  args: { displayName: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.accept.probe.seedProject, {
      displayName: args.displayName,
    });
  },
});

/** Ensures a fresh draft upload owned by the service user (guarded). */
export const seedUpload = internalMutation({
  args: {},
  handler: async (ctx) => {
    const resolved = await serviceContext(ctx.db);
    if (resolved === null) {
      return unavailable();
    }
    const companyId = ctx.db.normalizeId("companies", resolved.context.actor.companyId);
    const userId = ctx.db.normalizeId("users", resolved.context.actor.userId);
    if (companyId === null || userId === null) {
      return unavailable();
    }
    const uploadId = await ctx.db.insert("uploads", {
      companyId,
      userId,
      stage: "draft",
      partCount: 0,
      createdAtMs: Date.now(),
    });
    return okResult({ uploadId });
  },
});

export const probeSeedUpload = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.accept.probe.seedUpload, {});
  },
});

/**
 * Ensures the second company fixture: user, active membership, session, one
 * project and one draft upload — all owned by company B (guarded).
 */
export const seedIsolation = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", ISOLATION_EMAIL))
      .first();
    const userId =
      existingUser?._id ??
      (await ctx.db.insert("users", {
        email: ISOLATION_EMAIL,
        displayName: "D1 isolation proof",
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
    const membershipId =
      existingMembership?._id ??
      (await ctx.db.insert("memberships", {
        companyId,
        userId,
        role: "admin",
        state: "active",
        createdAtMs: Date.now(),
      }));
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
        deviceLabel: "d1-isolation-bridge",
      }));
    const existingProject = await ctx.db
      .query("projects")
      .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
      .first();
    const projectId =
      existingProject?._id ??
      (await ctx.db.insert("projects", {
        companyId,
        displayName: "Projekt izolacji D1",
        stage: "inquiry",
        stageRevision: 1,
        createdAtMs: Date.now(),
      }));
    const existingUpload = await ctx.db
      .query("uploads")
      .withIndex("by_company_stage", (q) => q.eq("companyId", companyId).eq("stage", "draft"))
      .first();
    const uploadId =
      existingUpload?._id ??
      (await ctx.db.insert("uploads", {
        companyId,
        userId,
        stage: "draft",
        partCount: 0,
        createdAtMs: Date.now(),
      }));
    return okResult({
      companyId,
      userId,
      membershipId,
      sessionId,
      projectId,
      uploadId,
    });
  },
});

export const probeSeedIsolation = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.sources.accept.probe.seedIsolation, {});
  },
});

// --- inspection ------------------------------------------------------------------

/** Tenant-scoped acceptance state for the evidence scripts (guarded read). */
export const acceptanceState = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const context = await resolveRequestContext(ctx.db, bridgeIdentity(args.serviceSessionId, Date.now()));
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_company_order", (q) => q.eq("companyId", companyId))
      .order("desc")
      .collect();
    const links: { sourceId: string; projectId: string; sentAtMs: number }[] = [];
    const runs: { sourceId: string; state: string; kind: string }[] = [];
    for (const source of sources) {
      const sourceLinks = await ctx.db
        .query("sourceProjectLinks")
        .withIndex("by_source", (q) => q.eq("sourceId", source._id))
        .collect();
      for (const link of sourceLinks) {
        links.push({ sourceId: link.sourceId, projectId: link.projectId, sentAtMs: link.sentAtMs });
      }
      const latestRun = await ctx.db
        .query("processingRuns")
        .withIndex("by_source_started", (q) => q.eq("sourceId", source._id))
        .order("desc")
        .first();
      if (latestRun !== null) {
        runs.push({ sourceId: source._id, state: latestRun.state, kind: latestRun.kind });
      }
    }
    const events = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const jobs = await ctx.db
      .query("durableJobs")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return okResult({
      sources: sources.map((source) => ({
        sourceId: source._id,
        authorText: source.authorText.slice(0, 60),
        sentAtMs: source.sentAtMs,
        sentAtTimezone: source.sentAtTimezone,
        fullyAcceptedAtMs: source.fullyAcceptedAtMs,
        lifecycle: source.lifecycle,
        ...(source.acceptanceKey === undefined ? {} : { acceptanceKey: source.acceptanceKey }),
      })),
      links,
      runs,
      events: events.map((row) => ({
        eventId: row.eventId,
        eventName: row.eventName,
        deliveryState: row.deliveryState,
        ...(row.dedupKey === undefined ? {} : { dedupKey: row.dedupKey }),
        ...(row.lastErrorKind === undefined ? {} : { lastErrorKind: row.lastErrorKind }),
      })),
      jobs: jobs.map((job) => ({
        jobKey: job.jobKey,
        kind: job.kind,
        state: job.state,
        attempts: job.attempts,
        ...(job.lastErrorKind === undefined ? {} : { lastErrorKind: job.lastErrorKind }),
        ...(job.dedupKey === undefined ? {} : { dedupKey: job.dedupKey }),
      })),
    });
  },
});

export const probeAcceptanceState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = args.sessionId ?? (await serviceSessionId(ctx));
    if (sessionId === null) {
      return unavailable();
    }
    return ctx.runQuery(internal.sources.accept.probe.acceptanceState, {
      serviceSessionId: sessionId,
    });
  },
});
