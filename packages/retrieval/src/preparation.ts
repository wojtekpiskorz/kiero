/**
 * Versioned text preparation (E5): the one folding both the indexed document
 * text and the query text go through before matching or embedding.
 *
 * Preparation is versioned because it changes every embedding: a different
 * fold, truncation or normalization produces different vectors, which is a
 * NEW index generation (never a silent rewrite). The version constant travels
 * on every `searchIndexGenerations` row and is part of the pinned initial
 * candidate (see ./candidate.ts).
 *
 * The fold is Polish-first barebones: case folding plus diacritic folding
 * (NFD, then combining marks stripped), so a boss searching "wylewka" finds
 * "Wylewka" and "wylewką" alike. The fold is lossy ON PURPOSE for matching;
 * results always link to the canonical record (hydration), never to this
 * prepared text.
 */

/** The version label stamped on generations built through this module. */
export const TEXT_PREPARATION_VERSION = "e5.fold.v1";

/**
 * Latin letters NFD cannot fold (single codepoints with no combining-mark
 * decomposition). Polish needs ł -> l; the neighbors ride along so the map
 * stays the region's one table.
 */
const NON_DECOMPOSING: ReadonlyMap<string, string> = new Map([
  ["ł", "l"],
  ["Ł", "l"],
  ["đ", "d"],
  ["Đ", "d"],
  ["ð", "d"],
  ["Ð", "d"],
  ["þ", "th"],
  ["Þ", "th"],
]);

/**
 * Folds one piece of text: trim, collapse runs of whitespace, NFD-decompose,
 * strip combining marks, fold the non-decomposing Latin letters, lowercase.
 * Unknown scripts pass through untouched.
 */
export function foldText(text: string): string {
  let folded = "";
  for (const character of text.normalize("NFD")) {
    if (/[\u0300-\u036f]/.test(character)) {
      continue;
    }
    folded += NON_DECOMPOSING.get(character) ?? character;
  }
  return folded.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Prepares one indexed document text (a source text, transcript, OCR or finding). */
export function prepareDocumentText(text: string): string {
  return foldText(text);
}

/**
 * Prepares the query text. E2's model family distinguishes query-side from
 * document-side input; the same fold keeps text matching symmetric with the
 * embedded comparison.
 */
export function prepareQueryText(query: string): string {
  return foldText(query);
}

/**
 * Prepares one finding revision's searchable text from its semantic key and
 * ENCODED value (the wire form revisions store). Barebones v1 renders the
 * key and the compact JSON of the value: scalar text and quantities match
 * directly, and structural fields (temporal shapes, money roles) remain
 * token-searchable. A richer renderer is a new preparation version, hence a
 * new index generation.
 */
export function prepareFindingText(semanticKey: string, encodedValue: unknown): string {
  return foldText(`${semanticKey} ${JSON.stringify(encodedValue ?? null)}`);
}

/** Splits a prepared text into non-empty tokens (whitespace-separated). */
export function tokensOf(preparedText: string): string[] {
  return preparedText.split(" ").filter((token) => token.length > 0);
}

/** The minimum length for the ending-tolerant comparison below. */
const INFLECTION_MIN_LENGTH = 5;

/**
 * Barebones token match, Polish-inflection tolerant: a needle matches a
 * document token when it occurs inside it, or (for tokens long enough) when
 * both agree after dropping the final character, the inflection ending
 * ("wylewka"/"wylewke"/"wylewką" all stem to "wylewk+"). The final search
 * design (proper stemming) is the excluded search track; this rule only has
 * to be honest, never silently exact.
 */
export function tokenMatches(needle: string, documentToken: string): boolean {
  if (documentToken.includes(needle)) {
    return true;
  }
  if (needle.length >= INFLECTION_MIN_LENGTH && documentToken.length >= INFLECTION_MIN_LENGTH) {
    return needle.slice(0, -1) === documentToken.slice(0, -1);
  }
  return false;
}

/**
 * Barebones full-text matching over prepared text: a query matches when
 * every prepared query token matches some document token.
 */
export function matchesPreparedText(preparedText: string, preparedQuery: string): boolean {
  const queryTokens = tokensOf(preparedQuery);
  if (queryTokens.length === 0) {
    return false;
  }
  const documentTokens = tokensOf(preparedText);
  return queryTokens.every((needle) =>
    documentTokens.some((documentToken) => tokenMatches(needle, documentToken)),
  );
}

/**
 * The text match score in [0, 1]: the fraction of query tokens present.
 * A full substring hit (the whole prepared query occurs verbatim) scores 1
 * regardless of tokenization.
 */
export function textMatchScore(preparedText: string, preparedQuery: string): number {
  const queryTokens = tokensOf(preparedQuery);
  if (queryTokens.length === 0) {
    return 0;
  }
  if (preparedText.includes(preparedQuery)) {
    return 1;
  }
  const documentTokens = tokensOf(preparedText);
  const present = queryTokens.filter((needle) =>
    documentTokens.some((documentToken) => tokenMatches(needle, documentToken)),
  ).length;
  return present / queryTokens.length;
}
