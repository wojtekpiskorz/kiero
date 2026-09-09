/**
 * Search module surface (derived search records; architecture "Logical data
 * dictionary"). Implements lanes: E5 (indexing/retrieval), H3 (UI reads).
 *
 * Search indexes are disposable derived data, never authority: absence of a
 * semantic hit is never absence of a fact. Index generations are versioned
 * (model, provider, dimensions, text preparation); an incompatible change
 * requires a new generation and verified cutover. Coverage gaps during
 * embedding outages are disclosed, not hidden.
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { operationEntry, eventEntry } from "./registration";

export const searchOperations = {
  "search.startIndexGeneration": operationEntry({
    kind: "operation",
    name: "search.startIndexGeneration",
    input: Schema.Struct({
      embeddingModel: Schema.NonEmptyString,
      textPreparationVersion: Schema.NonEmptyString,
      dimensions: Schema.Number.pipe(
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isGreaterThan(0)),
      ),
    }),
    result: Schema.Struct({ generationId: tableIdSchema("searchIndexGenerations") }),
    errorKinds: ["forbidden", "conflict"],
  }),
  "search.cutOverIndexGeneration": operationEntry({
    kind: "operation",
    name: "search.cutOverIndexGeneration",
    input: Schema.Struct({ generationId: tableIdSchema("searchIndexGenerations") }),
    result: Schema.Struct({ generationId: tableIdSchema("searchIndexGenerations") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  "search.queryEvidence": operationEntry({
    kind: "operation",
    name: "search.queryEvidence",
    input: Schema.Struct({
      query: Schema.NonEmptyString,
      limit: Schema.Number.pipe(
        Schema.check(Schema.isInt()),
        Schema.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
      ),
    }),
    result: Schema.Struct({
      entries: Schema.Array(
        Schema.Struct({
          searchEntryId: tableIdSchema("searchEntries"),
          sourceFragmentId: tableIdSchema("sourceFragments"),
          score: Schema.Number,
        }),
      ),
      coverage: Schema.Literals(["full", "text_only", "degraded"]),
    }),
    errorKinds: ["forbidden", "unavailable"],
  }),
} as const;

export const searchEvents = {
  "search.indexGenerationStarted": eventEntry({
    kind: "event",
    name: "search.indexGenerationStarted",
    payload: Schema.Struct({ generationId: tableIdSchema("searchIndexGenerations") }),
  }),
  "search.indexGenerationCutOver": eventEntry({
    kind: "event",
    name: "search.indexGenerationCutOver",
    payload: Schema.Struct({ generationId: tableIdSchema("searchIndexGenerations") }),
  }),
} as const;
