/**
 * The run journal (E3): the one helper set every text-processing stage
 * shares — idempotent step recording, failure/outcome markers, fragment
 * ensuring and text-extraction resolution.
 *
 * One module owns these mechanical persistence rules so the extract
 * executor, the analysis stages and the guarded probes cannot drift into
 * near-copies:
 *
 * - `recordStep` is insert-if-absent on (run, sequence) and only ever
 *   PATCHES a row still `running`/`pending` — journal replay of a
 *   committed stage is a no-op, so restarts cannot duplicate step rows;
 * - the marker bases live OUTSIDE the stage sequences (the A3 crash-proof
 *   pattern): a THROW marker makes the stage fail as an exception (the
 *   rollback proof), an OUTCOME marker makes it fail as a recorded outcome
 *   (the group-isolation proof);
 * - `ensureFragment` matches by exact anchor (whole-source or an exact
 *   text range), so replays reuse the fragment a prior execution created
 *   instead of minting coordinates twice;
 * - `resolveTextExtraction` validates an explicit extraction reference
 *   in-company (the drain projection may hand `null`) and otherwise
 *   resolves the source's single D1 text extraction.
 */

import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";

/** Failure markers (the A3 crash-proof pattern) live outside the stages. */
export const FAILURE_MARKER_BASE = 100_000;
/** Outcome markers (recorded group failure, no exception) for the isolation proof. */
export const OUTCOME_MARKER_BASE = 200_000;

/** The DB surface the journal needs (any mutation context). */
type JournalDb = MutationCtx["db"];

/** One step row by (run, sequence), if present. */
export async function stepRow(
  db: JournalDb,
  runId: Id<"processingRuns">,
  sequence: number,
) {
  return db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) => q.eq("runId", runId).eq("sequence", sequence))
    .first();
}

/** Records one step row idempotently with its outcome payload. */
export async function recordStep(
  db: JournalDb,
  runId: Id<"processingRuns">,
  sequence: number,
  stepKind: string,
  outcome: { state: "succeeded" | "failed"; output: unknown },
): Promise<void> {
  const existing = await stepRow(db, runId, sequence);
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
  }
}

/** Whether the armed THROW marker exists for one stage sequence. */
export async function failureMarkerArmed(
  db: JournalDb,
  runId: Id<"processingRuns">,
  sequence: number,
): Promise<boolean> {
  const marker = await stepRow(db, runId, FAILURE_MARKER_BASE + sequence);
  return marker !== null;
}

/**
 * Whether the armed OUTCOME marker exists for one stage sequence: unlike
 * the throw marker, this one makes the group's publication fail as a
 * RECORDED OUTCOME (state failed, no exception), so the workflow continues
 * and the independent groups still commit — the deterministic proof of
 * group isolation ("independent groups commit once and failed work stays
 * pending").
 */
export async function outcomeMarkerArmed(
  db: JournalDb,
  runId: Id<"processingRuns">,
  sequence: number,
): Promise<boolean> {
  const marker = await stepRow(db, runId, OUTCOME_MARKER_BASE + sequence);
  return marker !== null;
}

/** Fragment anchor shapes the journal ensures. */
export type FragmentAnchor =
  | { readonly _tag: "whole_source" }
  | { readonly _tag: "text_range"; readonly startOffset: number; readonly endOffset: number };

/** Ensures the extraction has a fragment with exactly this anchor. */
export async function ensureFragment(
  db: JournalDb,
  sourceId: Id<"sources">,
  extractionId: Id<"extractions">,
  anchor: FragmentAnchor,
): Promise<Id<"sourceFragments">> {
  const fragments = await db
    .query("sourceFragments")
    .withIndex("by_extraction", (q) => q.eq("extractionId", extractionId))
    .collect();
  const match = fragments.find(
    (fragment) =>
      fragment.anchor._tag === anchor._tag &&
      (anchor._tag !== "text_range" ||
        (fragment.anchor._tag === "text_range" &&
          fragment.anchor.startOffset === anchor.startOffset &&
          fragment.anchor.endOffset === anchor.endOffset)),
  );
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

/**
 * Resolves the text extraction of one source, in-company. An explicit
 * reference (the drain projection's named id, or `null` when the payload
 * could not name one) must belong to this source and be a text extraction;
 * without one, the source's single D1-seeded text extraction resolves.
 */
export async function resolveTextExtraction(
  db: JournalDb,
  sourceId: Id<"sources">,
  extractionRef: string | null,
): Promise<Id<"extractions"> | null> {
  if (extractionRef !== null) {
    const id = db.normalizeId("extractions", extractionRef);
    if (id === null) {
      return null;
    }
    const row = await db.get(id);
    if (row === null || row.sourceId !== sourceId || row.kind !== "text") {
      return null;
    }
    return row._id;
  }
  const row = await db
    .query("extractions")
    .withIndex("by_source_kind", (q) =>
      q.eq("sourceId", sourceId).eq("kind", "text"),
    )
    .first();
  return row?._id ?? null;
}
