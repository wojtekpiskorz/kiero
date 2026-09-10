/**
 * Tenant-safe versioned retrieval (E5): the `search.queryEvidence` core.
 *
 * The operation runs in an ACTION (the E2 checked-dispatch pattern over an
 * action context): the query-side embedding is a provider call and never
 * happens inside a transaction. The retrieval pipeline, in order:
 *
 * 1. SCOPE FIRST: the caller's company resolves from a verified identity
 *    (Convex Auth live session for the app path, the verified service
 *    session for the bridge path; ./views.ts); every subsequent read is
 *    company- and generation-scoped through real indexes, so neither a text
 *    nor a semantic result can cross company scope, whatever a stale derived
 *    row claims.
 * 2. The ACTIVE generation resolves; without one the result is the honest
 *    `degraded` coverage (typed/current structured reads, the D1 views and
 *    C2 current findings, remain available through their own operations).
 * 3. Text matching runs over the versioned prepared texts (the same fold
 *    that prepared the index); the semantic half embeds the QUERY through
 *    E2's adapter (inputKind `search_query`) and ranks same-generation rows
 *    by cosine in-action (the 4096-dimension baseline exceeds the platform
 *    vector-index limit; the final vector design is the excluded search
 *    track). An embedding outage leaves text retrieval standing and the
 *    coverage literal discloses `text_only`: absence of a semantic hit is
 *    retrieval coverage, never proof that the fact does not exist.
 * 4. HYDRATION: every candidate re-reads its canonical D1/C2 record
 *    (source lifecycle, tenant scope, project links, author, send time;
 *    finding current revision) and the keep-or-drop rules from
 *    @kiero/retrieval filter before anything is returned. Withdrawn or
 *    purged evidence and obsolete finding revisions cannot authorize an
 *    answer even when a stale derived row still matches.
 */

import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError } from "@kiero/runtime";
import {
  assembleRankedCandidates,
  computeCoverage,
  cosineSimilarity,
  keepFindingEntry,
  keepSourceEntry,
  pageCandidates,
  prepareQueryText,
  textMatchScore,
  type CandidateSignals,
  type RetrievalFilters,
} from "@kiero/retrieval";
import { openRouterCredentialsFromEnv, runEmbedding } from "@kiero/providers";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { ScopedContext } from "./views";

/** Reads the server-held OpenRouter key; presence only, never its value. */
/** The decoded query input (the contract shape, after dispatch decode). */
export interface QueryEvidenceInput {
  readonly query: string;
  readonly limit: number;
  readonly projectId?: string;
  readonly authorUserId?: string;
  readonly sentFromMs?: number;
  readonly sentToMs?: number;
  readonly cursor?: string;
}

/** One hydrated result entry (the contract result shape). */
export interface QueryResultEntry {
  readonly searchEntryId: Id<"searchEntries">;
  readonly kind: "source_fragment" | "finding";
  readonly sourceFragmentId?: Id<"sourceFragments">;
  readonly sourceId?: Id<"sources">;
  readonly findingId?: Id<"findings">;
  readonly score: number;
  readonly matchedVia: "text" | "semantic" | "text_and_semantic";
}

/** The whole result: entries, coverage disclosure and the page flag. */
export interface QueryEvidenceResult {
  readonly entries: QueryResultEntry[];
  readonly coverage: "full" | "text_only" | "degraded";
  readonly isDone: boolean;
}

/**
 * The one query core the dispatch handler and the guarded probe run: the
 * production path never skips the provider call; `simulateEmbeddingOutage`
 * exists only for the guarded proof of the outage coverage disclosure.
 */
export async function runEvidenceQuery(
  action: ActionCtx,
  context: ScopedContext,
  input: QueryEvidenceInput,
  options: { readonly simulateEmbeddingOutage?: boolean } = {},
): Promise<ResultEnvelope> {
  if (context.normalizedCompanyId === null) {
    return errorResult(unauthenticatedError("company_scope_unresolved"));
  }
  const companyId = context.normalizedCompanyId;
  const generation = await action.runQuery(internal.search.views.activeGeneration, {});
  if (generation === null) {
    // No active index: disclose degraded coverage; the typed/current
    // structured reads remain available through their own operations.
    const degraded: QueryEvidenceResult = { entries: [], coverage: "degraded", isDone: true };
    return okResult(degraded);
  }
  const rows = await action.runQuery(internal.search.views.companyEntries, {
    companyId,
    generationId: generation.generationId,
    includeEmbeddings: true,
  });
  // Query-side embedding (one bounded provider pass over the folded query).
  let queryVector: readonly number[] | null = null;
  const credentials = openRouterCredentialsFromEnv();
  const anyEmbedded = rows.some((row) => row.hasEmbedding);
  if (options.simulateEmbeddingOutage !== true && credentials !== null && anyEmbedded) {
    const call = await runEmbedding(credentials, {
      text: prepareQueryText(input.query),
      inputKind: "search_query",
    });
    if (call.outcome.outcome === "succeeded") {
      queryVector = call.outcome.value.vector;
    }
  }
  const preparedQuery = prepareQueryText(input.query);
  const rowById = new Map(rows.map((row) => [row._id as string, row]));
  const signals: CandidateSignals[] = [];
  for (const row of rows) {
    const textScore = textMatchScore(row.preparedText, preparedQuery);
    const semantic =
      queryVector !== null && row.embedding !== null
        ? cosineSimilarity(queryVector, row.embedding)
        : null;
    if (textScore > 0 || semantic !== null) {
      signals.push({ searchEntryId: row._id, textScore, semanticScore: semantic });
    }
  }
  const ranked = assembleRankedCandidates(signals);
  // Hydration: canonical records re-read for every candidate, then the
  // keep-or-drop rules (tenant scope, lifecycle, filters, current revision).
  const sourceIds = [
    ...new Set(
      ranked.flatMap((candidate) => {
        const row = rowById.get(candidate.searchEntryId);
        return row !== undefined && row.sourceId !== null ? [row.sourceId] : [];
      }),
    ),
  ];
  const findingIds = [
    ...new Set(
      ranked.flatMap((candidate) => {
        const row = rowById.get(candidate.searchEntryId);
        return row !== undefined && row.findingId !== null ? [row.findingId] : [];
      }),
    ),
  ];
  const filters: RetrievalFilters = {
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.authorUserId === undefined ? {} : { authorUserId: input.authorUserId }),
    ...(input.sentFromMs === undefined ? {} : { sentFromMs: input.sentFromMs }),
    ...(input.sentToMs === undefined ? {} : { sentToMs: input.sentToMs }),
  };
  const hydrated = await action.runQuery(internal.search.views.hydrateEntries, {
    companyId,
    sourceIds,
    findingIds,
  });
  const sourceById = new Map(hydrated.sources.map((source) => [source.sourceId as string, source]));
  const findingById = new Map(
    hydrated.findings.map((finding) => [finding.findingId as string, finding]),
  );
  const kept = ranked.filter((candidate) => {
    const row = rowById.get(candidate.searchEntryId);
    if (row === undefined) {
      return false;
    }
    if (row.sourceId !== null) {
      const source = sourceById.get(row.sourceId);
      if (source === undefined) {
        return false;
      }
      return keepSourceEntry(
        companyId,
        {
          source: {
            sourceCompanyId: source.companyId,
            lifecycle: source.lifecycle,
          },
          linkedProjectIds: source.linkedProjectIds,
          authorUserId: source.authorUserId,
          sentAtMs: source.sentAtMs,
        },
        filters,
      );
    }
    if (row.findingId !== null) {
      const finding = findingById.get(row.findingId);
      if (finding === undefined) {
        return false;
      }
      return keepFindingEntry(
        companyId,
        {
          findingCompanyId: finding.companyId,
          currentRevisionId: finding.currentRevisionId,
        },
        row.findingRevisionId,
        filters,
      );
    }
    return false;
  });
  const { page, isDone } = pageCandidates(kept, input.cursor, input.limit);
  const entries: QueryResultEntry[] = page.map((candidate) => {
    const row = rowById.get(candidate.searchEntryId);
    if (row === undefined) {
      throw new Error("query assembly: ranked candidate without row");
    }
    return {
      searchEntryId: row._id,
      kind: row.findingId !== null ? "finding" : "source_fragment",
      ...(row.sourceFragmentId === null ? {} : { sourceFragmentId: row.sourceFragmentId }),
      ...(row.sourceId === null ? {} : { sourceId: row.sourceId }),
      ...(row.findingId === null ? {} : { findingId: row.findingId }),
      score: candidate.score,
      matchedVia: candidate.matchedVia,
    };
  });
  const result: QueryEvidenceResult = {
    entries,
    coverage: computeCoverage({
      activeGeneration: true,
      queryEmbedded: queryVector !== null,
      indexedEntries: rows.length,
      embeddedEntries: rows.filter((row) => row.hasEmbedding).length,
    }),
    isDone,
  };
  return okResult(result);
}
