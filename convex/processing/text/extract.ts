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
 *   one fails honestly) and resolve the text extraction through the run
 *   journal (the drain projection may hand `extractionId: null`; exactly
 *   one text extraction exists per D1 source, resolved in-company);
 * - record the extract step idempotently and ensure the whole-source
 *   fragment exists (the honest fallback basis per CONTEXT.md: "Gdy nie da
 *   się wiarygodnie wskazać fragmentu, podstawą pozostaje cały materiał");
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
import { ensureFragment, recordStep, resolveTextExtraction } from "./journal";

/** The extract stage's sequence number inside the run. */
export const EXTRACT_STEP_SEQUENCE = 10;

/** The retry policy of the follow-on analysis registration. */
const ANALYSIS_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

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
    const extractionId = await resolveTextExtraction(ctx.db, source._id, decoded.extractionId);
    if (extractionId === null) {
      return { outcome: "failed", errorKind: "text_extraction_missing", retryable: false };
    }
    // The processing run D1 seeded with the acceptance (this job's run).
    if (job.processingRunId === undefined) {
      return { outcome: "failed", errorKind: "processing_run_missing", retryable: false };
    }
    const fragmentId = await ensureFragment(ctx.db, source._id, extractionId, {
      _tag: "whole_source",
    });
    await recordStep(ctx.db, job.processingRunId, EXTRACT_STEP_SEQUENCE, "extract_text", {
      state: "succeeded",
      output: { extractionId, wholeSourceFragmentId: fragmentId },
    });
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
