/**
 * D6 focused tests: the shared WAV module (the ONE byte authority both the
 * media executor and the Convex workflow use).
 *
 * These prove the time-mapping correctness of slicing: a planned interval
 * produces a standalone decodable WAV whose duration equals the asked
 * interval within one sample frame, the concatenation of all planned
 * segments covers the original data exactly, and every refusal is a closed
 * typed code (no fabricated conversions).
 */

import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  parseWav,
  serializeWav,
  sliceWav,
  toneWav,
  wavDurationMs,
} from "@kiero/media-worker/wav";
import { planSegments, DEFAULT_SEGMENTATION_CONFIG } from "../../convex/processing/audio/segmentation";

const fixture = toneWav({ seconds: 5 });

describe("header parsing", () => {
  it("parses the synthetic fixture as PCM WAV with exact duration", () => {
    const parsed = parseWav(fixture);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.header.channels).toBe(1);
      expect(parsed.header.sampleRate).toBe(8_000);
      expect(parsed.header.bitsPerSample).toBe(16);
      expect(parsed.header.blockAlign).toBe(2);
      expect(wavDurationMs(parsed.header)).toBeCloseTo(5_000, 5);
    }
  });

  it("refuses garbage and non-WAV containers with closed codes", () => {
    expect(parseWav(new Uint8Array([1, 2, 3]))).toMatchObject({ code: "truncated" });
    const webmish = new TextEncoder().encode("\x1aE\xdf\xa3B\x86\x81\x01B\xf7\x81\x01B\xf2\x81\x04B\xf3\x81\x08");
    expect(parseWav(webmish)).toMatchObject({ code: "not_wav" });
    const riffButEmpty = new Uint8Array(44);
    riffButEmpty.set([0x52, 0x49, 0x46, 0x46], 0);
    riffButEmpty.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(parseWav(riffButEmpty)).toMatchObject({ code: "no_fmt_chunk" });
  });
});

describe("slicing", () => {
  it("produces a standalone decodable WAV for one interval", () => {
    const sliced = sliceWav(fixture, 1_000, 3_000);
    expect(sliced.ok).toBe(true);
    if (sliced.ok) {
      const reparsed = parseWav(sliced.bytes);
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) {
        expect(wavDurationMs(reparsed.header)).toBeCloseTo(2_000, 5);
        // The slice is a complete file: header + exactly its own data.
        expect(sliced.bytes.length).toBe(44 + reparsed.header.dataBytes);
      }
      expect(sliced.durationMs).toBeCloseTo(2_000, 5);
    }
  });

  it("slicing at sub-frame boundaries never tears a sample frame", () => {
    const sliced = sliceWav(fixture, 1_234.9, 1_765.1);
    expect(sliced.ok).toBe(true);
    if (sliced.ok) {
      const reparsed = parseWav(sliced.bytes);
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) {
        expect(reparsed.header.dataBytes % reparsed.header.blockAlign).toBe(0);
        // Within one frame (2 bytes at 8kHz = 0.25ms) of the asked 530.2ms.
        expect(Math.abs(sliced.durationMs - 530.2)).toBeLessThan(0.25);
      }
    }
  });

  it("concatenating all planned segments reproduces the original data EXACTLY", () => {
    const parsed = parseWav(fixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const plan = planSegments(wavDurationMs(parsed.header), {
      targetSegmentMs: 1_234,
      minTailSegmentMs: 100,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    let total = 0;
    for (const segment of plan.segments) {
      const sliced = sliceWav(fixture, segment.startMs, segment.endMs);
      expect(sliced.ok).toBe(true);
      if (!sliced.ok) {
        return;
      }
      const reparsed = parseWav(sliced.bytes);
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) {
        total += reparsed.header.dataBytes;
      }
    }
    expect(total).toBe(parsed.header.dataBytes);
  });

  it("refuses intervals outside the audio and non-WAV input with closed codes", () => {
    expect(sliceWav(fixture, -10, 100)).toMatchObject({ code: "interval_out_of_range" });
    expect(sliceWav(fixture, 6_000, 7_000)).toMatchObject({ code: "interval_out_of_range" });
    expect(sliceWav(new Uint8Array(64), 0, 10)).toMatchObject({ code: "not_wav" });
  });
});

describe("serialization and base64 (runtime-neutral)", () => {
  it("round-trips bytes through base64 without mutation", () => {
    const encoded = bytesToBase64(fixture);
    expect(base64ToBytes(encoded)).toEqual(fixture);
  });

  it("serializeWav rebuilds a parseable file with the same parameters", () => {
    const parsed = parseWav(fixture);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const rebuilt = serializeWav(parsed.header, fixture.subarray(parsed.header.dataOffset));
      const reparsed = parseWav(rebuilt);
      expect(reparsed.ok).toBe(true);
      if (reparsed.ok) {
        expect(reparsed.header.sampleRate).toBe(parsed.header.sampleRate);
        expect(reparsed.header.dataBytes).toBe(parsed.header.dataBytes);
      }
    }
  });

  it("the default config bounds every segment of a long fixture", () => {
    const long = toneWav({ seconds: 90 });
    const parsed = parseWav(long);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const plan = planSegments(wavDurationMs(parsed.header), DEFAULT_SEGMENTATION_CONFIG);
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.segments).toHaveLength(3);
      }
    }
  });
});
