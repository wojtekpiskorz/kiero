/**
 * The ONE marking-commit core every memory-side marking lane shares (C2's
 * findings lane; extracted in E7 review round 1, issue #115): the commit
 * loop that writes one marking revision per pre-validated finding,
 * projects it onto the finding row and publishes `memory.findingRevised`,
 * all inside the caller's transaction.
 *
 * Before this core existed the loop was transcribed per lane (withdrawal
 * in ./withdrawal.ts, the cascade level in ../recompute/executor.ts, scope
 * re-assessment in the sources lane); its steps are identical and only the
 * stamp differs, so the stamp is a parameter:
 *
 * - `origin`: the revision's origin vocabulary entry;
 * - `knowledgeState`: the encoded epistemic state the marking writes;
 * - `attribution`: which source-attribution field pins the marking to its
 *   cause (by SOURCE ID, never by reason text);
 * - the per-marking `reason` (a lane may vary it per finding).
 *
 * Everything that can refuse runs before the first write: the caller
 * collects pre-validated {@link PlannedMarking}s and calls
 * {@link commitMarkings} once; the core only re-checks the event registry
 * (a missing entry refuses before any write) and then commits.
 */

import { Schema } from "effect";
import { events, type ClosedError } from "@kiero/contracts";
import { validationError } from "@kiero/runtime";
import type { RecomputeTarget } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import { TEMPLATE_ID, encodeKnowledgeState } from "./semantics";

/** One pre-validated marking: the finding, its current revision and reason. */
export interface PlannedMarking {
  readonly finding: Doc<"findings">;
  readonly currentRevision: Doc<"findingRevisions">;
  /** The machine reason recorded on this marking's revision. */
  readonly reason: string;
}

/**
 * How one marking lane stamps the revisions it writes: the origin
 * vocabulary entry, the encoded knowledge state and (when the marking pins
 * to a source cause) the source-attribution field.
 */
export interface MarkingStamp {
  /**
   * The revision origin of the lane (`withdrawal_marking` /
   * `reassignment_marking` / `purge_marking`).
   */
  readonly origin: "withdrawal_marking" | "reassignment_marking" | "purge_marking";
  /** The encoded knowledge state every marking writes (computed once per run). */
  readonly knowledgeState: ReturnType<typeof encodeKnowledgeState>;
  /**
   * Which source field attributes the marking, and to which source.
   * Absent on the cascade level's markings (they mark by ROOT FINDING and
   * carry no source attribution).
   */
  readonly attribution?:
    | { readonly kind: "withdrawnSourceId"; readonly sourceId: Id<"sources"> }
    | { readonly kind: "reassignedSourceId"; readonly sourceId: Id<"sources"> }
    | { readonly kind: "purgedSourceId"; readonly sourceId: Id<"sources"> };
}

/**
 * The typed outcome of one marking core (review round 1: the ok payload is
 * typed, so callers never re-assert the shape the core just built): the
 * marked roots, their new revision ids (the cascade carriers' dedup) and
 * their re-analysis targets, or the closed refusal.
 */
export type MarkingOutcome =
  | {
      readonly _tag: "ok";
      /** The findings this marking moved (the cascade's roots). */
      readonly markedFindingIds: Id<"findings">[];
      /** Each committed marking's new revision id, per finding. */
      readonly revisions: ReadonlyArray<{
        readonly findingId: Id<"findings">;
        readonly revisionId: Id<"findingRevisions">;
      }>;
      /** The marked findings' provenance sources (E3 re-analysis groups). */
      readonly targets: RecomputeTarget[];
    }
  | { readonly _tag: "error"; readonly error: ClosedError };

/**
 * Commits every pre-validated marking: one new revision per finding (the
 * value preserved VERBATIM, only the epistemic state moves), the finding
 * row's projection patch and the `memory.findingRevised` event, all inside
 * the caller's transaction: together with everything else, or not at all.
 */
export async function commitMarkings(
  tx: MutationCtx,
  args: {
    /** The tenant whose memory is marked. */
    readonly companyId: Id<"companies">;
    /** The user recorded as the markings' author. */
    readonly actorUserId: Id<"users">;
    /** How this lane stamps its revisions. */
    readonly stamp: MarkingStamp;
    /** The pre-validated markings (the caller's decision pass collected them). */
    readonly markings: readonly PlannedMarking[];
  },
): Promise<MarkingOutcome> {
  const findingRevised = events["memory.findingRevised"];
  if (findingRevised === undefined) {
    return { _tag: "error", error: validationError("memory_events_missing") };
  }
  // The pre-insert decode template (the D1 pattern): proves the event
  // payload still accepts the exact shape this loop constructs, BEFORE
  // anything is written.
  Schema.decodeUnknownSync(findingRevised.payload)({
    findingId: TEMPLATE_ID,
    revisionId: TEMPLATE_ID,
    supersedesRevisionId: null,
  });

  const nowMs = Date.now();
  const markedFindingIds: Id<"findings">[] = [];
  const revisions: Array<{ findingId: Id<"findings">; revisionId: Id<"findingRevisions"> }> = [];
  const targets: RecomputeTarget[] = [];
  for (const marking of args.markings) {
    const revisionId = await tx.db.insert("findingRevisions", {
      findingId: marking.finding._id,
      revision: marking.finding.revisionCounter + 1,
      // The value is preserved verbatim; only its epistemic state moves.
      value: marking.currentRevision.value,
      knowledgeState: args.stamp.knowledgeState,
      supersedesRevisionId: marking.currentRevision._id,
      origin: args.stamp.origin,
      reason: marking.reason,
      ...(args.stamp.attribution === undefined
        ? {}
        : args.stamp.attribution.kind === "withdrawnSourceId"
          ? { withdrawnSourceId: args.stamp.attribution.sourceId }
          : args.stamp.attribution.kind === "purgedSourceId"
            ? { purgedSourceId: args.stamp.attribution.sourceId }
            : { reassignedSourceId: args.stamp.attribution.sourceId }),
      recordedByUserId: args.actorUserId,
      recordedAtMs: nowMs,
    });
    await tx.db.patch(marking.finding._id, {
      currentRevisionId: revisionId,
      knowledgeState: args.stamp.knowledgeState,
      revisionCounter: marking.finding.revisionCounter + 1,
      updatedAtMs: nowMs,
    });
    markedFindingIds.push(marking.finding._id);
    revisions.push({ findingId: marking.finding._id, revisionId });
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
  return { _tag: "ok", markedFindingIds, revisions, targets };
}
