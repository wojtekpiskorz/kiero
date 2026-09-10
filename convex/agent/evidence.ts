/**
 * The tenant-scoped evidence search (E6, pre-E5): exact text retrieval over
 * the company's recent source texts.
 *
 * The question source's company row is the ONLY scope anchor — no client
 * input names a company, so a cross-tenant hit cannot occur by
 * construction. Matching runs an exact phrase first, then a
 * stem-tolerant word walk (Polish inflection: „zaliczka” finds
 * „zaliczkę”): results carry the located ORIGINAL-text offsets, so a
 * cited fragment anchor stays stable against the immutable source bytes.
 *
 * Similarity never establishes truth: this returns CANDIDATE citations
 * (source + offsets + verbatim quote + an existing fragment when one
 * matches the anchor), and the tool-result encoding the model reads says
 * so explicitly. Semantic/vector retrieval is E5's lane; when it lands,
 * this query becomes the hydrated structured-source fallback.
 */

import { v } from "convex/values";
import { locateQuote } from "@kiero/agent";
import {
  MAX_EVIDENCE_QUOTE_CHARS,
  MAX_EVIDENCE_SEARCH_RESULTS,
  overlapLocation,
} from "@kiero/agent/tools";
import { okResult, type ResultEnvelope } from "@kiero/contracts";
import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** One raw search hit (handles are assigned by the loop's ledger). */
export interface EvidenceHit {
  readonly sourceId: string;
  readonly sourceSentAtMs: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly quote: string;
  /** An existing fragment with exactly this anchor, when present. */
  readonly existingFragmentId: string | null;
}

/** How many company sources one search scans (bounded recent window). */
const SEARCH_SCAN_SOURCES = 60;

// The matching itself (exact phrase through locateQuote, then the
// inflection-tolerant word-overlap pass) is the pure surface of
// @kiero/agent/tools (packages/agent/tools/evidence.ts), reused and
// unit-tested there.

export const searchEvidenceRows = internalQuery({
  args: {
    questionSourceId: v.id("sources"),
    query: v.string(),
    projectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const source = await ctx.db.get(args.questionSourceId);
    if (source === null) {
      return okResult({ hits: [], scope: "source_missing" });
    }
    let projectIds: Id<"projects">[] | null = null;
    if (args.projectId !== undefined) {
      const project = await ctx.db.get(args.projectId);
      if (project === null || project.companyId !== source.companyId) {
        return okResult({ hits: [], scope: "project_not_in_company" });
      }
      projectIds = [args.projectId];
    }
    const candidates = await ctx.db
      .query("sources")
      .withIndex("by_company_order", (q) => q.eq("companyId", source.companyId))
      .order("desc")
      .take(SEARCH_SCAN_SOURCES);
    const ranked: {
      sourceId: Id<"sources">;
      sourceSentAtMs: number;
      startOffset: number;
      endOffset: number;
      fraction: number;
    }[] = [];
    for (const candidate of candidates) {
      if (candidate.lifecycle !== "active") {
        continue; // a withdrawn/purged source is no longer a citation target
      }
      if (candidate._id === source._id) {
        continue; // the question itself is not evidence for its own answer
      }
      if (projectIds !== null) {
        const links = await ctx.db
          .query("sourceProjectLinks")
          .withIndex("by_source", (q) => q.eq("sourceId", candidate._id))
          .collect();
        if (!links.some((link) => projectIds.includes(link.projectId))) {
          continue;
        }
      }
      // Exact phrase first (the strongest lexical signal), then the
      // order-free word-overlap pass; both stay verbatim-offset anchored.
      const exact = locateQuote(candidate.authorText, args.query);
      if (exact.located) {
        ranked.push({
          sourceId: candidate._id,
          sourceSentAtMs: candidate.sentAtMs,
          startOffset: exact.startOffset,
          endOffset: exact.endOffset,
          fraction: 1,
        });
        continue;
      }
      const overlap = overlapLocation(candidate.authorText, args.query);
      if (overlap !== null) {
        ranked.push({
          sourceId: candidate._id,
          sourceSentAtMs: candidate.sentAtMs,
          startOffset: overlap.startOffset,
          endOffset: overlap.endOffset,
          fraction: overlap.fraction,
        });
      }
    }
    ranked.sort(
      (a, b) => b.fraction - a.fraction || b.sourceSentAtMs - a.sourceSentAtMs,
    );
    const hits: EvidenceHit[] = [];
    for (const ranked_hit of ranked.slice(0, MAX_EVIDENCE_SEARCH_RESULTS)) {
      const candidate = candidates.find((row) => row._id === ranked_hit.sourceId);
      if (candidate === undefined) {
        continue;
      }
      const fragment = await ctx.db
        .query("sourceFragments")
        .withIndex("by_source", (q) => q.eq("sourceId", candidate._id))
        .collect()
        .then((rows) =>
          rows.find(
            (row) =>
              row.anchor._tag === "text_range" &&
              row.anchor.startOffset === ranked_hit.startOffset &&
              row.anchor.endOffset === ranked_hit.endOffset,
          ),
        );
      hits.push({
        sourceId: candidate._id,
        sourceSentAtMs: ranked_hit.sourceSentAtMs,
        startOffset: ranked_hit.startOffset,
        endOffset: ranked_hit.endOffset,
        quote: candidate.authorText.slice(
          ranked_hit.startOffset,
          Math.min(ranked_hit.endOffset, ranked_hit.startOffset + MAX_EVIDENCE_QUOTE_CHARS),
        ),
        existingFragmentId: fragment?._id ?? null,
      });
    }
    return okResult({
      hits,
      scope: projectIds === null ? "company" : "project",
      scanned: Math.min(candidates.length, SEARCH_SCAN_SOURCES),
    });
  },
});
