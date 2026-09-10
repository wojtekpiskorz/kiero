/**
 * The durable STT segment workflow (D6): resumable, checkpointed per
 * segment, one bounded provider pass per segment per run.
 *
 * The registered executor (`processing.transcribe_segment`, the coordinated
 * contracts amendment E2 named as its prerequisite) delegates to a
 * @convex-dev/workflow workflow — the ONE canonical engine (A3 precedent in
 * convex/platform/pipeline.ts). Crash/restart semantics:
 *
 * - The manifest is planned ONCE (insert-if-absent): the immutable
 *   original-time interval rows are the checkpoints.
 * - Each segment step re-reads its checkpoint: an already-succeeded segment
 *   replays as a no-op (no second provider call for it); a failed/pending
 *   segment gets ONE bounded provider pass (the accepted STT route order
 *   inside E2's adapter already covers mai -> whisper fallback per call).
 * - Segment attempts are bounded per segment (SEGMENT_MAX_ATTEMPTS) across
 *   resumes; the resume path is re-registration of the definitely-failed
 *   job (the A3 outbox rule), never an unbounded loop.
 * - A segment failure does not abort the run: remaining segments still
 *   process (maximum honest progress), and the transcript is left
 *   `partial`/`pending` with a sanitized error kind — never fake-complete.
 * - Assembly is idempotent: the extraction version and its audio-interval
 *   fragments are inserted exactly once, only when EVERY required segment
 *   succeeded.
 *
 * External-effect discipline (echo template): provider calls run in ACTIONS
 * only; outcomes are recorded in the same step's mutation. Uncertain
 * outcomes (deadline/connection) are marked `timeout_unknown` on the
 * attempt and make the job failure UNCERTAIN (externalOutcome "unknown"),
 * which blocks blind re-registration until reconciliation.
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { start, vResultValidator } from "@convex-dev/workflow";
import {
  runTranscription,
  type OpenRouterCredentials,
  type RouteCallResult,
  type SttTranscription,
} from "@kiero/providers";
import { transcribeSegmentInput } from "@kiero/contracts";
import { internal } from "../../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { workflow } from "../../platform/pipeline";
import type { JobExecutor, JobOutcome } from "../../platform/executors";
import {
  deriveTranscriptStatus,
  manifestFingerprint,
  planSegments,
  type SegmentationConfig,
} from "./segmentation";
import {
  measureProofStash,
  probeFromMediaWorker,
  segmentFromMediaWorker,
  segmentFromProofStash,
  type SegmentBytesResult,
} from "./media";

/** Bounded provider passes per segment across ALL resumes of one order. */
export const SEGMENT_MAX_ATTEMPTS = 3;

/**
 * Step-sequence keyspace (review round 1, the E3 collision fix).
 *
 * D6 orders anchor to the source's INITIAL analysis run — the same run
 * whose step journal E3's text stages own (`convex/processing/text`:
 * extract step 10, stages 20/30, clarifications 500+, groups 1000+, and
 * the failure/outcome marker bases 100_000/200_000). D6's segment steps
 * and probe markers therefore live at dedicated bases far OUTSIDE every
 * E3 range, and every (run, sequence) lookup additionally checks
 * `stepKind`, so a text+audio source can never cross-wire the two lanes'
 * journals (a D6 step attaching attempts to an E3 stage, or a disarm
 * deleting an E3 marker). Pinned against E3's exported constants by
 * tests/d6/keyspace.test.ts.
 */
export const SEGMENT_STEP_BASE = 1_000_000;
export const SEGMENT_MARKER_BASE = 5_000_000;

/** The step kinds D6 writes on `processingSteps` (lookup guards). */
export const SEGMENT_STEP_KIND = "stt_segment";
export const PROBE_FAILURE_MARKER_KIND = "d6_probe_fail_segment";

/** Provider failures classified uncertain by E2's event mapping. */
export const UNCERTAIN_FAILURE_KINDS = new Set(["deadline_exceeded", "connection_failed"]);

/** The db read surface the marker helpers need (any Convex ctx fits). */
type StepsDb = Pick<MutationCtx["db"], "query">;

/**
 * The probe-armed failure marker row for one segment (stepKind-guarded).
 * Rows are COLLECTED and filtered by kind, not `.first()`-checked: at a
 * shared (run, sequence) key the first row is arbitrary, and the guard must
 * find D6's marker regardless of a foreign lane's row at the same sequence.
 */
export async function segmentFailureMarkerRow(
  db: StepsDb,
  runId: Id<"processingRuns">,
  segmentIndex: number,
) {
  const rows = await db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) =>
      q.eq("runId", runId).eq("sequence", SEGMENT_MARKER_BASE + segmentIndex),
    )
    .collect();
  return rows.find((row) => row.stepKind === PROBE_FAILURE_MARKER_KIND) ?? null;
}

/** Arms the deterministic segment failure (insert-if-absent, guarded). */
export async function ensureSegmentFailureMarker(
  ctx: MutationCtx,
  runId: Id<"processingRuns">,
  segmentIndex: number,
): Promise<void> {
  const existing = await segmentFailureMarkerRow(ctx.db, runId, segmentIndex);
  if (existing !== null) {
    return;
  }
  await ctx.db.insert("processingSteps", {
    runId,
    stepKind: PROBE_FAILURE_MARKER_KIND,
    sequence: SEGMENT_MARKER_BASE + segmentIndex,
    state: "failed",
    outputRef: "armed",
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
  });
}

/** Disarms the marker; a foreign-kind row at the same sequence is NOT touched. */
export async function removeSegmentFailureMarker(
  ctx: MutationCtx,
  runId: Id<"processingRuns">,
  segmentIndex: number,
): Promise<void> {
  const marker = await segmentFailureMarkerRow(ctx.db, runId, segmentIndex);
  if (marker !== null) {
    await ctx.db.delete(marker._id);
  }
}

// ---------------------------------------------------------------------------
// Stage 1: manifest planning.
// ---------------------------------------------------------------------------

/** The outcome of the (idempotent) manifest planning mutation. */
export type ManifestOutcome = { ok: true; segmentCount: number } | { ok: false; code: string };

/** The manifest planning transaction (idempotent; testable without a deployment). */
export async function ensureManifestTransaction(
  ctx: MutationCtx,
  transcriptId: Id<"audioTranscripts">,
): Promise<ManifestOutcome> {
  {
    const transcript = await ctx.db.get(transcriptId);
    if (transcript === null) {
      return { ok: false, code: "transcript_row_missing" };
    }
    if (transcript.segmentCount > 0) {
      // Resume: the immutable manifest exists; never re-plan it.
      return { ok: true, segmentCount: transcript.segmentCount };
    }
    // Resolve the duration through the order's byte channel.
    let durationMs: number;
    if (transcript.bytesChannel === "proof_inline") {
      if (transcript.proofAudioBase64 === undefined) {
        await patchPlanningRefusal(ctx, transcriptId, "proof_stash_missing");
        return { ok: false, code: "proof_stash_missing" };
      }
      const measured = await measureProofStash(transcript.proofAudioBase64);
      if (!measured.ok) {
        await patchPlanningRefusal(ctx, transcriptId, measured.code);
        return { ok: false, code: measured.code };
      }
      // The order-time pin is COMPARED, not just stored (review finding 3):
      // a stash mutated after ordering refuses planning.
      if (
        transcript.proofBytesSha256 !== undefined &&
        transcript.proofBytesSha256 !== measured.sha256Hex
      ) {
        await patchPlanningRefusal(ctx, transcriptId, "proof_stash_hash_mismatch");
        return { ok: false, code: "proof_stash_hash_mismatch" };
      }
      durationMs = measured.durationMs;
    } else {
      const representation = await ctx.db.get(transcript.representationId);
      if (representation === null) {
        await patchPlanningRefusal(ctx, transcriptId, "representation_row_missing");
        return { ok: false, code: "representation_row_missing" };
      }
      const probed = await probeFromMediaWorker(representation.objectKey);
      if (!probed.ok) {
        // The honest production degradation: no media executor, no manifest.
        // The transcript stays `planning` — visible pending, never failed.
        await patchPlanningRefusal(ctx, transcriptId, probed.code);
        return { ok: false, code: probed.code };
      }
      durationMs = probed.durationMs;
    }
    const config: SegmentationConfig = JSON.parse(transcript.segmentationConfigJson);
    const plan = planSegments(durationMs, config);
    if (!plan.ok) {
      await patchPlanningRefusal(ctx, transcriptId, plan.code);
      return { ok: false, code: plan.code };
    }
    const nowMs = Date.now();
    for (const segment of plan.segments) {
      await ctx.db.insert("audioSegments", {
        transcriptId: transcriptId,
        segmentIndex: segment.segmentIndex,
        startMs: segment.startMs,
        endMs: segment.endMs,
        durationMs: segment.durationMs,
        state: "pending",
        attempts: 0,
      });
    }
    await ctx.db.patch(transcriptId, {
      audioDurationMs: durationMs,
      segmentCount: plan.segments.length,
      state: "pending",
      // The immutability pin: assembly re-derives this fingerprint from the
      // stored rows and refuses to publish over moved coordinates.
      manifestSha256: await manifestFingerprint(plan.segments),
      lastErrorKind: undefined,
      updatedAtMs: nowMs,
    });
    return { ok: true, segmentCount: plan.segments.length };
  }
}

/** The registered durable step (thin wrapper over the transaction). */
export const ensureManifest = internalMutation({
  args: { transcriptId: v.id("audioTranscripts") },
  handler: async (ctx, args): Promise<ManifestOutcome> =>
    ensureManifestTransaction(ctx, args.transcriptId),
});

/** Records a planning refusal without inventing a manifest. */
async function patchPlanningRefusal(
  ctx: MutationCtx,
  transcriptId: Id<"audioTranscripts">,
  code: string,
): Promise<void> {
  await ctx.db.patch(transcriptId, {
    lastErrorKind: code,
    updatedAtMs: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Stage 2: one bounded provider pass for one segment (ACTION: external).
// ---------------------------------------------------------------------------

/** What one segment attempt decided (serializable for the journal). */
export interface SegmentAttemptOutcome {
  readonly kind: "already_succeeded" | "succeeded" | "failed" | "exhausted";
  readonly text?: string;
  readonly servedModels?: readonly string[];
  readonly routingConfigVersion?: string;
  readonly latencyMs?: number;
  readonly usageTokens?: number;
  readonly audioSeconds?: number;
  readonly costUsd?: number;
  readonly errorKind?: string;
  readonly uncertain?: boolean;
  readonly providerAttempts?: readonly {
    readonly model: string;
    readonly outcome: "succeeded" | "failed" | "timeout" | "unknown";
    readonly errorKind?: string;
    readonly startedAtMs: number;
    readonly finishedAtMs: number;
  }[];
}

/** Reads the OpenRouter key like E2's dispatch (presence only, never value). */
function openRouterCredentials(): OpenRouterCredentials | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return null;
  }
  return { apiKey };
}

/** Everything one segment attempt needs, read through one internal query. */
export const segmentWork = internalQuery({
  args: { transcriptId: v.id("audioTranscripts"), segmentIndex: v.float64() },
  handler: async (ctx, args) => {
    const transcript = await ctx.db.get(args.transcriptId);
    if (transcript === null) {
      return { transcript: null } as const;
    }
    const segment = await ctx.db
      .query("audioSegments")
      .withIndex("by_transcript_index", (q) =>
        q.eq("transcriptId", args.transcriptId).eq("segmentIndex", args.segmentIndex),
      )
      .first();
    const marker = await segmentFailureMarkerRow(ctx.db, transcript.processingRunId, args.segmentIndex);
    const representation =
      transcript.bytesChannel === "media_worker"
        ? await ctx.db.get(transcript.representationId)
        : null;
    return {
      transcript,
      ...(segment === null ? {} : { segment }),
      ...(marker === null ? {} : { failureArmed: true as const }),
      ...(representation === null ? {} : { objectKey: representation.objectKey }),
    } as const;
  },
});

/**
 * Maps one E2 adapter call record onto the journal outcome (round-2
 * finding b: `servedModels` lists ONLY the models whose attempts actually
 * served; requested-but-failed fallback positions stay on the per-attempt
 * history rows). Pure: unit-tested directly over runner-record shapes.
 */
export function providerCallOutcome(
  call: RouteCallResult<SttTranscription>,
): SegmentAttemptOutcome {
  const providerAttempts = call.record.attempts.map((attempt) => ({
    model: attempt.requestedModel,
    outcome:
      attempt.outcome === "succeeded"
        ? ("succeeded" as const)
        : UNCERTAIN_FAILURE_KINDS.has(attempt.failureKind ?? "")
          ? ("unknown" as const)
          : ("failed" as const),
    ...(attempt.failureKind === undefined ? {} : { errorKind: attempt.failureKind }),
    startedAtMs: attempt.startedAtMs,
    finishedAtMs: attempt.finishedAtMs,
  }));
  if (call.outcome.outcome === "failed") {
    const kind = call.outcome.failure.kind;
    return {
      kind: "failed",
      errorKind: kind,
      uncertain: UNCERTAIN_FAILURE_KINDS.has(kind),
      providerAttempts,
    };
  }
  const value = call.outcome.value;
  const serving = call.record.attempts[call.record.attempts.length - 1];
  const latencyMs = serving === undefined ? undefined : serving.finishedAtMs - serving.startedAtMs;
  return {
    kind: "succeeded",
    text: value.text,
    servedModels: [
      ...call.record.attempts
        .filter((attempt) => attempt.outcome === "succeeded")
        .map((attempt) => attempt.requestedModel),
    ],
    ...(call.record.routingConfigVersion === undefined
      ? {}
      : { routingConfigVersion: call.record.routingConfigVersion }),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(value.usage === undefined
      ? {}
      : {
          ...(value.usage.totalTokens === undefined ? {} : { usageTokens: value.usage.totalTokens }),
          ...(value.usage.seconds === undefined ? {} : { audioSeconds: value.usage.seconds }),
          ...(value.usage.cost === undefined ? {} : { costUsd: value.usage.cost }),
        }),
    providerAttempts,
  };
}

export const attemptSegment = internalAction({
  args: { transcriptId: v.id("audioTranscripts"), segmentIndex: v.float64() },
  handler: async (ctx, args): Promise<SegmentAttemptOutcome> => {
    const work = await ctx.runQuery(internal.processing.audio.executor.segmentWork, {
      transcriptId: args.transcriptId,
      segmentIndex: args.segmentIndex,
    });
    const transcript = work.transcript;
    if (transcript === null) {
      return { kind: "failed", errorKind: "transcript_row_missing" };
    }
    const segment = work.segment;
    if (segment === undefined) {
      return { kind: "failed", errorKind: "segment_row_missing" };
    }
    if (segment.state === "succeeded") {
      // The resume checkpoint: completed segments never re-run.
      return { kind: "already_succeeded" };
    }
    if (segment.attempts >= SEGMENT_MAX_ATTEMPTS) {
      return { kind: "exhausted", errorKind: "segment_attempts_exhausted" };
    }
    // Probe-armed deterministic failure (the interrupt fixture).
    if (work.failureArmed === true) {
      return { kind: "failed", errorKind: "probe_armed_segment_failure" };
    }
    // Resolve this segment's bytes through the order's channel.
    let bytes: SegmentBytesResult;
    if (transcript.bytesChannel === "proof_inline") {
      if (transcript.proofAudioBase64 === undefined) {
        return { kind: "failed", errorKind: "proof_stash_missing" };
      }
      bytes = segmentFromProofStash(transcript.proofAudioBase64, {
        objectKey: "",
        startMs: segment.startMs,
        endMs: segment.endMs,
      });
    } else {
      if (work.objectKey === undefined) {
        return { kind: "failed", errorKind: "representation_row_missing" };
      }
      bytes = await segmentFromMediaWorker({
        objectKey: work.objectKey,
        startMs: segment.startMs,
        endMs: segment.endMs,
      });
    }
    if (!bytes.ok) {
      return { kind: "failed", errorKind: bytes.code };
    }
    const credentials = openRouterCredentials();
    if (credentials === null) {
      return { kind: "failed", errorKind: "provider_key_not_configured" };
    }
    // The accepted STT route order (mai -> whisper) lives INSIDE E2's
    // adapter; this call is one segment's bounded pass over that route, and
    // the pure mapping owns every recorded field.
    return providerCallOutcome(
      await runTranscription(credentials, {
        audioBase64: bytes.audioBase64,
        audioFormat: "wav",
        language: "pl",
      }),
    );
  },
});

// ---------------------------------------------------------------------------
// The idempotent outcome checkpoint mutation.
// ---------------------------------------------------------------------------

/** The serializable outcome shape (decode authority for the journal args). */
const segmentOutcomeSchema = Schema.Struct({
  kind: Schema.Literals(["already_succeeded", "succeeded", "failed", "exhausted"]),
  text: Schema.optionalKey(Schema.String),
  servedModels: Schema.optionalKey(Schema.Array(Schema.String)),
  routingConfigVersion: Schema.optionalKey(Schema.String),
  latencyMs: Schema.optionalKey(Schema.Number),
  usageTokens: Schema.optionalKey(Schema.Number),
  audioSeconds: Schema.optionalKey(Schema.Number),
  costUsd: Schema.optionalKey(Schema.Number),
  errorKind: Schema.optionalKey(Schema.String),
  uncertain: Schema.optionalKey(Schema.Boolean),
  providerAttempts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        model: Schema.String,
        outcome: Schema.Literals(["succeeded", "failed", "timeout", "unknown"]),
        errorKind: Schema.optionalKey(Schema.String),
        startedAtMs: Schema.Number,
        finishedAtMs: Schema.Number,
      }),
    ),
  ),
});

/** The outcome checkpoint transaction (idempotent; testable). */
export async function recordSegmentOutcomeTransaction(
  ctx: MutationCtx,
  params: { transcriptId: Id<"audioTranscripts">; segmentIndex: number; outcome: unknown },
): Promise<{ ok: boolean; state?: string }> {
  const outcome: SegmentAttemptOutcome = Schema.decodeUnknownSync(segmentOutcomeSchema)(params.outcome);
  const transcript = await ctx.db.get(params.transcriptId);
  if (transcript === null) {
    return { ok: false };
  }
  const segment = await ctx.db
    .query("audioSegments")
    .withIndex("by_transcript_index", (q) =>
      q.eq("transcriptId", params.transcriptId).eq("segmentIndex", params.segmentIndex),
    )
    .first();
  if (segment === null) {
    return { ok: false };
  }
  if (outcome.kind === "already_succeeded" || segment.state === "succeeded") {
    // Journal replay or resume: the checkpoint stands; nothing to write.
    return { ok: true, state: "succeeded" };
  }
  const nowMs = Date.now();
  const attempts = segment.attempts + (outcome.kind === "exhausted" ? 0 : 1);
  if (outcome.kind === "succeeded") {
    await ctx.db.patch(segment._id, {
      state: "succeeded",
      attempts,
      text: outcome.text,
      ...(outcome.servedModels === undefined ? {} : { servedModels: [...outcome.servedModels] }),
      provider: "openrouter",
      ...(outcome.routingConfigVersion === undefined
        ? {}
        : { routingConfigVersion: outcome.routingConfigVersion }),
      ...(outcome.latencyMs === undefined ? {} : { latencyMs: outcome.latencyMs }),
      ...(outcome.usageTokens === undefined ? {} : { usageTokens: outcome.usageTokens }),
      ...(outcome.audioSeconds === undefined ? {} : { audioSeconds: outcome.audioSeconds }),
      ...(outcome.costUsd === undefined ? {} : { costUsd: outcome.costUsd }),
      lastAttemptAtMs: nowMs,
      succeededAtMs: nowMs,
      lastErrorKind: undefined,
    });
  } else {
    await ctx.db.patch(segment._id, {
      state: "failed",
      attempts,
      ...(outcome.errorKind === undefined ? {} : { lastErrorKind: outcome.errorKind }),
      lastAttemptAtMs: nowMs,
    });
  }
  // The platform step row for this segment (insert-if-absent).
  const stepId = await ensureStepRow(ctx, transcript.processingRunId, params.segmentIndex, outcome);
  // One processingAttempts row per provider attempt of this pass. Attempt
  // numbers continue the step's existing history (review minor: the old
  // clamp could emit two rows numbered 1 on a first-pass route fallback).
  if (outcome.providerAttempts !== undefined && outcome.providerAttempts.length > 0) {
    const existingAttempts = await ctx.db
      .query("processingAttempts")
      .withIndex("by_step_attempt", (q) => q.eq("stepId", stepId))
      .collect();
    let attemptNo = existingAttempts.length;
    for (const attempt of outcome.providerAttempts) {
      attemptNo += 1;
      await ctx.db.insert("processingAttempts", {
        stepId,
        attempt: attemptNo,
        outcome: attempt.outcome,
        provider: "openrouter",
        model: attempt.model,
        ...(attempt.errorKind === undefined ? {} : { errorKind: attempt.errorKind }),
        startedAtMs: attempt.startedAtMs,
        finishedAtMs: attempt.finishedAtMs,
      });
    }
  }
  // Recompute the honest transcript state from the checkpoint rows.
  const all = await ctx.db
    .query("audioSegments")
    .withIndex("by_transcript_index", (q) => q.eq("transcriptId", params.transcriptId))
    .collect();
  const status = deriveTranscriptStatus(transcript.segmentCount, all);
  await ctx.db.patch(params.transcriptId, {
    state: status,
    updatedAtMs: nowMs,
  });
  return { ok: true, state: status };
}

/** The registered durable step (thin wrapper over the transaction). */
export const recordSegmentOutcome = internalMutation({
  args: {
    transcriptId: v.id("audioTranscripts"),
    segmentIndex: v.float64(),
    outcome: v.any(),
  },
  handler: async (ctx, args) =>
    recordSegmentOutcomeTransaction(ctx, {
      transcriptId: args.transcriptId,
      segmentIndex: args.segmentIndex,
      outcome: args.outcome,
    }),
});

/**
 * The per-segment platform step row: insert-if-absent at the D6-only
 * `SEGMENT_STEP_BASE + segmentIndex` keyspace, with the `stepKind` guard on
 * the lookup so a foreign lane's row at the same sequence can never be
 * adopted (or clobbered) as a segment step.
 */
async function ensureStepRow(
  ctx: MutationCtx,
  runId: Id<"processingRuns">,
  segmentIndex: number,
  outcome: SegmentAttemptOutcome,
): Promise<Id<"processingSteps">> {
  const existing = await ctx.db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) =>
      q.eq("runId", runId).eq("sequence", SEGMENT_STEP_BASE + segmentIndex),
    )
    .collect();
  const ours = existing.find((row) => row.stepKind === SEGMENT_STEP_KIND);
  if (ours !== undefined) {
    // The step row must reflect the LATEST pass, not freeze at the first
    // outcome (round-2 finding 1: the fail-then-succeed resume — the
    // interrupt fixture's exact case — left a failed STT step under a
    // completed transcript forever). Like E3's recordStep, a non-terminal
    // or superseded row is patched; a succeeded row never regresses (the
    // segment checkpoint makes later failures on it unreachable).
    if (outcome.kind === "succeeded" && ours.state !== "succeeded") {
      await ctx.db.patch(ours._id, {
        state: "succeeded",
        outputRef: "transcribed",
        finishedAtMs: Date.now(),
      });
    }
    return ours._id;
  }
  return ctx.db.insert("processingSteps", {
    runId,
    stepKind: SEGMENT_STEP_KIND,
    sequence: SEGMENT_STEP_BASE + segmentIndex,
    state: outcome.kind === "succeeded" ? "succeeded" : "failed",
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
    outputRef: outcome.kind === "succeeded" ? "transcribed" : (outcome.errorKind ?? "failed"),
  });
}

// ---------------------------------------------------------------------------
// Stage 3: idempotent assembly (extraction version + original-time anchors).
// ---------------------------------------------------------------------------

/** The assembly outcome (the workflow's return shape). */
export interface AssemblyOutcome {
  readonly complete: boolean;
  readonly succeeded: number;
  readonly total: number;
  readonly uncertain: boolean;
  readonly lastErrorKind?: string;
}

/** The idempotent assembly transaction (extraction version + anchors). */
export async function assembleTranscriptTransaction(
  ctx: MutationCtx,
  transcriptId: Id<"audioTranscripts">,
): Promise<AssemblyOutcome> {
  const transcript = await ctx.db.get(transcriptId);
  if (transcript === null) {
    return { complete: false, succeeded: 0, total: 0, uncertain: false };
  }
  const segments = await ctx.db
    .query("audioSegments")
    .withIndex("by_transcript_index", (q) => q.eq("transcriptId", transcriptId))
    .collect();
  const status = deriveTranscriptStatus(transcript.segmentCount, segments);
  const uncertain = segments.some(
    (segment) =>
      segment.state === "failed" &&
      segment.lastErrorKind !== undefined &&
      UNCERTAIN_FAILURE_KINDS.has(segment.lastErrorKind),
  );
  const succeededCount = segments.filter((segment) => segment.state === "succeeded").length;
  if (status !== "complete") {
    await ctx.db.patch(transcriptId, {
      state: status,
      updatedAtMs: Date.now(),
    });
    return {
      complete: false,
      succeeded: succeededCount,
      total: transcript.segmentCount,
      uncertain,
      ...(transcript.lastErrorKind === undefined
        ? {}
        : { lastErrorKind: transcript.lastErrorKind }),
    };
  }
  if (transcript.extractionId !== undefined) {
    // Idempotent assembly: the version exists; never a second one.
    return { complete: true, succeeded: segments.length, total: transcript.segmentCount, uncertain: false };
  }
  // Immutability check (review finding 3): the stored planning-time
  // fingerprint must equal the fingerprint of the rows being assembled —
  // coordinates that moved since planning refuse publication, loudly.
  if (transcript.manifestSha256 !== undefined) {
    const derived = await manifestFingerprint(
      segments
        .slice()
        .sort((a, b) => a.segmentIndex - b.segmentIndex)
        .map((segment) => ({
          segmentIndex: segment.segmentIndex,
          startMs: segment.startMs,
          endMs: segment.endMs,
        })),
    );
    if (derived !== transcript.manifestSha256) {
      await ctx.db.patch(transcriptId, {
        state: "failed",
        lastErrorKind: "manifest_fingerprint_mismatch",
        finishedAtMs: Date.now(),
        updatedAtMs: Date.now(),
      });
      return {
        complete: false,
        succeeded: succeededCount,
        total: transcript.segmentCount,
        uncertain,
        lastErrorKind: "manifest_fingerprint_mismatch",
      };
    }
  }
  // The immutable extraction version for this order: model = the models
  // that actually served (per-segment truth lives on the segment rows).
  const served = new Set<string>();
  for (const segment of segments) {
    for (const model of segment.servedModels ?? []) {
      served.add(model);
    }
  }
  const extractionId = await ctx.db.insert("extractions", {
    sourceId: transcript.sourceId,
    representationId: transcript.representationId,
    kind: "stt",
    pipelineVersion: transcript.pipelineVersion,
    model: [...served].sort().join("|"),
    provider: "openrouter",
    processingRunId: transcript.processingRunId,
    createdAtMs: Date.now(),
  });
  for (const segment of segments) {
    // Original-time anchors: Fragment źródła ranges on the source audio
    // timeline (audio_interval), never segment-relative offsets.
    await ctx.db.insert("sourceFragments", {
      extractionId,
      sourceId: transcript.sourceId,
      anchor: {
        _tag: "audio_interval",
        startMs: segment.startMs,
        endMs: segment.endMs,
      },
      createdAtMs: Date.now(),
    });
  }
  const nowMs = Date.now();
  await ctx.db.patch(transcriptId, {
    state: "complete",
    extractionId,
    finishedAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  return { complete: true, succeeded: segments.length, total: transcript.segmentCount, uncertain: false };
}

/** The registered durable step (thin wrapper over the transaction). */
export const assembleTranscript = internalMutation({
  args: { transcriptId: v.id("audioTranscripts") },
  handler: async (ctx, args) => assembleTranscriptTransaction(ctx, args.transcriptId),
});

// ---------------------------------------------------------------------------
// The workflow, its completion hook and the registered executor.
// ---------------------------------------------------------------------------

/** The durable STT workflow over one transcript order. */
export const transcribeAudioWorkflow = workflow
  .define({
    args: { transcriptId: v.id("audioTranscripts"), jobKey: v.string() },
    returns: v.object({
      complete: v.boolean(),
      succeeded: v.float64(),
      total: v.float64(),
      uncertain: v.boolean(),
      lastErrorKind: v.optional(v.string()),
    }),
  })
  .handler(async (step, args) => {
    const manifest = await step.runMutation(internal.processing.audio.executor.ensureManifest, {
      transcriptId: args.transcriptId,
    });
    if (!manifest.ok) {
      // Planning refused (typed): no manifest, no assembly. The order row
      // keeps the sanitized code; the job fails DEFINITELY (resume when the
      // blocked external condition clears).
      return {
        complete: false,
        succeeded: 0,
        total: 0,
        uncertain: false,
        lastErrorKind: manifest.code,
      };
    }
    let uncertain = false;
    let lastErrorKind: string | undefined;
    for (let index = 0; index < manifest.segmentCount; index += 1) {
      const outcome = await step.runAction(internal.processing.audio.executor.attemptSegment, {
        transcriptId: args.transcriptId,
        segmentIndex: index,
      });
      if (outcome.kind === "failed") {
        uncertain = uncertain || outcome.uncertain === true;
        lastErrorKind = outcome.errorKind;
      }
      if (outcome.kind === "exhausted") {
        lastErrorKind = outcome.errorKind;
      }
      await step.runMutation(internal.processing.audio.executor.recordSegmentOutcome, {
        transcriptId: args.transcriptId,
        segmentIndex: index,
        outcome,
      });
    }
    const assembled = await step.runMutation(internal.processing.audio.executor.assembleTranscript, {
      transcriptId: args.transcriptId,
    });
    return {
      complete: assembled.complete,
      succeeded: assembled.succeeded,
      total: assembled.total,
      uncertain,
      ...(lastErrorKind === undefined ? {} : { lastErrorKind }),
    };
  });

/** Records the workflow's terminal outcome on the durable job and order. */
export const completeTranscription = internalMutation({
  args: {
    workflowId: v.string(),
    result: vResultValidator,
    context: v.object({ jobKey: v.string(), transcriptId: v.id("audioTranscripts") }),
  },
  handler: async (ctx, args) => {
    const nowMs = Date.now();
    type WorkflowOutcome = { complete?: boolean; lastErrorKind?: string; uncertain?: boolean };
    const value: WorkflowOutcome | null =
      args.result.kind === "success" ? (args.result.returnValue as WorkflowOutcome) : null;
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.context.jobKey))
      .first();
    if (job !== null && job.state !== "succeeded" && job.state !== "cancelled") {
      if (value?.complete === true) {
        await ctx.db.patch(job._id, {
          state: "succeeded",
          updatedAtMs: nowMs,
          finishedAtMs: nowMs,
        });
      } else {
        await ctx.db.patch(job._id, {
          state: "failed",
          lastErrorKind: value?.lastErrorKind ?? "transcription_workflow_failed",
          // Uncertain provider outcomes block blind re-registration until
          // reconciliation observes the provider (echo template).
          ...(value?.uncertain === true ? { externalOutcome: "unknown" as const } : {}),
          updatedAtMs: nowMs,
          finishedAtMs: nowMs,
        });
      }
    }
    const transcript = await ctx.db.get(args.context.transcriptId);
    if (transcript !== null && transcript.state !== "complete" && value !== null) {
      await ctx.db.patch(args.context.transcriptId, {
        // Keep the honest partial/pending state visible (E3/E4 seam); the
        // sanitized planning error rides along when planning refused.
        ...(value.lastErrorKind === undefined ? {} : { lastErrorKind: value.lastErrorKind }),
        updatedAtMs: nowMs,
      });
    }
  },
});

/** The registered executor for `processing.transcribe_segment`. */
export const transcribeSegmentExecutor: JobExecutor = {
  jobKind: "processing.transcribe_segment",
  execute: async (ctx, job, input) => {
    const decoded = Schema.decodeUnknownSync(transcribeSegmentInput)(input);
    const transcriptId = ctx.db.normalizeId("audioTranscripts", decoded.transcriptId);
    if (transcriptId === null) {
      return { outcome: "failed", errorKind: "transcript_id_invalid", retryable: false };
    }
    await start(
      ctx,
      internal.processing.audio.executor.transcribeAudioWorkflow,
      { transcriptId, jobKey: job.jobKey },
      {
        onComplete: internal.processing.audio.executor.completeTranscription,
        context: { jobKey: job.jobKey, transcriptId },
        startAsync: true,
      },
    );
    return { outcome: "delegated" } satisfies JobOutcome;
  },
};
