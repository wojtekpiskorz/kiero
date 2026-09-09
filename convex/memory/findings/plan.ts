/**
 * The staged plan's shared vocabulary (C2): the row shape the
 * publicationGroups table stores between prepare and publish, and the pure
 * conversions between that shape and the checks from @kiero/domain.
 *
 * Produced exclusively by prepare (every id Convex-normalized, every
 * semantic value encoded); consumed exclusively by publish and re-checked
 * against the then-current world before any write.
 */

import { planScopeKey, type DependencyEdge, type PlanScope } from "@kiero/domain";
import { errorResult, type ClosedError, type ResultEnvelope } from "@kiero/contracts";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

/** One normalized evidence reference inside a staged planned change. */
export interface NormalizedEvidence {
  readonly sourceId: Id<"sources">;
  readonly sourceFragmentId?: Id<"sourceFragments">;
  readonly supportKind: "support" | "independent_corroboration";
  readonly extractionId?: Id<"extractions">;
}

/**
 * The row type the publicationGroups table stores for one planned change:
 * the normalized staged plan (every id Convex-normalized, every semantic
 * value in its encoded form).
 */
export type PlannedChangeRow = NonNullable<
  Doc<"publicationGroups">["plannedChanges"][number]
>;

/** The plan scope of one staged change, for the pure plan checks. */
export function planScopeOf(change: {
  scopeKind: "company" | "project";
  scopeProjectId?: Id<"projects"> | undefined;
}): PlanScope {
  return change.scopeKind === "company"
    ? { kind: "company" }
    : { kind: "project", projectId: change.scopeProjectId };
}

/**
 * The dependency edges a staged plan would add. The dependent is the
 * referenced finding id when the change addresses a live identity, else the
 * plan-scoped key (which `planScopeKey` also uses at prepare time).
 */
export function plannedEdgesOf(changes: readonly PlannedChangeRow[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const change of changes) {
    const dependent = change.findingId ?? planScopeKey(planScopeOf(change), change.semanticKey);
    for (const basis of change.derivesFrom) {
      edges.push({ dependent, dependsOn: basis });
    }
  }
  return edges;
}

/**
 * ONE validated planned change: the staged row plus the finding document the
 * validation pass resolved for it (null when this change creates the
 * identity). The commit loop consumes exactly this — it never resolves a
 * reference itself.
 */
export interface ResolvedChange {
  readonly entry: PlannedChangeRow;
  readonly finding: Doc<"findings"> | null;
}

/**
 * FAILURE-MARKING RULE (the one rule, applied at every refusal site):
 * a refused publish marks the change set — and its group — `failed` exactly
 * when the refusal proves THIS set can never publish as staged: its captured
 * expectations went stale, its stored source or an evidence witness died or
 * left the lifecycle/company, one of its stored references vanished, its
 * target identity was created by another set, or its staged plan violates an
 * invariant against the live graph. Refusals about the REQUEST or the SYSTEM
 * leave the set `prepared`: wrong or foreign ids in the request, unresolved
 * actor/tenant, a set already terminal (never overwrite the winner of a
 * concurrent publish or an OCC-retried loser's committed state), stale
 * CALLER expectations (the caller refreshes and retries — the conflict copy
 * says exactly that), and missing event templates (a code defect; retry
 * after a fix). Consequence: `by_company_state` never lists an
 * unpublishable set as actionable `prepared`.
 */
export async function failChangeSet(
  tx: MutationCtx,
  changeSetId: Id<"changeSets">,
  group: { readonly _id: Id<"publicationGroups"> } | null,
  failedReason: string,
  error: ClosedError,
): Promise<ResultEnvelope> {
  await tx.db.patch(changeSetId, { state: "failed", failedReason });
  if (group !== null) {
    await tx.db.patch(group._id, { state: "failed" });
  }
  return errorResult(error);
}
