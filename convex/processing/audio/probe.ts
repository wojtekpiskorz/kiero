/**
 * D6 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, the D1/D2 pattern; see convex/sources/probe_shared.ts).
 *
 * No business shortcuts exist here: every entry resolves the CALLER's
 * identity from the caller's own verified Convex Auth credential and runs
 * the REAL order/registration/inspection code against the caller's tenant.
 * The entries exist so the D6 evidence can drive the durable flow on the
 * real deployment:
 *
 * - `probeOrderTranscript`: the order transaction as the caller (the same
 *   entry E3's extract executor will call internally).
 * - `probeArmSegmentFailure` / `probeDisarmSegmentFailure`: the interrupt
 *   fixture — a deterministic per-segment failure marker (A3's armed-stage
 *   pattern) so transcribe -> interrupt -> resume is real, not a replay
 *   artifact.
 * - `probeResumeTranscript`: the sanctioned resume — re-running the order
 *   entry re-queues the definitely-failed job (bounded by its attempts).
 * - `probeTranscriptState`: the caller's tenant-scoped inspection the
 *   evidence asserts on (orders, segment checkpoints, platform steps and
 *   attempts, extraction versions and anchored fragments, durable jobs).
 *
 * The guards read deployment variables (KIERO_PROBE_ENABLED etc.) at call
 * time; changing them requires a functions re-push to rebind the bundle.
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError } from "@kiero/runtime";
import { resolveAccessContextFromConvexAuth } from "../../access/identity/resolution";
import { probeDisabled, probeGuardEnabled } from "../../sources/probe_shared";
import { orderAudioTranscript } from "./orders";
import { nextUnfinishedSegment } from "./segmentation";
import {
  SEGMENT_STEP_KIND,
  ensureSegmentFailureMarker,
  removeSegmentFailureMarker,
} from "./executor";

/** The read surface the caller resolution needs (query and mutation ctx fit). */
type CallerDb = Parameters<typeof resolveAccessContextFromConvexAuth>[0];
/** The auth surface the caller resolution needs (any Convex ctx fits). */
type CallerAuth = Parameters<typeof resolveAccessContextFromConvexAuth>[1];

/** Resolves the caller's read-side context, or the sanitized refusal. */
async function callerContextOrRefuse(
  db: CallerDb,
  auth: CallerAuth,
): Promise<
  | { ok: true; context: NonNullable<Awaited<ReturnType<typeof resolveAccessContextFromConvexAuth>>> }
  | { ok: false; result: ResultEnvelope }
> {
  const context = await resolveAccessContextFromConvexAuth(db, auth, Date.now());
  if (context === null) {
    return { ok: false, result: errorResult(unauthenticatedError()) };
  }
  return { ok: true, context };
}

// --- order as the caller ------------------------------------------------------

export const orderAsCaller = internalMutation({
  args: {
    attachmentId: v.string(),
    targetSegmentMs: v.optional(v.float64()),
    bytesChannel: v.string(),
    proofAudioBase64: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerContextOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    if (args.bytesChannel !== "media_worker" && args.bytesChannel !== "proof_inline") {
      return errorResult(forbiddenError("probe_malformed_channel", "audioTranscripts"));
    }
    return orderAudioTranscript(ctx, resolved.context, {
      attachmentId: args.attachmentId,
      ...(args.targetSegmentMs === undefined ? {} : { targetSegmentMs: args.targetSegmentMs }),
      bytesChannel: args.bytesChannel,
      ...(args.proofAudioBase64 === undefined ? {} : { proofAudioBase64: args.proofAudioBase64 }),
    });
  },
});

/** Orders (or idempotently replays) one transcript as the CALLER (guarded). */
export const probeOrderTranscript = action({
  args: {
    attachmentId: v.string(),
    targetSegmentMs: v.optional(v.float64()),
    bytesChannel: v.string(),
    proofAudioBase64: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.audio.probe.orderAsCaller, args);
  },
});

// --- the interrupt fixture (armed per-segment failure) ------------------------

/** Loads one transcript row after the tenant check, or refuses. */
async function callerTranscript(
  db: CallerDb,
  auth: CallerAuth,
  transcriptId: string,
): Promise<
  | { ok: true; companyId: string; runId: string }
  | { ok: false; result: ResultEnvelope }
> {
  const resolved = await callerContextOrRefuse(db, auth);
  if (!resolved.ok) {
    return resolved;
  }
  const id = db.normalizeId("audioTranscripts", transcriptId);
  if (id === null) {
    return { ok: false, result: errorResult(forbiddenError("transcript_not_found", "audioTranscripts")) };
  }
  const transcript = await db.get(id);
  if (transcript === null || transcript.companyId !== db.normalizeId("companies", resolved.context.actor.companyId)) {
    return { ok: false, result: errorResult(forbiddenError("transcript_not_found", "audioTranscripts")) };
  }
  return { ok: true, companyId: resolved.context.actor.companyId, runId: transcript.processingRunId };
}

export const armSegmentFailure = internalMutation({
  args: { transcriptId: v.string(), segmentIndex: v.float64(), arm: v.boolean() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const transcript = await callerTranscript(ctx.db, ctx.auth, args.transcriptId);
    if (!transcript.ok) {
      return transcript.result;
    }
    const runId = ctx.db.normalizeId("processingRuns", transcript.runId);
    if (runId === null) {
      return errorResult(forbiddenError("transcript_run_missing", "audioTranscripts"));
    }
    // The shared, stepKind-guarded marker helpers (the same authority the
    // workflow's segment lookup uses): arming/disarming can never touch a
    // foreign lane's rows even at a colliding sequence.
    if (args.arm) {
      await ensureSegmentFailureMarker(ctx, runId, args.segmentIndex);
      return okResult({ armed: true, segmentIndex: args.segmentIndex });
    }
    await removeSegmentFailureMarker(ctx, runId, args.segmentIndex);
    return okResult({ armed: false, segmentIndex: args.segmentIndex });
  },
});

/** Arms/disarms the deterministic segment failure (guarded fixture control). */
export const probeArmSegmentFailure = action({
  args: { transcriptId: v.string(), segmentIndex: v.float64(), arm: v.boolean() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.audio.probe.armSegmentFailure, args);
  },
});

// --- the sanctioned resume ----------------------------------------------------

export const resumeAsCaller = internalMutation({
  args: { transcriptId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerContextOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const id = ctx.db.normalizeId("audioTranscripts", args.transcriptId);
    if (id === null) {
      return errorResult(forbiddenError("transcript_not_found", "audioTranscripts"));
    }
    const transcript = await ctx.db.get(id);
    if (
      transcript === null ||
      transcript.companyId !== ctx.db.normalizeId("companies", resolved.context.actor.companyId)
    ) {
      return errorResult(forbiddenError("transcript_not_found", "audioTranscripts"));
    }
    const config = JSON.parse(transcript.segmentationConfigJson) as { targetSegmentMs: number };
    // The order entry's replay branch re-queues the definitely-failed job
    // with the SAME dedup key (one row, attempts preserved, bounded).
    return orderAudioTranscript(ctx, resolved.context, {
      attachmentId: transcript.attachmentId,
      targetSegmentMs: config.targetSegmentMs,
      bytesChannel: transcript.bytesChannel,
    });
  },
});

/** Re-runs the order entry as the CALLER: the bounded resume (guarded). */
export const probeResumeTranscript = action({
  args: { transcriptId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.audio.probe.resumeAsCaller, args);
  },
});

// --- inspection ---------------------------------------------------------------

export const transcriptInspection = internalQuery({
  args: { transcriptId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const resolved = await callerContextOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const companyId = ctx.db.normalizeId("companies", resolved.context.actor.companyId);
    if (companyId === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const one = args.transcriptId === undefined
      ? null
      : ctx.db.normalizeId("audioTranscripts", args.transcriptId);
    const transcripts = await ctx.db
      .query("audioTranscripts")
      .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
      .collect();
    const companyJobs = await ctx.db
      .query("durableJobs")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const selected = transcripts.filter(
      (row) => one === null || row._id === one,
    );
    const out = [];
    for (const transcript of selected) {
      const segments = await ctx.db
        .query("audioSegments")
        .withIndex("by_transcript_index", (q) => q.eq("transcriptId", transcript._id))
        .collect();
      const steps = (
        await ctx.db
          .query("processingSteps")
          .withIndex("by_run_sequence", (q) => q.eq("runId", transcript.processingRunId))
          .collect()
      ).filter((step) => step.stepKind === SEGMENT_STEP_KIND);
      const attempts = [];
      for (const step of steps) {
        const rows = await ctx.db
          .query("processingAttempts")
          .withIndex("by_step_attempt", (q) => q.eq("stepId", step._id))
          .collect();
        for (const row of rows) {
          attempts.push({
            stepSequence: step.sequence,
            attempt: row.attempt,
            outcome: row.outcome,
            ...(row.model === undefined ? {} : { model: row.model }),
            ...(row.errorKind === undefined ? {} : { errorKind: row.errorKind }),
          });
        }
      }
      const extractionId = transcript.extractionId;
      const fragments = extractionId === undefined
        ? []
        : await ctx.db
            .query("sourceFragments")
            .withIndex("by_extraction", (q) => q.eq("extractionId", extractionId))
            .collect();
      const extraction = extractionId === undefined ? null : await ctx.db.get(extractionId);
      out.push({
        transcriptId: transcript._id,
        nextUnfinishedSegmentIndex: nextUnfinishedSegment(transcript.segmentCount, segments),
        attachmentId: transcript.attachmentId,
        sourceId: transcript.sourceId,
        state: transcript.state,
        bytesChannel: transcript.bytesChannel,
        segmentCount: transcript.segmentCount,
        ...(transcript.audioDurationMs === undefined ? {} : { audioDurationMs: transcript.audioDurationMs }),
        ...(transcript.extractionId === undefined ? {} : { extractionId: transcript.extractionId }),
        ...(transcript.lastErrorKind === undefined ? {} : { lastErrorKind: transcript.lastErrorKind }),
        segments: segments.map((segment) => ({
          segmentIndex: segment.segmentIndex,
          startMs: segment.startMs,
          endMs: segment.endMs,
          durationMs: segment.durationMs,
          state: segment.state,
          attempts: segment.attempts,
          ...(segment.lastErrorKind === undefined ? {} : { lastErrorKind: segment.lastErrorKind }),
          ...(segment.text === undefined ? {} : { text: segment.text }),
          ...(segment.servedModels === undefined ? {} : { servedModels: segment.servedModels }),
          ...(segment.latencyMs === undefined ? {} : { latencyMs: segment.latencyMs }),
          ...(segment.audioSeconds === undefined ? {} : { audioSeconds: segment.audioSeconds }),
          ...(segment.costUsd === undefined ? {} : { costUsd: segment.costUsd }),
        })),
        sttSteps: steps
          .filter((step) => step.stepKind === "stt_segment")
          .map((step) => ({ sequence: step.sequence, state: step.state, outputRef: step.outputRef })),
        attempts,
        extraction: extraction === null
          ? null
          : {
              kind: extraction.kind,
              model: extraction.model,
              provider: extraction.provider,
              pipelineVersion: extraction.pipelineVersion,
            },
        fragmentAnchors: fragments.map((fragment) => fragment.anchor),
      });
    }
    return okResult({
      transcripts: out,
      transcriptJobs: transcripts.map((transcript) => {
        const job = companyJobs.find(
          (row) => row.dedupKey === `processing.transcribe_segment:${transcript._id}`,
        );
        return {
          transcriptId: transcript._id,
          ...(job === undefined
            ? { jobState: "none" as const }
            : {
                jobState: job.state,
                jobAttempts: job.attempts,
                maxAttempts: job.maxAttempts,
                ...(job.lastErrorKind === undefined ? {} : { jobLastErrorKind: job.lastErrorKind }),
                ...(job.externalOutcome === undefined ? {} : { jobExternalOutcome: job.externalOutcome }),
              }),
        };
      }),
    });
  },
});

/** The caller's tenant-scoped D6 inspection (guarded read). */
export const probeTranscriptState = action({
  args: { transcriptId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.processing.audio.probe.transcriptInspection, args);
  },
});

/** TEMPORARY D6 diagnostic (removed before handover): env visibility. */
export const d6DebugEnv = action({
  args: {},
  handler: async (): Promise<ResultEnvelope> =>
    okResult({
      probe: process.env.KIERO_PROBE_ENABLED === "1",
      b1: process.env.KIERO_B1_PROBE_ENABLED === "1",
      mediaUrlSet: process.env.KIERO_MEDIA_WORKER_URL !== undefined,
    }),
});
