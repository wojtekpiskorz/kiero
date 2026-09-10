/**
 * Shared tenant-scoped reference checks and usage bookkeeping for the
 * extensions lane (C3), mirroring the findings lane's references module.
 *
 * Visibility rule: a company sees its OWN definitions and the SHARED
 * definitions (companyId absent). Anything else — missing or another firm's
 * — resolves to null without saying which, so no existence information leaks
 * across the tenant boundary. Firm definitions never change another
 * tenant's catalog.
 */

import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";

/** The DB reader surface the reference checks need (mutation or query). */
export type Db = MutationCtx["db"] | QueryCtx["db"];

/** A definition row as the cores read it. */
export type DefinitionDoc = Doc<"extensionDefinitions">;
/** A version row as the cores read it (append-only snapshots). */
export type VersionDoc = Doc<"extensionVersions">;

/** True when the definition is visible to the company (own or shared). */
function visibleToCompany(definition: DefinitionDoc, companyId: Id<"companies">): boolean {
  return definition.companyId === undefined || definition.companyId === companyId;
}

/** One visible definition by id, or null when missing/foreign/malformed. */
export async function requireDefinition(
  db: Db,
  definitionRef: string,
  companyId: Id<"companies">,
): Promise<DefinitionDoc | null> {
  const definitionId = db.normalizeId("extensionDefinitions", definitionRef);
  if (definitionId === null) {
    return null;
  }
  const definition = await db.get(definitionId);
  if (definition === null || !visibleToCompany(definition, companyId)) {
    return null;
  }
  return definition;
}

/**
 * One visible definition version (the row + its definition), or null when
 * missing/foreign/malformed. This is the exact-version resolution every
 * value validation goes through.
 */
export async function requireDefinitionVersion(
  db: Db,
  versionRef: string,
  companyId: Id<"companies">,
): Promise<{ definition: DefinitionDoc; version: VersionDoc } | null> {
  const versionId = db.normalizeId("extensionVersions", versionRef);
  if (versionId === null) {
    return null;
  }
  const version = await db.get(versionId);
  if (version === null) {
    return null;
  }
  const definition = await db.get(version.definitionId);
  if (definition === null || !visibleToCompany(definition, companyId)) {
    return null;
  }
  return { definition, version };
}

/** The version-1 snapshot of a definition (the required-field baseline). */
export async function firstVersionOf(
  db: Db,
  definitionId: Id<"extensionDefinitions">,
): Promise<VersionDoc | null> {
  return await db
    .query("extensionVersions")
    .withIndex("by_definition_version", (q) =>
      q.eq("definitionId", definitionId).eq("version", 1),
    )
    .first();
}

/** All version snapshots of one definition, oldest first. */
export async function versionHistoryOf(
  db: Db,
  definitionId: Id<"extensionDefinitions">,
): Promise<VersionDoc[]> {
  return await db
    .query("extensionVersions")
    .withIndex("by_definition_version", (q) => q.eq("definitionId", definitionId))
    .order("asc")
    .collect();
}

/** The definition's current version row (null only for a corrupt definition). */
export async function currentVersionOf(
  db: Db,
  definition: DefinitionDoc,
): Promise<VersionDoc | null> {
  if (definition.currentVersionId === undefined) {
    return null;
  }
  return await db.get(definition.currentVersionId);
}

/** The definition with this stable key visible to the company, if any. */
export async function findDefinitionByStableKey(
  db: Db,
  companyId: Id<"companies">,
  stableKey: string,
): Promise<{ own: DefinitionDoc | null; shared: DefinitionDoc | null }> {
  const own = await db
    .query("extensionDefinitions")
    .withIndex("by_company_key", (q) => q.eq("companyId", companyId).eq("stableKey", stableKey))
    .first();
  // Shared definitions carry no company; the index's first field is the
  // optional companyId, so the undefined-value scan stays a filter query.
  const shared = await db
    .query("extensionDefinitions")
    .filter((q) =>
      q.and(
        q.eq(q.field("companyId"), undefined),
        q.eq(q.field("stableKey"), stableKey),
      ),
    )
    .first();
  return { own, shared };
}

/** This company's usage rows, grouped per definition (committed counts). */
export async function companyUsageByDefinition(
  db: Db,
  companyId: Id<"companies">,
): Promise<Map<Id<"extensionDefinitions">, { usageCount: number; lastUsedAtMs: number | null }>> {
  const rows = await db
    .query("extensionUsage")
    .withIndex("by_company_definition", (q) => q.eq("companyId", companyId))
    .collect();
  const usage = new Map<Id<"extensionDefinitions">, { usageCount: number; lastUsedAtMs: number | null }>();
  for (const row of rows) {
    const aggregated = usage.get(row.definitionId);
    usage.set(row.definitionId, {
      usageCount: (aggregated?.usageCount ?? 0) + row.usageCount,
      lastUsedAtMs:
        aggregated?.lastUsedAtMs === undefined || aggregated.lastUsedAtMs === null
          ? row.lastUsedAtMs
          : Math.max(aggregated.lastUsedAtMs, row.lastUsedAtMs),
    });
  }
  return usage;
}

/**
 * Moves the committed-usage counter for (company, definition, version) by
 * one, inside the caller's transaction. Called ONLY from the transactions
 * that commit a finding revision carrying the extension value, so counts
 * are derived from committed records and move atomically with them.
 */
export async function bumpExtensionUsage(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  definitionId: Id<"extensionDefinitions">,
  usedVersionId: Id<"extensionVersions">,
  nowMs: number,
): Promise<void> {
  const existing = await db
    .query("extensionUsage")
    .withIndex("by_company_definition", (q) =>
      q.eq("companyId", companyId).eq("definitionId", definitionId),
    )
    .filter((q) => q.eq(q.field("usedVersionId"), usedVersionId))
    .first();
  if (existing === null) {
    await db.insert("extensionUsage", {
      companyId,
      definitionId,
      usedVersionId,
      usageCount: 1,
      lastUsedAtMs: nowMs,
    });
    return;
  }
  await db.patch(existing._id, {
    usageCount: existing.usageCount + 1,
    lastUsedAtMs: nowMs,
  });
}
