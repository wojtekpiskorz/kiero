/**
 * The `processing.extract_fragments` executor (E3): the durable reaction to
 * `sources.sourceAccepted` (the registered consumer edge this lane owns).
 *
 * D1's acceptance registers this job atomically with `{sourceId,
 * extractionId}` and seeds the text extraction row plus the initial
 * analysis run: the author's words are their own extraction (provider
 * `kiero`, model `author-text`), so text extraction is deterministic — no
 * model call happens here. The executor's contract work:
 *
 * - validate the source (an active source supports extraction; a withdrawn
 *   one fails honestly) and resolve the text extraction (the drain
 *   projection may hand `extractionId: null` when the event payload could
 *   not name it — exactly one text extraction exists per D1 source, and
 *   the executor resolves it in-company);
 * - record the extract step idempotently (insert-if-absent on run+sequence)
 *   and ensure the whole-source fragment exists (the honest fallback basis
 *   per CONTEXT.md: "Gdy nie da się wiarygodnie wskazać fragmentu,
 *   podstawą pozostaje cały materiał");
 * - register the FOLLOW-ON analysis job (`processing.analyze_change_plan`)
 *   for the same run, with a dedup identity derived from this job's, so a
 *   replay collapses instead of double-registering.
 *
 * Reanalysis runs skip this executor entirely: the reanalysis event's
 * consumer edge already names `processing.analyze_change_plan`.
 */

import { Schema } from "effect";
import { executors } from "@kiero/contracts";
import { registerDurableJob } from "../../platform/publish";
import type { JobExecutor } from "../../platform/executors";
import type { MutationCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";

/** The extract stage's sequence number inside the run. */
export const EXTRACT_STEP_SEQUENCE = 10;

/** The retry policy of the follow-on analysis registration. */
const ANALYSIS_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

/** Resolves the text extraction row of one source, in-company. */
async function resolveTextExtraction(
  db: MutationCtx["db"],
  source: Doc<"sources">,
  extractionRef: string | null,
): Promise<Id<"extractions"> | null> {
  if (extractionRef !== null) {
    const id = db.normalizeId("extractions", extractionRef);
    if (id === null) {
      return null;
    }
    const row = await db.get(id);
    if (row === null || row.sourceId !== source._id || row.kind !== "text") {
      return null;
    }
    return row._id;
  }
  const row = await db
    .query("extractions")
    .withIndex("by_source_kind", (q) =>
      q.eq("sourceId", source._id).eq("kind", "text"),
    )
    .first();
  return row?._id ?? null;
}

/** Records the extract step idempotently (journal-safe replay). */
async function recordExtractStep(
  db: MutationCtx["db"],
  runId: Id<"processingRuns">,
  extractionId: Id<"extractions">,
  fragmentId: Id<"sourceFragments">,
): Promise<void> {
  const existing = await db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) =>
      q.eq("runId", runId).eq("sequence", EXTRACT_STEP_SEQUENCE),
    )
    .first();
  if (existing !== null) {
    return;
  }
  await db.insert("processingSteps", {
    runId,
    stepKind: "extract_text",
    sequence: EXTRACT_STEP_SEQUENCE,
    state: "succeeded",
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
    outputRef: JSON.stringify({ extractionId, wholeSourceFragmentId: fragmentId }),
  });
}

/** Ensures the extraction's whole-source fragment exists (honest basis). */
async function ensureWholeSourceFragment(
  db: MutationCtx["db"],
  sourceId: Id<"sources">,
  extractionId: Id<"extractions">,
): Promise<Id<"sourceFragments">> {
  const fragments = await db
    .query("sourceFragments")
    .withIndex("by_extraction", (q) => q.eq("extractionId", extractionId))
    .collect();
  const whole = fragments.find(
    (fragment) => fragment.anchor._tag === "whole_source",
  );
  if (whole !== undefined) {
    return whole._id;
  }
  return db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor: { _tag: "whole_source" },
    createdAtMs: Date.now(),
  });
}

/** The registered executor for `processing.extract_fragments`. */
export const extractFragmentsExecutor: JobExecutor = {
  jobKind: "processing.extract_fragments",
  execute: async (ctx, job, input) => {
    const entry = executors.find((candidate) => candidate.jobKind === job.kind);
    if (entry === undefined) {
      return { outcome: "failed", errorKind: "executor_not_registered", retryable: false };
    }
    // Decode authority: the registry executor schema for this kind.
    let decoded: { sourceId: string; extractionId: string | null };
    try {
      decoded = Schema.decodeUnknownSync(entry.input)(input) as {
        sourceId: string;
        extractionId: string | null;
      };
    } catch {
      return { outcome: "failed", errorKind: "job_input_rejected", retryable: false };
    }
    const sourceId = ctx.db.normalizeId("sources", decoded.sourceId);
    if (sourceId === null) {
      return { outcome: "failed", errorKind: "source_id_invalid", retryable: false };
    }
    const source = await ctx.db.get(sourceId);
    if (source === null) {
      return { outcome: "failed", errorKind: "source_missing", retryable: false };
    }
    if (source.lifecycle !== "active") {
      // A withdrawn/purged source supports no extraction: honest, terminal.
      return { outcome: "failed", errorKind: "source_not_active", retryable: false };
    }
    const extractionId = await resolveTextExtraction(ctx.db, source, decoded.extractionId);
    if (extractionId === null) {
      return { outcome: "failed", errorKind: "text_extraction_missing", retryable: false };
    }
    // The processing run D1 seeded with the acceptance (this job's run).
    if (job.processingRunId === undefined) {
      return { outcome: "failed", errorKind: "processing_run_missing", retryable: false };
    }
    const fragmentId = await ensureWholeSourceFragment(ctx.db, source._id, extractionId);
    await recordExtractStep(ctx.db, job.processingRunId, extractionId, fragmentId);
    // Follow-on durable analysis, same run, deduped against replays.
    await registerDurableJob(ctx, {
      kind: "processing.analyze_change_plan",
      input: {
        sourceId: source._id,
        processingRunId: job.processingRunId,
        reanalysisOfRunId: null,
      },
      companyId: source.companyId,
      sourceId: source._id,
      processingRunId: job.processingRunId,
      policy: ANALYSIS_RETRY_POLICY,
      dedupKey: `processing.analyze:${job.dedupKey ?? job.jobKey}`,
    });
    return { outcome: "succeeded" };
  },
};
