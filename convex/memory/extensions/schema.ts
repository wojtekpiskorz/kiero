/**
 * Typed extension definition tables (candidate fragment, A2).
 *
 * Owning implementer: C3 (versioned typed extensions and catalog reuse).
 * Definitions are bounded data, never executable schema code. Field IDs are
 * stable across label changes; a change of meaning or kind creates a new
 * immutable version, preserving the interpretation of historic values.
 * Reuse and similarity checks precede creating near-duplicates; usage counts
 * come from stored data, not model estimates.
 *
 * Tables: extensionDefinitions, extensionVersions, extensionUsage.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../../schema/shared";
import { ExtensionFieldKind } from "@kiero/contracts";

/** Field kinds inside a version snapshot; pinned to the contracts vocabulary. */
const fieldKind: ValueValidator<Encoded<typeof ExtensionFieldKind>> = v.union(
  v.literal("text"),
  v.literal("quantity"),
  v.literal("boolean"),
  v.literal("enum"),
  v.literal("financial"),
  v.literal("temporal"),
  v.literal("entity_ref"),
  v.literal("object"),
  v.literal("list"),
);

/** One field shape inside a definition version (bounded snapshot). */
const fieldShape = v.object({
  fieldId: v.string(),
  label: v.string(),
  kind: fieldKind,
  options: v.optional(v.array(v.object({ optionId: v.string(), label: v.string() }))),
  description: v.optional(v.string()),
});

export const extensionsTables = {
  /** Stable definition identity; shared catalog entries have no company. */
  extensionDefinitions: defineTable({
    companyId: v.optional(shared.companyId),
    stableKey: v.string(),
    currentVersionId: v.optional(shared.extensionVersionId),
    createdAtMs: shared.tsMs,
  })
    // by_company (companyId) is intentionally absent: it is a strict prefix
    // of by_company_key.
    .index("by_company_key", ["companyId", "stableKey"]),

  /** Append-only version snapshots. No row here is ever rewritten. */
  extensionVersions: defineTable({
    definitionId: shared.extensionDefinitionId,
    version: shared.counter,
    name: v.string(),
    fields: v.array(fieldShape),
    changeNote: v.string(),
    createdAtMs: shared.tsMs,
  }).index("by_definition_version", ["definitionId", "version"]),

  /** Stored usage statistics per company (repeat-need signal, not model guess). */
  extensionUsage: defineTable({
    companyId: shared.companyId,
    definitionId: shared.extensionDefinitionId,
    usedVersionId: shared.extensionVersionId,
    usageCount: shared.counter,
    lastUsedAtMs: shared.tsMs,
  }).index("by_company_definition", ["companyId", "definitionId"]),
} as const;
