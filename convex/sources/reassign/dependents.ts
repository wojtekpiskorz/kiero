/**
 * The scope re-assessment marking of one project reassignment (E7, issue
 * #115): the memory-side reaction C5's durable executor invokes for the
 * `source_reassigned` cause, the reassignment twin of
 * `markWithdrawnSupport` (convex/memory/findings/withdrawal.ts), over the
 * SAME one-core-two-entries discipline.
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
 * Pure decisions live in @kiero/domain so tests prove them without a
 * deployment (the C5 precedent); this module is the transactional core.
 */

import { Schema } from "effect";
import { events, errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { notFoundError, validationError } from "@kiero/runtime";
import {
  explicitUpdating,
  updatingUntilRevalidatedReason,
  type RecomputeTarget,
} from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import { encodeKnowledgeState, knowledgeTagOf, TEMPLATE_ID } from "../../memory/findings/semantics";
import {
  decideScopeReassessment,
  type ScopeWitnessRef,
} from "./scope";

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

/** The marking core's result: the marked roots and their re-analysis targets. */
export interface ReassignmentMarking {
  /** The findings this marking moved to updating (the cascade's roots). */
  readonly markedFindingIds: Id<"findings">[];
  /** The marked findings' provenance sources (E3 re-analysis groups). */
  readonly targets: readonly RecomputeTarget[];
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
 */
export async function markReassignedScope(
  tx: MutationCtx,
  args: ReassignmentMarkingArgs,
): Promise<ResultEnvelope> {
  const source = await tx.db.get(args.sourceId);
  if (source === null || source.companyId !== args.companyId) {
    return errorResult(notFoundError("sources"));
  }
  // Marking follows the link change and never runs ahead of it: only an
  // ACTIVE source's placement re-assessment runs here (withdrawal/purge own
  // the stronger reactions for their lifecycles).
  if (source.lifecycle !== "active") {
    return errorResult(
      validationError(source.lifecycle === "withdrawn" ? "source_withdrawn" : "source_not_active"),
    );
  }
  const findingRevised = events["memory.findingRevised"];
  if (findingRevised === undefined) {
    return errorResult(validationError("memory_events_missing"));
  }

  // --- the candidate walk (bounded, indexed; everything before writes) ----
  const candidates = await scopeCandidates(tx.db, args.companyId, args.sourceId);
  const currentProjectSet = new Set<string>(args.currentProjectIds.map((id) => id as string));

  interface MarkingPlan {
    finding: Doc<"findings">;
    currentRevision: Doc<"findingRevisions">;
    /** The finding's scope project (the reason the marking names). */
    scopeProjectId: Id<"projects">;
  }
  const markings: MarkingPlan[] = [];
  const seenFindings = new Set<Id<"findings">>();
  for (const candidate of candidates) {
    if (seenFindings.has(candidate.finding._id)) {
      continue;
    }
    seenFindings.add(candidate.finding._id);
    // The narrowed scope test: only a project the source no longer links.
    if (
      candidate.finding.scopeKind !== "project" ||
      candidate.finding.scopeProjectId === undefined ||
      currentProjectSet.has(candidate.finding.scopeProjectId as string)
    ) {
      continue;
    }
    // The surviving-placement test: another active source cited by the
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
      scopeProjectLinked: false,
      movedSourceId: args.sourceId,
      restsOnMovedSource: candidate.restsOnMovedSource,
      currentWitnesses: witnesses,
    });
    if (decision.decision === "mark_updating") {
      markings.push({
        finding: candidate.finding,
        currentRevision: candidate.currentRevision,
        scopeProjectId: candidate.finding.scopeProjectId,
      });
    }
  }
  Schema.decodeUnknownSync(findingRevised.payload)({
    findingId: TEMPLATE_ID,
    revisionId: TEMPLATE_ID,
    supersedesRevisionId: null,
  });

  // --- the commit loop: only pre-validated writes from here ----------------
  const nowMs = Date.now();
  const markedKnowledge = encodeKnowledgeState(
    explicitUpdating(scopeUpdatingReason(args.sourceId)),
  );
  const markedFindingIds: Id<"findings">[] = [];
  const targets: RecomputeTarget[] = [];
  for (const marking of markings) {
    const revisionId = await tx.db.insert("findingRevisions", {
      findingId: marking.finding._id,
      revision: marking.finding.revisionCounter + 1,
      // The value is preserved verbatim; only its epistemic state moves.
      value: marking.currentRevision.value,
      knowledgeState: markedKnowledge,
      supersedesRevisionId: marking.currentRevision._id,
      origin: "reassignment_marking",
      reason: scopeReassignedReason(marking.scopeProjectId),
      reassignedSourceId: args.sourceId,
      recordedByUserId: args.actorUserId,
      recordedAtMs: nowMs,
    });
    await tx.db.patch(marking.finding._id, {
      currentRevisionId: revisionId,
      knowledgeState: markedKnowledge,
      revisionCounter: marking.finding.revisionCounter + 1,
      updatedAtMs: nowMs,
    });
    markedFindingIds.push(marking.finding._id);
    await publishEvent(tx, {
      companyId: args.companyId,
      eventName: "memory.findingRevised",
      payload: {
        findingId: marking.finding._id,
        revisionId,
        supersedesRevisionId: marking.currentRevision._id,
      },
      dedupKey: `memory.findingRevised:${revisionId}`,
    });
    if (marking.currentRevision.provenance !== undefined) {
      const provenanceSource = await tx.db.get(marking.currentRevision.provenance.sourceId);
      targets.push({
        findingId: marking.finding._id,
        provenanceSourceId: marking.currentRevision.provenance.sourceId,
        provenanceSourceActive:
          provenanceSource !== null && provenanceSource.lifecycle === "active",
      });
    }
  }
  return okResult({ markedFindingIds, targets });
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
