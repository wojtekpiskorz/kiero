/**
 * Multimodal evidence grounding (E4): locating a proposal's evidence in the
 * joined inspectable parts of ONE source ("Fragment źródła": a text
 * fragment, an audio range or an image region; CONTEXT.md).
 *
 * The three grounding families, each with its own anchor authority:
 *
 * - text: E3's `locateQuote` over the immutable author text -> a
 *   `text_range` anchor on the text extraction;
 * - audio: a verbatim quote located in ONE D6 segment's text -> that
 *   segment's ORIGINAL-TIME interval (`audio_interval`, the segment's
 *   [startMs, endMs) over the source audio timeline, never segment-relative
 *   offsets) on the transcript's stt extraction version;
 * - image: a reference to a vision observation from a COMPLETED extraction
 *   -> the observation's `image_region` anchor on the vision extraction,
 *   whose row pins the exact representationId (its width/height define the
 *   coordinate space).
 *
 * Every locator is pure and total: an unlocatable quote is reported, never
 * invented; an unknown observation reference is refused; nothing here can
 * mint evidence for media the run did not inspect.
 */

import { locateQuote } from "../planning/quotes";
import type { JoinVisionObservation } from "./vision";
import { parseObservationId } from "./vision";

/** One assembled transcript segment as the joined context carries it. */
export interface TranscriptSegmentView {
  readonly transcriptId: string;
  /** The transcript order's completed extraction version. */
  readonly extractionId: string;
  readonly segmentIndex: number;
  /** Original-time interval [startMs, endMs) over the source audio. */
  readonly startMs: number;
  readonly endMs: number;
  /** The verbatim provider transcript of this segment (succeeded only). */
  readonly text: string;
}

/** The outcome of locating one quote over the transcript (pure). */
export type TranscriptQuoteLocation =
  | {
      readonly located: true;
      readonly segmentIndex: number;
      readonly startMs: number;
      readonly endMs: number;
      readonly extractionId: string;
    }
  | { readonly located: false };

/**
 * Locates one quote in the assembled transcript: exact-first then the same
 * whitespace/case-tolerant token walk E3 uses, INSIDE one segment's text —
 * a quote spanning two segments does not locate (the anchor must name one
 * original-time interval; the honest fallback for a spanning statement is
 * two quotes, one per segment).
 */
export function locateTranscriptQuote(
  segments: readonly TranscriptSegmentView[],
  quote: string,
): TranscriptQuoteLocation {
  for (const segment of segments) {
    const location = locateQuote(segment.text, quote);
    if (location.located) {
      return {
        located: true,
        segmentIndex: segment.segmentIndex,
        startMs: segment.startMs,
        endMs: segment.endMs,
        extractionId: segment.extractionId,
      };
    }
  }
  return { located: false };
}

/** The outcome of resolving one observation reference (pure). */
export type ObservationResolution =
  | { readonly resolved: true; readonly observation: JoinVisionObservation }
  | { readonly resolved: false; readonly reason: "malformed_id" | "unknown_observation" };

/**
 * Resolves one observation handle against the observations the joined
 * context ACTUALLY holds. The context only ever contains observations from
 * completed vision extractions, so an id that resolves is inspectable
 * evidence and an id that does not is refused — the text-only fallback
 * cannot claim image inspection because there is nothing to claim with.
 */
export function resolveObservationReference(
  observations: readonly JoinVisionObservation[],
  observationId: string,
): ObservationResolution {
  const parsed = parseObservationId(observationId);
  if (parsed === null) {
    return { resolved: false, reason: "malformed_id" };
  }
  const observation = observations.find(
    (candidate) => candidate.observationId === observationId,
  );
  if (observation === undefined) {
    return { resolved: false, reason: "unknown_observation" };
  }
  return { resolved: true, observation };
}

/** The modality kinds a piece of located evidence belongs to. */
export type EvidenceKind = "text" | "audio" | "image";

/**
 * One located evidence item in wire form (journal-safe). Image items carry
 * the region coordinates FLAT, exactly as the fragment-anchor contract
 * (`sourceFragments.anchor.image_region`) spells them: one anchor shape
 * everywhere, so evidence can never diverge from the anchor it mints.
 */
export type LocatedEvidence =
  | {
      readonly _tag: "text_range";
      readonly quote: string;
      readonly startOffset: number;
      readonly endOffset: number;
      readonly extractionId: string;
    }
  | {
      readonly _tag: "audio_interval";
      readonly quote: string;
      readonly startMs: number;
      readonly endMs: number;
      readonly extractionId: string;
    }
  | {
      readonly _tag: "image_region";
      readonly observationId: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly representationId: string;
      readonly extractionId: string;
    };

/** The evidence kinds one located item grounds in. */
export function evidenceKindOf(evidence: LocatedEvidence): EvidenceKind {
  switch (evidence._tag) {
    case "text_range":
      return "text";
    case "audio_interval":
      return "audio";
    case "image_region":
      return "image";
  }
}
