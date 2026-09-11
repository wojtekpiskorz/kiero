/**
 * Source-withdrawal marking (C2): the memory-side reaction to
 * "Źródło wycofane" (issue 8), with full recomputation left to C5.
 *
 * When a source is withdrawn it "przestaje stanowić podstawę aktualnych
 * ustaleń": findings whose CURRENT revision is a publication supported only
 * by that source are marked unknown with the withdrawal reason — as a NEW
 * revision (origin `withdrawal_marking`), so the value, its sources and the
 * whole history stay intact and inspectable. Current revisions that stand
 * on their own keep standing:
 *
 * - a later EXPLICIT correction is its own resolution, not borrowed support;
 * - a remaining witness on another source (independent corroboration)
 *   keeps the finding alive;
 * - an already-marked revision is not marked twice.
 *
 * Derivation-only findings (no witness links) are located through their
 * dependency edges by C5's recomputation; this marking covers the
 * witness-backed current state, which is what withdrawal removes.
 *
 * TWO entries over ONE core (review round 2): `markWithdrawnSupport` is
 * the parameterized core (tenant + recording user as arguments, source id
 * already normalized): the marking walk lives here once, and the commit
 * loop (revision + projection patch + event) is the ONE shared
 * marking-commit core (./marking.ts, extracted in E7 review round 1) this
 * lane and the reassignment lane both call. `performWithdrawalMarking`
 * stays the RequestContext-backed entry (the guarded probe and any
 * session-holding caller); C5's durable `memory.recompute_dependents`
 * executor calls the core directly, because a deferred job cannot depend
 * on a live session existing; its actor is the withdrawal's actor
 * (fallback: the source's author), recorded honestly with the
 * system-driven origin and reason.
 *
 * Each marking revision carries `withdrawnSourceId` (C5 amendment, flagged
 * below in ./schema.ts): the exact withdrawal a marking belongs to, so
 * recomputation adopts only its own roots — identical reason TEXT is not
 * attribution (two withdrawals may share wording).
 */

import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { conflictError, notFoundError, validationError, type RequestContext } from "@kiero/runtime";
import { decideWithdrawalMarking, explicitUnknown, sourceWithdrawnReason, type EvidenceSupportRef } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { normalizedCompany, normalizedActor } from "./references";
import { encodeKnowledgeState } from "./semantics";
import { commitMarkings, type MarkingOutcome, type PlannedMarking } from "./marking";

/** The marking core's parameters: everything the reaction needs, no session. */
export interface WithdrawalMarkingArgs {
  /** The tenant whose memory is marked (the source must belong to it). */
  readonly companyId: Id<"companies">;
  /** The user recorded as the marking's author (withdrawal actor or author). */
  readonly actorUserId: Id<"users">;
  /** The normalized id of the withdrawn source. */
  readonly sourceId: Id<"sources">;
  /** The withdrawal's reason, recorded verbatim on each marking revision. */
  readonly reason: string;
}

/**
 * The ONE witness-based marking core: marks findings whose CURRENT revision
 * was a publication supported only by the withdrawn source. Runs entirely
 * inside the caller's transaction: every marking (revision + projection
 * patch) and its `memory.findingRevised` event commit together with
 * everything else, or not at all. Everything that can refuse runs before
 * the first write. Returns the typed marking outcome (review round 1: the
 * ok payload is typed, no envelope re-assertions at the callers).
 */
export async function markWithdrawnSupport(
  tx: MutationCtx,
  args: WithdrawalMarkingArgs,
): Promise<MarkingOutcome> {
  const source = await tx.db.get(args.sourceId);
  if (source === null || source.companyId !== args.companyId) {
    return { _tag: "error", error: notFoundError("sources") };
  }
  // Marking follows withdrawal; it never runs ahead of the explicit
  // lifecycle transition (conflict detection alone is not withdrawal).
  if (source.lifecycle !== "withdrawn") {
    return {
      _tag: "error",
      error: conflictError("source_not_withdrawn", "sources", source._id),
    };
  }

  // Everything that can throw or refuse runs before the first write.
  const links = await tx.db
    .query("evidenceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", args.sourceId))
    .collect();
  const affectedRevisions: Id<"findingRevisions">[] = [
    ...new Set(links.map((link) => link.findingRevisionId)),
  ];
  const markings: PlannedMarking[] = [];
  for (const revisionId of affectedRevisions) {
    const revision = await tx.db.get(revisionId);
    if (revision === null) {
      continue;
    }
    const finding = await tx.db.get(revision.findingId);
    if (finding === null || finding.companyId !== args.companyId) {
      continue;
    }
    // Only the CURRENT revision matters: older revisions are history.
    if (finding.currentRevisionId !== revision._id) {
      continue;
    }
    const currentLinks = await tx.db
      .query("evidenceLinks")
      .withIndex("by_revision", (q) => q.eq("findingRevisionId", revision._id))
      .collect();
    const evidence: EvidenceSupportRef[] = currentLinks.map((link) => ({
      sourceId: link.sourceId,
      supportKind: link.supportKind,
    }));
    const decision = decideWithdrawalMarking({
      currentRevisionOrigin: revision.origin,
      currentEvidence: evidence,
      withdrawnSourceId: args.sourceId,
    });
    if (decision.decision === "mark_unknown") {
      markings.push({ finding, currentRevision: revision, reason: args.reason });
    }
  }
  return commitMarkings(tx, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    stamp: {
      origin: "withdrawal_marking",
      knowledgeState: encodeKnowledgeState(
        explicitUnknown(sourceWithdrawnReason(args.reason)),
      ),
      attribution: { kind: "withdrawnSourceId", sourceId: args.sourceId },
    },
    markings,
  });
}

/**
 * The RequestContext-backed entry over the same core: resolves the tenant,
 * the recording user and the source reference, then marks. C5's durable
 * executor calls {@link markWithdrawnSupport} directly (identity
 * independence); session-holding callers use this one.
 */
export async function performWithdrawalMarking(
  tx: MutationCtx,
  context: RequestContext,
  sourceRef: string,
  reason: string,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const sourceId = tx.db.normalizeId("sources", sourceRef);
  if (sourceId === null) {
    return errorResult(notFoundError("sources"));
  }
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }
  const marking = await markWithdrawnSupport(tx, {
    companyId,
    actorUserId,
    sourceId,
    reason,
  });
  // The session-backed wire keeps its historical payload shape: the roots
  // (targets stay with the durable executor, which owns re-analysis).
  return marking._tag === "ok"
    ? okResult({ markedFindingIds: marking.markedFindingIds })
    : errorResult(marking.error);
}
