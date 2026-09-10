/**
 * Derived search records (A2 candidate, certified by A3; completed by E5
 * for tenant-safe versioned retrieval).
 *
 * Owning implementer: E5 (indexing/retrieval), H3 (UI reads).
 * Search indexes are disposable derived data, never authority. Entries carry
 * their index generation; incompatible model, dimensions or text preparation
 * requires a new generation and verified cutover. Absence of a semantic hit
 * is never absence of a fact.
 *
 * E5 amendments (the owning lane completes the candidate fragment):
 * - `searchEntries.sourceId`: the canonical link for source-backed entries
 *   (message text, transcript, OCR), denormalized so hydration re-checks
 *   source lifecycle and tenant scope without a fragment hop, and scoped
 *   refreshes (withdrawal, purge) find their rows through a real index.
 * - `searchEntries.findingRevisionId`: the revision a finding-backed entry
 *   was prepared from; hydration drops the entry when the finding's current
 *   projection moved (an obsolete revision never authorizes an answer).
 * - `by_company_generation` (companyId, generationId): the tenant-scoped
 *   read every query starts from; `by_source`/`by_finding` back the scoped
 *   refresh paths.
 * - embeddings are plain columns, NOT a Convex vector index: the pinned
 *   initial candidate's 4096 dimensions exceed the platform vector-index
 *   limit, so the semantic half ranks same-generation rows in-action after
 *   the company filter (the final vector design is the excluded search
 *   track; see @kiero/retrieval similarity).
 * - `searchIndexGenerations.providerRouteVersion`: the frozen E2 route label
 *   the generation rode, so model + dimensions + preparation + ROUTE are
 *   versioned together (the bounded solution's four versioning axes).
 *
 * Tables: searchEntries, searchIndexGenerations.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../schema/shared";

export const searchTables = {
  /** One indexed fragment/finding text with its optional embedding. */
  searchEntries: defineTable({
    companyId: shared.companyId,
    generationId: shared.searchIndexGenerationId,
    sourceFragmentId: v.optional(shared.sourceFragmentId),
    findingId: v.optional(shared.findingId),
    /**
     * E5: the canonical source this entry was derived from, when it is
     * source-backed (message text, transcript segment, OCR region).
     */
    sourceId: v.optional(shared.sourceId),
    /** E5: the revision a finding-backed entry was prepared from. */
    findingRevisionId: v.optional(shared.findingRevisionId),
    /** Versioned text preparation output. */
    preparedText: v.string(),
    /** Same-generation embedding; absent rows still serve full-text reads. */
    embedding: v.optional(v.array(v.float64())),
    createdAtMs: shared.tsMs,
  })
    .index("by_fragment", ["sourceFragmentId"])
    .index("by_generation", ["generationId"])
    // E5: the tenant-scoped query read and the scoped refresh indexes.
    .index("by_company_generation", ["companyId", "generationId"])
    .index("by_source", ["sourceId"])
    .index("by_finding", ["findingId"]),

  /** Versioned index generation lifecycle for verified cutover. */
  searchIndexGenerations: defineTable({
    embeddingModel: v.string(),
    textPreparationVersion: v.string(),
    dimensions: v.float64(),
    /** E5: the frozen E2 provider route label this generation rode. */
    providerRouteVersion: v.string(),
    state: v.union(
      v.literal("building"),
      v.literal("active"),
      v.literal("retired"),
    ),
    createdAtMs: shared.tsMs,
    activatedAtMs: v.optional(shared.tsMs),
    retiredAtMs: v.optional(shared.tsMs),
  }).index("by_state", ["state"]),
} as const;
