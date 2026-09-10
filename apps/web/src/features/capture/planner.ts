/**
 * Pure capture planning (D4): how one logical message's attachments map
 * onto the D2 resumable-upload protocol, with NO I/O.
 *
 * The ONE definition of the protocol bounds is the shared pure module the
 * gateway also imports (convex/sources/uploads/protocol.ts); this planner
 * consumes it directly instead of re-declaring sizes.
 *
 * Rules encoded here:
 *
 * - an attachment is sliced into parts of `MIN_PART_BYTES` except the last
 *   (R2 requires every non-last part to be at least that size; a small
 *   attachment is ONE part);
 * - the prepare declaration's `parts` bound is the MAXIMUM part number any
 *   attachment may use (per-attachment numbering starts at 1 — see D2's
 *   recordPartTransaction), so the declared bound is the max over
 *   attachments, never the sum;
 * - the declared `mediaKinds` array is canonical (audio first, then one
 *   image per photo): prepare is idempotent per (company, draftId) only
 *   under the SAME multiset, so the client's declaration must be a pure
 *   function of the draft;
 * - resume planning subtracts the server's recorded part manifest from the
 *   plan: only missing parts travel again (the D2 resume contract).
 */

import { MAX_ATTACHMENTS, MIN_PART_BYTES } from "../../../../../convex/sources/uploads/protocol";

export { MAX_ATTACHMENTS, MIN_PART_BYTES };

/** One attachment's byte size, in send order (audio first, then photos). */
export interface AttachmentBytes {
  readonly kind: "audio" | "image";
  readonly bytes: number;
}

/** The number of parts one attachment occupies (>= 1, exact slicing). */
export function partCountOf(bytes: number, minPartBytes = MIN_PART_BYTES): number {
  if (bytes <= 0) {
    return 1; // An empty attachment still completes as a single empty part.
  }
  return Math.ceil(bytes / minPartBytes);
}

/** The prepare declaration's part bound: the max over attachments. */
export function declaredPartsOf(attachments: readonly AttachmentBytes[]): number {
  return attachments.reduce(
    (bound, attachment) => Math.max(bound, partCountOf(attachment.bytes)),
    1,
  );
}

/**
 * The canonical mediaKinds declaration: audio first (0 or 1), then one
 * image per photo. A text-only draft declares `[]` (the certified
 * text-only prepare semantics).
 */
export function canonicalMediaKinds(
  hasRecording: boolean,
  photoCount: number,
): ("audio" | "image")[] {
  const kinds: ("audio" | "image")[] = [];
  if (hasRecording) {
    kinds.push("audio");
  }
  for (let index = 0; index < photoCount; index += 1) {
    kinds.push("image");
  }
  return kinds;
}

/**
 * The byte range of one planned part: `[offset, end)` within the source
 * blob. Every part except the last is exactly `minPartBytes`; the last
 * carries the remainder.
 */
export function partRange(
  bytes: number,
  partNumber: number,
  minPartBytes = MIN_PART_BYTES,
): { readonly offset: number; readonly end: number } {
  const count = partCountOf(bytes, minPartBytes);
  const bounded = Math.min(Math.max(partNumber, 1), count);
  const offset = (bounded - 1) * minPartBytes;
  return { offset, end: Math.min(offset + minPartBytes, bytes) };
}

/** The part numbers the server has NOT recorded yet (the resume work). */
export function missingPartNumbers(
  plannedCount: number,
  recordedPartNumbers: readonly number[],
): number[] {
  const recorded = new Set(recordedPartNumbers);
  return Array.from({ length: plannedCount }, (_, index) => index + 1).filter(
    (partNumber) => !recorded.has(partNumber),
  );
}

/**
 * Whether an interrupted draft can still be sent with its local blobs: the
 * local material must produce EXACTLY the declaration the server recorded
 * (same kinds multiset). A draft whose local material changed after prepare
 * must be discarded honestly (`draft_declaration_mismatch` is a conflict,
 * never a silent redefinition).
 */
export function declarationMatches(
  declared: readonly ("audio" | "image")[],
  local: readonly ("audio" | "image")[],
): boolean {
  if (declared.length !== local.length) {
    return false;
  }
  const sorted = (kinds: readonly ("audio" | "image")[]) => [...kinds].sort();
  const a = sorted(declared);
  const b = sorted(local);
  return a.every((kind, index) => kind === b[index]);
}
