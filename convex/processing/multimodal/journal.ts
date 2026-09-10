/**
 * The E4 join journal: the step keyspace and fragment-ensuring helpers the
 * multimodal stages share.
 *
 * Keyspace discipline (the D6 precedent): the join anchors its steps to the
 * SAME run row E3's text stages and D6's segment steps journal — the
 * source's initial analysis run (or the reanalysis kicker's new run). E3
 * owns 10..200_000+, D6 owns 1_000_000+/5_000_000+; E4's stages and probe
 * markers live at dedicated bases far OUTSIDE both, and every (run,
 * sequence) lookup additionally guards on `stepKind`, so no lane can
 * cross-wire another's journal.
 *
 * `ensureAnchorFragment` extends E3's text-only `ensureFragment` to ALL
 * four anchor families of the fragment contract (text_range,
 * audio_interval, image_region, whole_source), matching by exact anchor so
 * replays reuse the fragment a prior execution created instead of minting
 * coordinates twice. Image-region anchors ride the VISION extraction row,
 * whose `representationId` pins the coordinate space.
 */

import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

/**
 * Step-sequence keyspace: E4 join stages (evaluate/vision/model/clarify/
 * publish) plus per-image vision step slots. Kept outside every E3 range
 * (10..~200_000+, the E3 probe markers) and every D6 range (1_000_000+,
 * 5_000_000+); pinned in tests/e4/keyspace.test.ts against the exported
 * constants of both lanes.
 */
export const JOIN_STEP_BASE = 10_000_000;
/** Per-image vision extraction step slots (JOIN_STEP_BASE + 1_000 + index). */
export const JOIN_VISION_STEP_OFFSET = 1_000;
/** Probe marker base for E4 (armed vision unavailability). */
export const JOIN_MARKER_BASE = 15_000_000;

/** The step kinds E4 writes on `processingSteps` (lookup guards). */
export const JOIN_EVALUATE_STEP_KIND = "e4_evaluate_media";
export const JOIN_VISION_STEP_KIND = "e4_vision_extraction";
export const JOIN_MODEL_STEP_KIND = "e4_model_join";
export const JOIN_CLARIFY_STEP_KIND = "e4_raise_clarification";
export const JOIN_PUBLISH_STEP_KIND = "e4_publish_group";
export const JOIN_VISION_MARKER_KIND = "e4_probe_vision_unavailable";

/** The DB surface the journal needs (any mutation context). */
type JournalDb = MutationCtx["db"];

/** Fragment anchor shapes the join ensures (all four families). */
export type JoinFragmentAnchor =
  | { readonly _tag: "whole_source" }
  | { readonly _tag: "text_range"; readonly startOffset: number; readonly endOffset: number }
  | { readonly _tag: "audio_interval"; readonly startMs: number; readonly endMs: number }
  | {
      readonly _tag: "image_region";
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };

/** Structural equality of two anchors (exact-coordinate identity). */
function sameAnchor(a: JoinFragmentAnchor, b: JoinFragmentAnchor): boolean {
  if (a._tag !== b._tag) {
    return false;
  }
  switch (a._tag) {
    case "whole_source":
      return true;
    case "text_range":
      return (
        b._tag === "text_range" && a.startOffset === b.startOffset && a.endOffset === b.endOffset
      );
    case "audio_interval":
      return b._tag === "audio_interval" && a.startMs === b.startMs && a.endMs === b.endMs;
    case "image_region":
      return (
        b._tag === "image_region" &&
        a.x === b.x &&
        a.y === b.y &&
        a.width === b.width &&
        a.height === b.height
      );
  }
}

/** Ensures the extraction has a fragment with exactly this anchor. */
export async function ensureAnchorFragment(
  db: JournalDb,
  sourceId: Id<"sources">,
  extractionId: Id<"extractions">,
  anchor: JoinFragmentAnchor,
): Promise<Id<"sourceFragments">> {
  const fragments = await db
    .query("sourceFragments")
    .withIndex("by_extraction", (q) => q.eq("extractionId", extractionId))
    .collect();
  const match = fragments.find((fragment) => sameAnchor(fragment.anchor, anchor));
  if (match !== undefined) {
    return match._id;
  }
  return db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor,
    createdAtMs: Date.now(),
  });
}

/** One step row by (run, sequence) AND step kind (the lane guard). */
export async function joinStepRow(
  db: JournalDb,
  runId: Id<"processingRuns">,
  sequence: number,
  stepKind: string,
) {
  const rows = await db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) => q.eq("runId", runId).eq("sequence", sequence))
    .collect();
  return rows.find((row) => row.stepKind === stepKind) ?? null;
}

/** Records one join step row idempotently with its outcome payload. */
export async function recordJoinStep(
  db: JournalDb,
  runId: Id<"processingRuns">,
  sequence: number,
  stepKind: string,
  outcome: { state: "succeeded" | "failed"; output: unknown },
): Promise<void> {
  const existing = await joinStepRow(db, runId, sequence, stepKind);
  const patch = {
    runId,
    stepKind,
    sequence,
    state: outcome.state,
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
    outputRef: JSON.stringify(outcome.output),
  };
  if (existing === null) {
    await db.insert("processingSteps", patch);
  } else if (existing.state === "running" || existing.state === "pending") {
    await db.patch(existing._id, patch);
  } else if (outcome.state === "succeeded" && existing.state === "failed") {
    // The fail-then-succeed resume (the interrupt fixture's case): the step
    // row must reflect the latest pass, never freeze at the first outcome.
    await db.patch(existing._id, patch);
  }
}

/** The DB read surface the marker helper needs (query or mutation ctx fit). */
type MarkerDb = Pick<MutationCtx["db"], "query">;

/**
 * Whether the armed probe marker forcing BOTH vision routes unavailable
 * exists for one source (the deterministic "image extraction pending"
 * fixture; stepKind-guarded like D6's markers).
 */
export async function visionUnavailableArmed(
  db: MarkerDb,
  runId: Id<"processingRuns">,
): Promise<boolean> {
  const rows = await db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) =>
      q.eq("runId", runId).eq("sequence", JOIN_MARKER_BASE),
    )
    .collect();
  return rows.some((row) => row.stepKind === JOIN_VISION_MARKER_KIND);
}
