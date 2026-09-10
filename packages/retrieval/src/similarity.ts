/**
 * Cosine similarity and the hybrid result assembly (E5).
 *
 * The initial candidate's 4096 dimensions exceed what a Convex vector index
 * can hold (2048), so the semantic half is an in-action cosine over the
 * SAME company-and-generation-scoped rows the text half already reads. That
 * is a deliberate barebones decision, not the final search design (explicit
 * scope exclusion in issue #39): tenant filtering happens in our code before
 * any vector is touched, so a vector can never cross company scope.
 */

/**
 * Cosine similarity of two equal-length finite vectors, in [-1, 1].
 * Returns null when the vectors differ in length, are empty, contain a
 * non-finite value, or either has zero magnitude: an incomparable pair is
 * never silently scored (incompatible generations must not mix).
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length === 0) {
    return null;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined || right === undefined || !Number.isFinite(left) || !Number.isFinite(right)) {
      return null;
    }
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  if (normA === 0 || normB === 0) {
    return null;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * The barebones semantic floor: a candidate that matched ONLY semantically
 * stays below the result set unless its cosine similarity reaches this.
 * Real-world unrelated text often shares 0.2-0.4 cosine on dense embedding
 * models, so returning every above-zero row would rank noise into results.
 * This constant is versioned with the candidate (raising it past existing
 * entries' similarities only changes ranking, never the index contents).
 */
export const SEMANTIC_MIN_SCORE = 0.4;

/** How one candidate row reached the result set. */
export type MatchedVia = "text" | "semantic" | "text_and_semantic";

/** One assembled search hit before hydration filtering. */
export interface RankedCandidate {
  readonly searchEntryId: string;
  readonly textScore: number;
  /** Present only when both the query and the entry are embedded. */
  readonly semanticScore: number | null;
  readonly score: number;
  readonly matchedVia: MatchedVia;
}

/** The raw signals one indexed row produced for one query. */
export interface CandidateSignals {
  readonly searchEntryId: string;
  readonly textScore: number;
  readonly semanticScore: number | null;
}

/**
 * Merges text and semantic signals into one ranked, deterministically
 * ordered candidate list. The final score is the larger of the clamped
 * semantic similarity and the text score; `matchedVia` discloses which half
 * produced the hit. A candidate whose ONLY signal is a below-floor semantic
 * similarity is dropped (ranking noise, not evidence). Ordering: score
 * descending, then entry id ascending (stable across pages).
 */
export function assembleRankedCandidates(
  signals: readonly CandidateSignals[],
): RankedCandidate[] {
  const rows: RankedCandidate[] = [];
  for (const signal of signals) {
    const semantic =
      signal.semanticScore === null ? 0 : clamp01(signal.semanticScore);
    const score = Math.max(clamp01(signal.textScore), semantic);
    const viaText = signal.textScore > 0;
    const viaSemantic = signal.semanticScore !== null && semantic >= SEMANTIC_MIN_SCORE;
    if (!viaText && !viaSemantic) {
      continue;
    }
    const matchedVia: MatchedVia = viaText && viaSemantic
      ? "text_and_semantic"
      : viaSemantic
        ? "semantic"
        : "text";
    rows.push({
      searchEntryId: signal.searchEntryId,
      textScore: signal.textScore,
      semanticScore: signal.semanticScore,
      score: viaSemantic ? score : clamp01(signal.textScore),
      matchedVia,
    });
  }
  rows.sort((a, b) =>
    a.score !== b.score ? b.score - a.score : compareStrings(a.searchEntryId, b.searchEntryId),
  );
  return rows;
}

/** Applies cursor pagination to an ordered candidate list. */
export function pageCandidates(
  ordered: readonly RankedCandidate[],
  cursor: string | undefined,
  limit: number,
): { readonly page: RankedCandidate[]; readonly isDone: boolean } {
  const startIndex =
    cursor === undefined
      ? 0
      : ordered.findIndex((candidate) => candidate.searchEntryId === cursor) + 1;
  const safeStart = startIndex <= 0 && cursor !== undefined ? ordered.length : Math.max(0, startIndex);
  const slice = ordered.slice(safeStart, safeStart + limit);
  return { page: slice, isDone: safeStart + limit >= ordered.length };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
