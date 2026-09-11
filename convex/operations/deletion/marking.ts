/**
 * The purge support-removal marking (I4): the memory-side reaction to a
 * committed source tombstone, over the C5 marking machinery.
 *
 * A permanently deleted source can witness nothing ("baza" gone, not merely
 * withdrawn): findings whose CURRENT revision was a publication supported
 * only by that source are marked unknown with the machine purge reason, as
 * a NEW revision (origin `purge_marking`) through the ONE shared marking
 * commit core (../../memory/findings/marking.ts - the C2/E7 discipline), so
 * the value's history stays inspectable while the current projection is the
 * explicit unknown. Current revisions that stand on their own keep standing:
 * a later explicit correction is its own resolution, and a remaining witness
 * on another source (independent corroboration) keeps the finding alive.
 *
 * Every marked root then hands its derivation dependents to the C5 cascade
 * by publishing one `memory.dependentsMarkedStale` carrier per root (the
 * same revision-unique carrier discipline the withdrawal recompute uses):
 * dependents become visibly `updating`-until-revalidated, and any Calendar
 * copies follow their subjects' term revisions through G2's own drift pass.
 * A purged provenance source supports no new run, so such dependents stay
 * honestly `updating` until NEW evidence.
 *
 * IDENTITY-INDEPENDENT (the C5 review rule): the durable purge executor
 * calls this core with the tenant and the deleting administrator as
 * arguments; a deferred job never depends on a live session.
 */

import { events } from "@kiero/contracts";
import { conflictError, notFoundError } from "@kiero/runtime";
import { decideWithdrawalMarking, directDependents, explicitUnknown, type EvidenceSupportRef } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import { encodeKnowledgeState } from "../../memory/findings/semantics";
import { commitMarkings, type MarkingOutcome, type PlannedMarking } from "../../memory/findings/marking";
import { PURGED_SUPPORT_REASON } from "./purge";

/** Everything the purge marking needs (no session, no request context). */
export interface PurgeMarkingArgs {
  readonly companyId: Id<"companies">;
  readonly actorUserId: Id<"users">;
  readonly sourceId: Id<"sources">;
}

/**
 * The ONE purge marking core: marks findings whose CURRENT revision rested
 * only on the purged source, then publishes one cascade carrier per marked
 * root. Runs entirely inside the caller's transaction; replay-safe (an
 * already purge-marked revision is retained by the pure decision).
 */
export async function markPurgedSupport(
  tx: MutationCtx,
  args: PurgeMarkingArgs,
): Promise<MarkingOutcome> {
  const source = await tx.db.get(args.sourceId);
  if (source === null || source.companyId !== args.companyId) {
    return { _tag: "error", error: notFoundError("sources", "source_not_found") };
  }
  // Marking follows the committed tombstone; it never runs ahead of the
  // permanent deletion (the initiating transaction owns that transition).
  if (source.lifecycle !== "purged") {
    return {
      _tag: "error",
      error: conflictError("source_not_purged", "sources", source._id),
    };
  }
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
      markings.push({ finding, currentRevision: revision, reason: PURGED_SUPPORT_REASON });
    }
  }
  const outcome = await commitMarkings(tx, {
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    stamp: {
      origin: "purge_marking",
      knowledgeState: encodeKnowledgeState(explicitUnknown(PURGED_SUPPORT_REASON)),
      attribution: { kind: "purgedSourceId", sourceId: args.sourceId },
    },
    markings,
  });
  if (outcome._tag === "error") {
    return outcome;
  }
  for (const marked of outcome.revisions) {
    await publishCascadeCarrier(tx, {
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      rootFindingId: marked.findingId,
      markingRevisionId: marked.revisionId,
    });
  }
  return outcome;
}

/**
 * Publishes the cascade carrier for one marked root (the recompute
 * executor's carrier shape, re-declared here so the dependency stays on
 * the shared EVENT, not on C5's private helper).
 */
async function publishCascadeCarrier(
  tx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    actorUserId: Id<"users">;
    rootFindingId: Id<"findings">;
    markingRevisionId: Id<"findingRevisions">;
  },
): Promise<void> {
  const childEdges = await tx.db
    .query("findingDependencies")
    .withIndex("by_depends_on", (q) => q.eq("dependsOnFindingId", args.rootFindingId))
    .collect();
  if (childEdges.length === 0) {
    return;
  }
  const dependentsMarkedStale = events["memory.dependentsMarkedStale"];
  if (dependentsMarkedStale === undefined) {
    throw new Error("deletion marking: memory.dependentsMarkedStale missing from the registry");
  }
  await publishEvent(tx, {
    companyId: args.companyId,
    eventName: "memory.dependentsMarkedStale",
    payload: {
      rootFindingId: args.rootFindingId,
      dependentFindingIds: directDependents(
        childEdges.map((edge) => ({
          dependent: edge.dependentFindingId,
          dependsOn: edge.dependsOnFindingId,
        })),
        args.rootFindingId,
      ),
      withdrawnByUserId: args.actorUserId,
    },
    // Revision-unique: a replayed purge can never re-fire the cascade.
    dedupKey: `memory.dependentsMarkedStale:${args.rootFindingId}:${args.markingRevisionId}`,
  });
}
