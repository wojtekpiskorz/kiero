/**
 * E5 guarded dev proofs (the A3 probe pattern; KIERO_PROBE_ENABLED plus this
 * lane's own KIERO_E5_PROOF_ENABLED for the fixtures that write rows).
 *
 * Every action resolves the default service session (or an explicitly seeded
 * one) and runs the SAME checked dispatch or internal entry production uses:
 * no development-auth shortcut, no client-supplied identity. The fixture
 * seeds (the second-company isolation fixture and the minimal STT transcript
 * fixture) follow the D1 seeding precedent: server-side rows, honestly
 * labeled, never reachable as client inputs.
 *
 * `probeInjectEmbedding` is the wrong-dimension focused verification: it
 * drives a fabricated vector through the REAL index-write mutation and
 * returns the typed failure, proving the write boundary refuses incompatible
 * vectors (nothing commits, the job records the typed error).
 */

import { v } from "convex/values";
import { Schema } from "effect";
import {
  CommandEnvelope,
  newDurableJobKey,
  okResult,
  errorResult,
  searchOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import { forbiddenError, unsupportedError } from "@kiero/runtime";
import { action, internalMutation, internalQuery } from "../_generated/server";
import { internal, api } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
  SERVICE_EMAIL,
} from "../sources/probe_shared";
import { dispatchSearchQueryCommand } from "./dispatch";
import { runEvidenceQuery } from "./query";
import type { ScopedContext } from "./views";
import type { IndexRowInput } from "./records";

/** The E5 tenant-isolation fixture account (seeded by ./probeSeedIsolation). */
export const ISOLATION_EMAIL = "e5-isolation@kiero.invalid";

/** The E5 tenant-isolation fixture company name. */
export const ISOLATION_COMPANY = "Kiero Dev Proof E5 (search isolation)";

/** This lane's own fixture guard (writes labeled proof rows). */
function fixturesEnabled(): boolean {
  return process.env.KIERO_E5_PROOF_ENABLED === "1";
}

const fixturesDisabled = (): ResultEnvelope =>
  errorResult(unsupportedError("search.probe", "e5_fixtures_disabled"));

// --- checked-path drives -------------------------------------------------------

/** Dispatches one search lifecycle envelope (guarded; service or seeded session). */
export const probeSearchCommand = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.search.commands.searchLifecycleTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/**
 * Dispatches one `search.queryEvidence` envelope through the checked action
 * path (the service or explicitly seeded session; the user path stays the
 * public `search/commands:queryEvidence` action). `simulateEmbeddingOutage`
 * skips ONLY the provider call inside the same query core (a clearly-labeled
 * proof facility for the outage coverage disclosure; the production path
 * never skips it).
 */
export const probeQueryEvidence = action({
  args: {
    envelope: v.any(),
    sessionId: v.optional(v.string()),
    simulateEmbeddingOutage: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    if (args.simulateEmbeddingOutage === true) {
      const context = await ctx.runQuery(internal.search.views.serviceContext, {
        serviceSessionId: sessionId,
      });
      if (context === null) {
        return serviceIdentityUnavailable();
      }
      const command = Schema.decodeUnknownSync(CommandEnvelope)(args.envelope);
      const decoded = Schema.decodeUnknownSync(
        searchOperations["search.queryEvidence"].input,
      )(command.input);
      return runEvidenceQuery(ctx, context, decoded, { simulateEmbeddingOutage: true });
    }
    return dispatchSearchQueryCommand(ctx, args.envelope, sessionId);
  },
});

// --- fixtures -------------------------------------------------------------------

/** Ensures the second-company fixture: user, membership, session, project, upload. */
export const seedIsolation = internalMutation({
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
        displayName: "E5 search isolation proof",
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
    // `.first()` returns null for an empty range, never undefined.
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
        deviceLabel: "e5-isolation-bridge",
      }));
    const existingProject = await ctx.db
      .query("projects")
      .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
      .first();
    const projectId =
      existingProject?._id ??
      (await ctx.db.insert("projects", {
        companyId,
        displayName: "Projekt izolacji E5",
        stage: "inquiry",
        stageRevision: 1,
        createdAtMs: Date.now(),
      }));
    const uploadId = await ctx.db.insert("uploads", {
      companyId,
      userId,
      stage: "draft",
      partCount: 0,
      createdAtMs: Date.now(),
    });
    return okResult({ companyId, userId, sessionId, projectId, uploadId });
  },
});

export const probeSeedIsolation = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled() || !fixturesEnabled()) {
      return fixturesDisabled();
    }
    return ctx.runMutation(internal.search.probe.seedIsolation, {});
  },
});

/**
 * Seeds the minimal COMPLETED STT fixture for one source (the D6 tables with
 * honestly-labeled proof metadata): upload, audio attachment, representation,
 * the stt extraction version on the source's analysis run, the complete
 * transcript order, two verbatim Polish segments and their audio-interval
 * fragments. This makes the live index actually cover transcript text
 * through the real collection path.
 */
export const seedTranscript = internalMutation({
  args: { sourceId: v.id("sources"), firstText: v.string(), secondText: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    const run = await ctx.db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", args.sourceId))
      .order("desc")
      .first();
    if (run === null) {
      return errorResult(unsupportedError("search.probe", "processing_run_missing"));
    }
    const uploadId = await ctx.db.insert("uploads", {
      companyId: source.companyId,
      userId: source.authorUserId,
      stage: "finalized",
      partCount: 1,
      finalizedAtMs: Date.now(),
      acceptedSourceId: args.sourceId,
      createdAtMs: Date.now(),
    });
    const attachmentId = await ctx.db.insert("attachments", {
      uploadId,
      sourceId: args.sourceId,
      kind: "audio",
      objectKey: `e5-proof/${args.sourceId}`,
      createdAtMs: Date.now(),
      completedAtMs: Date.now(),
    });
    const representationId = await ctx.db.insert("mediaRepresentations", {
      attachmentId,
      role: "received",
      objectKey: `e5-proof/${args.sourceId}`,
      contentHash: "e5-proof",
      transformVersion: "e5-proof",
      durationMs: 2_000,
      createdAtMs: Date.now(),
    });
    const extractionId = await ctx.db.insert("extractions", {
      sourceId: args.sourceId,
      representationId,
      kind: "stt",
      pipelineVersion: "e5-proof-stt",
      model: "proof-stt",
      provider: "kiero-proof",
      processingRunId: run._id,
      createdAtMs: Date.now(),
    });
    const transcriptId = await ctx.db.insert("audioTranscripts", {
      companyId: source.companyId,
      sourceId: args.sourceId,
      attachmentId,
      representationId,
      processingRunId: run._id,
      pipelineVersion: "e5-proof-stt",
      sttRoutingVersion: "e5-proof",
      segmentationConfigJson: "{}",
      bytesChannel: "proof_inline",
      audioDurationMs: 2_000,
      manifestSha256: "e5-proof",
      segmentCount: 2,
      state: "complete",
      extractionId,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    const intervals = [
      { startMs: 0, endMs: 1_000, text: args.firstText },
      { startMs: 1_000, endMs: 2_000, text: args.secondText },
    ];
    for (const [index, interval] of intervals.entries()) {
      await ctx.db.insert("audioSegments", {
        transcriptId,
        segmentIndex: index,
        startMs: interval.startMs,
        endMs: interval.endMs,
        durationMs: interval.endMs - interval.startMs,
        state: "succeeded",
        attempts: 1,
        text: interval.text,
        provider: "kiero-proof",
        succeededAtMs: Date.now(),
      });
      await ctx.db.insert("sourceFragments", {
        extractionId,
        sourceId: args.sourceId,
        anchor: {
          _tag: "audio_interval",
          startMs: interval.startMs,
          endMs: interval.endMs,
        },
        createdAtMs: Date.now(),
      });
    }
    return okResult({ transcriptId, extractionId, attachmentId, representationId });
  },
});

export const probeSeedTranscript = action({
  args: {
    sourceId: v.id("sources"),
    firstText: v.string(),
    secondText: v.string(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled() || !fixturesEnabled()) {
      return fixturesDisabled();
    }
    return ctx.runMutation(internal.search.probe.seedTranscript, {
      sourceId: args.sourceId,
      firstText: args.firstText,
      secondText: args.secondText,
    });
  },
});

// --- the wrong-dimension injection (focused verification) ----------------------

/** Creates the probe job row the injection rides (honestly labeled). */
async function ensureProbeJob(ctx: ActionCtx, generationId: string): Promise<string | null> {
  const jobKey = newDurableJobKey();
  return ctx
    .runMutation(internal.search.probe.createProbeJob, { jobKey, generationId })
    .then(() => jobKey)
    .catch(() => null);
}

export const createProbeJob = internalMutation({
  args: { jobKey: v.string(), generationId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("durableJobs", {
      jobKey: args.jobKey,
      kind: "search.index_generation",
      inputJson: JSON.stringify({
        generationId: args.generationId,
        mode: "refresh_finding",
        sourceId: null,
        findingId: null,
      }),
      state: "running",
      attempts: 0,
      maxAttempts: 1,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    return okResult({ jobKey: args.jobKey });
  },
});

/**
 * Drives a fabricated embedding through the REAL write mutation: the typed
 * verdict (never a committed row) is the proof that wrong-dimension or
 * malformed vectors fail the index write. The before/after counts are the
 * same company+generation count the injection targets.
 */
export const probeInjectEmbedding = action({
  args: {
    generationId: v.id("searchIndexGenerations"),
    companyId: v.id("companies"),
    sourceId: v.id("sources"),
    dimensions: v.number(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled() || !fixturesEnabled()) {
      return fixturesDisabled();
    }
    const entriesBefore = await ctx.runQuery(internal.search.probe.probeEntryCount, {
      companyId: args.companyId,
      generationId: args.generationId,
    });
    const jobKey = await ensureProbeJob(ctx, args.generationId);
    if (jobKey === null) {
      return serviceIdentityUnavailable();
    }
    const vector = Array.from({ length: args.dimensions }, () => 0.5);
    const rows: IndexRowInput[] = [
      {
        generationId: args.generationId,
        companyId: args.companyId,
        sourceId: args.sourceId,
        preparedText: "wylewka probe",
        embedding: vector,
      },
    ];
    const outcome = await ctx.runMutation(internal.search.records.recordEntries, {
      jobKey,
      rows,
    });
    const entriesAfter = await ctx.runQuery(internal.search.probe.probeEntryCount, {
      companyId: args.companyId,
      generationId: args.generationId,
    });
    return okResult({ writeOutcome: outcome, entriesBefore, entriesAfter });
  },
});

// --- lane-state reset ------------------------------------------------------------

/**
 * Clears THIS LANE's disposable derived state (searchEntries, generations,
 * and the lane's own durable job rows). The index is derived data that is
 * never authority: resetting it is the rebuildability proof's own first
 * step, and only this lane's rows are touched.
 */
export const resetLaneState = internalMutation({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    let entries = 0;
    for (const row of await ctx.db.query("searchEntries").collect()) {
      await ctx.db.delete(row._id);
      entries += 1;
    }
    let generations = 0;
    for (const row of await ctx.db.query("searchIndexGenerations").collect()) {
      await ctx.db.delete(row._id);
      generations += 1;
    }
    let jobs = 0;
    const laneJobs = await ctx.db
      .query("durableJobs")
      .withIndex("by_kind_state", (q) => q.eq("kind", "search.index_generation"))
      .collect();
    for (const row of laneJobs) {
      await ctx.db.delete(row._id);
      jobs += 1;
    }
    return okResult({ entries, generations, jobs });
  },
});

export const probeResetLaneState = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled() || !fixturesEnabled()) {
      return fixturesDisabled();
    }
    return ctx.runMutation(internal.search.probe.resetLaneState, {});
  },
});

// --- inspection ------------------------------------------------------------------

/** The counting result for the injection proof. */
export interface EntryCountResult {
  readonly total: number;
  readonly embedded: number;
  readonly fragments: number;
  readonly findings: number;
}

/** Counting query for the injection proof (company+generation scope). */
export const probeEntryCount = internalQuery({
  args: { companyId: v.id("companies"), generationId: v.id("searchIndexGenerations") },
  handler: async (ctx, args): Promise<EntryCountResult> => {
    const rows = await ctx.db
      .query("searchEntries")
      .withIndex("by_company_generation", (q) =>
        q.eq("companyId", args.companyId).eq("generationId", args.generationId),
      )
      .collect();
    return {
      total: rows.length,
      embedded: rows.filter((row) => row.embedding !== undefined).length,
      fragments: rows.filter((row) => row.sourceFragmentId !== undefined).length,
      findings: rows.filter((row) => row.findingId !== undefined).length,
    };
  },
});

/** Sanitized generation row for the evidence read. */
export interface GenerationStateRow {
  readonly generationId: string;
  readonly state: string;
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly textPreparationVersion: string;
  readonly providerRouteVersion: string;
  readonly createdAtMs: number;
  readonly activatedAtMs: number | null;
  readonly retiredAtMs: number | null;
}

/** Sanitized search job row for the evidence read. */
export interface SearchJobStateRow {
  readonly jobKey: string;
  readonly state: string;
  readonly externalOutcome: string | null;
  readonly lastErrorKind: string | null;
  readonly dedupKey: string | null;
  readonly attempts: number;
}

/** The sanitized index state (counts only; no prepared texts, no vectors). */
export interface SearchStateResult {
  readonly generations: GenerationStateRow[];
  readonly jobs: SearchJobStateRow[];
  readonly entriesByCompany: {
    readonly companyId: string;
    readonly total: number;
    readonly embedded: number;
  }[];
}

/** Sanitized index state for the evidence script (guarded read). */
export const searchState = internalQuery({
  args: {},
  handler: async (ctx): Promise<SearchStateResult> => {
    const generations = await ctx.db.query("searchIndexGenerations").collect();
    const jobs = await ctx.db
      .query("durableJobs")
      .withIndex("by_kind_state", (q) =>
        q.eq("kind", "search.index_generation"),
      )
      .collect();
    const entries = await ctx.db.query("searchEntries").collect();
    const byCompany = new Map<string, { total: number; embedded: number }>();
    for (const row of entries) {
      const current = byCompany.get(row.companyId) ?? { total: 0, embedded: 0 };
      current.total += 1;
      if (row.embedding !== undefined) {
        current.embedded += 1;
      }
      byCompany.set(row.companyId, current);
    }
    return {
      generations: generations
        .map((generation) => ({
          generationId: generation._id,
          state: generation.state,
          embeddingModel: generation.embeddingModel,
          dimensions: generation.dimensions,
          textPreparationVersion: generation.textPreparationVersion,
          providerRouteVersion: generation.providerRouteVersion,
          createdAtMs: generation.createdAtMs,
          activatedAtMs: generation.activatedAtMs ?? null,
          retiredAtMs: generation.retiredAtMs ?? null,
        }))
        .sort((a, b) => a.createdAtMs - b.createdAtMs),
      jobs: jobs.map((job) => ({
        jobKey: job.jobKey,
        state: job.state,
        externalOutcome: job.externalOutcome ?? null,
        lastErrorKind: job.lastErrorKind ?? null,
        dedupKey: job.dedupKey ?? null,
        attempts: job.attempts,
      })),
      entriesByCompany: [...byCompany.entries()].map(([companyId, counts]) => ({
        companyId,
        total: counts.total,
        embedded: counts.embedded,
      })),
    };
  },
});

export const probeSearchState = action({
  args: {},
  handler: async (ctx): Promise<SearchStateResult | ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.search.probe.searchState, {});
  },
});

/** Resolves the service account's context (the default probe identity). */
export const probeServiceScope = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const session = await ctx.runQuery(api.platform.probe.serviceSession, {});
    if (session === null) {
      return serviceIdentityUnavailable();
    }
    const context: ScopedContext | null = await ctx.runQuery(
      internal.search.views.serviceContext,
      { serviceSessionId: session.sessionId },
    );
    if (context === null || context.normalizedCompanyId === null) {
      return serviceIdentityUnavailable();
    }
    return okResult({
      companyId: context.normalizedCompanyId,
      userId: context.actor.userId,
      email: SERVICE_EMAIL,
    });
  },
});
