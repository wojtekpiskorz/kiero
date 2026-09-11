/**
 * Inflection-tolerant evidence matching (E6, pre-E5): the pure string
 * half of the tenant-scoped evidence search, unit-testable without
 * Convex (the internalQuery in convex/agent/evidence.ts composes it).
 *
 * Matching runs an exact phrase first (that pass is `locateQuote` of the
 * planning surface), then this stem-tolerant word walk (Polish
 * inflection: „zaliczka” finds „zaliczkę”): results carry the located
 * ORIGINAL-text offsets, so a cited fragment anchor stays stable against
 * the immutable source bytes. Similarity never establishes truth: these
 * functions only locate CANDIDATE citations.
 */

import { MAX_EVIDENCE_QUOTE_CHARS } from "./versions";

/** Minimum matched-word fraction for the word-overlap pass (rank filter). */
const WORD_OVERLAP_MIN_FRACTION = 0.5;

/**
 * Inflection-tolerance bounds for one query/source word pair: Polish
 * declension changes word endings („zaliczka”/„zaliczkę”,
 * „Kaczmarek”/„Kaczmarka”), so exact token equality loses real candidates.
 * Two words match when they share a stem of at least
 * {@link MIN_STEM_CHARS} characters and each diverges from it by at most
 * {@link MAX_ENDING_CHARS} ending characters. This only widens CANDIDATE
 * discovery: the returned quote stays a contiguous verbatim range of the
 * immutable source text and establishes nothing by itself.
 */
const MIN_STEM_CHARS = 4;
const MAX_ENDING_CHARS = 2;

/** One located word token with its stable offsets. */
export interface Token {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** Lowercased word tokens with offsets (Polish diacritics preserved). */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[^\s]+/g;
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    const raw = match[0];
    const word = raw.toLowerCase().replace(/[.,;:!?()«»"„”'\-–—]+/g, "");
    if (word.length > 0) {
      tokens.push({ word, start: match.index, end: match.index + raw.length });
    }
  }
  return tokens;
}

/** Stem-based inflection-tolerant equality of two word forms (see bounds). */
export function inflectionMatch(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) {
    common += 1;
  }
  return (
    common >= MIN_STEM_CHARS &&
    a.length - common <= MAX_ENDING_CHARS &&
    b.length - common <= MAX_ENDING_CHARS
  );
}

/**
 * The word-overlap pass: a fraction of the query's words must recur in the
 * source, order-free, with Polish-inflection tolerance (a query's
 * „zaliczka” matches the source's „zaliczkę”; an unrelated 4-letter
 * collision stays a CANDIDATE at most — never truth). The quote widens to
 * the SENTENCE containing the matched span, so a citation stays a
 * contiguous verbatim range of the immutable source text AND carries
 * enough context to be inspectable evidence. Returns null when the overlap
 * is too weak.
 */
export function overlapLocation(
  authorText: string,
  query: string,
): { startOffset: number; endOffset: number; fraction: number } | null {
  const queryWords = [...new Set(tokenize(query).map((token) => token.word))];
  if (queryWords.length === 0) {
    return null;
  }
  const tokens = tokenize(authorText);
  const matched = tokens.filter((token) =>
    queryWords.some((word) => inflectionMatch(word, token.word)),
  );
  if (matched.length === 0 || matched.length / queryWords.length < WORD_OVERLAP_MIN_FRACTION) {
    return null;
  }
  const matchStart = Math.min(...matched.map((token) => token.start));
  const matchEnd = Math.max(...matched.map((token) => token.end));
  // Widen to the containing sentence (nearest . ! ? boundaries).
  let start = matchStart;
  while (start > 0 && !".!?".includes(authorText[start - 1] ?? "")) {
    start -= 1;
  }
  let end = matchEnd;
  while (end < authorText.length && !".!?".includes(authorText[end] ?? "")) {
    end += 1;
  }
  if (end - start > MAX_EVIDENCE_QUOTE_CHARS) {
    // Keep the match-centered window when the sentence is too long.
    start = Math.max(start, matchStart - 80);
    end = Math.min(end, start + MAX_EVIDENCE_QUOTE_CHARS);
  }
  return {
    startOffset: start,
    endOffset: end,
    fraction: matched.length / queryWords.length,
  };
}
