/**
 * Shared tenant-scoped reference checks for the findings lane (C2).
 *
 * The resolved company is the only company any row may belong to: every
 * require* helper normalizes the id, reads the row and refuses (returns
 * null) when the row is missing OR belongs to another company — without
 * saying which, so the refusal leaks no existence information across the
 * tenant boundary. Imported by the changeset transactions, corrections,
 * the current read and the withdrawal marking.
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
