/**
 * Pure change-plan decisions (C2): plan consistency, the stale-plan guard
 * and correction supersession.
 *
 * The publish mutation rechecks every one of these against the CURRENT
 * database state inside its own transaction; these functions are the
 * decision cores it (and the focused tests) run. "Ponowne przetworzenie
 * starszego źródła nie może cofnąć późniejszej jawnej poprawki" (issue 8):
 * precedence is decided by the expected-revision check, never by arrival or
 * completion time.
 */

import { wouldCreateCycle, type DependencyEdge } from "./provenance";

/** One revision-number expectation for one finding. */
export interface RevisionExpectation {
  readonly findingId: string;
  readonly revision: number;
}

/** The scope identity of a planned finding: company memory or one project. */
export interface PlanScope {
  readonly kind: "company" | "project";
  readonly projectId?: string | undefined;
}

/** The minimal shape of one planned revision the plan checks need. */
export interface PlannedRevisionShape {
  readonly findingId: string | null;
  readonly scope: PlanScope;
  readonly semanticKey: string;
  readonly evidence: readonly { sourceId: string }[];
  readonly derivesFrom: readonly string[];
}

/** A sanitized validation outcome for one plan check. */
export type PlanCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };

/** The stable identity key of one planned finding within its company. */
export function planScopeKey(scope: PlanScope, semanticKey: string): string {
  return scope.kind === "company"
    ? `company|${semanticKey}`
    : `project|${scope.projectId ?? "missing"}|${semanticKey}`;
}

/**
 * Per-entry and whole-plan semantic consistency:
 *
 * - every revision carries a BASIS: at least one evidence witness or one
 *   derivation input (an agent conclusion names its basis; a directly read
 *   value cites its source);
 * - one plan may not write the same finding identity twice (duplicate
 *   semantic keys inside one publication group are ambiguous);
 * - a planned revision addressing an EXISTING finding must reference it by
 *   findingId (never create a second row for a live identity);
 * - planned dependency edges must not create a cycle among themselves (the
 *   graph half against existing edges runs at prepare/publish with the real
 *   graph).
 */
export function checkPlanConsistency(
  planned: readonly PlannedRevisionShape[],
): PlanCheck {
  const seenKeys = new Set<string>();
  const plannedEdges: DependencyEdge[] = [];
  for (const entry of planned) {
    if (entry.evidence.length === 0 && entry.derivesFrom.length === 0) {
      return { ok: false, code: "revision_without_basis" };
    }
    if (entry.scope.kind === "project" && entry.scope.projectId === undefined) {
      return { ok: false, code: "project_scope_without_project" };
    }
    const key = planScopeKey(entry.scope, entry.semanticKey);
    if (seenKeys.has(key)) {
      return { ok: false, code: "duplicate_planned_finding_identity" };
    }
    seenKeys.add(key);
    for (const basis of entry.derivesFrom) {
      if (entry.findingId !== null && basis === entry.findingId) {
        return { ok: false, code: "derivation_of_itself" };
      }
      plannedEdges.push({
        dependent: entry.findingId ?? key,
        dependsOn: basis,
      });
    }
  }
  if (wouldCreateCycle([], plannedEdges)) {
    return { ok: false, code: "planned_dependencies_cyclic" };
  }
  return { ok: true };
}

/** The publish readiness inputs (all read inside the publish transaction). */
export interface PublishReadiness {
  readonly changeSetState: string;
  /** Expectations captured when the plan was prepared. */
  readonly captured: readonly RevisionExpectation[];
  /** Expectations the publishing caller supplies now. */
  readonly caller: readonly RevisionExpectation[];
  /** The CURRENT revision counter of each referenced finding. */
  readonly current: Readonly<Record<string, number>>;
}

/** The publish decision: proceed, or refuse with a sanitized code. */
export type PublishDecision =
  | { readonly decision: "publish" }
  | { readonly decision: "refuse"; readonly code: "change_set_not_prepared" | "stale_plan" | "caller_expectation_mismatch" };

/**
 * The stale-plan guard. The change set must still be `prepared`, and BOTH
 * the captured expectations (what the plan believed when it was made) and
 * the caller's expectations (what the executor believes now) must equal the
 * current revision counters. A newer correction bumps a counter, so resuming
 * an older plan fails `stale_plan` — the old plan can never overwrite the
 * newer truth, however late it arrives.
 */
export function decidePublish(readiness: PublishReadiness): PublishDecision {
  if (readiness.changeSetState !== "prepared") {
    return { decision: "refuse", code: "change_set_not_prepared" };
  }
  for (const expectation of readiness.captured) {
    const current = readiness.current[expectation.findingId];
    if (current !== expectation.revision) {
      return { decision: "refuse", code: "stale_plan" };
    }
  }
  for (const expectation of readiness.caller) {
    const current = readiness.current[expectation.findingId];
    if (current !== expectation.revision) {
      return { decision: "refuse", code: "caller_expectation_mismatch" };
    }
  }
  return { decision: "publish" };
}

/**
 * The correction supersession decision: an explicit correction applies only
 * against the revision the corrector saw; anything else is the honest
 * `conflict` (refresh and reconsider — it never merges or overwrites).
 */
export type CorrectionDecision =
  | { readonly decision: "apply" }
  | { readonly decision: "refuse"; readonly code: "revision_mismatch" };

export function decideCorrection(expectedRevision: number, currentRevision: number): CorrectionDecision {
  return expectedRevision === currentRevision
    ? { decision: "apply" }
    : { decision: "refuse", code: "revision_mismatch" };
}
