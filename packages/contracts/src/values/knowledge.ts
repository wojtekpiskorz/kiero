/**
 * Knowledge state contract ("Value contracts", architecture design).
 *
 * Knowledge is `known`, `unknown` with a reason, `conflicted`, or
 * `not_applicable` only where meaningful. These epistemic states are strictly
 * separate from:
 *
 * - business progress (task/event/project states live in the work and
 *   projects module surfaces), and
 * - extraction confidence (how sure the model was about what it read; it
 *   lives on extraction records and never upgrades a statement's meaning).
 *
 * Omission in a patch means "no change". Clearing, withdrawal and conflict
 * are explicit operations with their own provenance: an arbitrary model
 * `null` never erases a fact. Candidate contract until A3 certifies it.
 */

import { Schema } from "effect";

/** The epistemic state of one finding value. */
export const KnowledgeState = Schema.TaggedUnion({
  known: {},
  unknown: { reason: Schema.NonEmptyString },
  conflicted: {},
  not_applicable: {},
});
export type KnowledgeState = Schema.Schema.Type<typeof KnowledgeState>;

/**
 * Confidence of an extraction (how sure the reader was about the bytes), kept
 * deliberately outside `KnowledgeState`. Bounded to [0, 1].
 */
export const ExtractionConfidence = Schema.Number.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
);
export type ExtractionConfidence = Schema.Schema.Type<typeof ExtractionConfidence>;
