/**
 * Knowledge state contract ("Value contracts", architecture design).
 *
 * Knowledge is `known`, `unknown` with a reason, `conflicted`, `updating`
 * with a reason, or `not_applicable` only where meaningful. These epistemic
 * states are strictly separate from:
 *
 * - business progress (task/event/project states live in the work and
 *   projects module surfaces), and
 * - extraction confidence (how sure the model was about what it read; it
 *   lives on extraction records and never upgrades a statement's meaning).
 *
 * Omission in a patch means "no change". Clearing, withdrawal and conflict
 * are explicit operations with their own provenance: an arbitrary model
 * `null` never erases a fact. Certified by A3 on 2026-09-09 (docs/implementation/contracts/README.md).
 *
 * C5 amendment (issue #28, additive, flagged on the B3 precedent): the
 * `updating` variant is the "updating until revalidated" state the
 * architecture's processing protocol names for dependent inferred
 * conclusions after their basis moved (withdrawal or correction): the value
 * is preserved verbatim and visibly marked, the finding cannot drive
 * automation, and only a newer publication or explicit correction
 * (revalidation) replaces the marking.
 */

import { Schema } from "effect";

/** The epistemic state of one finding value. */
export const KnowledgeState = Schema.TaggedUnion({
  known: {},
  unknown: { reason: Schema.NonEmptyString },
  conflicted: {},
  updating: { reason: Schema.NonEmptyString },
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
