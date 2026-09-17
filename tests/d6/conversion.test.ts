/**
 * R30 tests: the container's FFmpeg conversion boundary (the voice byte
 * channel) and the Convex typed-code pass-through.
 *
 * The real FFmpeg spawn is container-only — the image ships the binary, the
 * npm/test environment does not. These tests therefore drive exactly the
 * seams production wires:
 *
 * - the protocol boundary with an INJECTED converter (the same
 *   `serveSegmentRequest` the container server runs): non-WAV audio
 *   converts, the converted WAV is measured/sliced with the existing exact
 *   PCM discipline, WAV objects never convert, converter-less surfaces keep
 *   `format_requires_container`, and every converter refusal is relayed as
 *   its typed code;
 * - the FFmpeg module's spawn-free decisions: the pure output bounds check
 *   and the converter's typed input discipline (including a cache HIT, which
 *   never reaches the binary);
 * - the bounded, process-local disk cache with real temp files;
 * - /healthz stating the conversion capability honestly per surface;
 * - Convex carrying the protocol's typed `code` through instead of the
 *   `media_worker_refused` collapse — down to `lastErrorKind` naming the
 *   real cause (the D7 staging symptom).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEAD_WINDOW_BYTES,
  handleMediaProtocol,
  serveSegmentRequest,
  type AudioConverter,
  type ObjectReader,
  type SegmentRefusal,
} from "@kiero/media-worker/segment-service";
import {
  FFMPEG_CONVERSION_BOUNDS,
  ConversionCache,
  assessConvertedWav,
  conversionCacheKey,
  ffmpegConverter,
  type ConversionBounds,
} from "@kiero/media-worker/convert";
import { base64ToBytes, serializeWav, sliceWav, toneWav } from "@kiero/media-worker/wav";
import { probeFromMediaWorker } from "../../convex/processing/audio/media";
import { ensureManifestTransaction } from "../../convex/processing/audio/executor";
import { asTx, fakeCtx, type FakeCtx } from "../d2/harness";

/** The composer's retained container (webm/opus): EBML magic, never WAV. */
const WEBM = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3, 0x96, 0x19, 0x4f, 0x80, 0x00, 0x42, 0x81, 0x00, 0x00, 0x80, 0x00, 0x00,
]);

/** A real PCM WAV the fake converter "produced" (6 s, 8 kHz mono). */
const CONVERTED = toneWav({ seconds: 6 });
const WAV_FIXTURE = toneWav({ seconds: 6 });

/** An in-memory ranged reader that records every window it served. */
function recordingReader(bytes: Uint8Array, log: { start: number; end: number }[]): ObjectReader {
  return async (_objectKey, range) => {
    if (range === undefined) {
      log.push({ start: 0, end: bytes.length - 1 });
      return bytes;
    }
    log.push({ start: range.start, end: range.end });
    return bytes.subarray(range.start, range.end + 1);
  };
}

/** A converter scripted with one outcome that records its calls. */
function scriptedConverter(
  outcome: { ok: true; wav: Uint8Array } | { ok: false; code: SegmentRefusal },
  calls: string[],
): AudioConverter {
  return async (call) => {
    calls.push(call.objectKey);
    return outcome;
  };
}

describe("the conversion boundary (an injected converter, the container wiring)", () => {
  it("probe converts non-WAV audio and measures the CONVERTED WAV", async () => {
    const log: { start: number; end: number }[] = [];
    const calls: string[] = [];
    const probed = await serveSegmentRequest(
      recordingReader(WEBM, log),
      { op: "probe", objectKey: "voice.webm" },
      scriptedConverter({ ok: true, wav: CONVERTED }, calls),
    );
    expect(probed).toMatchObject({ ok: true, format: "wav", sampleRate: 8_000, converted: true });
    if (!probed.ok || !("durationMs" in probed)) {
      throw new Error("expected ok probe");
    }
    expect(probed.durationMs).toBeCloseTo(6_000, 3);
    expect(calls).toEqual(["voice.webm"]);
    // The bounded read first: the 8 KiB head window, THEN conversion.
    expect(log).toEqual([{ start: 0, end: HEAD_WINDOW_BYTES }]);
  });

  it("segment converts once and slices the CONVERTED WAV with the exact PCM discipline", async () => {
    const log: { start: number; end: number }[] = [];
    const calls: string[] = [];
    const served = await serveSegmentRequest(
      recordingReader(WEBM, log),
      { op: "segment", objectKey: "voice.webm", startMs: 1_234.9, endMs: 3_210.1 },
      scriptedConverter({ ok: true, wav: CONVERTED }, calls),
    );
    if (!served.ok || !("audioBase64" in served)) {
      throw new Error("expected ok segment");
    }
    // Byte-identical to the proof channel's slicing of the SAME converted
    // WAV: the two byte channels cannot disagree.
    const proofSliced = sliceWav(CONVERTED, 1_234.9, 3_210.1);
    if (!proofSliced.ok) {
      throw new Error("expected proof slice ok");
    }
    expect(base64ToBytes(served.audioBase64)).toEqual(proofSliced.bytes);
    expect(served.durationMs).toBeCloseTo(proofSliced.durationMs, 6);
    expect(served.converted).toBe(true);
    expect(calls).toEqual(["voice.webm"]);
  });

  it("intervals are checked against the CONVERTED duration", async () => {
    const calls: string[] = [];
    const served = await serveSegmentRequest(
      recordingReader(WEBM, []),
      { op: "segment", objectKey: "voice.webm", startMs: 7_000, endMs: 8_000 },
      scriptedConverter({ ok: true, wav: CONVERTED }, calls),
    );
    expect(served).toMatchObject({ ok: false, code: "interval_out_of_range" });
  });

  it("a WAV object never invokes the converter (the exact ranged fast path is unchanged)", async () => {
    const log: { start: number; end: number }[] = [];
    const converter: AudioConverter = async () => {
      throw new Error("the converter must not run for PCM WAV objects");
    };
    const probed = await serveSegmentRequest(
      recordingReader(WAV_FIXTURE, log),
      { op: "probe", objectKey: "voice.wav" },
      converter,
    );
    expect(probed).toMatchObject({ ok: true, format: "wav" });
    expect("converted" in probed).toBe(false);
    expect(log).toEqual([{ start: 0, end: HEAD_WINDOW_BYTES }]);
  });

  it("without a converter non-WAV still answers format_requires_container (isolates cannot spawn)", async () => {
    expect(
      await serveSegmentRequest(recordingReader(WEBM, []), { op: "probe", objectKey: "voice.webm" }),
    ).toMatchObject({ ok: false, code: "format_requires_container" });
    expect(
      await serveSegmentRequest(recordingReader(WEBM, []), {
        op: "segment",
        objectKey: "voice.webm",
        startMs: 0,
        endMs: 1_000,
      }),
    ).toMatchObject({ ok: false, code: "format_requires_container" });
  });

  it("every converter refusal is relayed as its typed code", async () => {
    const relayed: SegmentRefusal[] = [
      "conversion_unavailable",
      "conversion_input_too_large",
      "conversion_output_too_large",
      "conversion_output_too_long",
      "conversion_timed_out",
      "conversion_failed",
      "object_not_found",
    ];
    for (const code of relayed) {
      const calls: string[] = [];
      expect(
        await serveSegmentRequest(
          recordingReader(WEBM, []),
          { op: "probe", objectKey: "voice.webm" },
          scriptedConverter({ ok: false, code }, calls),
        ),
      ).toMatchObject({ ok: false, code });
      expect(calls).toEqual(["voice.webm"]);
    }
  });

  it("a converter whose output is not PCM WAV refuses conversion_failed (never a served guess)", async () => {
    expect(
      await serveSegmentRequest(
        recordingReader(WEBM, []),
        { op: "probe", objectKey: "voice.webm" },
        scriptedConverter({ ok: true, wav: WEBM }, []),
      ),
    ).toMatchObject({ ok: false, code: "conversion_failed" });
  });

  it("missing objects refuse object_not_found before any conversion", async () => {
    const missing: ObjectReader = async () => null;
    const converter: AudioConverter = async () => {
      throw new Error("the converter must not run for a missing object");
    };
    expect(
      await serveSegmentRequest(missing, { op: "probe", objectKey: "gone" }, converter),
    ).toMatchObject({ ok: false, code: "object_not_found" });
  });
});

describe("the FFmpeg bounds (pure decisions, no spawn)", () => {
  it("a converted WAV within the bounds parses and passes", () => {
    const assessed = assessConvertedWav(toneWav({ seconds: 2 }), FFMPEG_CONVERSION_BOUNDS);
    expect(assessed).toMatchObject({ ok: true });
    if (!assessed.ok) {
      return;
    }
    expect(assessed.header.sampleRate).toBe(8_000);
  });

  it("a converted WAV beyond the duration cap refuses conversion_output_too_long (never truncated)", () => {
    const bounds: ConversionBounds = { ...FFMPEG_CONVERSION_BOUNDS, maxOutputDurationMs: 1_500 };
    expect(assessConvertedWav(toneWav({ seconds: 2 }), bounds)).toMatchObject({
      ok: false,
      code: "conversion_output_too_long",
    });
  });

  it("a converted WAV at the output byte cap refuses conversion_output_too_large (never served truncated)", () => {
    const pcmHeader = {
      audioFormat: 1,
      channels: 1,
      sampleRate: 8_000,
      bitsPerSample: 16,
      byteRate: 16_000,
      blockAlign: 2,
    };
    const wav = serializeWav(pcmHeader, new Uint8Array(1_000));
    expect(wav).toHaveLength(1_044);
    const atCap: ConversionBounds = { ...FFMPEG_CONVERSION_BOUNDS, maxOutputBytes: wav.length };
    expect(assessConvertedWav(wav, atCap)).toMatchObject({
      ok: false,
      code: "conversion_output_too_large",
    });
    const oneByteMore: ConversionBounds = { ...FFMPEG_CONVERSION_BOUNDS, maxOutputBytes: wav.length + 1 };
    expect(assessConvertedWav(wav, oneByteMore)).toMatchObject({ ok: true });
  });

  it("non-WAV conversion output refuses conversion_failed", () => {
    expect(assessConvertedWav(WEBM, FFMPEG_CONVERSION_BOUNDS)).toMatchObject({
      ok: false,
      code: "conversion_failed",
    });
  });
});

describe("the FFmpeg converter's typed input discipline (pre-spawn; no binary needed)", () => {
  const tinyBounds: ConversionBounds = { ...FFMPEG_CONVERSION_BOUNDS, maxInputBytes: 8 };

  it("a missing object refuses object_not_found", async () => {
    const missing: ObjectReader = async () => null;
    const converted = await ffmpegConverter({ bounds: tinyBounds })({
      objectKey: "gone",
      readObject: missing,
    });
    expect(converted).toMatchObject({ ok: false, code: "object_not_found" });
  });

  it("an empty read refuses object_read_failed", async () => {
    const empty: ObjectReader = async () => new Uint8Array(0);
    const converted = await ffmpegConverter({ bounds: tinyBounds })({
      objectKey: "k",
      readObject: empty,
    });
    expect(converted).toMatchObject({ ok: false, code: "object_read_failed" });
  });

  it("an input beyond the cap refuses conversion_input_too_large, reading ONLY the cap window", async () => {
    const log: { start: number; end: number }[] = [];
    const reader = recordingReader(new Uint8Array(tinyBounds.maxInputBytes + 1), log);
    const converted = await ffmpegConverter({ bounds: tinyBounds })({ objectKey: "k", readObject: reader });
    expect(converted).toMatchObject({ ok: false, code: "conversion_input_too_large" });
    expect(log).toEqual([{ start: 0, end: tinyBounds.maxInputBytes }]);
  });

  it("a cache HIT serves the cached WAV without any spawn (idempotent per object version)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kiero-convert-test-"));
    try {
      // The cache owns its directory (wiped on first use, like production's
      // fixed dir); the seeded temp file must live OUTSIDE it, exactly like
      // the converter's mkdtemp working directory does.
      const cache = new ConversionCache(join(dir, "cache"), 1024 * 1024);
      const tempPath = join(dir, "seed.wav");
      await writeFile(tempPath, CONVERTED);
      await cache.store(conversionCacheKey(WEBM), tempPath, CONVERTED.length);
      const reader = recordingReader(WEBM, []);
      // No ffmpeg binary in this environment: reaching the spawn would end
      // in conversion_unavailable — a cache hit proves the spawn never ran.
      // (The cap must admit the 16-byte fixture input BEFORE the cache.)
      const bounds: ConversionBounds = { ...FFMPEG_CONVERSION_BOUNDS, maxInputBytes: WEBM.length };
      const converted = await ffmpegConverter({ bounds, cache })({
        objectKey: "voice.webm",
        readObject: reader,
      });
      expect(converted).toMatchObject({ ok: true });
      if (!converted.ok) {
        throw new Error("expected cache hit");
      }
      expect(converted.wav).toEqual(CONVERTED);
      expect(conversionCacheKey(WEBM)).not.toBe(conversionCacheKey(WAV_FIXTURE));
      expect(conversionCacheKey(WEBM)).toBe(conversionCacheKey(new Uint8Array(WEBM)));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the bounded conversion cache (disk, process-local)", () => {
  async function seed(dir: string, name: string, bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
    const path = join(dir, `${name}.tmp`);
    await writeFile(path, bytes);
    return { path, bytes: bytes.length };
  }

  it("stores, reads back byte-identically and evicts least-recent over the budget", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kiero-convert-test-"));
    try {
      const a = toneWav({ seconds: 1 });
      const b = toneWav({ seconds: 1 });
      const c = toneWav({ seconds: 1 });
      // Budget fits exactly two entries; the third must evict.
      const cache = new ConversionCache(join(dir, "cache"), a.length + b.length);
      const entryA = await seed(dir, "a", a);
      const entryB = await seed(dir, "b", b);
      const entryC = await seed(dir, "c", c);
      await cache.store("a", entryA.path, entryA.bytes);
      await cache.store("b", entryB.path, entryB.bytes);
      // Touch ONLY a: it becomes most recent, b stays least recent.
      expect(await cache.read("a")).toEqual(a);
      // The incoming c exceeds the budget and must evict b (least recent).
      await cache.store("c", entryC.path, entryC.bytes);
      expect(await cache.read("b")).toBeNull();
      expect(await cache.read("a")).toEqual(a);
      expect(await cache.read("c")).toEqual(c);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("an entry larger than the whole budget is simply not cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kiero-convert-test-"));
    try {
      const big = toneWav({ seconds: 1 });
      const cache = new ConversionCache(join(dir, "cache"), big.length - 1);
      const entry = await seed(dir, "big", big);
      await cache.store("big", entry.path, entry.bytes);
      expect(await cache.read("big")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("healthz states the conversion capability honestly per surface", () => {
  it("the shared default: conversion is the container surface's job only", async () => {
    const response = await handleMediaProtocol(new Request("https://media.test/healthz"), {
      ENVIRONMENT: "dev",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      wavSlicing: "ranged-exact",
      ffmpegConversion: "container-only",
    });
  });

  it("the container states its VERIFIED ffmpeg state", async () => {
    for (const [conversionHealth, expected] of [
      ["ffmpeg-bounded", "ffmpeg-bounded"],
      ["ffmpeg-unavailable", "ffmpeg-unavailable"],
    ] as const) {
      const response = await handleMediaProtocol(
        new Request("https://media.test/healthz"),
        { ENVIRONMENT: "dev" },
        { conversionHealth },
      );
      expect(await response.json()).toMatchObject({ ok: true, ffmpegConversion: expected });
    }
  });
});

// ---------------------------------------------------------------------------
// The Convex typed-code pass-through (R30).
// ---------------------------------------------------------------------------

const TABLES = [
  "companies",
  "sources",
  "processingRuns",
  "mediaRepresentations",
  "audioTranscripts",
  "audioSegments",
];

let ctx: FakeCtx;

/** A JSON HTTP answer for the stubbed fetch. */
function jsonAnswer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Seeds one media-worker-channel transcript in the planning state. */
async function seedWorkerChannelTranscript(): Promise<string> {
  const nowMs = Date.now();
  const companyId = await ctx.db.insert("companies", { name: "c", createdAtMs: nowMs });
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: "k0user0user0user0user00",
    authorText: "x",
    sentAtMs: nowMs,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: nowMs,
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
    startedAtMs: nowMs,
  });
  const representationId = await ctx.db.insert("mediaRepresentations", {
    attachmentId: "k0att00att00att00att0000",
    role: "retained",
    objectKey: "companies/k/attachments/voice.webm",
    contentHash: "x",
    transformVersion: "d2.receive/1",
    verifiedAtMs: nowMs,
    createdAtMs: nowMs,
  });
  return ctx.db.insert("audioTranscripts", {
    companyId,
    sourceId,
    attachmentId: "k0att00att00att00att0000",
    representationId,
    processingRunId: runId,
    pipelineVersion: "d6.stt/1",
    sttRoutingVersion: "e2.0",
    segmentationConfigJson: JSON.stringify({ targetSegmentMs: 1_200, minTailSegmentMs: 200 }),
    bytesChannel: "media_worker",
    segmentCount: 0,
    state: "planning",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
}

beforeEach(() => {
  ctx = fakeCtx(TABLES);
  process.env.KIERO_MEDIA_WORKER_URL = "https://media.test";
  process.env.KIERO_MEDIA_WORKER_TOKEN = "proof-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.KIERO_MEDIA_WORKER_URL;
  delete process.env.KIERO_MEDIA_WORKER_TOKEN;
});

describe("the Convex typed-code pass-through", () => {
  it("carries the protocol's typed code instead of the generic collapse", async () => {
    for (const code of ["format_requires_container", "conversion_output_too_long", "object_not_found"] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonAnswer(422, { ok: false, code })),
      );
      const probed = await probeFromMediaWorker("voice.webm");
      expect(probed).toMatchObject({ ok: false, code });
    }
  });

  it("falls back to media_worker_refused for unknown codes, boundary codes and non-JSON bodies", async () => {
    for (const answer of [
      jsonAnswer(422, { ok: false, code: "definitely_not_a_closed_code" }),
      jsonAnswer(401, { ok: false, code: "unauthorized" }),
      jsonAnswer(503, { ok: false, code: "not_configured" }),
      new Response("not json", { status: 422 }),
    ]) {
      vi.stubGlobal("fetch", vi.fn(async () => answer));
      expect(await probeFromMediaWorker("voice.webm")).toMatchObject({
        ok: false,
        code: "media_worker_refused",
      });
    }
  });

  it("keeps the unreachable/not-configured/malformed-response codes honest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await probeFromMediaWorker("voice.webm")).toMatchObject({
      ok: false,
      code: "media_worker_unreachable",
    });
    delete process.env.KIERO_MEDIA_WORKER_URL;
    expect(await probeFromMediaWorker("voice.webm")).toMatchObject({
      ok: false,
      code: "media_worker_not_configured",
    });
    process.env.KIERO_MEDIA_WORKER_URL = "https://media.test";
    vi.stubGlobal("fetch", vi.fn(async () => jsonAnswer(200, "not the shape")));
    expect(await probeFromMediaWorker("voice.webm")).toMatchObject({
      ok: false,
      code: "media_worker_malformed_response",
    });
  });

  it("a converted probe answer still decodes (the added field breaks nothing)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonAnswer(200, { ok: true, format: "wav", durationMs: 6_000, converted: true })),
    );
    expect(await probeFromMediaWorker("voice.webm")).toMatchObject({ ok: true, durationMs: 6_000 });
  });

  it("ensureManifest records the REAL cause on lastErrorKind (the D7 staging symptom)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonAnswer(422, { ok: false, code: "format_requires_container" })),
    );
    const transcriptId = await seedWorkerChannelTranscript();
    const outcome = await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    expect(outcome).toMatchObject({ ok: false, code: "format_requires_container" });
    const transcript = ctx.db.rows("audioTranscripts")[0];
    expect(transcript).toMatchObject({
      state: "planning",
      lastErrorKind: "format_requires_container",
    });
    expect(ctx.db.rows("audioSegments")).toHaveLength(0);
  });

  it("a manifest plans over the converted duration the worker-channel probe reports", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonAnswer(200, { ok: true, format: "wav", durationMs: 4_800, converted: true })),
    );
    const transcriptId = await seedWorkerChannelTranscript();
    const outcome = await ensureManifestTransaction(asTx(ctx), transcriptId as never);
    expect(outcome).toMatchObject({ ok: true, segmentCount: 4 });
    expect(ctx.db.rows("audioTranscripts")[0]).toMatchObject({ state: "pending", segmentCount: 4 });
  });
});
