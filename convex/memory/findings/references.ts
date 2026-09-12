/**
 * Shared tenant-scoped reference checks for the findings lane (C2).
 *
 * The resolved company is the only company any row may belong to: every
 * require* helper normalizes the id, reads the row and refuses (returns
 * null) when the row is missing OR belongs to another company — without
 * saying which, so the refusal leaks no existence information across the
 * tenant boundary. Imported by the changeset transactions, corrections,
 * the current read and the withdrawal marking.
 *
 * R1 (issue #126) addition: `checkResolutionEvidenceReference` is the ONE
 * per-reference rule for evidence cited by a clarification resolution
 * (existence, company, active lifecycle, fragment ownership). Both the
 * agent executor and the resolution transaction validate through it — each
 * layer still runs its own end-to-end check; only the rule text lives
 * here, so the two can never drift apart.
 */

import type { RequestContext } from "@kiero/runtime";
import type { DependencyEdge } from "@kiero/domain";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";

/** The DB reader surface the reference checks need (mutation or query). */
export type Db = MutationCtx["db"] | QueryCtx["db"];

/** The actor's normalized company id (null when malformed — refuse loudly). */
export function normalizedCompany(
  db: Db,
  context: RequestContext,
): Id<"companies"> | null {
  return db.normalizeId("companies", context.actor.companyId);
}

/** The actor's normalized user id (null when malformed — refuse loudly). */
export function normalizedActor(
  db: Db,
  context: RequestContext,
): Id<"users"> | null {
  return db.normalizeId("users", context.actor.userId);
}

/** One source of this company, or null when missing/foreign/malformed. */
export async function requireSource(
  db: Db,
  sourceRef: string,
  companyId: Id<"companies">,
): Promise<Doc<"sources"> | null> {
  const sourceId = db.normalizeId("sources", sourceRef);
  if (sourceId === null) {
    return null;
  }
  const source = await db.get(sourceId);
  if (source === null || source.companyId !== companyId) {
    return null;
  }
  return source;
}

/** One project of this company (id only), or null when missing/foreign. */
export async function requireProject(
  db: Db,
  projectRef: string,
  companyId: Id<"companies">,
): Promise<Id<"projects"> | null> {
  const projectId = db.normalizeId("projects", projectRef);
  if (projectId === null) {
    return null;
  }
  const project = await db.get(projectId);
  if (project === null || project.companyId !== companyId) {
    return null;
  }
  return projectId;
}

/** One finding of this company, or null when missing/foreign/malformed. */
export async function requireFinding(
  db: Db,
  findingRef: string,
  companyId: Id<"companies">,
): Promise<Doc<"findings"> | null> {
  const findingId = db.normalizeId("findings", findingRef);
  if (findingId === null) {
    return null;
  }
  const finding = await db.get(findingId);
  if (finding === null || finding.companyId !== companyId) {
    return null;
  }
  return finding;
}

/** Finds the live finding identity for one scope key, if any. */
export async function findFindingByKey(
  db: Db,
  companyId: Id<"companies">,
  scopeProjectId: Id<"projects"> | undefined,
  semanticKey: string,
): Promise<Doc<"findings"> | null> {
  return await db
    .query("findings")
    .withIndex("by_company_scope_key", (q) =>
      q
        .eq("companyId", companyId)
        .eq("scopeProjectId", scopeProjectId)
        .eq("semanticKey", semanticKey),
    )
    .first();
}

/** All dependency edges of one company (the acyclicity check's graph). */
export async function companyDependencyEdges(
  db: Db,
  companyId: Id<"companies">,
): Promise<DependencyEdge[]> {
  const rows = await db
    .query("findingDependencies")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .collect();
  return rows.map((row) => ({
    dependent: row.dependentFindingId,
    dependsOn: row.dependsOnFindingId,
  }));
}

/** The typed refusal code of one resolution-evidence reference check (R1). */
export type ResolutionEvidenceRefusalCode =
  | "resolution_source_not_found"
  | "resolution_source_not_in_company"
  | "resolution_source_not_active"
  | "resolution_fragment_mismatch";

/**
 * R1 (issue #126): the per-reference rule for evidence cited by a
 * clarification resolution — the cited source must EXIST, belong to the
 * resolved company and be ACTIVE ("Źródło wycofane" no longer grounds a
 * resolution), and a cited fragment must belong to that source. Returns
 * the typed refusal code, or null when the reference is valid; the caller
 * wraps the code in its own error shape and keeps its own dedupe.
 */
export async function checkResolutionEvidenceReference(
  db: Db,
  companyId: Id<"companies">,
  reference: { readonly sourceId: string; readonly fragmentId: string | null },
): Promise<ResolutionEvidenceRefusalCode | null> {
  const sourceId = db.normalizeId("sources", reference.sourceId);
  const source = sourceId === null ? null : await db.get(sourceId);
  if (source === null) {
    return "resolution_source_not_found";
  }
  if (source.companyId !== companyId) {
    return "resolution_source_not_in_company";
  }
  if (source.lifecycle !== "active") {
    return "resolution_source_not_active";
  }
  if (reference.fragmentId !== null) {
    const fragmentId = db.normalizeId("sourceFragments", reference.fragmentId);
    const fragment = fragmentId === null ? null : await db.get(fragmentId);
    if (fragment === null || fragment.sourceId !== source._id) {
      return "resolution_fragment_mismatch";
    }
  }
  return null;
}
