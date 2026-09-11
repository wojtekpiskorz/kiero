/**
 * The scope re-assessment marking of one project reassignment (E7, issue
 * #115): the memory-side reaction C5's durable executor invokes for the
 * `source_reassigned` cause; the reassignment twin of
 * `markWithdrawnSupport` (./withdrawal.ts), living in the memory lane it
 * writes (review round 1 moved it from the sources lane: it touches only
 * findings, findingRevisions and `memory.findingRevised`, and its commit
 * loop is the ONE shared marking-commit core, ./marking.ts).
 *
 * A reassignment moves the source's PLACEMENT, not its support: the source
 * stays `active`, its evidence still witnesses what it witnessed. What the
 * link change invalidates is the SCOPE of findings whose placement in a
 * project conversation rested on the source's link to that project. Per
 * C5's rules ("A correction to one fragment or project assignment narrows
 * the affected graph"):
 *
 * - only findings scoped to a project that is NO LONGER linked are
 *   candidates (company memory always holds the source; a still-linked
 *   project keeps its findings standing);
 * - an explicit correction keeps its authority; a finding already marked
 *   (updating/unknown) is not marked twice (idempotence); only `known`
 *   findings move;
 * - a candidate that still rests on ANOTHER active source which is itself
 *   linked to the finding's scope project keeps standing (independent
 *   placement evidence survives);
 * - every marked finding gets a NEW revision (origin
 *   `reassignment_marking`) whose value is preserved VERBATIM and whose
 *   knowledge state becomes updating-until-revalidated (visible, excluded
 *   from automation, never discarded), full history stays intact;
 * - the marked findings' linked re-analysis is registered by the executor
 *   through E3's seam (a re-analysis reads the source's CURRENT links and
 *   re-derives placement), so revalidation replaces the marking.
 *
 * The candidates are located through two bounded, indexed walks: the
 * witness walk (`evidenceLinks.by_source`, the same walk the withdrawal
 * marking core uses) and the provenance walk (`changeSets.by_source` ->
 * `publicationGroups.memberRevisionIds`), so derivation-only findings
 * published from the moved source are found too. Derivation dependents of
 * the marked roots are NOT walked here: the executor hands every marked
 * root to the existing `memory.dependentsMarkedStale` cascade, which owns
 * every level in its own bounded transaction.
 *
 * The pure decision ({@link decideScopeReassessment}) lives here beside
 * the core so tests prove it without a deployment (the C5 precedent);
 * review round 1 folded the WHOLE narrowing rule into it (scope kind,
 * scope project and the source's current links are its inputs), so the
 * branch that runs in production is exactly the branch the unit tests
 * prove. This module is the transactional core.
 */

import {
  notFoundError,
  validationError,
} from "@kiero/runtime";
import {
  explicitUpdating,
  updatingUntilRevalidatedReason,
} from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import { encodeKnowledgeState, knowledgeTagOf } from "./semantics";
import { commitMarkings, type MarkingOutcome, type PlannedMarking } from "./marking";

// ---------------------------------------------------------------------------
// The pure decision (unit-tested in tests/e7).
// ---------------------------------------------------------------------------

/** One witness reference of a candidate's current revision, placement-known. */
export interface ScopeWitnessRef {
  readonly sourceId: string;
  /** Whether that source's lifecycle still lets it witness anything. */
  readonly sourceActive: boolean;
  /** Whether that source is currently linked to the candidate's scope project. */
  readonly linkedToScope: boolean;
}

/** What the scope re-assessment decision needs about one candidate finding. */
export interface ScopeReassessmentInput {
  /** The knowledge-state tag of the candidate's CURRENT revision. */
  readonly currentKnowledgeTag: string | null;
  /** The origin of that revision (or null when absent). */
  readonly currentRevisionOrigin: string | null;
  /** The candidate's scope kind (company memory is never narrowed away). */
  readonly scopeKind: "company" | "project";
  /** The project the candidate is scoped to (null on company scope). */
  readonly scopeProjectId: string | null;
  /** The moved source's CURRENT project links (the link set that changed). */
  readonly currentProjectIds: readonly string[];
  /** The id of the source that moved. */
  readonly movedSourceId: string;
  /** Whether the current revision rests on the moved source: cites it as a
   * witness or was published from it (provenance). */
  readonly restsOnMovedSource: boolean;
  /** The witness links of that revision with placement knowledge. */
  readonly currentWitnesses: readonly ScopeWitnessRef[];
}

/**
 * What the re-assessment does to one candidate finding.
 *
 * - `mark_updating`: the finding's placement lost the moved source's
 *   support and has no surviving placement witness, it becomes
 *   updating-until-revalidated (value preserved, excluded from automation);
 * - `retain`: the finding keeps standing: company memory, a scope the
 *   source still links, an already-marked finding, an explicit correction,
 *   a finding not resting on the moved source, or another active linked
 *   witness surviving.
 */
export type ScopeReassessmentDecision =
  | { readonly decision: "mark_updating" }
  | {
      readonly decision: "retain";
      readonly basis:
        | "company_scope"
        | "scope_still_linked"
        | "already_marked"
        | "explicit_correction"
        | "not_resting_on_moved_source"
        | "independent_placement_witness";
    };

/**
 * The WHOLE narrowing rule in one place (review round 1: the caller's
 * pre-filter and the decision's `scope_still_linked` branch were two
 * halves of one rule, the second unreachable in production).
 */
export function decideScopeReassessment(
  input: ScopeReassessmentInput,
): ScopeReassessmentDecision {
  if (input.scopeKind !== "project" || input.scopeProjectId === null) {
    // The narrowing rule's floor: company memory always holds the source.
    return { decision: "retain", basis: "company_scope" };
  }
  if (input.currentProjectIds.includes(input.scopeProjectId)) {
    // The link change did not touch this finding's scope.
    return { decision: "retain", basis: "scope_still_linked" };
  }
  if (input.currentKnowledgeTag !== "known") {
    // Unknown or updating already: visibly non-current; idempotent.
    return { decision: "retain", basis: "already_marked" };
  }
  if (input.currentRevisionOrigin === "correction") {
    // An explicit correction is its own resolution ("Korekta ustalenia").
    return { decision: "retain", basis: "explicit_correction" };
  }
  if (!input.restsOnMovedSource) {
    // A candidate that neither cites the moved source on its current
    // revision nor was published from it is not affected by this move.
    return { decision: "retain", basis: "not_resting_on_moved_source" };
  }
  const survivingWitness = input.currentWitnesses.some(
    (witness) =>
      witness.sourceId !== input.movedSourceId &&
      witness.sourceActive &&
      witness.linkedToScope,
  );
  if (survivingWitness) {
    // Independent placement evidence survives.
    return { decision: "retain", basis: "independent_placement_witness" };
  }
  return { decision: "mark_updating" };
}

// ---------------------------------------------------------------------------
// The transactional core.
// ---------------------------------------------------------------------------

/** The marking core's parameters: everything the reaction needs, no session. */
export interface ReassignmentMarkingArgs {
  /** The tenant whose memory is marked (the source must belong to it). */
  readonly companyId: Id<"companies">;
  /** The user recorded as the marking's author (reassignment actor or author). */
  readonly actorUserId: Id<"users">;
  /** The normalized id of the reassigned source. */
  readonly sourceId: Id<"sources">;
  /** The source's CURRENT project links, read by the executor at reaction time. */
  readonly currentProjectIds: readonly Id<"projects">[];
}

/** The machine reason recorded on each marking revision (per finding scope). */
export function scopeReassignedReason(scopeProjectId: string): string {
  return `source_reassigned:${scopeProjectId}`;
}

/** The knowledge-state reason of each marking revision. */
export function scopeUpdatingReason(sourceId: Id<"sources">): string {
  return updatingUntilRevalidatedReason(`source_reassigned:${sourceId}`);
}

/**
 * The ONE scope-marking core: marks the findings whose project placement
 * the reassignment removed support for. Runs entirely inside the caller's
 * transaction: every marking (revision + projection patch) and its
 * `memory.findingRevised` event commit together with everything else, or
 * not at all. Everything that can refuse runs before the first write.
 * Returns the typed marking outcome (review round 1: the ok payload is
 * typed, the executor re-asserts nothing).
 */
export async function markReassignedScope(
  tx: MutationCtx,
  args: ReassignmentMarkingArgs,
): Promise<MarkingOutcome> {
  const source = await tx.db.get(args.sourceId);
  if (source === null || source.companyId !== args.companyId) {
    return { _tag: "error", error: notFoundError("sources") };
  }
  // Marking follows the link change and never runs ahead of it: only an
  // ACTIVE source's placement re-assessment runs here (withdrawal/purge own
  // the stronger reactions for their lifecycles).
  if (source.lifecycle !== "active") {
    return {
      _tag: "error",
      error: validationError(
        source.lifecycle === "withdrawn" ? "source_withdrawn" : "source_not_active",
      ),
    };
  }

  // --- the candidate walk (bounded, indexed; everything before writes) ----
  const candidates = await scopeCandidates(tx.db, args.companyId, args.sourceId);

  type MarkingPlan = PlannedMarking;
  const markings: MarkingPlan[] = [];
  const seenFindings = new Set<Id<"findings">>();
  for (const candidate of candidates) {
    if (seenFindings.has(candidate.finding._id)) {
      continue;
    }
    seenFindings.add(candidate.finding._id);
    // The surviving-placement reads: another active source cited by the
    // current revision that is itself still linked to the finding's scope.
    const currentLinks = await tx.db
      .query("evidenceLinks")
      .withIndex("by_revision", (q) =>
        q.eq("findingRevisionId", candidate.currentRevision._id),
      )
      .collect();
    const witnesses: ScopeWitnessRef[] = [];
    for (const link of currentLinks) {
      const witness = await tx.db.get(link.sourceId);
      if (witness === null) {
        continue;
      }
      const witnessLinks = await tx.db
        .query("sourceProjectLinks")
        .withIndex("by_source", (q) => q.eq("sourceId", witness._id))
        .collect();
      witnesses.push({
        sourceId: link.sourceId,
        sourceActive: witness.lifecycle === "active",
        linkedToScope: witnessLinks.some(
          (l) => (l.projectId as string) === (candidate.finding.scopeProjectId as string),
        ),
      });
    }
    const decision = decideScopeReassessment({
      currentKnowledgeTag: knowledgeTagOf(candidate.currentRevision.knowledgeState),
      currentRevisionOrigin: candidate.currentRevision.origin,
      scopeKind: candidate.finding.scopeKind,
      scopeProjectId: candidate.finding.scopeProjectId ?? null,
      currentProjectIds: args.currentProjectIds.map((id) => id as string),
      movedSourceId: args.sourceId,
      restsOnMovedSource: candidate.restsOnMovedSource,
      currentWitnesses: witnesses,
    });
    if (decision.decision === "mark_updating") {
      markings.push({
        finding: candidate.finding,
        currentRevision: candidate.currentRevision,
        reason: scopeReassignedReason(candidate.finding.scopeProjectId as string),
      });
    }
  }
  return commitMarkings(tx, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    stamp: {
      origin: "reassignment_marking",
      knowledgeState: encodeKnowledgeState(
        explicitUpdating(scopeUpdatingReason(args.sourceId)),
      ),
      attribution: { kind: "reassignedSourceId", sourceId: args.sourceId },
    },
    markings,
  });
}

/** One candidate finding the reassignment may re-assess, with its current revision. */
interface ScopeCandidate {
  readonly finding: Doc<"findings">;
  readonly currentRevision: Doc<"findingRevisions">;
  /** Whether the current revision rests on the moved source (witness or provenance). */
  readonly restsOnMovedSource: boolean;
}

/**
 * The bounded candidate walk: findings whose CURRENT revision either cites
 * the moved source as evidence (`evidenceLinks.by_source`, the withdrawal
 * core's walk) or was published from it (`changeSets.by_source` ->
 * `publicationGroups.memberRevisionIds`). Every row is tenant-checked.
 */
async function scopeCandidates(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  sourceId: Id<"sources">,
): Promise<ScopeCandidate[]> {
  const revisionsCitingSource = new Set<Id<"findingRevisions">>();
  const links = await db
    .query("evidenceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  for (const link of links) {
    revisionsCitingSource.add(link.findingRevisionId);
  }
  const changeSets = await db
    .query("changeSets")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  for (const changeSet of changeSets) {
    const groups = await db
      .query("publicationGroups")
      .withIndex("by_change_set", (q) => q.eq("changeSetId", changeSet._id))
      .collect();
    for (const group of groups) {
      for (const revisionId of group.memberRevisionIds ?? []) {
        revisionsCitingSource.add(revisionId);
      }
    }
  }

  const byFinding = new Map<Id<"findings">, ScopeCandidate>();
  for (const revisionId of revisionsCitingSource) {
    const revision = await db.get(revisionId);
    if (revision === null) {
      continue;
    }
    const finding = await db.get(revision.findingId);
    if (finding === null || finding.companyId !== companyId) {
      continue; // tenant scope: foreign rows are never marked
    }
    // Only the CURRENT revision matters: older revisions are history.
    if (finding.currentRevisionId !== revision._id) {
      continue;
    }
    const citesMovedSource = links.some((link) => link.findingRevisionId === revision._id);
    const publishedFromMovedSource =
      revision.provenance !== undefined && revision.provenance.sourceId === sourceId;
    byFinding.set(finding._id, {
      finding,
      currentRevision: revision,
      restsOnMovedSource: citesMovedSource || publishedFromMovedSource,
    });
  }
  return [...byFinding.values()];
}
