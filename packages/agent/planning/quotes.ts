/**
 * Quote location (E3): mapping the model's verbatim evidence quote onto a
 * stable text range of the source ("Fragment źródła": "fragment tekstu",
 * with honest whole-material fallback per CONTEXT.md).
 *
 * Pure string work: exact match first, then a whitespace-and-case
 * normalized scan. A quote that cannot be located is NOT silently accepted
 * with invented coordinates — the proposal either falls back to whole-source
 * evidence (no fragment claimed) or, when the quote is required to exist
 * (corroboration/conflict citations), is refused.
 */

/** The result of locating one quote in the author text. */
export type QuoteLocation =
  | { readonly located: true; readonly startOffset: number; readonly endOffset: number }
  | { readonly located: false };

/** Collapses runs of whitespace and lowercases for tolerant matching. */
function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Locates a quote in the author text. Offsets are into the ORIGINAL text,
 * so fragment anchors stay stable against the immutable source bytes:
 * the tolerant pass walks the original's word tokens and compares their
 * normalized forms, returning the first token's start and the last token's
 * end as the range.
 */
export function locateQuote(sourceText: string, quote: string): QuoteLocation {
  const trimmed = quote.trim();
  if (trimmed.length === 0) {
    return { located: false };
  }
  const exact = sourceText.indexOf(trimmed);
  if (exact !== -1) {
    return { located: true, startOffset: exact, endOffset: exact + trimmed.length };
  }
  const tokens: { word: string; start: number; end: number }[] = [];
  const tokenRe = /\S+/g;
  for (let match = tokenRe.exec(sourceText); match !== null; match = tokenRe.exec(sourceText)) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  const quoteWords = trimmed.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (quoteWords.length === 0) {
    return { located: false };
  }
  for (let start = 0; start + quoteWords.length <= tokens.length; start += 1) {
    let matches = true;
    for (let i = 0; i < quoteWords.length; i += 1) {
      const candidate = tokens[start + i];
      if (candidate === undefined || normalizeWord(candidate.word) !== quoteWords[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const first = tokens[start];
      const last = tokens[start + quoteWords.length - 1];
      if (first === undefined || last === undefined) {
        return { located: false };
      }
      return { located: true, startOffset: first.start, endOffset: last.end };
    }
  }
  return { located: false };
}

/** Whether the netto/brutto basis claim appears in the quoted words. */
export function quoteStatesTaxBasis(quote: string): boolean {
  const normalized = quote.toLowerCase();
  return normalized.includes("netto") || normalized.includes("brutto");
}
