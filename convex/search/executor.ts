/**
 * The derived-search durable executor (E5): `search.index_generation`.
 *
 * Modes (the one closed input the registry owns):
 * - `build`: the full generation pass `search.startIndexGeneration` registers.
 *   The transactional half validates the generation and hands the effect to
 *   the external ACTION (the echo external-outcome protocol): the embedding
 *   pass is a provider call and never runs inside the committing
 *   transaction. The action collects the work, embeds what it can through
 *   E2's adapter, and records the batch through the write authority
 *   (./records.ts), which re-validates dimensions and tenant linkage and
 *   FAILS THE INDEX WRITE on wrong-dimension or malformed vectors.
 * - `refresh_source` (withdrawal/purge drain): drops the source's derived
 *   rows in the same transaction; no provider call.
 * - `refresh_finding` (revision drain): rebuilds the finding's rows from its
 *   CURRENT revision through the same external pass; a finding with no
 *   current projection keeps only the delete.
 *
 * Embedding outage discipline (issue #39): a provider failure classified as
 * an outage (deadline, connection, rate limit, unavailability, or no key at
 * all) does NOT fail the build; the affected rows commit text-only and the
 * query-side coverage literal discloses the semantic gap. Only incompatible
 * OUTPUT (`output_rejected`: a vector that did not decode, or decodes to the
 * wrong shape) fails the index write. Absence of an embedding is never a
 * silent semantic claim.
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { executors } from "@kiero/contracts";
import { runEmbedding, type OpenRouterCredentials } from "@kiero/providers";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { DurableJobDoc, JobExecutor, JobOutcome } from "../platform/executors";
import {
  collectFindingWork,
  collectGenerationWork,
  type CollectStats,
  type EntryDraft,
} from "./collect";
import { deleteFindingEntries, deleteSourceEntries, type IndexRowInput } from "./records";

/** The registered executor for `search.index_generation`. */
export const searchIndexExecutor: JobExecutor = {
  jobKind: "search.index_generation",
  execute: async (ctx: MutationCtx, job: DurableJobDoc, input: unknown): Promise<JobOutcome> => {
    const entry = executors.find((candidate) => candidate.jobKind === job.kind);
    if (entry === undefined) {
      return { outcome: "failed", errorKind: "executor_not_registered", retryable: false };
    }
    let decoded: {
      generationId: string | null;
      mode: "build" | "refresh_source" | "refresh_finding";
      sourceId: string | null;
      findingId: string | null;
    };
    try {
      decoded = Schema.decodeUnknownSync(entry.input)(input) as {
        generationId: string | null;
        mode: "build" | "refresh_source" | "refresh_finding";
        sourceId: string | null;
        findingId: string | null;
      };
    } catch {
      return { outcome: "failed", errorKind: "job_input_rejected", retryable: false };
    }
    if (decoded.mode === "refresh_source") {
      if (decoded.sourceId === null) {
        return { outcome: "failed", errorKind: "source_missing", retryable: false };
      }
      const sourceId = ctx.db.normalizeId("sources", decoded.sourceId);
      if (sourceId === null) {
        return { outcome: "failed", errorKind: "source_id_invalid", retryable: false };
      }
      await deleteSourceEntries(ctx, sourceId);
      return { outcome: "succeeded" };
    }
    if (decoded.mode === "refresh_finding") {
      if (decoded.findingId === null) {
        return { outcome: "failed", errorKind: "finding_missing", retryable: false };
      }
      const findingId = ctx.db.normalizeId("findings", decoded.findingId);
      if (findingId === null) {
        return { outcome: "failed", errorKind: "finding_id_invalid", retryable: false };
      }
      const finding = await ctx.db.get(findingId);
      if (finding === null || finding.currentRevisionId === undefined) {
        // No current projection: the derived rows only go away.
        await deleteFindingEntries(ctx, findingId);
        return { outcome: "succeeded" };
      }
      await deleteFindingEntries(ctx, findingId);
      return { outcome: "external", action: internal.search.executor.runIndexPass };
    }
    // build
    if (decoded.generationId === null) {
      return { outcome: "failed", errorKind: "generation_missing", retryable: false };
    }
    const generationId = ctx.db.normalizeId("searchIndexGenerations", decoded.generationId);
    if (generationId === null) {
      return { outcome: "failed", errorKind: "generation_id_invalid", retryable: false };
    }
    const generation = await ctx.db.get(generationId);
    if (generation === null) {
      return { outcome: "failed", errorKind: "generation_not_found", retryable: false };
    }
    if (generation.state !== "building") {
      return { outcome: "failed", errorKind: "generation_not_building", retryable: false };
    }
    return { outcome: "external", action: internal.search.executor.runIndexPass };
  },
};

/** What one external pass collected for its job. */
export interface IndexPassWork {
  readonly mode: "build" | "refresh_finding";
  readonly drafts: readonly EntryDraft[];
  readonly stats: CollectStats | null;
  /** Draft keys that already carry an embedding (skipped by the pass). */
  readonly alreadyEmbedded: readonly string[];
}

/** Loads one job's index work (the action's read half; actions have no db). */
export const indexWork = internalQuery({
  args: { jobKey: v.string() },
  handler: async (ctx, args): Promise<
    { readonly ok: true; readonly work: IndexPassWork } | { readonly ok: false; readonly errorKind: string }
  > => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null) {
      return { ok: false, errorKind: "job_not_found" };
    }
    const entry = executors.find((candidate) => candidate.jobKind === job.kind);
    if (entry === undefined) {
      return { ok: false, errorKind: "executor_not_registered" };
    }
    let decoded: {
      generationId: string | null;
      mode: string;
      findingId: string | null;
    };
    try {
      decoded = Schema.decodeUnknownSync(entry.input)(JSON.parse(job.inputJson)) as {
        generationId: string | null;
        mode: string;
        findingId: string | null;
      };
    } catch {
      return { ok: false, errorKind: "job_input_rejected" };
    }
    if (decoded.mode === "build") {
      if (decoded.generationId === null) {
        return { ok: false, errorKind: "generation_missing" };
      }
      const generationId = ctx.db.normalizeId("searchIndexGenerations", decoded.generationId);
      if (generationId === null) {
        return { ok: false, errorKind: "generation_id_invalid" };
      }
      const collected = await collectGenerationWork(ctx.db, generationId);
      const existing = await ctx.db
        .query("searchEntries")
        .withIndex("by_generation", (q) => q.eq("generationId", generationId))
        .collect();
      return {
        ok: true,
        work: {
          mode: "build",
          drafts: collected.drafts,
          stats: collected.stats,
          alreadyEmbedded: existing
            .filter((row) => row.embedding !== undefined)
            .map((row) => draftKeyOf(row)),
        },
      };
    }
    if (decoded.mode === "refresh_finding") {
      if (decoded.findingId === null) {
        return { ok: false, errorKind: "finding_missing" };
      }
      const findingId = ctx.db.normalizeId("findings", decoded.findingId);
      if (findingId === null) {
        return { ok: false, errorKind: "finding_id_invalid" };
      }
      const drafts = await collectFindingWork(ctx.db, findingId);
      return {
        ok: true,
        work: { mode: "refresh_finding", drafts, stats: null, alreadyEmbedded: [] },
      };
    }
    return { ok: false, errorKind: "mode_unsupported" };
  },
});

/**
 * The ONE keying rule for index-entry drafts and rows (review round 1: it
 * lived in three functions): fragment identity first, then finding, then
 * the source-only entry.
 */
export function draftKeyOf(input: {
  readonly sourceFragmentId?: string;
  readonly findingId?: string;
  readonly sourceId?: string;
  readonly generationId?: string;
  readonly companyId?: string;
}): string {
  return input.sourceFragmentId !== undefined
    ? `fragment:${input.sourceFragmentId}`
    : input.findingId !== undefined
      ? `finding:${input.findingId}`
      : `source:${input.sourceId ?? ""}`;
}

/** Reads the server-held OpenRouter key; presence only, never its value. */
function openRouterCredentials(): OpenRouterCredentials | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return null;
  }
  return { apiKey };
}

/** Records a typed terminal failure from the external half. */
export const failJob = internalMutation({
  args: { jobKey: v.string(), errorKind: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null || job.state === "succeeded" || job.state === "cancelled") {
      return;
    }
    await ctx.db.patch(job._id, {
      state: "failed",
      externalOutcome: "failed",
      lastErrorKind: args.errorKind,
      updatedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
  },
});

/** The external embedding pass and batch record (the scheduled action). */
export const runIndexPass = internalAction({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.search.executor.indexWork, { jobKey: args.jobKey });
    if (!loaded.ok) {
      await ctx.runMutation(internal.search.executor.failJob, {
        jobKey: args.jobKey,
        errorKind: loaded.errorKind,
      });
      return;
    }
    const credentials = openRouterCredentials();
    const embedded = new Set(loaded.work.alreadyEmbedded);
    const rows: IndexRowInput[] = [];
    for (const draft of loaded.work.drafts) {
      const row: IndexRowInput = {
        generationId: draft.generationId,
        companyId: draft.companyId,
        ...(draft.sourceFragmentId === undefined ? {} : { sourceFragmentId: draft.sourceFragmentId }),
        ...(draft.sourceId === undefined ? {} : { sourceId: draft.sourceId }),
        ...(draft.findingId === undefined ? {} : { findingId: draft.findingId }),
        ...(draft.findingRevisionId === undefined
          ? {}
          : { findingRevisionId: draft.findingRevisionId }),
        preparedText: draft.preparedText,
      };
      if (credentials !== null && !embedded.has(draftKeyOf(draft))) {
        const call = await runEmbedding(credentials, {
          text: draft.preparedText,
          inputKind: "search_document",
        });
        if (call.outcome.outcome === "succeeded") {
          row.embedding = [...call.outcome.value.vector];
        } else if (call.outcome.failure.kind === "output_rejected") {
          // Incompatible provider output fails the index write: nothing
          // commits for this pass and the job records the typed failure.
          await ctx.runMutation(internal.search.executor.failJob, {
            jobKey: args.jobKey,
            errorKind: "embedding_output_rejected",
          });
          return;
        }
        // Any other failure is an outage: the row stays text-only and the
        // query-side coverage literal discloses the semantic gap.
      }
      rows.push(row);
    }
    await ctx.runMutation(internal.search.records.recordEntries, {
      jobKey: args.jobKey,
      rows,
    });
  },
});

/** Exposed for the focused unit tests: the draft key derivation. */
/** Narrow type re-export so tests pin the Convex id branding. */
export type SearchEntryDoc = Doc<"searchEntries">;
export type GenerationId = Id<"searchIndexGenerations">;
