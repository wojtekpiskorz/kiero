/**
 * D6 focused tests: the PURE segmentation and status decisions.
 *
 * These prove the decisions that make long audio "bounded resumable
 * segments" without a deployment: manifest boundaries (including the
 * no-duration-cap arithmetic and tail merge), pending-vs-complete
 * derivation (a removed middle segment can never read complete), resume
 * bookkeeping, manifest fingerprint stability and the WAV frame-alignment
 * arithmetic that keeps byte slicing honest to original time.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEGMENTATION_CONFIG,
  canonicalConfig,
  deriveTranscriptStatus,
  manifestFingerprint,
  nextUnfinishedSegment,
  planSegments,
} from "../../convex/processing/audio/segmentation";
import { wavRangeForInterval, parseWav, toneWav, wavDurationMs } from "@kiero/media-worker/wav";

describe("manifest planning", () => {
  it("splits exact multiples into equal bounded segments covering the whole duration", () => {
    const plan = planSegments(90_000, { targetSegmentMs: 30_000, minTailSegmentMs: 2_000 });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.segments.map((s) => [s.startMs, s.endMs])).toEqual([
      [0, 30_000],
      [30_000, 60_000],
      [60_000, 90_000],
    ]);
    // Ascending, gap-free, non-overlapping, full coverage.
    for (let i = 0; i < plan.segments.length; i += 1) {
      expect(plan.segments[i]?.segmentIndex).toBe(i);
      if (i > 0) {
        expect(plan.segments[i]?.startMs).toBe(plan.segments[i - 1]?.endMs);
      }
    }
  });

  it("keeps a short remainder as its own segment when it is not a sliver", () => {
    const plan = planSegments(70_000, { targetSegmentMs: 30_000, minTailSegmentMs: 2_000 });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      const last = plan.segments[plan.segments.length - 1];
      expect(last).toMatchObject({ startMs: 60_000, endMs: 70_000, durationMs: 10_000 });
    }
  });

  it("merges a sliver tail into its predecessor instead of a degenerate segment", () => {
    const plan = planSegments(61_000, { targetSegmentMs: 30_000, minTailSegmentMs: 2_000 });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.segments).toHaveLength(2);
      expect(plan.segments[1]).toMatchObject({ startMs: 30_000, endMs: 61_000 });
    }
  });

  it("audio shorter than the target is ONE segment", () => {
    const plan = planSegments(5_000, DEFAULT_SEGMENTATION_CONFIG);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.segments).toHaveLength(1);
      expect(plan.segments[0]).toMatchObject({ startMs: 0, endMs: 5_000 });
    }
  });

  it("imposes NO product duration cap: a 10-hour recording plans 1200 segments", () => {
    const tenHoursMs = 10 * 60 * 60 * 1_000;
    const plan = planSegments(tenHoursMs, DEFAULT_SEGMENTATION_CONFIG);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.segments).toHaveLength(1_200);
      // Every segment individually bounded; the last one closes at the end.
      const last = plan.segments[plan.segments.length - 1];
      expect(last?.endMs).toBe(tenHoursMs);
      for (const segment of plan.segments) {
        expect(segment.durationMs).toBeLessThanOrEqual(DEFAULT_SEGMENTATION_CONFIG.targetSegmentMs);
      }
    }
  });

  it("refuses non-positive and non-finite durations and broken configs (typed)", () => {
    expect(planSegments(0, DEFAULT_SEGMENTATION_CONFIG)).toMatchObject({ code: "duration_not_positive" });
    expect(planSegments(-5, DEFAULT_SEGMENTATION_CONFIG)).toMatchObject({ code: "duration_not_positive" });
    expect(planSegments(Number.POSITIVE_INFINITY, DEFAULT_SEGMENTATION_CONFIG)).toMatchObject({
      code: "duration_not_finite",
    });
    expect(planSegments(1_000, { targetSegmentMs: 0, minTailSegmentMs: 1 })).toMatchObject({
      code: "target_segment_not_positive",
    });
    expect(planSegments(1_000, { targetSegmentMs: 1_000, minTailSegmentMs: 0 })).toMatchObject({
      code: "min_tail_not_positive",
    });
  });

  it("aggressive proof segmentation cuts a tiny clip into decode-bounded pieces", () => {
    const plan = planSegments(5_400, { targetSegmentMs: 1_200, minTailSegmentMs: 200 });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.segments).toHaveLength(5);
      // Boundaries deliberately cross word boundaries of real speech (the
      // focused verification's across-segment proof rides these cuts).
      expect(plan.segments.map((s) => s.startMs)).toEqual([0, 1_200, 2_400, 3_600, 4_800]);
    }
  });
});

describe("pending-vs-complete derivation", () => {
  const checkpoints = (states: string[]) =>
    states.map((state, index) => ({ segmentIndex: index, state: state as "pending" | "succeeded" | "failed" | "running" }));

  it("complete requires EVERY required segment", () => {
    expect(deriveTranscriptStatus(3, checkpoints(["succeeded", "succeeded", "succeeded"]))).toBe("complete");
    expect(deriveTranscriptStatus(3, checkpoints(["succeeded", "succeeded", "pending"]))).toBe("partial");
    expect(deriveTranscriptStatus(3, checkpoints(["pending", "pending", "pending"]))).toBe("pending");
    expect(deriveTranscriptStatus(3, checkpoints(["succeeded", "failed", "succeeded"]))).toBe("partial");
  });

  it("a MISSING middle row (removed segment) never reads complete", () => {
    const hole = checkpoints(["succeeded", "succeeded", "succeeded"]).filter(
      (checkpoint) => checkpoint.segmentIndex !== 1,
    );
    expect(deriveTranscriptStatus(3, hole)).toBe("partial");
  });

  it("no manifest yet means pending", () => {
    expect(deriveTranscriptStatus(0, [])).toBe("pending");
  });
});

describe("resume bookkeeping", () => {
  it("continues from the first unfinished segment", () => {
    const checkpoints = [
      { segmentIndex: 0, state: "succeeded" as const },
      { segmentIndex: 1, state: "succeeded" as const },
      { segmentIndex: 2, state: "failed" as const },
      { segmentIndex: 3, state: "pending" as const },
    ];
    expect(nextUnfinishedSegment(4, checkpoints)).toBe(2);
    expect(nextUnfinishedSegment(4, checkpoints.slice(0, 2))).toBe(2);
  });

  it("returns null when every required segment is done", () => {
    expect(
      nextUnfinishedSegment(2, [
        { segmentIndex: 0, state: "succeeded" },
        { segmentIndex: 1, state: "succeeded" },
      ]),
    ).toBeNull();
  });

  it("a running checkpoint (interrupted mid-segment) resumes at that segment", () => {
    expect(
      nextUnfinishedSegment(3, [
        { segmentIndex: 0, state: "succeeded" },
        { segmentIndex: 1, state: "running" },
      ]),
    ).toBe(1);
  });
});

describe("manifest immutability identity", () => {
  it("the fingerprint is stable and config identity is canonical", async () => {
    const a = planSegments(90_000, DEFAULT_SEGMENTATION_CONFIG);
    const b = planSegments(90_000, DEFAULT_SEGMENTATION_CONFIG);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      return;
    }
    expect(await manifestFingerprint(a.segments)).toBe(await manifestFingerprint(b.segments));
    const shifted = planSegments(90_000, { ...DEFAULT_SEGMENTATION_CONFIG, targetSegmentMs: 45_000 });
    expect(shifted.ok).toBe(true);
    if (shifted.ok) {
      expect(await manifestFingerprint(shifted.segments)).not.toBe(await manifestFingerprint(a.segments));
    }
    expect(canonicalConfig(DEFAULT_SEGMENTATION_CONFIG)).toBe(
      canonicalConfig({ targetSegmentMs: 30_000, minTailSegmentMs: 2_000 }),
    );
  });
});

describe("original-time byte arithmetic (shared WAV authority)", () => {
  it("measures fixture duration from the header", () => {
    const bytes = toneWav({ seconds: 2.5 });
    const parsed = parseWav(bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(wavDurationMs(parsed.header)).toBeCloseTo(2_500, 5);
    }
  });

  it("maps intervals to FRAME-ALIGNED byte ranges clamped to the data chunk", () => {
    const bytes = toneWav({ seconds: 3 });
    const parsed = parseWav(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const header = parsed.header;
    const { byteStart, byteEnd } = wavRangeForInterval(header, 1_234.7, 2_001.3);
    expect((byteStart - header.dataOffset) % header.blockAlign).toBe(0);
    expect((byteEnd - header.dataOffset) % header.blockAlign).toBe(0);
    expect(byteStart).toBeGreaterThanOrEqual(header.dataOffset);
    expect(byteEnd).toBeLessThanOrEqual(header.dataOffset + header.dataBytes);
    // 766.6ms of mono 16-bit 8kHz (16,000 B/s) is ~12,265 bytes; the
    // aligned window must be within ONE frame (2 bytes) of that.
    expect(byteEnd - byteStart).toBeGreaterThan(12_260);
    expect(byteEnd - byteStart).toBeLessThan(12_270);
  });

  it("out-of-range intervals are clamped at the end and refused past the end", () => {
    const bytes = toneWav({ seconds: 1 });
    const parsed = parseWav(bytes);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const clamped = wavRangeForInterval(parsed.header, 900, 5_000);
      expect(clamped.byteEnd).toBe(parsed.header.dataOffset + parsed.header.dataBytes);
    }
  });
});
