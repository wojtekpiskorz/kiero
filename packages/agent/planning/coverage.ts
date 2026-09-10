/**
 * Segment coverage honesty (E3; architecture protocol step 5-6: "A missing
 * required segment is pending, not a complete transcript. Text-only
 * fallback cannot claim to have inspected a pending image").
 *
 * The analysis context records which parts of the source were actually
 * inspectable by THIS run: completed extraction kinds versus attachments
 * still waiting for theirs. The runtime rules that consume the snapshot:
 *
 * - `decideRunCompleteness` is wired into BOTH halves of the pipeline: the
 *   load stage records the label on its step output, and the completion
 *   summary copies it onto the run's checkpoint — a run whose source still
 *   has pending segments completes PARTIAL, never as a complete transcript;
 * - the inspection guard itself is STRUCTURAL, not a per-proposal runtime
 *   check: every evidence quote a plan may carry must locate verbatim in
 *   THIS source's author text (the reducer refuses hallucinated quotes),
 *   so a text-only run can never cite an image or audio segment it did not
 *   inspect. There is no per-kind runtime predicate because the tool
 *   surface exposes no other basis kind to check.
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

/** Whether the whole source was inspectable: no required segment is pending. */
export function isCompleteTranscript(coverage: CoverageSnapshot): boolean {
  return coverage.pendingSegments.length === 0;
}

/** The honest run-completion state recorded with the analysis outcome. */
export type RunCompleteness = "complete" | "partial_pending_segments";

/** Derives the honest completeness label from the coverage snapshot. */
export function decideRunCompleteness(coverage: CoverageSnapshot): RunCompleteness {
  return isCompleteTranscript(coverage) ? "complete" : "partial_pending_segments";
}
