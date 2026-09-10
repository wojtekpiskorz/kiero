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
 * C5's durable executor (job kind `memory.recompute_dependents`, input
 * `recomputeDependentsInput` with cause `source_withdrawn`) calls
 * `performWithdrawalMarking` in its own transaction; the guarded probe and
 * the internal mutation below exist so the operation is provable NOW.
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { conflictError, notFoundError, validationError, type RequestContext } from "@kiero/runtime";
import { decideWithdrawalMarking, explicitUnknown, sourceWithdrawnReason, type EvidenceSupportRef } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import { normalizedCompany } from "./references";
import { TEMPLATE_ID, encodeKnowledgeState } from "./semantics";

/**
 * Marks findings affected by one withdrawn source. Runs entirely inside the
 * caller's transaction: every marking (revision + projection patch) and its
 * `memory.findingRevised` event commit together with everything else, or
 * not at all.
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
  const source = await tx.db.get(sourceId);
  if (source === null || source.companyId !== companyId) {
    return errorResult(notFoundError("sources"));
  }
  // Marking follows withdrawal; it never runs ahead of the explicit
  // lifecycle transition (conflict detection alone is not withdrawal).
  if (source.lifecycle !== "withdrawn") {
    return errorResult(conflictError("source_not_withdrawn", "sources", source._id));
  }
  const findingRevised = events["memory.findingRevised"];
  if (findingRevised === undefined) {
    return errorResult(validationError("memory_events_missing"));
  }

  // Everything that can throw or refuse runs before the first write.
  const links = await tx.db
    .query("evidenceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const affectedRevisions: Id<"findingRevisions">[] = [
    ...new Set(links.map((link) => link.findingRevisionId)),
  ];
  interface MarkingPlan {
    finding: Doc<"findings">;
    currentRevision: Doc<"findingRevisions">;
  }
  const markings: MarkingPlan[] = [];
  for (const revisionId of affectedRevisions) {
    const revision = await tx.db.get(revisionId);
    if (revision === null) {
      continue;
    }
    const finding = await tx.db.get(revision.findingId);
    if (finding === null || finding.companyId !== companyId) {
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
      withdrawnSourceId: sourceId,
    });
    if (decision.decision === "mark_unknown") {
      markings.push({ finding, currentRevision: revision });
    }
  }
  const actorUserId = tx.db.normalizeId("users", context.actor.userId);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }
  Schema.decodeUnknownSync(findingRevised.payload)({
    findingId: TEMPLATE_ID,
    revisionId: TEMPLATE_ID,
    supersedesRevisionId: null,
  });

  const nowMs = Date.now();
  const markedFindingIds: Id<"findings">[] = [];
  for (const marking of markings) {
    const markedKnowledge = encodeKnowledgeState(
      explicitUnknown(sourceWithdrawnReason(reason)),
    );
    const revisionId = await tx.db.insert("findingRevisions", {
      findingId: marking.finding._id,
      revision: marking.finding.revisionCounter + 1,
      // The value is preserved verbatim; only its epistemic state changes.
      value: marking.currentRevision.value,
      knowledgeState: markedKnowledge,
      supersedesRevisionId: marking.currentRevision._id,
      origin: "withdrawal_marking",
      reason,
      recordedByUserId: actorUserId,
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
      companyId: context.actor.companyId,
      eventName: "memory.findingRevised",
      payload: {
        findingId: marking.finding._id,
        revisionId,
        supersedesRevisionId: marking.currentRevision._id,
      },
      dedupKey: `memory.findingRevised:${revisionId}`,
    });
  }
  return okResult({ markedFindingIds });
}
