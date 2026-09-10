/**
 * E5 focused verification, part 2: the wiring surfaces, the contract
 * entries, the write-authority validation, the executor registration behind
 * the A3 seam, the dispatch intents, the schema-fragment amendments and the
 * outbox projections of this lane's consumer edges. The transaction halves
 * and the live retrieval paths are exercised by tests/e5/live-proof.mjs
 * against the leased dev deployment.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { searchIndexInput, searchOperations } from "@kiero/contracts";
import { projectEventToJobInputs } from "../../convex/platform/outbox";
import { jobExecutors } from "../../convex/platform/executors";
import { searchIndexExecutor, draftKeyOf } from "../../convex/search/executor";
import { buildDedupKey } from "../../convex/search/generations";
import {
  searchMutationHandlers,
  searchQueryHandlers,
} from "../../convex/search/dispatch";
import { validateEmbeddingForGeneration, validatePreparedText } from "../../convex/search/records";
import { searchTables } from "../../convex/search/schema";
import { INDEX_CANDIDATE } from "@kiero/retrieval";

describe("contract entries and the write authority", () => {
  it("the executor input decodes the three modes with nullable subjects", () => {
    const decoded = Schema.decodeUnknownSync(searchIndexInput)({
      generationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      mode: "build",
      sourceId: null,
      findingId: null,
    });
    expect(decoded.mode).toBe("build");
    const refresh = Schema.decodeUnknownSync(searchIndexInput)({
      generationId: null,
      mode: "refresh_source",
      sourceId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      findingId: null,
    });
    expect(refresh.generationId).toBeNull();
    expect(() =>
      Schema.decodeUnknownSync(searchIndexInput)({
        generationId: null,
        mode: "reindex_everything",
        sourceId: null,
        findingId: null,
      }),
    ).toThrow();
  });

  it("wrong-dimension or malformed embeddings fail the index write (pure verdicts)", () => {
    const okVector = new Array<number>(INDEX_CANDIDATE.dimensions).fill(0.1);
    expect(validateEmbeddingForGeneration(4096, okVector)).toEqual({ ok: true });
    // Wrong-dimension vector against the generation: the write fails.
    expect(validateEmbeddingForGeneration(4096, [0.1, 0.2])).toEqual({
      ok: false,
      errorKind: "embedding_dimension_mismatch",
    });
    // A generation that disagrees with the pinned baseline refuses all writes.
    expect(validateEmbeddingForGeneration(2048, new Array<number>(2048).fill(0.1))).toEqual({
      ok: false,
      errorKind: "generation_dimensions_incompatible",
    });
    // Non-finite members are malformed output, never normalized into acceptance.
    const withNaN = new Array<number>(4096).fill(0.1);
    withNaN[7] = Number.POSITIVE_INFINITY;
    expect(validateEmbeddingForGeneration(4096, withNaN)).toEqual({
      ok: false,
      errorKind: "embedding_not_finite",
    });
    expect(validatePreparedText("   ")).toEqual({ ok: false, errorKind: "prepared_text_empty" });
  });

  it("the query evidence contract decodes filters, cursor and rejects bad limits", () => {
    const queryEntry = searchOperations["search.queryEvidence"];
    const decoded = Schema.decodeUnknownSync(queryEntry.input)({
      query: "wylewka",
      limit: 10,
      projectId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      cursor: "abc",
    });
    expect(decoded.limit).toBe(10);
    expect(() =>
      Schema.decodeUnknownSync(queryEntry.input)({ query: "wylewka", limit: 0 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(queryEntry.input)({ query: "", limit: 5 }),
    ).toThrow();
    // The result shape carries the coverage disclosure and the page flag.
    expect(() =>
      Schema.decodeUnknownSync(queryEntry.result)({
        entries: [
          {
            searchEntryId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
            kind: "source_fragment",
            sourceId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
            score: 0.5,
            matchedVia: "text",
          },
        ],
        coverage: "text_only",
        isDone: true,
      }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(queryEntry.result)({
        entries: [],
        coverage: "partial",
        isDone: true,
      }),
    ).toThrow();
  });
});

describe("executor and dispatch registration", () => {
  it("the search executor claims exactly the registered job kind", () => {
    expect(searchIndexExecutor.jobKind).toBe("search.index_generation");
    expect(jobExecutors["search.index_generation"]).toBe(searchIndexExecutor);
  });

  it("the lifecycle operations dispatch under the administer intent", () => {
    const handlers = searchMutationHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "search.cutOverIndexGeneration",
      "search.startIndexGeneration",
    ]);
    expect(handlers["search.startIndexGeneration"]?.intent).toBe("administer");
    expect(handlers["search.cutOverIndexGeneration"]?.intent).toBe("administer");
    expect(handlers["search.queryEvidence"]).toBeUndefined();
  });

  it("the query operation dispatches under the read intent", () => {
    const handlers = searchQueryHandlers();
    expect(Object.keys(handlers)).toEqual(["search.queryEvidence"]);
    expect(handlers["search.queryEvidence"]?.intent).toBe("read");
  });

  it("the build dedup key is the cutover's evidence identity", () => {
    expect(buildDedupKey("gen1")).toBe("search.index_generation:build:gen1");
  });

  it("draft keys prefer the fragment, then the finding, then the source", () => {
    expect(
      draftKeyOf({
        generationId: "g" as never,
        companyId: "c" as never,
        sourceFragmentId: "f1" as never,
        sourceId: "s1" as never,
        preparedText: "x",
      }),
    ).toBe("fragment:f1");
    expect(
      draftKeyOf({
        generationId: "g" as never,
        companyId: "c" as never,
        findingId: "fd1" as never,
        findingRevisionId: "r1" as never,
        preparedText: "x",
      }),
    ).toBe("finding:fd1");
    expect(
      draftKeyOf({
        generationId: "g" as never,
        companyId: "c" as never,
        sourceId: "s1" as never,
        preparedText: "x",
      }),
    ).toBe("source:s1");
  });
});

describe("schema fragment amendments", () => {
  type IndexableTable = { " indexes"(): { indexDescriptor: string; fields: string[] }[] };

  it("the entry reads are company-and-generation scoped through real indexes", () => {
    const indexes = (searchTables.searchEntries as unknown as IndexableTable)[" indexes"]();
    const byName = new Map(indexes.map((index) => [index.indexDescriptor, index.fields]));
    expect(byName.get("by_company_generation")).toEqual(["companyId", "generationId"]);
    expect(byName.get("by_source")).toEqual(["sourceId"]);
    expect(byName.get("by_finding")).toEqual(["findingId"]);
    expect(byName.get("by_fragment")).toEqual(["sourceFragmentId"]);
    expect(byName.get("by_generation")).toEqual(["generationId"]);
  });

  it("the generation state vocabulary is the closed three-state lifecycle", () => {
    const fields = (searchTables.searchIndexGenerations as unknown as {
      validator: { fields: Record<string, { kind: string; members?: { value: unknown }[] }> };
    }).validator.fields;
    const state = fields.state;
    expect(state?.kind).toBe("union");
    expect(state?.members?.map((member) => member.value).sort()).toEqual([
      "active",
      "building",
      "retired",
    ]);
  });
});

describe("outbox projections of the search edges", () => {
  it("withdrawal and purge project one scoped source refresh each", () => {
    const withdrawn = projectEventToJobInputs(
      "sources.sourceWithdrawn",
      { sourceId: "s1", reason: "mylące" },
      "dk-w",
    );
    expect(withdrawn).toContainEqual({
      kind: "job",
      jobKind: "search.index_generation",
      input: { generationId: null, mode: "refresh_source", sourceId: "s1", findingId: null },
      dedupKey: "search.index_generation:refresh_source:s1",
    });
    const purged = projectEventToJobInputs("sources.sourcePurged", { sourceId: "s2" }, "dk-p");
    expect(purged).toContainEqual({
      kind: "job",
      jobKind: "search.index_generation",
      input: { generationId: null, mode: "refresh_source", sourceId: "s2", findingId: null },
      dedupKey: "search.index_generation:refresh_source:s2",
    });
  });

  it("a revised finding projects one current-revision rebuild", () => {
    const revised = projectEventToJobInputs(
      "memory.findingRevised",
      { findingId: "f1", revisionId: "r2", supersedesRevisionId: "r1" },
      "dk-r",
    );
    expect(revised).toContainEqual({
      kind: "job",
      jobKind: "search.index_generation",
      input: { generationId: null, mode: "refresh_finding", sourceId: null, findingId: "f1" },
      dedupKey: "search.index_generation:refresh_finding:f1",
    });
  });
});
