/**
 * Publication-group bounding (E3): turning the accumulated plan into
 * bounded, source-linked, logically dependent groups (protocol step 7: a
 * delivery event and its deliberately linked receiving task publish
 * together; independent information for another project can complete
 * separately).
 *
 * The bounding rule is structural, not heuristic:
 *
 * - every finding proposal joins the group of its scope — firm memory
 *   forms the company group, and each project forms its own group;
 * - a derived conclusion ("Wniosek agenta") joins the group of its basis,
 *   so a derivation and what it derives from commit atomically; a basis in
 *   ANOTHER scope is refused at reduce time and can never couple groups;
 * - clarifications are not publications: they become source-backed
 *   questions ("Sprawa do wyjaśnienia"), raised per scope, never blocking
 *   independent groups;
 * - each group carries the input-revision expectations the ANALYSIS used
 *   (the stage-one context snapshot): the publish stage passes them as the
 *   CALLER expectations, so a newer correction mid-run (or before a paused
 *   plan publishes) refuses the group instead of overwriting the newer
 *   truth (C2's stale-plan guard wired; issue #8 precedence).
 */

import type { AnalysisContext, ContextScope } from "./context";
import type { ClarificationDraft, FindingProposal, PlanningState } from "./reducer";

/** The stable identity of one publication group. */
export interface GroupKey {
  readonly kind: "company" | "project";
  /** The `new:N` handle for a to-be-created project, else the project id. */
  readonly projectId: string | null;
}

/** One bounded publication group in wire form (journal-safe). */
export interface PublicationGroup {
  readonly key: GroupKey;
  readonly proposals: readonly FindingProposal[];
  /**
   * Input-revision expectations from the ANALYSIS context (stage one):
   * what the plan believed when it was made. Passed as caller
   * expectations at publish — the honest staleness anchor.
   */
  readonly analysisRevisions: readonly { findingId: string; revision: number }[];
}

/** The bounded plan: groups plus the clarifications to raise. */
export interface BoundedPlan {
  readonly groups: readonly PublicationGroup[];
  readonly clarifications: readonly ClarificationDraft[];
}

function sameKey(scope: ContextScope, key: GroupKey): boolean {
  return scope.kind === key.kind && (key.kind === "company" || (scope.kind === "project" && scope.projectId === key.projectId));
}

/** The group key of one scope (project scopes keep their handle/id). */
export function groupKeyOfScope(scope: ContextScope): GroupKey {
  return scope.kind === "company"
    ? { kind: "company", projectId: null }
    : { kind: "project", projectId: scope.projectId };
}

/**
 * Bounds the accumulated plan: one group per scope, derivations pulled
 * into their basis's group, clarifications kept apart. Proposals whose
 * derivation basis lives outside their own scope were already refused by
 * the reducer; this function defensively drops any that slipped through
 * (fail-closed bounding, never a coupled group).
 */
export function boundPublicationGroups(
  state: PlanningState,
  context: AnalysisContext,
): BoundedPlan {
  const analysisRevisions = context.findings.map((finding) => ({
    findingId: finding.findingId,
    revision: finding.revisionCounter,
  }));
  const groups = new Map<string, PublicationGroup>();
  const accepted: FindingProposal[] = [];
  for (const proposal of state.proposals) {
    const basisScopes = proposal.derivesFromFindingIds.map((basisId) => {
      const basis = context.findings.find((finding) => finding.findingId === basisId);
      return basis === undefined ? null : basis.scope;
    });
    const foreignBasis = basisScopes.some(
      (basisScope) => basisScope !== null && !sameKey(basisScope, groupKeyOfScope(proposal.scope)),
    );
    if (foreignBasis) {
      continue; // A derivation must commit with its basis, never across scopes.
    }
    accepted.push(proposal);
  }
  for (const proposal of accepted) {
    const key = groupKeyOfScope(proposal.scope);
    const mapKey = `${key.kind}:${key.projectId ?? "-"}`;
    const existing = groups.get(mapKey);
    if (existing === undefined) {
      groups.set(mapKey, { key, proposals: [proposal], analysisRevisions });
    } else {
      groups.set(mapKey, { ...existing, proposals: [...existing.proposals, proposal] });
    }
  }
  return {
    groups: [...groups.values()],
    clarifications: [...state.clarifications],
  };
}

/**
 * The honest group outcome vocabulary recorded per group against one
 * source (issue #37: "committed, awaiting clarification, pending and
 * failed groups remain explicit against one source").
 */
export type GroupOutcome =
  | "published"
  /** The analysis's input revisions went stale before commit: refused. */
  | "stale_refused"
  /** A typed C2 refusal (validation/conflict): no partial writes. */
  | "failed"
  /** Requires segments still pending extraction; nothing claimed. */
  | "pending_segments"
  /** A correctly raised clarification (not a stuck job, no retries). */
  | "clarified";

/** The publish decision inputs for one group. */
export interface GroupPublishReadiness {
  readonly analysisRevisions: readonly { findingId: string; revision: number }[];
  /** The CURRENT revision counters, read fresh in the publish transaction. */
  readonly currentRevisions: Readonly<Record<string, number>>;
}

/** The decision: publish through C2, or refuse honestly. */
export type GroupPublishDecision =
  | { readonly decision: "publish" }
  | { readonly decision: "refuse"; readonly code: "analysis_context_stale" };

/**
 * The mid-run staleness guard: every finding the ANALYSIS read (and may
 * address by id) must still be at the revision the analysis saw. A newer
 * correction between stage one and commit means the plan analyzed a
 * superseded world: refuse — reanalysis as a linked NEW run is the only
 * recovery, never an overwrite (issue #8).
 */
export function decideGroupPublish(
  readiness: GroupPublishReadiness,
): GroupPublishDecision {
  for (const expectation of readiness.analysisRevisions) {
    const current = readiness.currentRevisions[expectation.findingId];
    if (current !== expectation.revision) {
      return { decision: "refuse", code: "analysis_context_stale" };
    }
  }
  return { decision: "publish" };
}

/** Whether one group's proposals are all text-grounded (no segment claims). */
export function groupIsTextGrounded(group: PublicationGroup): boolean {
  return group.proposals.every((proposal) => proposal.evidence.length > 0 || proposal.derivesFromFindingIds.length > 0);
}
