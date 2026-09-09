/**
 * Typed extension definition tables (A2 candidate, certified by A3;
 * completed by C3 for the versioned typed extensions and catalog reuse
 * lane).
 *
 * Owning implementer: C3. Definitions are bounded data, never executable
 * schema code. Field IDs are stable across label changes; a change of
 * meaning or kind creates a new immutable version, preserving the
 * interpretation of historic values. Reuse and similarity checks precede
 * creating near-duplicates; usage counts come from stored data (committed
 * finding revisions), not model estimates.
 *
 * C3 completion of the candidate fragment:
 * - `extensionVersions.fields` pins to the C3-amended contracts field shape
 *   (scalar kinds plus scalar-item lists; `unit` on quantity fields and
 *   `itemKind` on list fields). The value-vocabulary kind `object` is NOT a
 *   legal field kind here, so the Convex validator itself refuses recursive
 *   shapes; the domain rule layer re-checks on every write path.
 * - `extensionDefinitions.stableKey` is the normalized name (the idempotency
 *   key for duplicate-definition races and the never-silently-reuse guard).
 * - Version rows are append-only by construction: no code path patches or
 *   deletes them; a definition only ever moves `currentVersionId` forward.
 *
 * Tables: extensionDefinitions, extensionVersions, extensionUsage.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../../schema/shared";
import { ExtensionFieldShape } from "@kiero/contracts";

/**
 * Field kinds inside a version snapshot; pinned to the contracts definition
 * field vocabulary (scalar kinds plus bounded lists; `object` is a value
 * kind, not a field kind — an object field would demand forbidden nesting).
 */
const fieldKind: ValueValidator<Encoded<typeof ExtensionFieldShape>["kind"]> = v.union(
  v.literal("text"),
  v.literal("quantity"),
  v.literal("boolean"),
  v.literal("enum"),
  v.literal("financial"),
  v.literal("temporal"),
  v.literal("entity_ref"),
  v.literal("list"),
);

/** The scalar item kinds a list field may declare (no nested containers). */
const scalarItemKind: ValueValidator<
  NonNullable<Encoded<typeof ExtensionFieldShape>["itemKind"]>
> = v.union(
  v.literal("text"),
  v.literal("quantity"),
  v.literal("boolean"),
  v.literal("enum"),
  v.literal("financial"),
  v.literal("temporal"),
  v.literal("entity_ref"),
);

/** One field shape inside a definition version (bounded snapshot). */
const fieldShape = v.object({
  fieldId: v.string(),
  label: v.string(),
  kind: fieldKind,
  unit: v.optional(v.string()),
  itemKind: v.optional(scalarItemKind),
  options: v.optional(v.array(v.object({ optionId: v.string(), label: v.string() }))),
  description: v.optional(v.string()),
});

export const extensionsTables = {
  /**
   * Stable definition identity; shared catalog entries have no company
   * (only product code can publish those — the checked operation surface
   * offers no shared-creation path). `stableKey` is the normalized name.
   */
  extensionDefinitions: defineTable({
    companyId: v.optional(shared.companyId),
    stableKey: v.string(),
    currentVersionId: v.optional(shared.extensionVersionId),
    createdAtMs: shared.tsMs,
  })
    // by_company (companyId) is intentionally absent: it is a strict prefix
    // of by_company_key.
    .index("by_company_key", ["companyId", "stableKey"]),

  /**
   * Append-only version snapshots. No row here is ever rewritten; historic
   * values keep the version row they were written against.
   *
   * Bounded sizes: Convex 1.45 validators cannot bound array LENGTHS, so
   * the size bounds (max fields per version, max enum options) are enforced
   * at every write path — the Effect operation inputs carry the exact
   * value-contract bounds and the domain rule re-checks them before any
   * insert; there is no other write path (the guarded product seeding
   * writes fixed shapes).
   */
  extensionVersions: defineTable({
    definitionId: shared.extensionDefinitionId,
    version: shared.counter,
    name: v.string(),
    fields: v.array(fieldShape),
    changeNote: v.string(),
    createdAtMs: shared.tsMs,
  }).index("by_definition_version", ["definitionId", "version"]),

  /**
   * Stored usage statistics per company (repeat-need signal, not a model
   * guess). One row per (company, definition, version); counters move ONLY
   * inside the transactions that commit finding revisions carrying the
   * extension value, so counts are derived from committed records.
   */
  extensionUsage: defineTable({
    companyId: shared.companyId,
    definitionId: shared.extensionDefinitionId,
    usedVersionId: shared.extensionVersionId,
    usageCount: shared.counter,
    lastUsedAtMs: shared.tsMs,
  }).index("by_company_definition", ["companyId", "definitionId"]),
} as const;
