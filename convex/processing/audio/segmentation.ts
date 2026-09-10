/**
 * Pure segmentation and transcript-status decisions (D6).
 *
 * Every decision that makes long audio "bounded resumable segments" is a
 * pure function here, so tests/d6 can prove boundaries, resume bookkeeping,
 * pending-vs-complete derivation and manifest immutability without a
 * deployment:
 *
 * - `planSegments`: the ORIGINAL-time interval manifest. There is NO
 *   product duration cap: an arbitrary duration maps to N contiguous
 *   [start, end) intervals of at most `targetSegmentMs`, each decodable on
 *   its own, with a tail shorter than `minTailSegmentMs` merged into its
 *   predecessor (no degenerate sliver segment).
 * - `deriveTranscriptStatus`: a transcript is `complete` ONLY when every
 *   required segment succeeded; any missing/failed segment leaves it
 *   `pending` (none succeeded) or `partial` — never a fake complete.
 * - `nextUnfinishedSegment`: resume bookkeeping — the first segment that is
 *   not yet succeeded; a resumed run continues from it without re-running
 *   completed segments.
 * - `manifestFingerprint`: canonical digest of the interval list; recorded
 *   at planning time and re-derived on every assembly so "coordinates never
 *   silently move" is checkable from the rows.
 */

/** The immutable per-order segmentation configuration. */
export interface SegmentationConfig {
  /** Maximum original-time length of one decodable segment. */
  readonly targetSegmentMs: number;
  /** Tails shorter than this merge into the previous segment (min 2 per file). */
  readonly minTailSegmentMs: number;
}

/** The initial D6 segmentation configuration (30s decoder-bounded segments). */
export const DEFAULT_SEGMENTATION_CONFIG: SegmentationConfig = {
  targetSegmentMs: 30_000,
  minTailSegmentMs: 2_000,
};

/** Bound for dev-proof aggressive segmentation (real clips, tiny segments). */
export const MIN_PROOF_TARGET_SEGMENT_MS = 500;

/** A planned segment: an original-time interval and its length. */
export interface PlannedSegment {
  readonly segmentIndex: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

/** Typed validation refusal of a segmentation decision (closed codes). */
export type SegmentationRefusal =
  | "duration_not_positive"
  | "duration_not_finite"
  | "target_segment_not_positive"
  | "min_tail_not_positive";

export type SegmentationPlan =
  | { readonly ok: true; readonly segments: readonly PlannedSegment[] }
  | { readonly ok: false; readonly code: SegmentationRefusal };

/**
 * Plans the contiguous interval manifest over [0, durationMs). Segments are
 * ascending, gap-free, non-overlapping and cover the whole duration; the
 * LAST segment may be short unless shorter than `minTailSegmentMs`, in
 * which case it merges into its predecessor. One segment covers audio
 * shorter than the target itself.
 */
export function planSegments(
  durationMs: number,
  config: SegmentationConfig,
): SegmentationPlan {
  if (!Number.isFinite(durationMs)) {
    return { ok: false, code: "duration_not_finite" };
  }
  if (durationMs <= 0) {
    return { ok: false, code: "duration_not_positive" };
  }
  if (!Number.isFinite(config.targetSegmentMs) || config.targetSegmentMs <= 0) {
    return { ok: false, code: "target_segment_not_positive" };
  }
  if (!Number.isFinite(config.minTailSegmentMs) || config.minTailSegmentMs <= 0) {
    return { ok: false, code: "min_tail_not_positive" };
  }
  const count = Math.ceil(durationMs / config.targetSegmentMs);
  const segments: PlannedSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const startMs = index * config.targetSegmentMs;
    const endMs = Math.min(startMs + config.targetSegmentMs, durationMs);
    segments.push({ segmentIndex: index, startMs, endMs, durationMs: endMs - startMs });
  }
  const last = segments[segments.length - 1];
  if (last !== undefined && segments.length > 1 && last.durationMs < config.minTailSegmentMs) {
    // Merge the sliver tail into its predecessor: gap-free coverage with one
    // fewer decodable unit (never a 50ms request to a speech decoder).
    segments.pop();
    const predecessor = segments[segments.length - 1];
    if (predecessor !== undefined) {
      segments[segments.length - 1] = {
        ...predecessor,
        endMs: durationMs,
        durationMs: durationMs - predecessor.startMs,
      };
    }
  }
  return { ok: true, segments };
}

/** The states a checkpoint row can carry (D6 never writes "running": an
 * interrupted pass leaves the segment `pending`, which resume re-attempts). */
export type SegmentState = "pending" | "succeeded" | "failed";

/** The slim checkpoint shape the pure decisions read. */
export interface SegmentCheckpoint {
  readonly segmentIndex: number;
  readonly state: SegmentState;
}

/** The product-visible transcript state derived from checkpoints. */
export type TranscriptStatus = "pending" | "partial" | "complete";

/**
 * Derives the honest transcript status: `complete` requires EVERY required
 * segment to have succeeded. A missing row (a removed middle segment, a
 * manifest gap) counts as not succeeded, so the derivation can never report
 * complete over a hole.
 */
export function deriveTranscriptStatus(
  requiredCount: number,
  checkpoints: readonly SegmentCheckpoint[],
): TranscriptStatus {
  if (requiredCount <= 0) {
    return "pending";
  }
  const succeeded = new Set(
    checkpoints
      .filter((checkpoint) => checkpoint.state === "succeeded")
      .map((checkpoint) => checkpoint.segmentIndex),
  );
  let succeededCount = 0;
  for (let index = 0; index < requiredCount; index += 1) {
    if (succeeded.has(index)) {
      succeededCount += 1;
    }
  }
  if (succeededCount === requiredCount) {
    return "complete";
  }
  return succeededCount === 0 ? "pending" : "partial";
}

/**
 * Resume bookkeeping: the first segment that is not yet succeeded, or null
 * when every required segment is done. The inspection surface reports this
 * per order for operators and the evidence script; the workflow itself
 * skips completed segments through the per-segment checkpoint rows (the
 * same decision, read from the rows it already loads).
 */
export function nextUnfinishedSegment(
  requiredCount: number,
  checkpoints: readonly SegmentCheckpoint[],
): number | null {
  const succeeded = new Set(
    checkpoints
      .filter((checkpoint) => checkpoint.state === "succeeded")
      .map((checkpoint) => checkpoint.segmentIndex),
  );
  for (let index = 0; index < requiredCount; index += 1) {
    if (!succeeded.has(index)) {
      return index;
    }
  }
  return null;
}

/** Canonical JSON of the segmentation config (order identity component). */
export function canonicalConfig(config: SegmentationConfig): string {
  return JSON.stringify({
    targetSegmentMs: config.targetSegmentMs,
    minTailSegmentMs: config.minTailSegmentMs,
  });
}

/** The minimal interval identity a manifest fingerprint is derived from. */
export interface ManifestInterval {
  readonly segmentIndex: number;
  readonly startMs: number;
  readonly endMs: number;
}

/** Canonical JSON of an interval manifest (key order is part of identity). */
export function canonicalManifest(segments: readonly ManifestInterval[]): string {
  return JSON.stringify(
    segments.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
  );
}

/** SHA-256 hex digest of the canonical manifest (WebCrypto; universal). */
export async function manifestFingerprint(segments: readonly ManifestInterval[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalManifest(segments)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 hex digest of arbitrary bytes (pinning the proof byte channel). */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  // Copy into a plain ArrayBuffer-backed view: WebCrypto's BufferSource
  // rejects SharedArrayBuffer-backed views under our strict lib types.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
