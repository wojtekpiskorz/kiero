/**
 * Completeness-based publication bounding (E4): turning the joined plan
 * into bounded groups split BY EVIDENCE COMPLETENESS.
 *
 * E3 bounds groups by scope (firm memory vs each project) and pulls
 * derivations into their basis's group. The join keeps that rule and adds
 * the partial-safe split INSIDE a scope: within one scope, proposals whose
 * evidence is entirely inspectable (text over the author's words, intervals
 * over a completed transcript, regions over a completed vision extraction)
 * form the publishable group, while proposals referencing unresolved media
 * form the scope's WAITING group — "a group needing the image waits; a
 * text-only group publishes. Independent text facts may publish during
 * image failure, but image-dependent amounts or dimensions cannot."
 *
 * The waiting group is an honest `pending_segments` outcome, never a
 * fabrication and never a block: when the media completes, a later join
 * (or a linked reanalysis) publishes it against the same source.
 *
 * The two structural invariants this module owns (both under pure test):
 *
 * - `mediaClaimsBackedByCompleteInputs`: every image/audio evidence item
 *   references an extraction version the coverage reports COMPLETE — the
 *   text-only-fallback-never-claims-inspection guard, as a checkable
 *   predicate over any bounded plan (the reducer admits such evidence
 *   structurally; this re-proves it at the boundary);
 * - `groupGroundingComplete`: a group publishes only when every evidence
 *   kind it uses is complete in the CURRENT coverage snapshot — the
 *   publish stage re-runs this against a FRESH read before C2.
 */

import { revisionSnapshotOf, sameScope, type AnalysisContext } from "../planning/context";
import {
  evidenceKindOf,
  type LocatedEvidence,
} from "./grounding";
import type { RequiredInput } from "./coverage";
import type {
  MultimodalClarificationDraft,
  MultimodalFindingProposal,
  MultimodalPlanningState,
} from "./reducer";

/** The stable identity of one publication group (E3's shape). */
export interface JoinGroupKey {
  readonly kind: "company" | "project";
  /** The `new:N` handle for a to-be-created project, else the project id. */
  readonly projectId: string | null;
}

/** One bounded joined group in wire form (journal-safe). */
export interface MultimodalPublicationGroup {
  readonly key: JoinGroupKey;
  readonly proposals: readonly MultimodalFindingProposal[];
  /** Whether every proposal's evidence is complete in the bounding snapshot. */
  readonly waitForMedia: boolean;
  /** Input-revision expectations from the analysis context (E3's anchor). */
  readonly analysisRevisions: readonly { findingId: string; revision: number }[];
}

/** The bounded joined plan. */
export interface BoundedJoinPlan {
  readonly groups: readonly MultimodalPublicationGroup[];
  readonly clarifications: readonly MultimodalClarificationDraft[];
}

/**
 * Whether one proposal's evidence kinds are all complete in the coverage.
 * A `replaced_by_newer_version` input counts as complete ONLY for evidence
 * pinned to its SELECTED extraction (the newest completed version): the
 * marking never blocks publication by itself, but an older pin is a
 * re-join trigger.
 */
export function proposalGroundingComplete(
  proposal: { readonly evidence: readonly LocatedEvidence[] },
  coverage: { readonly inputs: readonly RequiredInput[] },
): boolean {
  return proposal.evidence.every((evidence) =>
    coverage.inputs.some(
      (input) =>
        (input.status === "complete" || input.status === "replaced_by_newer_version") &&
        input.kind === evidenceKindOf(evidence) &&
        input.extractionId === evidence.extractionId,
    ),
  );
}

/**
 * THE inspection-honesty invariant: no proposal may carry image or audio
 * evidence whose extraction version the coverage does not report as its
 * selected completed version (complete, or the newest of several completed
 * versions). The reducer admits such evidence only from completed
 * extractions loaded into the context; this predicate re-proves it over
 * ANY plan (wire or pure), so the publish stage and the tests share one
 * authority. The parameter is structural on purpose: it accepts the wire
 * proposals the workflow hands over exactly as it accepts the reducer's
 * own.
 */
export function mediaClaimsBackedByCompleteInputs(
  plan: { readonly proposals: readonly { readonly evidence: readonly LocatedEvidence[] }[] },
  coverage: { readonly inputs: readonly RequiredInput[] },
): boolean {
  return plan.proposals.every((proposal) => proposalGroundingComplete(proposal, coverage));
}

/** The group key of one scope (E3's derivation, unchanged). */
export function joinGroupKeyOfScope(scope: {
  readonly kind: "company" | "project";
  readonly projectId?: string | null;
}): JoinGroupKey {
  return scope.kind === "company"
    ? { kind: "company", projectId: null }
    : { kind: "project", projectId: scope.projectId ?? null };
}

/**
 * Bounds the joined plan: one group per (scope x completeness) pair —
 * within a scope, the publishable proposals and the media-waiting
 * proposals form SEPARATE groups, so waiting never blocks publishing and
 * publishing never drags an ungrounded claim along. Derivations keep E3's
 * rule (they commit with their basis; a foreign-scope basis drops
 * fail-closed).
 */
export function boundMultimodalGroups(
  state: MultimodalPlanningState,
  context: { readonly base: AnalysisContext; readonly coverage: { readonly inputs: readonly RequiredInput[] } },
): BoundedJoinPlan {
  const analysisRevisions = revisionSnapshotOf(context.base);
  const accepted: MultimodalFindingProposal[] = [];
  for (const proposal of state.proposals) {
    const basisScopes = proposal.derivesFromFindingIds.map((basisId) => {
      const basis = context.base.findings.find((finding) => finding.findingId === basisId);
      return basis === undefined ? null : basis.scope;
    });
    const foreignBasis = basisScopes.some(
      (basisScope) => basisScope !== null && !sameScope(basisScope, proposal.scope),
    );
    if (foreignBasis) {
      continue; // A derivation must commit with its basis, never across scopes.
    }
    accepted.push(proposal);
  }
  const groups = new Map<string, MultimodalPublicationGroup>();
  for (const proposal of accepted) {
    const key = joinGroupKeyOfScope(proposal.scope);
    const waitForMedia = !proposalGroundingComplete(proposal, context.coverage);
    const mapKey = `${key.kind}:${key.projectId ?? "-"}:${waitForMedia ? "wait" : "pub"}`;
    const existing = groups.get(mapKey);
    if (existing === undefined) {
      groups.set(mapKey, { key, proposals: [proposal], waitForMedia, analysisRevisions });
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
 * The honest joined-group outcome vocabulary (E3's, with the media wait
 * made first-class).
 */
export type JoinGroupOutcome =
  | "published"
  | "stale_refused"
  | "failed"
  /** Requires media still unresolved; nothing claimed, nothing blocked. */
  | "pending_segments"
  | "clarified";

/** The evidence kinds one group's proposals ground in (deduped). */
export function groupEvidenceKinds(group: {
  readonly proposals: readonly { readonly evidence: readonly LocatedEvidence[] }[];
}): ("text" | "audio" | "image")[] {
  const kinds = new Set<"text" | "audio" | "image">();
  for (const proposal of group.proposals) {
    for (const evidence of proposal.evidence) {
      kinds.add(evidenceKindOf(evidence));
    }
  }
  return [...kinds];
}
