/**
 * The media protocol's closed refusal vocabulary (the
 * release blocker) — deliberately a ZERO-IMPORT leaf.
 *
 * `convex deploy` typechecks `convex/tsconfig.json` (no
 * `allowImportingTsExtensions`), and the Convex side legitimately imports
 * this union (`convex/processing/audio/media.ts`'s typed pass-through).
 * The union therefore lives in a file with no imports at all, so the
 * Convex program can reach it without pulling `segment-service.ts` (whose
 * `./wav.ts`-style extension imports are legal in this package's own
 * programs, not in Convex's). `segment-service.ts` re-exports it — the
 * one spelling stays there for the worker surfaces.
 */

/** Every protocol refusal code; answers carry a closed code only. */
export type SegmentRefusal =
  | "malformed_request"
  | "object_not_found"
  | "object_read_failed"
  | "format_requires_container"
  | "interval_out_of_range"
  | "object_too_large"
  | "format_unsupported"
  | "conversion_unavailable"
  | "conversion_input_too_large"
  | "conversion_output_too_large"
  | "conversion_output_too_long"
  | "conversion_timed_out"
  | "conversion_failed";
