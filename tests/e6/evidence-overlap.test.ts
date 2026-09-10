/**
 * E6 focused verification, part 4: the inflection-tolerant evidence
 * matching (packages/agent/tools/evidence.ts), the second
 * inherited-defect fix pinned deterministically.
 *
 * The word-overlap pass must find Polish-inflected recurrences of the
 * query's words („zaliczka” finds „zaliczkę”), return ORIGINAL-text
 * offsets widened to the containing sentence, stay bounded by the quote
 * cap, and refuse weak overlaps (candidates, never truth).
 */

import { describe, expect, it } from "vitest";
import {
  inflectionMatch,
  overlapLocation,
  tokenize,
} from "@kiero/agent/tools";

describe("tokenize", () => {
  it("lowercases and strips punctuation, preserving Polish diacritics", () => {
    const text = "Zaliczka (5000 zł) wpłynęła.";
    const tokens = tokenize(text);
    expect(tokens.map((token) => token.word)).toEqual([
      "zaliczka",
      "5000",
      "zł",
      "wpłynęła",
    ]);
  });

  it("keeps offsets into the ORIGINAL text (anchor stability)", () => {
    const text = "Zaliczka (5000 zł) wpłynęła.";
    const tokens = tokenize(text);
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    expect(text.slice(first?.start ?? -1, first?.end ?? -1)).toBe("Zaliczka");
    expect(text.slice(last?.start ?? -1, last?.end ?? -1)).toBe("wpłynęła.");
  });
});

describe("inflectionMatch", () => {
  it("matches Polish declension within the stem/ending bounds", () => {
    expect(inflectionMatch("zaliczka", "zaliczkę")).toBe(true);
    expect(inflectionMatch("kaczmarek", "kaczmarka")).toBe(true);
    expect(inflectionMatch("dostawa", "dostawy")).toBe(true);
    // a two-character ending ("ch") is still within the bound
    expect(inflectionMatch("zaliczka", "zaliczkach")).toBe(true);
  });

  it("rejects words with no shared stem", () => {
    expect(inflectionMatch("beton", "płytki")).toBe(false);
  });

  it("rejects a stem shorter than the bound, however close the words", () => {
    expect(inflectionMatch("dom", "domek")).toBe(false);
  });

  it("rejects an ending longer than the bound", () => {
    expect(inflectionMatch("dostawa", "dostawczy")).toBe(false);
  });

  it("accepts identical forms", () => {
    expect(inflectionMatch("płytki", "płytki")).toBe(true);
  });
});

describe("overlapLocation", () => {
  const TEXT =
    "Dostawa płytek w piątek. Kaczmarek wpłacił zaliczkę 5000. Montaż w środę.";

  it("locates inflected query words and widens to their sentence", () => {
    const located = overlapLocation(TEXT, "zaliczka Kaczmarka");
    expect(located).not.toBeNull();
    if (located !== null) {
      expect(located.fraction).toBe(1);
      const quote = TEXT.slice(located.startOffset, located.endOffset);
      expect(quote).toContain("Kaczmarek wpłacił zaliczkę");
      expect(quote).not.toContain("Dostawa");
      expect(quote).not.toContain("Montaż");
    }
  });

  it("matches order-free (the query's words may recur in any order)", () => {
    const located = overlapLocation(TEXT, "Kaczmarka zaliczka");
    expect(located).not.toBeNull();
  });

  it("refuses an overlap below the minimum fraction", () => {
    // one of three query words recurs: 1/3 < 1/2
    expect(overlapLocation(TEXT, "zaliczka beton transport")).toBeNull();
  });

  it("accepts an overlap exactly at the minimum fraction", () => {
    // one of two query words recurs: 1/2 is not below the bound
    expect(overlapLocation(TEXT, "zaliczka beton")).not.toBeNull();
  });

  it("refuses a query with no words after tokenization", () => {
    expect(overlapLocation(TEXT, "?!?")).toBeNull();
  });

  it("keeps the match-centered window when the sentence exceeds the quote cap", () => {
    const long =
      "A".repeat(300) + " zaliczka " + "B".repeat(300) + "." + " Drugie zdanie.";
    const located = overlapLocation(long, "zaliczka");
    expect(located).not.toBeNull();
    if (located !== null) {
      expect(located.endOffset - located.startOffset).toBeLessThanOrEqual(400);
      expect(long.slice(located.startOffset, located.endOffset)).toContain(
        "zaliczka",
      );
      expect(located.startOffset).toBeGreaterThan(0); // centered, not from 0
    }
  });
});
