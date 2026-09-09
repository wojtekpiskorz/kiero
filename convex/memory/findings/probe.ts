/**
 * C2 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the A3 platform probes and the D1 sources probes;
 * shared plumbing imported from convex/sources/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the C2 evidence can
 * run against the REAL dev deployment without a development-auth shortcut:
 * the actor is always the service account's own session (the A3
 * service-bridge identity) or an explicitly seeded second-company session,
 * resolved through the SAME canonical resolution and authorization seam as
 * production calls. Sessions are created server-side here; no identity is
 * ever accepted from client input.
 *
 * - `probeMemoryCommand`: dispatches one memory envelope through the checked
 *   path with the service identity (or a seeded session).
 * - `probeReadCurrentFindings`: the tenant-scoped current read.
 * - `probeResolveRelativeDay`: runs the deployed pure temporal resolver.
 * - `probeCrashPublish`: performs the FULL publish transaction and then
 *   THROWS before commit (the D1 no-orphan pattern), proving rollback of
 *   revisions, provenance, projection, group state and events together.
 * - `probeSeedMemoryFixtures` / `probeSeedMemoryIsolation`: idempotent
 *   fixtures (two witnessed sources with text extractions and fragments in
 *   the service company; a whole second company with its own session and
 *   source for tenant isolation).
 * - `probeWithdrawSource` / `probeMarkWithdrawn`: the explicit withdrawal
 *   transition and the marking core.
 * - `probeMemoryState`: the tenant-scoped inspection read the evidence
 *   script asserts on.
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { resolveRelativeDay } from "@kiero/domain";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import {
  ISOLATION_COMPANY,
  ISOLATION_EMAIL,
  SERVICE_EMAIL,
  bridgeContextForEmail,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../../sources/probe_shared";
import { dispatchMemoryCommand } from "./dispatch";
import { readCurrentFindingsEntry } from "./semantics";
import { readCurrentFindingsRows } from "./read";

const PROOF_TZ = "Europe/Warsaw";
const PROOF_SENT_AT_MS = Date.parse("2026-09-08T16:30:00.000Z"); // 18:30 Warsaw
const PROOF_PIPELINE_VERSION = "c2.proof/1";

function probeGuardEnabled(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

function probeDisabled(): ResultEnvelope {
  return errorResult(unsupportedError("memory.findings.probe", "probe_guard_disabled"));
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
    const extraction =
      fragment === null
        ? null
        : await db.get(fragment.extractionId);
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
    acceptanceFingerprint: `c2-proof:${acceptanceKey}`,
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

/** Seeds the service company's two witnessed proof sources (guarded). */
export const seedMemoryFixtures = internalMutation({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const context = await bridgeContextForEmail(ctx.db, SERVICE_EMAIL);
    if (context === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    const userId = ctx.db.normalizeId("users", context.actor.userId);
    if (companyId === null || userId === null) {
      return serviceIdentityUnavailable();
    }
    const first = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      "c2-proof-s1",
      "Termin dostawy płytek na Buniewice — jutro; cena 10 tysięcy.",
    );
    const second = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      "c2-proof-s2",
      "Potwierdzam termin dostawy płytek na Buniewice.",
    );
    return okResult({ companyId, ...first, secondSourceId: second.sourceId, secondFragmentId: second.fragmentId });
  },
});

export const probeSeedMemoryFixtures = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.memory.findings.probe.seedMemoryFixtures, {});
  },
});

/**
 * Ensures the second-company fixture: user, active membership, session and
 * one witnessed source — all owned by company B (guarded).
 */
export const seedMemoryIsolation = internalMutation({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", ISOLATION_EMAIL))
      .first();
    const userId =
      existingUser?._id ??
      (await ctx.db.insert("users", {
        email: ISOLATION_EMAIL,
        displayName: "C2 isolation proof",
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
    // load-bearing — `=== undefined` would silently skip the insert and the
    // seeded session could never resolve a membership.
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
        deviceLabel: "c2-isolation-bridge",
      }));
    const source = await ensureWitnessedSource(
      ctx.db,
      companyId,
      userId,
      "c2-proof-isolation",
      "Wiadomość drugiej firmy (dowód izolacji).",
    );
    return okResult({ companyId, userId, sessionId, ...source });
  },
});

export const probeSeedMemoryIsolation = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.memory.findings.probe.seedMemoryIsolation, {});
  },
});

// --- checked-path probes ---------------------------------------------------------

/** Dispatches one memory envelope as the service identity (guarded). */
export const probeMemoryCommand = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.memory.findings.functions.dispatchMemoryTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/** The guarded current-memory read (scope decoded through the contract). */
export const readState = internalQuery({
  args: { serviceSessionId: v.string(), scope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return serviceIdentityUnavailable();
    }
    const decoded = Schema.decodeUnknownSync(readCurrentFindingsEntry.input)({
      scope: args.scope,
    });
    const rows = await readCurrentFindingsRows(ctx.db, context, decoded);
    return rows.ok ? okResult({ rows: rows.rows }) : errorResult(rows.error);
  },
});

export const probeReadCurrentFindings = action({
  args: { scope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.memory.findings.probe.readState, {
      serviceSessionId: sessionId,
      scope: args.scope,
    });
  },
});

/** Runs the deployed pure temporal resolver (guarded; no state touched). */
export const probeResolveRelativeDay = action({
  args: { expression: v.string(), sentAtMs: v.float64(), timezone: v.string() },
  handler: async (_ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const resolution = resolveRelativeDay(args.expression, args.sentAtMs, args.timezone);
    return okResult({ ...resolution });
  },
});

// --- crash and withdrawal proofs -------------------------------------------------

/**
 * The guarded crash mutation: FULL publish, then a deliberate throw so the
 * whole transaction rolls back (revisions, evidence, dependencies, current
 * projection, group state and events together — the no-partial-group
 * proof).
 */
export const crashPublish = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const result = await dispatchMemoryCommand(ctx, args.envelope, args.serviceSessionId);
    if (result._tag === "error") {
      return result; // the publish itself refused; nothing was committed
    }
    throw new Error("probe: deliberate failure after publish commit writes");
  },
});

export const probeCrashPublish = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.memory.findings.probe.crashPublish, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/** The explicit withdrawal lifecycle transition (guarded dev fixture). */
export const withdrawSource = internalMutation({
  args: { sourceId: v.string(), reason: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const sourceId = ctx.db.normalizeId("sources", args.sourceId);
    if (sourceId === null) {
      return errorResult(unsupportedError("memory.findings.probe", "source_id_malformed"));
    }
    await ctx.db.patch(sourceId, {
      lifecycle: "withdrawn",
      withdrawnReason: args.reason,
      withdrawnAtMs: Date.now(),
    });
    return okResult({ withdrawn: true });
  },
});

export const probeWithdrawSource = action({
  args: { sourceId: v.string(), reason: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.memory.findings.probe.withdrawSource, {
      sourceId: args.sourceId,
      reason: args.reason,
    });
  },
});

/** Runs the withdrawal marking core as the service identity (guarded). */
export const probeMarkWithdrawn = action({
  args: { sourceId: v.string(), reason: v.string(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.memory.findings.functions.markWithdrawnSource, {
      sourceId: args.sourceId,
      reason: args.reason,
      serviceSessionId: sessionId,
    });
  },
});

// --- inspection --------------------------------------------------------------------

/** Tenant-scoped findings state for the evidence script (guarded read). */
export const memoryState = internalQuery({
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
        const links = await ctx.db
          .query("evidenceLinks")
          .withIndex("by_revision", (q) => q.eq("findingRevisionId", revision._id))
          .collect();
        revisionRows.push({
          findingId: finding._id,
          revisionId: revision._id,
          revision: revision.revision,
          semanticKey: finding.semanticKey,
          scopeKind: finding.scopeKind,
          value: revision.value,
          knowledgeState: revision.knowledgeState,
          origin: revision.origin,
          reason: revision.reason ?? null,
          supersedesRevisionId: revision.supersedesRevisionId ?? null,
          provenanceSourceId: revision.provenance?.sourceId ?? null,
          recordedByUserId: revision.recordedByUserId,
          evidence: links.map((link) => ({
            sourceId: link.sourceId,
            sourceFragmentId: link.sourceFragmentId ?? null,
            supportKind: link.supportKind,
          })),
        });
      }
    }
    const dependencies = await ctx.db
      .query("findingDependencies")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const changeSets = await ctx.db
      .query("changeSets")
      .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
      .collect();
    const groups = [];
    for (const changeSet of changeSets) {
      const groupRows = await ctx.db
        .query("publicationGroups")
        .withIndex("by_change_set", (q) => q.eq("changeSetId", changeSet._id))
        .collect();
      for (const group of groupRows) {
        groups.push({
          changeSetId: changeSet._id,
          state: group.state,
          memberRevisionIds: group.memberRevisionIds ?? [],
          expectedRevisions: group.expectedRevisions,
          plannedCount: group.plannedChanges.length,
        });
      }
    }
    const events = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    return okResult({
      findings: findings.map((finding) => ({
        findingId: finding._id,
        semanticKey: finding.semanticKey,
        scopeKind: finding.scopeKind,
        currentRevisionId: finding.currentRevisionId ?? null,
        knowledgeState: finding.knowledgeState,
        revisionCounter: finding.revisionCounter,
      })),
      revisions: revisionRows,
      dependencies: dependencies.map((row) => ({
        dependentFindingId: row.dependentFindingId,
        dependsOnFindingId: row.dependsOnFindingId,
        cause: row.cause,
      })),
      changeSets: changeSets.map((row) => ({
        changeSetId: row._id,
        state: row.state,
        failedReason: row.failedReason ?? null,
        publishedAtMs: row.publishedAtMs ?? null,
      })),
      groups,
      memoryEvents: events
        .filter((row) => row.eventName.startsWith("memory."))
        .map((row) => ({ eventName: row.eventName, deliveryState: row.deliveryState })),
    });
  },
});

export const probeMemoryState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.memory.findings.probe.memoryState, {
      serviceSessionId: sessionId,
    });
  },
});
