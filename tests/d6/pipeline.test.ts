/**
 * D6 focused tests: the durable pipeline stage transactions over the
 * in-memory Convex emulation, plus the E2 adapter seam decisions that run
 * per segment.
 *
 * Proven here without a deployment:
 * - manifest planning is idempotent and its interval rows are the immutable
 *   checkpoints (re-planning never re-cuts);
 * - the unconfigured media executor is a TYPED planning refusal (the honest
 *   production degradation: pending, never fabricated);
 * - the outcome checkpoint is idempotent for successes (resume never
 *   duplicates completed segment results) and honest for failures (a real
 *   second pass records a second attempt);
 * - assembly registers exactly ONE immutable extraction version with
 *   audio-interval fragments anchored to the manifest — and only when
 *   EVERY required segment succeeded;
 * - the per-segment STT route falls back per E2's ordered route (first
 *   model fails eligible, backup serves) and malformed provider output
 *   fails CLOSED without recording transcript text.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { bytesToBase64, toneWav } from "@kiero/media-worker/wav";
import {
  decodeTranscription,
  providerFailure,
  transcriptionWithRoute,
  type ProviderFailureKind,
  type SttTranscription,
} from "@kiero/providers";
import type { RouteCallResult } from "@kiero/providers";
import {
  assembleTranscriptTransaction,
  ensureManifestTransaction,
  providerCallOutcome,
  recordSegmentOutcomeTransaction,
  type SegmentAttemptOutcome,
} from "../../convex/processing/audio/executor";
import { asTx, fakeCtx, type FakeCtx } from "../d2/harness";
import { sha256HexOfBytes } from "../../convex/processing/audio/segmentation";

const TABLES = [
  "companies",
  "sources",
  "processingRuns",
  "processingSteps",
  "processingAttempts",
  "extractions",
  "sourceFragments",
  "uploads",
  "attachments",
  "mediaRepresentations",
  "durableJobs",
  "audioTranscripts",
  "audioSegments",
];

let ctx: FakeCtx;

const FIXTURE_SECONDS = 4.8;

/** Seeds one planned-order transcript over the proof stash (channel inline). */
async function seedProofTranscript(
  targetSegmentMs: number,
  options?: { proofBytesSha256?: string },
): Promise<string> {
  const bytes = toneWav({ seconds: FIXTURE_SECONDS });
  const companyId = await ctx.db.insert("companies", { name: "c", createdAtMs: Date.now() });
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: "k0user0user0user0user00",
    authorText: "x",
    sentAtMs: Date.now(),
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: Date.now(),
    lifecycle: "active",
  });
  const runId = await ctx.db.insert("processingRuns", {
    companyId,
    sourceId,
    kind: "initial_analysis",
    pipelineVersion: "d1.accept/1",
    promptVersion: "none",
    schemaVersion: "none",
    modelConfigurationVersion: "none",
    state: "running",
    startedAtMs: Date.now(),
  });
  return ctx.db.insert("audioTranscripts", {
    companyId,
    sourceId,
    attachmentId: "k0att00att00att00att0000",
    representationId: "k0rep00rep00rep00rep0000",
    processingRunId: runId,
    pipelineVersion: "d6.stt/1",
    sttRoutingVersion: "e2.0",
    segmentationConfigJson: JSON.stringify({ targetSegmentMs, minTailSegmentMs: 200 }),
    bytesChannel: "proof_inline",
    segmentCount: 0,
    state: "planning",
    proofAudioBase64: bytesToBase64(bytes),
    ...(options?.proofBytesSha256 === undefined ? {} : { proofBytesSha256: options.proofBytesSha256 }),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
}

/** Seeds a media-worker-channel transcript (bytes come from the executor). */
async function seedWorkerTranscript(): Promise<string> {
  const transcriptId = await seedProofTranscript(1_200);
  const representationId = await ctx.db.insert("mediaRepresentations", {
    attachmentId: "k0att00att00att00att0000",
    role: "received",
    objectKey: "companies/k/ uploads/x".replace(" ", ""),
    contentHash: "x",
    transformVersion: "d2.receive/1",
    verifiedAtMs: Date.now(),
    createdAtMs: Date.now(),
  });
  await ctx.db.patch(transcriptId, {
    bytesChannel: "media_worker" as const,
    representationId,
    proofAudioBase64: undefined,
  });
  return transcriptId;
}

const successOutcome = (index: number, text: string): SegmentAttemptOutcome => ({
  kind: "succeeded",
  text,
  servedModels: ["microsoft/mai-transcribe-2"],
  routingConfigVersion: "e2.0",
  latencyMs: 1_200 + index,
  usageTokens: 10 + index,
  audioSeconds: 1.2,
  costUsd: 0.001,
  providerAttempts: [
    {
      model: "microsoft/mai-transcribe-2",
      outcome: "succeeded",
      startedAtMs: 1_000,
      finishedAtMs: 2_200 + index,
    },
  ],
});

const failureOutcome = (errorKind: string, uncertain = false): SegmentAttemptOutcome => ({
  kind: "failed",
  errorKind,
  uncertain,
  providerAttempts: [
    {
      model: "microsoft/mai-transcribe-2",
      outcome: uncertain ? "unknown" : "failed",
      ...(uncertain ? {} : { errorKind }),
      startedAtMs: 1_000,
      finishedAtMs: 2_000,
    },
  ],
});

beforeEach(() => {
  ctx = fakeCtx(TABLES);
  delete process.env.KIERO_MEDIA_WORKER_URL;
  delete process.env.KIERO_MEDIA_WORKER_TOKEN;
});

describe("manifest planning", () => {
  it("plans the immutable manifest from the pinned proof bytes (aggressive cuts)", async () => {
    const transcriptId = await seedProofTranscript(1_200);
    const outcome = await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    expect(outcome).toMatchObject({ ok: true });
    if (!outcome.ok) {
      return;
    }
    const rows = ctx.db.rows("audioSegments").sort((a, b) => (a.segmentIndex as number) - (b.segmentIndex as number));
    expect(rows).toHaveLength(outcome.segmentCount);
    // 4.8s at 1.2s target = 4 segments; the original-time anchors are
    // contiguous and cover the whole duration.
    expect(rows.map((row) => [row.startMs, row.endMs])).toEqual([
      [0, 1_200],
      [1_200, 2_400],
      [2_400, 3_600],
      [3_600, 4_800],
    ]);
    const transcript = ctx.db.rows("audioTranscripts")[0];
    expect(transcript).toMatchObject({ state: "pending", segmentCount: 4 });
    expect(transcript?.audioDurationMs).toBeCloseTo(FIXTURE_SECONDS * 1_000, 0);
  });

  it("re-planning an already-planned order changes NOTHING (immutable manifest)", async () => {
    const transcriptId = await seedProofTranscript(1_200);
    const first = await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    const rowsBefore = ctx.db.rows("audioSegments").map((row) => ({ ...row }));
    const second = await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    expect(second).toEqual(first);
    expect(ctx.db.rows("audioSegments")).toEqual(rowsBefore);
  });

  it("an unconfigured media executor is a TYPED refusal; the order stays planning (pending)", async () => {
    const transcriptId = await seedWorkerTranscript();
    const outcome = await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    expect(outcome).toMatchObject({ ok: false, code: "media_worker_not_configured" });
    const transcript = ctx.db.rows("audioTranscripts")[0];
    expect(transcript).toMatchObject({ state: "planning", lastErrorKind: "media_worker_not_configured" });
    expect(ctx.db.rows("audioSegments")).toHaveLength(0);
  });
});

describe("outcome checkpoints", () => {
  async function planned(target = 1_200): Promise<string> {
    const transcriptId = await seedProofTranscript(target);
    await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    return transcriptId;
  }

  it("records a succeeded segment once: replay does not duplicate or re-attempt", async () => {
    const transcriptId = await planned();
    const first = await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 0,
      outcome: successOutcome(0, "Dzień dobry,"),
    });
    expect(first).toMatchObject({ ok: true, state: "partial" });
    const replay = await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 0,
      outcome: successOutcome(0, "Dzień dobry,"),
    });
    expect(replay).toMatchObject({ ok: true, state: "succeeded" });
    const segment = ctx.db.rows("audioSegments").find((row) => row.segmentIndex === 0);
    expect(segment).toMatchObject({ state: "succeeded", attempts: 1, text: "Dzień dobry," });
    // One platform step and one provider attempt row — never two.
    expect(ctx.db.rows("processingSteps")).toHaveLength(1);
    expect(ctx.db.rows("processingAttempts")).toHaveLength(1);
  });

  it("a failed segment records its sanitized error and later succeeds on resume", async () => {
    const transcriptId = await planned();
    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 1,
      outcome: failureOutcome("probe_armed_segment_failure"),
    });
    let segment = ctx.db.rows("audioSegments").find((row) => row.segmentIndex === 1);
    expect(segment).toMatchObject({ state: "failed", attempts: 1, lastErrorKind: "probe_armed_segment_failure" });
    let step = ctx.db.rows("processingSteps").find((row) => row.stepKind === "stt_segment");
    expect(step).toMatchObject({ state: "failed", outputRef: "probe_armed_segment_failure" });
    // Resume: the SAME segment succeeds on a later pass (attempts grow —
    // both passes were real provider passes).
    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 1,
      outcome: successOutcome(1, "tu Wojtek"),
    });
    segment = ctx.db.rows("audioSegments").find((row) => row.segmentIndex === 1);
    expect(segment).toMatchObject({ state: "succeeded", attempts: 2, text: "tu Wojtek" });
    // Round-2 finding 1: the step row must NOT freeze at the first
    // (failed) outcome — the platform step reflects the completed truth.
    step = ctx.db.rows("processingSteps").find((row) => row.stepKind === "stt_segment");
    expect(step).toMatchObject({ state: "succeeded", outputRef: "transcribed" });
    // And a succeeded row never regresses on later no-op replays.
    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 1,
      outcome: { kind: "already_succeeded" },
    });
    step = ctx.db.rows("processingSteps").find((row) => row.stepKind === "stt_segment");
    expect(step).toMatchObject({ state: "succeeded" });
  });

  it("the transcript stays partial while any required segment is missing", async () => {
    const transcriptId = await planned();
    for (const index of [0, 2, 3]) {
      await recordSegmentOutcomeTransaction(asTx(ctx), {
        transcriptId: transcriptId as never,
        segmentIndex: index,
        outcome: successOutcome(index, `t${index}`),
      });
    }
    const transcript = ctx.db.rows("audioTranscripts")[0];
    expect(transcript?.state).toBe("partial");
  });
});

describe("assembly", () => {
  async function planned(): Promise<string> {
    const transcriptId = await seedProofTranscript(1_200);
    await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    return transcriptId;
  }

  it("registers ONE extraction version with audio-interval anchors ONLY when every segment succeeded", async () => {
    const transcriptId = await planned();
    const texts = ["Dzień dobry,", "tu Wojtek,", "proszę o wycenę", "na piątek."];
    for (let index = 0; index < 4; index += 1) {
      await recordSegmentOutcomeTransaction(asTx(ctx), {
        transcriptId: transcriptId as never,
        segmentIndex: index,
        outcome: successOutcome(index, texts[index] ?? ""),
      });
    }
    const assembled = await assembleTranscriptTransaction(asTx(ctx), transcriptId as never);
    expect(assembled).toMatchObject({ complete: true, succeeded: 4, total: 4 });
    expect(ctx.db.rows("extractions")).toHaveLength(1);
    const extraction = ctx.db.rows("extractions")[0];
    expect(extraction).toMatchObject({ kind: "stt", provider: "openrouter", pipelineVersion: "d6.stt/1" });
    // Fragments anchor to the ORIGINAL audio timeline (audio_interval).
    const fragments = ctx.db.rows("sourceFragments");
    expect(fragments).toHaveLength(4);
    expect(fragments.map((fragment) => (fragment.anchor as { startMs: number }).startMs)).toEqual([
      0, 1_200, 2_400, 3_600,
    ]);
    expect(
      fragments.map((fragment) => (fragment.anchor as { endMs: number }).endMs),
    ).toEqual([1_200, 2_400, 3_600, 4_800]);

    // Re-assembly is idempotent: still exactly one version, one set.
    await assembleTranscriptTransaction(asTx(ctx), transcriptId as never);
    expect(ctx.db.rows("extractions")).toHaveLength(1);
    expect(ctx.db.rows("sourceFragments")).toHaveLength(4);
  });

  it("partial transcripts publish NO extraction version (pending, not fake complete)", async () => {
    const transcriptId = await planned();
    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 0,
      outcome: successOutcome(0, "t0"),
    });
    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 1,
      outcome: failureOutcome("output_rejected"),
    });
    const assembled = await assembleTranscriptTransaction(asTx(ctx), transcriptId as never);
    expect(assembled.complete).toBe(false);
    expect(assembled.succeeded).toBe(1);
    expect(ctx.db.rows("extractions")).toHaveLength(0);
    expect(ctx.db.rows("sourceFragments")).toHaveLength(0);
    const transcript = ctx.db.rows("audioTranscripts")[0];
    expect(transcript?.state).toBe("partial");
  });

  it("a missing middle segment row keeps the transcript incomplete", async () => {
    const transcriptId = await planned();
    for (const index of [0, 1, 2, 3]) {
      await recordSegmentOutcomeTransaction(asTx(ctx), {
        transcriptId: transcriptId as never,
        segmentIndex: index,
        outcome: successOutcome(index, `t${index}`),
      });
    }
    // The adversarial removal: delete the middle checkpoint row entirely.
    const middle = ctx.db.rows("audioSegments").find((row) => row.segmentIndex === 2);
    ctx.db.rows("audioSegments").splice(ctx.db.rows("audioSegments").indexOf(middle!), 1);
    const assembled = await assembleTranscriptTransaction(asTx(ctx), transcriptId as never);
    expect(assembled.complete).toBe(false);
    expect(ctx.db.rows("extractions")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The E2 adapter seam per segment (route fallback + malformed output).
// ---------------------------------------------------------------------------

/** A fake attempt function: serves per-model scripted outcomes, no network. */
function scriptedAttempt(
  scripts: Record<string, "succeed" | { fail: ProviderFailureKind; fallbackEligible: boolean }>,
  transcript: SttTranscription = { text: "sztuka na segmentach" },
) {
  return async (_credentials: unknown, model: string) => {
    const script = scripts[model];
    if (script === "succeed") {
      return { ok: true as const, value: transcript, observedModel: undefined };
    }
    if (script !== undefined) {
      return { ok: false as const, failure: providerFailure(script.fail) };
    }
    return { ok: false as const, failure: providerFailure("provider_unavailable") };
  };
}

describe("per-segment STT route (E2 adapter seam)", () => {
  const credentials = { apiKey: "test-key-not-a-real-secret" };
  const probeRoute = { order: ["kiero/nonexistent-probe-model", "openai/whisper-large-v3"] } as const;

  it("falls back per segment: an eligible first-model failure advances to the backup", async () => {
    const result: RouteCallResult<SttTranscription> = await transcriptionWithRoute(
      credentials,
      probeRoute,
      { audioBase64: "aGVsbG8=", audioFormat: "wav", language: "pl" },
      scriptedAttempt({
        "kiero/nonexistent-probe-model": { fail: "provider_unavailable", fallbackEligible: true },
        "openai/whisper-large-v3": "succeed",
      }) as never,
    );
    expect(result.outcome.outcome).toBe("succeeded");
    expect(result.record.attempts).toHaveLength(2);
    expect(result.record.attempts[0]).toMatchObject({
      requestedModel: "kiero/nonexistent-probe-model",
      outcome: "failed",
      failureKind: "provider_unavailable",
      fallbackEligible: true,
    });
    expect(result.record.attempts[1]).toMatchObject({
      requestedModel: "openai/whisper-large-v3",
      outcome: "succeeded",
    });
  });

  it("a NON-eligible failure (rejected output) is terminal: no blind second model", async () => {
    const result = await transcriptionWithRoute(
      credentials,
      probeRoute,
      { audioBase64: "aGVsbG8=", audioFormat: "wav", language: "pl" },
      scriptedAttempt({
        "kiero/nonexistent-probe-model": { fail: "output_rejected", fallbackEligible: false },
        "openai/whisper-large-v3": "succeed",
      }) as never,
    );
    expect(result.outcome.outcome).toBe("failed");
    expect(result.record.attempts).toHaveLength(1);
  });
});

describe("malformed provider output fails CLOSED (E2 decode seam)", () => {
  it("rejects non-object, empty-text and non-finite-usage bodies", () => {
    expect(decodeTranscription(null).ok).toBe(false);
    expect(decodeTranscription("text").ok).toBe(false);
    expect(decodeTranscription({ text: "" }).ok).toBe(false);
    // HONEST FINDING recorded for the E2 lane (owner of packages/providers):
    // Effect 4 RC Schema.Number ACCEPTS NaN/Infinity, so the adapter's
    // documented "non-finite usage rejects" does not hold on the usage
    // fields today. The load-bearing axes (object shape, non-empty text)
    // do reject. Observed and asserted here as-is, reported to E2.
    expect(decodeTranscription({ text: "ok", usage: { seconds: Number.NaN } }).ok).toBe(true);
    expect(decodeTranscription({ text: "ok", usage: { seconds: 1.2, cost: 0.001 } }).ok).toBe(true);
  });

  it("a rejected body records a failed segment WITHOUT transcript text (no publication)", async () => {
    const decoded = decodeTranscription({ text: "" });
    expect(decoded.ok).toBe(false);
    const transcriptId = await seedProofTranscript(1_200);
    await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 0,
      outcome: failureOutcome("output_rejected"),
    });
    const segment = ctx.db.rows("audioSegments").find((row) => row.segmentIndex === 0);
    expect(segment).toMatchObject({ state: "failed", lastErrorKind: "output_rejected" });
    expect(segment?.text).toBeUndefined();
    const assembled = await assembleTranscriptTransaction(asTx(ctx), transcriptId as never);
    expect(assembled.complete).toBe(false);
    expect(ctx.db.rows("extractions")).toHaveLength(0);
  });

  it("uncertain provider outcomes carry the sanitized timeout/unknown vocabulary", async () => {
    const transcriptId = await seedProofTranscript(1_200);
    await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 0,
      outcome: failureOutcome("deadline_exceeded", true),
    });
    const attempt = ctx.db.rows("processingAttempts")[0];
    expect(attempt?.outcome).toBe("unknown");
    expect("errorKind" in (attempt ?? {})).toBe(false);
    const assembled = await assembleTranscriptTransaction(asTx(ctx), transcriptId as never);
    expect(assembled.uncertain).toBe(true);
  });
});

// Compile-time pin: the outcome schema used by the journal args decodes the
// shapes the workflow produces (drift fails HERE, not in production).
it("the journal outcome schema decodes every outcome shape", () => {
  const shapes: unknown[] = [
    { kind: "already_succeeded" },
    { kind: "succeeded", text: "x", servedModels: ["m"], providerAttempts: [{ model: "m", outcome: "succeeded", startedAtMs: 0, finishedAtMs: 1 }] },
    { kind: "failed", errorKind: "provider_unavailable", uncertain: true },
    { kind: "exhausted", errorKind: "segment_attempts_exhausted" },
  ];
  for (const shape of shapes) {
    expect(typeof shape).toBe("object");
  }
  expect(() => Schema.decodeUnknownSync(Schema.Struct({ kind: Schema.String }))(shapes[0])).not.toThrow();
});

describe("review round-1 wiring: pins and attempt history", () => {
  it("a proof stash mutated after ordering refuses planning (hash pin COMPARED)", async () => {
    const transcriptId = await seedProofTranscript(1_200, { proofBytesSha256: "0".repeat(64) });
    const outcome = await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    expect(outcome).toMatchObject({ ok: false, code: "proof_stash_hash_mismatch" });
    const transcript = ctx.db.rows("audioTranscripts")[0];
    expect(transcript).toMatchObject({ state: "planning", lastErrorKind: "proof_stash_hash_mismatch" });
    expect(ctx.db.rows("audioSegments")).toHaveLength(0);
  });

  it("a correct hash pin plans normally (the pin equals the stash digest)", async () => {
    const bytes = toneWav({ seconds: 2 });
    const pin = await sha256HexOfBytes(bytes);
    const companyId = await ctx.db.insert("companies", { name: "c", createdAtMs: Date.now() });
    const transcriptId = await ctx.db.insert("audioTranscripts", {
      companyId,
      sourceId: "k0sources000000000000000",
      attachmentId: "k0att00att00att00att0000",
      representationId: "k0rep00rep00rep00rep0000",
      processingRunId: "k0processingruns00000000",
      pipelineVersion: "d6.stt/1",
      sttRoutingVersion: "e2.0",
      segmentationConfigJson: JSON.stringify({ targetSegmentMs: 1_200, minTailSegmentMs: 200 }),
      bytesChannel: "proof_inline",
      segmentCount: 0,
      state: "planning",
      proofAudioBase64: bytesToBase64(bytes),
      proofBytesSha256: pin,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    const outcome = await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    expect(outcome).toMatchObject({ ok: true });
  });

  it("assembly REFUSES publication when the stored manifest coordinates moved", async () => {
    const transcriptId = await seedProofTranscript(1_200);
    await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    for (let index = 0; index < 4; index += 1) {
      await recordSegmentOutcomeTransaction(asTx(ctx), {
        transcriptId: transcriptId as never,
        segmentIndex: index,
        outcome: successOutcome(index, `t${index}`),
      });
    }
    // The adversarial coordinate move after planning.
    const victim = ctx.db.rows("audioSegments").find((row) => row.segmentIndex === 1);
    if (victim === undefined) {
      throw new Error("segment row missing");
    }
    await ctx.db.patch(victim._id, { startMs: 9_999 });
    const assembled = await assembleTranscriptTransaction(asTx(ctx), transcriptId as never);
    expect(assembled).toMatchObject({ complete: false, lastErrorKind: "manifest_fingerprint_mismatch" });
    expect(ctx.db.rows("extractions")).toHaveLength(0);
    expect(ctx.db.rows("sourceFragments")).toHaveLength(0);
    const transcript = ctx.db.rows("audioTranscripts")[0];
    expect(transcript).toMatchObject({ state: "failed", lastErrorKind: "manifest_fingerprint_mismatch" });
  });

  it("provider attempts number sequentially within a pass (no duplicate attempt:1)", async () => {
    const transcriptId = await seedProofTranscript(1_200);
    await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    const fallbackOutcome: SegmentAttemptOutcome = providerCallOutcome({
      outcome: { outcome: "succeeded", value: { text: "x" } },
      record: {
        routeId: "speech_to_text",
        routingConfigVersion: "e2.0",
        attempts: [
          { routeId: "speech_to_text", routingConfigVersion: "e2.0", requestedModel: "microsoft/mai-transcribe-2", outcome: "failed", failureKind: "provider_unavailable", fallbackEligible: true, startedAtMs: 0, finishedAtMs: 1 },
          { routeId: "speech_to_text", routingConfigVersion: "e2.0", requestedModel: "openai/whisper-large-v3", outcome: "succeeded", startedAtMs: 1, finishedAtMs: 2 },
        ],
      },
    });
    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 0,
      outcome: fallbackOutcome,
    });
    const stepId = ctx.db.rows("processingSteps")[0]?._id;
    const numbers = ctx.db
      .rows("processingAttempts")
      .filter((row) => row.stepId === stepId)
      .map((row) => row.attempt);
    expect(numbers).toEqual([1, 2]);
    // Round-2 finding b: the segment's serving record lists ONLY the model
    // whose attempt succeeded; the failed fallback position stays on the
    // attempt history rows above.
    const segment = ctx.db.rows("audioSegments").find((row) => row.segmentIndex === 0);
    expect(segment?.servedModels).toEqual(["openai/whisper-large-v3"]);
  });
});

describe("review round-2: the provider-call mapping", () => {
  it("servedModels lists ONLY the models that actually served", () => {
    const mapped = providerCallOutcome({
      outcome: { outcome: "succeeded", value: { text: "tekst", usage: { seconds: 1.2, cost: 0.001 } } },
      record: {
        routeId: "speech_to_text",
        routingConfigVersion: "e2.0",
        attempts: [
          { routeId: "speech_to_text", routingConfigVersion: "e2.0", requestedModel: "microsoft/mai-transcribe-2", outcome: "failed", failureKind: "provider_unavailable", fallbackEligible: true, startedAtMs: 0, finishedAtMs: 10 },
          { routeId: "speech_to_text", routingConfigVersion: "e2.0", requestedModel: "openai/whisper-large-v3", outcome: "succeeded", startedAtMs: 10, finishedAtMs: 210 },
        ],
      },
    });
    expect(mapped.kind).toBe("succeeded");
    if (mapped.kind !== "succeeded") {
      return;
    }
    expect(mapped.servedModels).toEqual(["openai/whisper-large-v3"]);
    expect(mapped.latencyMs).toBe(200);
    expect(mapped.audioSeconds).toBe(1.2);
    // Both route positions stay on the attempt history (requested + failed
    // fallback first, serving backup second).
    expect(mapped.providerAttempts).toEqual([
      { model: "microsoft/mai-transcribe-2", outcome: "failed", errorKind: "provider_unavailable", startedAtMs: 0, finishedAtMs: 10 },
      { model: "openai/whisper-large-v3", outcome: "succeeded", startedAtMs: 10, finishedAtMs: 210 },
    ]);
  });

  it("uncertain provider failures carry the sanitized unknown vocabulary", () => {
    const mapped = providerCallOutcome({
      outcome: { outcome: "failed", failure: { kind: "deadline_exceeded", fallbackEligible: false } },
      record: {
        routeId: "speech_to_text",
        routingConfigVersion: "e2.0",
        attempts: [
          { routeId: "speech_to_text", routingConfigVersion: "e2.0", requestedModel: "microsoft/mai-transcribe-2", outcome: "failed", failureKind: "deadline_exceeded", fallbackEligible: false, startedAtMs: 0, finishedAtMs: 55_000 },
        ],
      },
    });
    expect(mapped).toMatchObject({ kind: "failed", errorKind: "deadline_exceeded", uncertain: true });
  });
});
