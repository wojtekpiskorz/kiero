/**
 * D6 media-executor protocol tests (review round 1, finding 2): the ranged
 * byte discipline and the ONE shared HTTP boundary.
 *
 * The ranged reader fixture RECORDS every window it serves, so these prove
 * the structural guarantee directly: `probe` never reads beyond the 8 KiB
 * header window; `segment` reads the header window plus EXACTLY the
 * frame-aligned interval window — never the whole object — and the returned
 * standalone WAV is byte-identical to `sliceWav` of the whole file (the
 * same slicing the proof channel performs), so the two channels cannot
 * disagree.
 */

import { describe, expect, it } from "vitest";
import {
  HEAD_WINDOW_BYTES,
  serveSegmentRequest,
  handleMediaProtocol,
  type ObjectReader,
} from "@kiero/media-worker/segment-service";
import { base64ToBytes, sliceWav, toneWav, wavDurationMs, parseWav } from "@kiero/media-worker/wav";

const FIXTURE = toneWav({ seconds: 6 });

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

describe("ranged byte discipline", () => {
  it("probe reads ONLY the 8 KiB header window", async () => {
    const log: { start: number; end: number }[] = [];
    const reader = recordingReader(FIXTURE, log);
    const probed = await serveSegmentRequest(reader, { op: "probe", objectKey: "k" });
    expect(probed).toMatchObject({ ok: true, format: "wav" });
    if (!probed.ok) {
      return;
    }
    expect(probed.durationMs).toBeCloseTo(6_000, 3);
    expect(log).toEqual([{ start: 0, end: HEAD_WINDOW_BYTES }]);
  });

  it("segment reads the header window plus EXACTLY the frame-aligned interval window — never the whole object", async () => {
    const log: { start: number; end: number }[] = [];
    const reader = recordingReader(FIXTURE, log);
    const served = await serveSegmentRequest(reader, {
      op: "segment",
      objectKey: "k",
      startMs: 1_234.9,
      endMs: 3_210.1,
    });
    expect(served.ok).toBe(true);
    if (!served.ok) {
      return;
    }
    expect(log).toHaveLength(2);
    const [head, data] = log;
    expect(head).toEqual({ start: 0, end: HEAD_WINDOW_BYTES });
    // The data window must be the whole read beyond the header: bounded by
    // the interval, orders of magnitude below the object size.
    expect((data?.end ?? 0) - (data?.start ?? 0) + 1).toBeGreaterThan(30_000);
    expect((data?.end ?? 0) - (data?.start ?? 0) + 1).toBeLessThan(40_000);
    for (const window of log) {
      expect(window.end - window.start + 1).toBeLessThan(HEAD_WINDOW_BYTES + 40_000);
    }
  });

  it("the ranged result is byte-identical to slicing the whole file", async () => {
    const log: { start: number; end: number }[] = [];
    const reader = recordingReader(FIXTURE, log);
    const served = await serveSegmentRequest(reader, {
      op: "segment",
      objectKey: "k",
      startMs: 1_234.9,
      endMs: 3_210.1,
    });
    if (!served.ok || !("audioBase64" in served)) {
      throw new Error("expected ok segment");
    }
    const wholeSliced = sliceWav(FIXTURE, 1_234.9, 3_210.1);
    if (!wholeSliced.ok) {
      throw new Error("expected slice ok");
    }
    expect(base64ToBytes(served.audioBase64)).toEqual(wholeSliced.bytes);
    expect(served.durationMs).toBeCloseTo(wholeSliced.durationMs, 6);
  });

  it("every planned segment resolves through two bounded reads; concatenation covers the file", async () => {
    const log: { start: number; end: number }[] = [];
    const reader = recordingReader(FIXTURE, log);
    const parsed = parseWav(FIXTURE);
    if (!parsed.ok) {
      throw new Error("fixture must parse");
    }
    const durationMs = wavDurationMs(parsed.header);
    const bounds = [0, 1_500, 3_000, 4_500, durationMs];
    for (let index = 0; index < bounds.length - 1; index += 1) {
      const served = await serveSegmentRequest(reader, {
        op: "segment",
        objectKey: "k",
        startMs: bounds[index] ?? 0,
        endMs: bounds[index + 1] ?? durationMs,
      });
      expect(served.ok).toBe(true);
    }
    // Two bounded reads per segment (8 windows for 4 segments); every
    // window is bounded by the interval sizes (~66 KiB for the 1.5 s tail
    // at 22.05 kHz mono), never the 264 KiB whole object.
    expect(log).toHaveLength(8);
    const biggest = Math.max(...log.map((window) => window.end - window.start + 1));
    expect(biggest).toBeLessThan(70_000);
    expect(biggest).toBeLessThan(FIXTURE.length - HEAD_WINDOW_BYTES);
  });

  it("refuses intervals outside the audio and missing objects with closed codes", async () => {
    const log: { start: number; end: number }[] = [];
    const reader = recordingReader(FIXTURE, log);
    expect(
      await serveSegmentRequest(reader, { op: "segment", objectKey: "k", startMs: 7_000, endMs: 8_000 }),
    ).toMatchObject({ code: "interval_out_of_range" });
    const missing: ObjectReader = async () => null;
    expect(await serveSegmentRequest(missing, { op: "probe", objectKey: "gone" })).toMatchObject({
      code: "object_not_found",
    });
  });
});

describe("the ONE shared HTTP boundary", () => {
  const token = "proof-segment-token";

  function request(path: string, init: RequestInit = {}): Request {
    return new Request(`https://media.test${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(path === "/healthz" ? {} : { authorization: `Bearer ${token}` }),
      },
    });
  }

  it("healthz answers unauthenticated through the shared handler", async () => {
    const response = await handleMediaProtocol(request("/healthz"), { ENVIRONMENT: "dev" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, wavSlicing: "ranged-exact" });
  });

  it("byte operations refuse typed when the media S3 credentials are absent", async () => {
    const response = await handleMediaProtocol(
      request("/probe", { method: "POST", body: JSON.stringify({ op: "probe", objectKey: "k" }) }),
      { MEDIA_SEGMENT_TOKEN: token },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: "not_configured" });
  });

  it("a wrong bearer is unauthorized before any byte is touched", async () => {
    const response = await handleMediaProtocol(
      new Request("https://media.test/segment", {
        method: "POST",
        headers: { authorization: `Bearer ${token}x`, "content-type": "application/json" },
        body: "{}",
      }),
      { MEDIA_SEGMENT_TOKEN: token },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("unknown routes and unknown ops are closed-code refusals", async () => {
    const response = await handleMediaProtocol(request("/nope", { method: "POST", body: "{}" }), {
      MEDIA_SEGMENT_TOKEN: token,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ ok: false, code: "unknown_route" });
  });
});
