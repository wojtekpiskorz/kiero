/**
 * Derived search records (A2 candidate, certified by A3).
 *
 * Owning implementer: E5 (tenant-safe versioned retrieval).
 * Search indexes are disposable derived data, never authority. Entries carry
 * their index generation; incompatible model, dimensions or text preparation
 * requires a new generation and verified cutover. Absence of a semantic hit
 * is never absence of a fact.
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
    /** Versioned text preparation output. */
    preparedText: v.string(),
    embedding: v.optional(v.array(v.float64())),
    createdAtMs: shared.tsMs,
  })
    .index("by_fragment", ["sourceFragmentId"])
    .index("by_generation", ["generationId"]),

  /** Versioned index generation lifecycle for verified cutover. */
  searchIndexGenerations: defineTable({
    embeddingModel: v.string(),
    textPreparationVersion: v.string(),
    dimensions: v.float64(),
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
