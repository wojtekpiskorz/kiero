/**
 * E5 focused verification, part 1: the pure retrieval cores
 * (@kiero/retrieval), versioned text preparation, the pinned initial
 * candidate, cosine similarity and hybrid assembly, coverage disclosure and
 * the hydration keep-or-drop rules (tenant scope, lifecycle, filters,
 * obsolete revisions).
 */

import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS_BASELINE,
  EMBEDDING_MODEL_ORDER,
} from "@kiero/providers";
import {
  INDEX_CANDIDATE,
  assembleRankedCandidates,
  computeCoverage,
  cosineSimilarity,
  foldText,
  isCompatibleCandidate,
  keepFindingEntry,
  keepSourceEntry,
  matchesPreparedText,
  pageCandidates,
  prepareDocumentText,
  prepareFindingText,
  prepareQueryText,
  textMatchScore,
  TEXT_PREPARATION_VERSION,
} from "@kiero/retrieval";

describe("versioned text preparation", () => {
  it("folds Polish case and diacritics for matching (lossy by design)", () => {
    expect(foldText("  Wylewka   betonowa  ")).toBe("wylewka betonowa");
    expect(foldText("Żółwia łódź")).toBe("zolwia lodz");
    expect(foldText("Łódź")).toBe("lodz");
    expect(prepareDocumentText("Ładunek DREWNA")).toBe("ladunek drewna");
  });

  it("query and document preparation are the same fold (symmetric matching)", () => {
    const document = prepareDocumentText("Umówiliśmy wylewkę na 12 października");
    expect(matchesPreparedText(document, prepareQueryText("wylewka"))).toBe(true);
    expect(matchesPreparedText(document, prepareQueryText("WYLEWKĄ"))).toBe(true);
    expect(matchesPreparedText(document, prepareQueryText("bruk"))).toBe(false);
  });

  it("every query token must match; the score is the matched fraction", () => {
    const document = prepareDocumentText("wylewka betonowa na suficie poddasza");
    expect(matchesPreparedText(document, prepareQueryText("wylewka bruk"))).toBe(false);
    expect(textMatchScore(document, prepareQueryText("wylewka betonowa"))).toBe(1);
    expect(textMatchScore(document, prepareQueryText("wylewka bruk"))).toBeCloseTo(0.5);
    expect(textMatchScore(document, prepareQueryText("bruk kostka"))).toBe(0);
  });

  it("a substring inflection hit matches (wylewk finds wylewke/wylewka)", () => {
    const document = prepareDocumentText("Zrobimy wylewkę anhydrytową");
    expect(matchesPreparedText(document, prepareQueryText("wylewk"))).toBe(true);
  });

  it("finding preparation renders the semantic key and the encoded value", () => {
    const prepared = prepareFindingText("termin_wykonania", {
      _tag: "temporal",
      temporal: { shape: { _tag: "day", day: "2026-10-12" }, originalExpression: "12 października", role: "agreed" },
    });
    expect(prepared).toContain("termin_wykonania");
    expect(prepared).toContain("2026-10-12");
    expect(prepared).toContain("agreed");
  });

  it("an empty query never matches anything", () => {
    expect(matchesPreparedText("wylewka", prepareQueryText("  "))).toBe(false);
    expect(textMatchScore("wylewka", prepareQueryText("  "))).toBe(0);
  });
});

describe("the pinned initial candidate", () => {
  it("mirrors E2's routing constants exactly (drift fails here)", () => {
    expect(INDEX_CANDIDATE.embeddingModel).toBe(EMBEDDING_MODEL_ORDER[0]);
    expect(INDEX_CANDIDATE.dimensions).toBe(EMBEDDING_DIMENSIONS_BASELINE);
    expect(INDEX_CANDIDATE.dimensions).toBe(4096);
    expect(INDEX_CANDIDATE.textPreparationVersion).toBe(TEXT_PREPARATION_VERSION);
  });

  it("accepts exactly the pinned candidate and refuses every drift", () => {
    expect(
      isCompatibleCandidate({
        embeddingModel: INDEX_CANDIDATE.embeddingModel,
        textPreparationVersion: INDEX_CANDIDATE.textPreparationVersion,
        dimensions: INDEX_CANDIDATE.dimensions,
      }),
    ).toEqual({ ok: true });
    expect(
      isCompatibleCandidate({
        embeddingModel: "other/model",
        textPreparationVersion: INDEX_CANDIDATE.textPreparationVersion,
        dimensions: INDEX_CANDIDATE.dimensions,
      }),
    ).toEqual({ ok: false, reason: "model_not_supported" });
    expect(
      isCompatibleCandidate({
        embeddingModel: INDEX_CANDIDATE.embeddingModel,
        textPreparationVersion: INDEX_CANDIDATE.textPreparationVersion,
        dimensions: 2048,
      }),
    ).toEqual({ ok: false, reason: "dimensions_not_supported" });
    expect(
      isCompatibleCandidate({
        embeddingModel: INDEX_CANDIDATE.embeddingModel,
        textPreparationVersion: "e5.fold.v2",
        dimensions: INDEX_CANDIDATE.dimensions,
      }),
    ).toEqual({ ok: false, reason: "preparation_unknown" });
  });
});

describe("cosine similarity and hybrid assembly", () => {
  it("scores parallel and orthogonal vectors; incomparable pairs are null", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNull();
    expect(cosineSimilarity([], [])).toBeNull();
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNull();
    expect(cosineSimilarity([1, Number.NaN], [1, 0])).toBeNull();
  });

  it("merges signals, discloses matchedVia, orders deterministically", () => {
    const ranked = assembleRankedCandidates([
      { searchEntryId: "k3", textScore: 0.5, semanticScore: null },
      { searchEntryId: "k1", textScore: 0, semanticScore: 0.9 },
      { searchEntryId: "k2", textScore: 1, semanticScore: 0.45 },
      { searchEntryId: "k4", textScore: 0.5, semanticScore: 0.5 },
    ]);
    // Scores: k2 = 1, k1 = 0.9, k3 = k4 = 0.5 (tie broken by id ascending).
    expect(ranked.map((candidate) => candidate.searchEntryId)).toEqual(["k2", "k1", "k3", "k4"]);
    expect(ranked.find((c) => c.searchEntryId === "k1")?.matchedVia).toBe("semantic");
    expect(ranked.find((c) => c.searchEntryId === "k2")?.matchedVia).toBe("text_and_semantic");
    expect(ranked.find((c) => c.searchEntryId === "k3")?.matchedVia).toBe("text");
  });

  it("a below-floor pure-semantic candidate is ranking noise, not evidence", () => {
    // Above the floor: a pure semantic hit survives.
    expect(
      assembleRankedCandidates([{ searchEntryId: "k1", textScore: 0, semanticScore: 0.9 }]),
    ).toHaveLength(1);
    // Below the floor with no text signal: dropped.
    expect(
      assembleRankedCandidates([{ searchEntryId: "k2", textScore: 0, semanticScore: 0.2 }]),
    ).toEqual([]);
    // Below the floor WITH a text signal: kept, reported as a text hit.
    const kept = assembleRankedCandidates([
      { searchEntryId: "k3", textScore: 0.5, semanticScore: 0.2 },
    ]);
    expect(kept[0]?.matchedVia).toBe("text");
    expect(kept[0]?.score).toBeCloseTo(0.5);
  });

  it("paginates by cursor with stable ordering and an end flag", () => {
    const ranked = assembleRankedCandidates([
      { searchEntryId: "ka", textScore: 1, semanticScore: null },
      { searchEntryId: "kb", textScore: 0.8, semanticScore: null },
      { searchEntryId: "kc", textScore: 0.6, semanticScore: null },
    ]);
    const first = pageCandidates(ranked, undefined, 2);
    expect(first.page.map((c) => c.searchEntryId)).toEqual(["ka", "kb"]);
    expect(first.isDone).toBe(false);
    const second = pageCandidates(ranked, "kb", 2);
    expect(second.page.map((c) => c.searchEntryId)).toEqual(["kc"]);
    expect(second.isDone).toBe(true);
    const unknownCursor = pageCandidates(ranked, "zz", 2);
    expect(unknownCursor.page).toEqual([]);
    expect(unknownCursor.isDone).toBe(true);
  });
});

describe("retrieval coverage disclosure", () => {
  it("no active generation degrades (typed reads remain, disclosed)", () => {
    expect(
      computeCoverage({ activeGeneration: false, queryEmbedded: false, indexedEntries: 0, embeddedEntries: 0 }),
    ).toBe("degraded");
  });

  it("an embedding outage or a partially embedded scope is text_only", () => {
    expect(
      computeCoverage({ activeGeneration: true, queryEmbedded: false, indexedEntries: 5, embeddedEntries: 5 }),
    ).toBe("text_only");
    expect(
      computeCoverage({ activeGeneration: true, queryEmbedded: true, indexedEntries: 5, embeddedEntries: 3 }),
    ).toBe("text_only");
  });

  it("full only when the query embedded and every entry is embedded", () => {
    expect(
      computeCoverage({ activeGeneration: true, queryEmbedded: true, indexedEntries: 5, embeddedEntries: 5 }),
    ).toBe("full");
    expect(
      computeCoverage({ activeGeneration: true, queryEmbedded: true, indexedEntries: 0, embeddedEntries: 0 }),
    ).toBe("full");
  });
});

describe("hydration keep-or-drop rules", () => {
  const activeSource = {
    source: { sourceCompanyId: "c1", lifecycle: "active" as const },
    linkedProjectIds: ["p1"],
    authorUserId: "u1",
    sentAtMs: 1_000,
  };

  it("keeps an in-company active source; drops every tenant mismatch", () => {
    expect(keepSourceEntry("c1", activeSource, {})).toBe(true);
    expect(keepSourceEntry("c2", activeSource, {})).toBe(false);
  });

  it("withdrawn and purged evidence authorize nothing", () => {
    expect(
      keepSourceEntry("c1", { ...activeSource, source: { sourceCompanyId: "c1", lifecycle: "withdrawn" } }, {}),
    ).toBe(false);
    expect(
      keepSourceEntry("c1", { ...activeSource, source: { sourceCompanyId: "c1", lifecycle: "purged" } }, {}),
    ).toBe(false);
  });

  it("enforces project, author and date filters server-side", () => {
    expect(keepSourceEntry("c1", activeSource, { projectId: "p1" })).toBe(true);
    expect(keepSourceEntry("c1", activeSource, { projectId: "p2" })).toBe(false);
    expect(keepSourceEntry("c1", activeSource, { authorUserId: "u1" })).toBe(true);
    expect(keepSourceEntry("c1", activeSource, { authorUserId: "u2" })).toBe(false);
    expect(keepSourceEntry("c1", activeSource, { sentFromMs: 900 })).toBe(true);
    expect(keepSourceEntry("c1", activeSource, { sentFromMs: 1_001 })).toBe(false);
    expect(keepSourceEntry("c1", activeSource, { sentToMs: 1_000 })).toBe(true);
    expect(keepSourceEntry("c1", activeSource, { sentToMs: 999 })).toBe(false);
  });

  it("an obsolete finding revision never authorizes an answer", () => {
    const finding = { findingCompanyId: "c1", currentRevisionId: "r2" };
    expect(keepFindingEntry("c1", finding, "r2", {})).toBe(true);
    expect(keepFindingEntry("c1", finding, "r1", {})).toBe(false);
    expect(keepFindingEntry("c1", { findingCompanyId: "c1", currentRevisionId: null }, "r1", {})).toBe(false);
    expect(keepFindingEntry("c1", finding, null, {})).toBe(false);
    expect(keepFindingEntry("c2", finding, "r2", {})).toBe(false);
  });

  it("message-attribute filters exclude finding-backed entries (no guessed scope)", () => {
    const finding = { findingCompanyId: "c1", currentRevisionId: "r2" };
    expect(keepFindingEntry("c1", finding, "r2", { projectId: "p1" })).toBe(false);
    expect(keepFindingEntry("c1", finding, "r2", { authorUserId: "u1" })).toBe(false);
    expect(keepFindingEntry("c1", finding, "r2", { sentFromMs: 1 })).toBe(false);
  });
});
