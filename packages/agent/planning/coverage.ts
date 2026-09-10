/**
 * Segment coverage honesty (E3; architecture protocol step 5-6: "A missing
 * required segment is pending, not a complete transcript. Text-only
 * fallback cannot claim to have inspected a pending image").
 *
 * The analysis context records which parts of the source were actually
 * inspectable by THIS run: completed extraction kinds versus attachments
 * still waiting for theirs. The rules here are pure decisions over that
 * snapshot:
 *
 * - a run whose source still has pending segments is NOT a complete
 *   transcript: it completes as partial, never as a full analysis;
 * - a text-only run cannot claim to have inspected a pending image or
 *   audio segment: proposals whose declared basis is a not-yet-extracted
 *   segment are refused, whatever the model said;
 * - text-grounded findings remain publishable: they do not claim image
 *   inspection, and unrelated confirmed information is not blocked by an
 *   unrelated backlog (protocol step 6).
 */

/** Media kinds whose extraction may be pending on one source. */
export type PendingSegmentKind = "audio" | "image";

/**
 * The inspectable-parts snapshot of one source at analysis time.
 * `extractedKinds` always contains `"text"` for D1 sources (the author's
 * words are their own extraction); `pendingSegments` lists attachments
 * without a completed extraction version.
 */
export interface CoverageSnapshot {
  readonly extractedKinds: readonly ("text" | "stt" | "vision")[];
  readonly pendingSegments: readonly PendingSegmentKind[];
}

/** Whether one extraction kind has a completed version. */
export function hasCompletedExtraction(
  coverage: CoverageSnapshot,
  kind: "text" | "stt" | "vision",
): boolean {
  return coverage.extractedKinds.includes(kind);
}

/**
 * Whether the whole source was inspectable: no required segment is pending.
 * A run over a source with pending segments completes PARTIAL, never as a
 * complete transcript.
 */
export function isCompleteTranscript(coverage: CoverageSnapshot): boolean {
  return coverage.pendingSegments.length === 0;
}

/**
 * Whether a proposal may ground itself in one media kind. A pending image
 * or audio segment supports no claim of inspection; completed text, STT and
 * vision extractions do. This is the server-side honesty guard: the model
 * never gets to assert inspection the run did not perform.
 */
export function mayClaimInspection(
  coverage: CoverageSnapshot,
  basisKind: "text" | "stt" | "vision",
): boolean {
  return hasCompletedExtraction(coverage, basisKind);
}

/** The honest run-completion state recorded with the analysis outcome. */
export type RunCompleteness = "complete" | "partial_pending_segments";

/** Derives the honest completeness label from the coverage snapshot. */
export function decideRunCompleteness(coverage: CoverageSnapshot): RunCompleteness {
  return isCompleteTranscript(coverage) ? "complete" : "partial_pending_segments";
}
