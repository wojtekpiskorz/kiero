/**
 * readCurrentFindings (C2): current knowledge without replaying the
 * conversation.
 *
 * One current-findings row in its WIRE form: `value` and `knowledgeState`
 * cross the API boundary ENCODED (the runtime envelope carries JSON values;
 * Effect decoding guards input boundaries, and BigDecimal objects are not
 * Convex-serializable). The contract schemas define the shapes; rows carry
 * their encoded form.
 */

import { type ClosedError } from "@kiero/contracts";
import { notFoundError, validationError, type RequestContext } from "@kiero/runtime";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { normalizedCompany, requireProject } from "./references";
import type { ReadCurrentFindingsInput } from "./semantics";

export interface CurrentFindingWireRow {
  readonly findingId: string;
  readonly semanticKey: string;
  readonly value: unknown;
  readonly knowledgeState: unknown;
  readonly currentRevisionId: string;
}

/** Reads the current findings of one scope (no conversation replay). */
export async function readCurrentFindingsRows(
  db: QueryCtx["db"],
  context: RequestContext,
  input: ReadCurrentFindingsInput,
): Promise<
  | { readonly ok: true; readonly rows: CurrentFindingWireRow[] }
  | { readonly ok: false; readonly error: ClosedError }
> {
  const companyId = normalizedCompany(db, context);
  if (companyId === null) {
    return { ok: false, error: validationError("company_scope_unresolved") };
  }
  let scopeProjectId: Id<"projects"> | undefined;
  if (input.scope._tag === "project") {
    const resolved = await requireProject(db, input.scope.projectId, companyId);
    if (resolved === null) {
      return {
        ok: false,
        error: notFoundError("projects", "project_scope_not_found"),
      };
    }
    scopeProjectId = resolved;
  }
  const findings = await db
    .query("findings")
    .withIndex("by_company_scope_key", (q) =>
      q.eq("companyId", companyId).eq("scopeProjectId", scopeProjectId),
    )
    .order("asc")
    .collect();
  const rows: CurrentFindingWireRow[] = [];
  for (const finding of findings) {
    if (finding.currentRevisionId === undefined) {
      continue;
    }
    const revision = await db.get(finding.currentRevisionId);
    if (revision === null) {
      continue;
    }
    rows.push({
      findingId: finding._id,
      semanticKey: finding.semanticKey,
      value: revision.value,
      knowledgeState: revision.knowledgeState,
      currentRevisionId: revision._id,
    });
  }
  return { ok: true, rows };
}
