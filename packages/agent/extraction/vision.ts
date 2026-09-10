/**
 * The typed vision-extraction contract (E4): what the model reads off ONE
 * retained image representation through E2's vision adapter.
 *
 * The output is STRUCTURED, never prose: each observation carries the read
 * text and the image region it was read from, in PIXEL coordinates of the
 * EXACT representation the extraction row pins (`mediaRepresentations.
 * width/height` define the coordinate space — re-normalization produces a
 * NEW representation with its own space, so old anchors never move).
 *
 * Region validity is checked twice, structurally:
 * - the Effect schema bounds the numbers (finite, non-negative, within the
 *   bound constant), because a provider completion must decode through it;
 * - `validateImageRegion` checks the region against the REPRESENTATION's
 *   dimensions before any fragment is minted (the DB-side authority of the
 *   coordinate space), so an invalid region is a typed refusal, never a
 *   silently-clamped or negative anchor.
 */

import { Schema } from "effect";
import {
  MAX_VISION_OBSERVATIONS,
  MAX_VISION_OBSERVATION_CHARS,
} from "./versions";

/** Bounded region edge: no coordinate may exceed this (defensive bound;
 * the representation's own dimensions are the real authority). */
export const MAX_REGION_EDGE = 8_192;

/** One read observation: text plus where it was read. */
export const VisionObservation = Schema.Struct({
  /** The verbatim read text (an amount, a measurement, a label, a caption). */
  text: Schema.NonEmptyString.pipe(
    Schema.check(Schema.isMaxLength(MAX_VISION_OBSERVATION_CHARS)),
  ),
  /** The region of the representation the text was read from, pixels. */
  region: Schema.Struct({
    x: Schema.Number.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.check(Schema.isLessThanOrEqualTo(MAX_REGION_EDGE)),
    ),
    y: Schema.Number.pipe(
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.check(Schema.isLessThanOrEqualTo(MAX_REGION_EDGE)),
    ),
    width: Schema.Number.pipe(
      Schema.check(Schema.isGreaterThan(0)),
      Schema.check(Schema.isLessThanOrEqualTo(MAX_REGION_EDGE)),
    ),
    height: Schema.Number.pipe(
      Schema.check(Schema.isGreaterThan(0)),
      Schema.check(Schema.isLessThanOrEqualTo(MAX_REGION_EDGE)),
    ),
  }),
});
export type VisionObservation = Schema.Schema.Type<typeof VisionObservation>;

/** The vision-extraction output contract pinned as strict json_schema. */
export const VisionExtractionOutput = Schema.Struct({
  /** How sure the reader was about reading the image (separate from knowledge state). */
  readConfidence: Schema.Number.pipe(
    Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  ),
  observations: Schema.Array(VisionObservation).pipe(
    Schema.check(Schema.isMaxLength(MAX_VISION_OBSERVATIONS)),
  ),
});
export type VisionExtractionOutput = Schema.Schema.Type<typeof VisionExtractionOutput>;

/** The dimensions that define one representation's coordinate space. */
export interface RepresentationSpace {
  readonly width: number;
  readonly height: number;
}

/** The typed region-validation outcome. */
export type RegionValidation =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason:
        | "space_invalid"
        | "region_not_positive"
        | "region_outside_representation";
    };

/**
 * THE coordinate-space check: a region is valid only when it lies entirely
 * inside the representation's pixel space. This is the authority the
 * fragment-ensuring path consults — a region that fails here never becomes
 * an anchor (typed refusal), because "invalid regions ... assert typed
 * failure" is the focused-verification contract.
 */
export function validateImageRegion(
  region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  space: RepresentationSpace,
): RegionValidation {
  if (
    !Number.isFinite(space.width) ||
    !Number.isFinite(space.height) ||
    space.width < 1 ||
    space.height < 1
  ) {
    return { valid: false, reason: "space_invalid" };
  }
  if (!Number.isFinite(region.width) || !Number.isFinite(region.height) || region.width <= 0 || region.height <= 0) {
    return { valid: false, reason: "region_not_positive" };
  }
  if (
    region.x < 0 ||
    region.y < 0 ||
    region.x + region.width > space.width ||
    region.y + region.height > space.height
  ) {
    return { valid: false, reason: "region_outside_representation" };
  }
  return { valid: true };
}

/**
 * The stable observation identity inside one joined run: the attachment
 * plus the observation index, the handle the chat analysis references as
 * evidence. Ids only exist for observations from COMPLETED vision
 * extractions loaded into the joined context — the structural guarantee
 * behind "text-only fallback cannot claim to have inspected a pending
 * image".
 */
export function observationIdOf(attachmentId: string, index: number): string {
  return `obs:${attachmentId}:${index}`;
}

/**
 * One observation loaded into the joined context (wire form). The region
 * coordinates ride FLAT, in the fragment-anchor shape. The nested `region`
 * object is the PROVIDER decode schema's shape (and the durable
 * `observationsJson` record's) and is flattened once, at the load edge.
 */
export interface JoinVisionObservation {
  /** The stable handle the model cites (`obs:<attachmentId>:<index>`). */
  readonly observationId: string;
  readonly attachmentId: string;
  readonly representationId: string;
  /** The vision extraction version the observation was read by. */
  readonly extractionId: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Parses an observation handle back to its parts (null when malformed). */
export function parseObservationId(
  observationId: string,
): { attachmentId: string; index: number } | null {
  const match = /^obs:([^:]+):(\d+)$/.exec(observationId);
  if (match === null) {
    return null;
  }
  return { attachmentId: match[1] ?? "", index: Number(match[2]) };
}
