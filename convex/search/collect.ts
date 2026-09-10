/**
 * Index work collection (E5): which canonical texts one generation pass
 * indexes, resolved from the CURRENT canonical rows (D1 sources/extractions/
 * fragments, D6 transcripts, C2 current finding revisions).
 *
 * Coverage (issue #39 "message text, transcript and OCR"):
 * - message text: every ACTIVE source's author text, anchored to its
 *   whole-source text fragment when E3's extract stage has ensured one (a
 *   source accepted but not yet processed is still indexed, anchored to the
 *   source alone: the canonical link is the source id);
 * - transcript: every completed D6 order's per-segment audio-interval
 *   fragments, each with its verbatim segment text (and a whole-source STT
 *   fragment, when one exists, over the concatenated transcript);
 * - OCR: vision-kind extraction fragments are collected only when a text
 *   source exists for them; none exists yet (E4 owns that join), so today
 *   they are counted and skipped in `stats.visionFragmentsSkipped`, an
 *   honestly disclosed gap rather than a silent omission.
 *
 * Only lifecycle-active sources are indexed; withdrawn/purged evidence never
 * enters a fresh pass (hydration re-checks anyway: the index is derived).
 */

import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { prepareDocumentText, prepareFindingText } from "@kiero/retrieval";

/** The db read surface collection needs (any Convex ctx fits). */
export type CollectDb = QueryCtx["db"];

/** One prepared index entry draft, before embedding and before the write. */
export interface EntryDraft {
  readonly generationId: Id<"searchIndexGenerations">;
  readonly companyId: Id<"companies">;
  readonly sourceFragmentId?: Id<"sourceFragments">;
  readonly sourceId?: Id<"sources">;
  readonly findingId?: Id<"findings">;
  readonly findingRevisionId?: Id<"findingRevisions">;
  readonly preparedText: string;
}

/** What one pass saw (the disclosed coverage counters). */
export interface CollectStats {
  readonly messageTexts: number;
  readonly transcriptSegments: number;
  readonly visionFragmentsSkipped: number;
  readonly findings: number;
}

/** The mutable builder behind the frozen counters. */
type StatsBuilder = { -readonly [K in keyof CollectStats]: number };

/** The stt text of one interval fragment, resolved from its order's segments. */
function segmentTextFor(
  segments: readonly Doc<"audioSegments">[],
  startMs: number,
  endMs: number,
): string | null {
  const segment = segments.find(
    (candidate) => candidate.startMs === startMs && candidate.endMs === endMs,
  );
  if (segment === undefined || segment.text === undefined || segment.text.trim() === "") {
    return null;
  }
  return segment.text;
}

/**
 * Collects the drafts of one full generation pass across every company (the
 * index is global; every row stays company-scoped).
 */
export async function collectGenerationWork(
  db: CollectDb,
  generationId: Id<"searchIndexGenerations">,
): Promise<{ readonly drafts: EntryDraft[]; readonly stats: CollectStats }> {
  const drafts: EntryDraft[] = [];
  const stats: StatsBuilder = {
    messageTexts: 0,
    transcriptSegments: 0,
    visionFragmentsSkipped: 0,
    findings: 0,
  };
  const sources = await db.query("sources").collect();
  for (const source of sources) {
    if (source.lifecycle !== "active") {
      continue;
    }
    const extractions = await db
      .query("extractions")
      .withIndex("by_source_kind", (q) => q.eq("sourceId", source._id))
      .collect();
    const transcripts = await db
      .query("audioTranscripts")
      .withIndex("by_source", (q) => q.eq("sourceId", source._id))
      .collect();
    for (const extraction of extractions) {
      const fragments = await db
        .query("sourceFragments")
        .withIndex("by_extraction", (q) => q.eq("extractionId", extraction._id))
        .collect();
      if (extraction.kind === "text") {
        const wholeSource = fragments.find((f) => f.anchor._tag === "whole_source");
        drafts.push({
          generationId,
          companyId: source.companyId,
          ...(wholeSource === undefined ? {} : { sourceFragmentId: wholeSource._id }),
          sourceId: source._id,
          preparedText: prepareDocumentText(source.authorText),
        });
        stats.messageTexts += 1;
        continue;
      }
      if (extraction.kind === "stt") {
        const transcript = transcripts.find((row) => row.extractionId === extraction._id);
        if (transcript === undefined) {
          continue;
        }
        const segments = (
          await db
            .query("audioSegments")
            .withIndex("by_transcript_index", (q) => q.eq("transcriptId", transcript._id))
            .collect()
        ).sort((a, b) => a.segmentIndex - b.segmentIndex);
        let joined = "";
        for (const fragment of fragments) {
          if (fragment.anchor._tag !== "audio_interval") {
            continue;
          }
          const text = segmentTextFor(segments, fragment.anchor.startMs, fragment.anchor.endMs);
          if (text === null) {
            continue;
          }
          drafts.push({
            generationId,
            companyId: source.companyId,
            sourceFragmentId: fragment._id,
            sourceId: source._id,
            preparedText: prepareDocumentText(text),
          });
          stats.transcriptSegments += 1;
        }
        const wholeTranscript = fragments.find((f) => f.anchor._tag === "whole_source");
        if (wholeTranscript !== undefined) {
          joined = segments
            .map((segment) => segment.text ?? "")
            .join(" ")
            .trim();
          if (joined !== "") {
            drafts.push({
              generationId,
              companyId: source.companyId,
              sourceFragmentId: wholeTranscript._id,
              sourceId: source._id,
              preparedText: prepareDocumentText(joined),
            });
          }
        }
        continue;
      }
      // Vision (OCR) fragments: no canonical text exists yet (E4 owns the
      // join); counted and skipped, never silently pretended indexed.
      stats.visionFragmentsSkipped += fragments.length;
    }
  }
  const findings = await db.query("findings").collect();
  for (const finding of findings) {
    if (finding.currentRevisionId === undefined) {
      continue;
    }
    const revision = await db.get(finding.currentRevisionId);
    if (revision === null) {
      continue;
    }
    drafts.push({
      generationId,
      companyId: finding.companyId,
      findingId: finding._id,
      findingRevisionId: revision._id,
      preparedText: prepareFindingText(finding.semanticKey, revision.value),
    });
    stats.findings += 1;
  }
  return { drafts, stats };
}

/**
 * Collects one finding's current-revision drafts for every NON-RETIRED
 * generation (the scoped refresh after `memory.findingRevised`).
 */
export async function collectFindingWork(
  db: CollectDb,
  findingId: Id<"findings">,
): Promise<readonly EntryDraft[]> {
  const finding = await db.get(findingId);
  if (finding === null || finding.currentRevisionId === undefined) {
    return [];
  }
  const revision = await db.get(finding.currentRevisionId);
  if (revision === null) {
    return [];
  }
  const building = await db
    .query("searchIndexGenerations")
    .withIndex("by_state", (q) => q.eq("state", "building"))
    .collect();
  const active = await db
    .query("searchIndexGenerations")
    .withIndex("by_state", (q) => q.eq("state", "active"))
    .collect();
  const preparedText = prepareFindingText(finding.semanticKey, revision.value);
  return [...building, ...active].map((generation) => ({
    generationId: generation._id,
    companyId: finding.companyId,
    findingId: finding._id,
    findingRevisionId: revision._id,
    preparedText,
  }));
}
