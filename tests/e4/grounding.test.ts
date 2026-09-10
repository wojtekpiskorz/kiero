/**
 * E4 focused verification, part 2: the multimodal GROUNDING and the anchor
 * coordinate spaces (issue #38: "Resolve text offsets, original-audio
 * intervals, image regions or honest whole-source references"; focused
 * verification: "Inject invalid regions, offsets, representation IDs and
 * cross-tenant references and assert typed failure").
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  VisionExtractionOutput,
  observationIdOf,
  parseObservationId,
  validateImageRegion,
  locateTranscriptQuote,
  resolveObservationReference,
  type JoinVisionObservation,
  type TranscriptSegmentView,
} from "@kiero/agent";

/** Two D6-style segments on the ORIGINAL audio timeline (4s clip). */
const SEGMENTS: TranscriptSegmentView[] = [
  {
    transcriptId: "audioTranscripts_t",
    extractionId: "extractions_stt_v1",
    segmentIndex: 0,
    startMs: 0,
    endMs: 2_000,
    text: "Dowóz płytek w środę rano",
  },
  {
    transcriptId: "audioTranscripts_t",
    extractionId: "extractions_stt_v1",
    segmentIndex: 1,
    startMs: 2_000,
    endMs: 4_000,
    text: "Kaczmarek potwierdza odbiór o dziewiątej",
  },
];

describe("transcript quote location (audio evidence)", () => {
  it("locates a verbatim quote inside ONE segment and anchors its ORIGINAL-time interval", () => {
    const location = locateTranscriptQuote(SEGMENTS, "Kaczmarek potwierdza odbiór");
    expect(location).toEqual({
      located: true,
      segmentIndex: 1,
      startMs: 2_000,
      endMs: 4_000,
      extractionId: "extractions_stt_v1",
    });
  });

  it("anchors the interval of the segment that contains the words, never a transcript-relative offset", () => {
    const location = locateTranscriptQuote(SEGMENTS, "w środę rano");
    expect(location).toMatchObject({ located: true, startMs: 0, endMs: 2_000 });
  });

  it("refuses a quote spanning two segments (one interval must name one segment)", () => {
    // "rano Kaczmarek" spans the boundary: words exist, but not inside one
    // segment — the honest result is not-located, never a fabricated
    // interval.
    const location = locateTranscriptQuote(SEGMENTS, "rano Kaczmarek potwierdza");
    expect(location.located).toBe(false);
  });

  it("refuses a quote that appears nowhere in the transcript", () => {
    expect(locateTranscriptQuote(SEGMENTS, "takie zdanie nie istnieje").located).toBe(false);
  });

  it("tolerates whitespace/case drift like E3's text location (the same walk)", () => {
    const location = locateTranscriptQuote(SEGMENTS, "kaczmarek  potwierdza");
    expect(location).toMatchObject({ located: true, segmentIndex: 1 });
  });
});

describe("image region validation (the representation defines the coordinate space)", () => {
  const SPACE = { width: 1_200, height: 900 };

  it("accepts a region fully inside the representation", () => {
    expect(validateImageRegion({ x: 100, y: 50, width: 400, height: 300 }, SPACE)).toEqual({
      valid: true,
    });
  });

  it("rejects a region crossing the right/bottom edge (typed reason)", () => {
    expect(
      validateImageRegion({ x: 1_000, y: 0, width: 400, height: 100 }, SPACE),
    ).toMatchObject({ valid: false, reason: "region_outside_representation" });
    expect(
      validateImageRegion({ x: 0, y: 800, width: 10, height: 200 }, SPACE),
    ).toMatchObject({ valid: false, reason: "region_outside_representation" });
  });

  it("rejects negative origin and non-positive dimensions", () => {
    expect(validateImageRegion({ x: -5, y: 0, width: 10, height: 10 }, SPACE)).toMatchObject({
      valid: false,
      reason: "region_outside_representation",
    });
    expect(validateImageRegion({ x: 0, y: 0, width: 0, height: 10 }, SPACE)).toMatchObject({
      valid: false,
      reason: "region_not_positive",
    });
  });

  it("rejects an invalid space itself (a representation without dimensions)", () => {
    expect(validateImageRegion({ x: 0, y: 0, width: 5, height: 5 }, { width: 0, height: 0 })).toMatchObject(
      { valid: false, reason: "space_invalid" },
    );
  });

  it("re-normalization never moves old anchors: a different space validates independently", () => {
    // The SAME region coordinates inside a DIFFERENT (newer) representation
    // space: the validation is per-space, and historical fragments keep
    // their pinned extraction/representation — the join merely REFUSES to
    // reuse the region against a space it does not fit.
    const region = { x: 900, y: 700, width: 300, height: 200 };
    expect(validateImageRegion(region, { width: 1_200, height: 900 })).toEqual({ valid: true });
    expect(
      validateImageRegion(region, { width: 1_000, height: 800 }),
    ).toMatchObject({ valid: false, reason: "region_outside_representation" });
  });
});

describe("observation reference resolution (image evidence)", () => {
  const OBSERVATIONS: JoinVisionObservation[] = [
    {
      observationId: observationIdOf("mediaRep_img1", 0),
      attachmentId: "attachments_img1",
      representationId: "mediaRep_img1",
      extractionId: "extractions_vision_img1",
      text: "12 400 zł",
      x: 40,
      y: 60,
      width: 300,
      height: 80,
    },
  ];

  it("resolves a handle that exists in the joined context", () => {
    const resolution = resolveObservationReference(OBSERVATIONS, observationIdOf("mediaRep_img1", 0));
    expect(resolution.resolved).toBe(true);
    if (resolution.resolved) {
      expect(resolution.observation.text).toBe("12 400 zł");
    }
  });

  it("refuses a malformed handle", () => {
    expect(resolveObservationReference(OBSERVATIONS, "img1:obs:0")).toMatchObject({
      resolved: false,
      reason: "malformed_id",
    });
  });

  it("refuses an unknown handle — the hallucination guard", () => {
    expect(resolveObservationReference(OBSERVATIONS, observationIdOf("mediaRep_img1", 7))).toMatchObject(
      { resolved: false, reason: "unknown_observation" },
    );
    expect(
      resolveObservationReference(OBSERVATIONS, observationIdOf("mediaRep_pending", 0)),
    ).toMatchObject({ resolved: false, reason: "unknown_observation" });
  });

  it("an EMPTY observation set (vision pending) resolves nothing — nothing to claim with", () => {
    expect(resolveObservationReference([], observationIdOf("mediaRep_img1", 0)).resolved).toBe(false);
  });

  it("the handle parses back to its parts", () => {
    expect(parseObservationId(observationIdOf("mediaRep_img1", 3))).toEqual({
      attachmentId: "mediaRep_img1",
      index: 3,
    });
  });
});

describe("the vision output contract (provider completions decode through it)", () => {
  it("decodes a well-formed extraction output", () => {
    const decoded = Schema.decodeUnknownSync(VisionExtractionOutput)({
      readConfidence: 0.8,
      observations: [{ text: "szer. 3,60 m", region: { x: 0, y: 0, width: 100, height: 40 } }],
    });
    expect(decoded.observations[0]?.text).toBe("szer. 3,60 m");
  });

  it("rejects invalid regions at the DECODE boundary (typed failure, fail-closed)", () => {
    expect(() =>
      Schema.decodeUnknownSync(VisionExtractionOutput)({
        readConfidence: 0.8,
        observations: [{ text: "x", region: { x: -10, y: 0, width: 5, height: 5 } }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(VisionExtractionOutput)({
        readConfidence: 0.8,
        observations: [{ text: "x", region: { x: 0, y: 0, width: 99_999, height: 5 } }],
      }),
    ).toThrow();
  });

  it("rejects empty observation text and out-of-range confidence", () => {
    expect(() =>
      Schema.decodeUnknownSync(VisionExtractionOutput)({
        readConfidence: 0.8,
        observations: [{ text: "", region: { x: 0, y: 0, width: 5, height: 5 } }],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(VisionExtractionOutput)({
        readConfidence: 1.5,
        observations: [],
      }),
    ).toThrow();
  });
});
