/**
 * Search module surface (derived search records; architecture "Logical data
 * dictionary"). Implements lanes: E5 (indexing/retrieval), H3 (UI reads).
 *
 * Search indexes are disposable derived data, never authority: absence of a
 * semantic hit is never absence of a fact. Index generations are versioned
 * (model, provider, dimensions, text preparation); an incompatible change
 * requires a new generation and verified cutover. Coverage gaps during
 * embedding outages are disclosed, not hidden.
 *
 * E5 amendments (the owning lane completes its candidate surface; the
 * A2/A3 candidate shapes are kept and extended additively):
 * - `search.queryEvidence` input gains the optional Polish barebones
 *   filters (project, author, send-date range) and a cursor, and its result
 *   entries become hydrated rows: kind (source fragment vs finding), the
 *   canonical ids the UI links to, the score and which half (text/semantic)
 *   produced the hit, plus the page's `isDone`. The declared coverage
 *   literal is unchanged and remains the semantic-gap disclosure.
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
      // E5: optional filters and cursor (all additive; H3 consumes).
      projectId: Schema.optionalKey(tableIdSchema("projects")),
      authorUserId: Schema.optionalKey(tableIdSchema("users")),
      sentFromMs: Schema.optionalKey(Schema.Number),
      sentToMs: Schema.optionalKey(Schema.Number),
      cursor: Schema.optionalKey(Schema.String),
    }),
    result: Schema.Struct({
      entries: Schema.Array(
        Schema.Struct({
          searchEntryId: tableIdSchema("searchEntries"),
          /** Which canonical record kind backs this hit. */
          kind: Schema.Literals(["source_fragment", "finding"]),
          sourceFragmentId: Schema.optionalKey(tableIdSchema("sourceFragments")),
          /** The canonical source link (message text, transcript, OCR rows). */
          sourceId: Schema.optionalKey(tableIdSchema("sources")),
          findingId: Schema.optionalKey(tableIdSchema("findings")),
          score: Schema.Number,
          matchedVia: Schema.Literals(["text", "semantic", "text_and_semantic"]),
        }),
      ),
      coverage: Schema.Literals(["full", "text_only", "degraded"]),
      isDone: Schema.Boolean,
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
