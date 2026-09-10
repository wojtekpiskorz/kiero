/**
 * @kiero/retrieval (E5): evidence lookup over the derived search index.
 *
 * Pure cores for tenant-safe versioned retrieval:
 * - versioned text preparation (./preparation);
 * - the pinned initial embedding candidate and its compatibility gate
 *   (./candidate);
 * - cosine similarity and hybrid result assembly with cursor pagination
 *   (./similarity);
 * - retrieval coverage disclosure (./coverage);
 * - hydration keep-or-drop rules against canonical D1/C2 records
 *   (./hydration).
 *
 * The Convex-side wiring (index generations, the durable index executor and
 * the checked query operation) lives in convex/search and imports this
 * package; similarity is never truth and the index is never authority.
 */

export {
  INDEX_CANDIDATE,
  PROVIDER_ROUTE_VERSION,
  isCompatibleCandidate,
  type CandidateRequest,
  type CandidateVerdict,
} from "./candidate";
export {
  TEXT_PREPARATION_VERSION,
  foldText,
  matchesPreparedText,
  prepareDocumentText,
  prepareFindingText,
  prepareQueryText,
  textMatchScore,
  tokenMatches,
  tokensOf,
} from "./preparation";
export {
  SEMANTIC_MIN_SCORE,
  assembleRankedCandidates,
  cosineSimilarity,
  pageCandidates,
  type CandidateSignals,
  type MatchedVia,
  type RankedCandidate,
} from "./similarity";
export { computeCoverage, type CoverageInputs, type RetrievalCoverage } from "./coverage";
export {
  keepFindingEntry,
  keepSourceEntry,
  type HydratedFinding,
  type HydratedSource,
  type RetrievalFilters,
  type SourceHydrationInput,
} from "./hydration";
