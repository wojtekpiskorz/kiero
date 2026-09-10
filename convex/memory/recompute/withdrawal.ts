/**
 * Source withdrawal as a durable operation (C5): the explicit transition
 * "Szef może jawnie wycofać źródło" (issue 8) plus the atomic registration
 * of dependency-aware recomputation.
 *
 * ONE Convex mutation does everything ("Withdrawal records actor, time and
 * reason on the same immutable D1 source, then schedules bounded
 * recomputation groups"):
 *
 * - guard: the source belongs to the actor's company and is still `active`
 *   (withdrawal is an explicit operation; conflict detection alone is not
 *   withdrawal, and an already withdrawn/purged source refuses);
 * - patch the immutable D1 source row: `lifecycle: withdrawn` with the
 *   reason, time and the acting user — the row keeps its authorship,
 *   content and full history ("Jej wcześniejsza rola i przyczyna korekty
 *   pozostają częścią historii");
 * - publish the canonical `sources.sourceWithdrawn` event;
 * - register the durable `memory.recompute_dependents` job ATOMICICALLY
 *   under the SAME dedup key, so the outbox drain's projection collapses
 *   onto this registration (the D1 acceptance pattern): the recomputation
 *   reaction can never be lost, and a replay never double-registers.
 *
 * The marking of affected findings does NOT run inline: the registered
 * executor (./executor.ts) calls C2's `performWithdrawalMarking` in its own
 * transaction — marking follows withdrawal, never ahead of it (C2's rule),
 * and the whole reaction is durable, retryable and inspectable.
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  executors,
  okResult,
  sourcesOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent, registerDurableJob } from "../../platform/publish";
import { normalizedActor, normalizedCompany, requireSource } from "../findings/references";

/** The contract entry this transaction implements (decode/typed authority). */
export const withdrawSourceEntry = sourcesOperations["sources.withdrawSource"];

/** The input type of `sources.withdrawSource` as decoded by the checked path. */
export type WithdrawSourceInput = Schema.Schema.Type<typeof withdrawSourceEntry.input>;

/** Retry policy of the registered recomputation (bounded, like D1's). */
export const RECOMPUTE_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

/** Pipeline version recorded on the reanalysis runs recomputation creates. */
export const RECOMPUTE_PIPELINE_VERSION = "c5.recompute/1";

/**
 * A representative table id used only by the pre-insert decode templates
 * (D1's pattern): proves the event payload, executor input and receipt
 * schemas still accept the exact shapes this transaction constructs,
 * BEFORE anything is written.
 */
const REGISTRATION_TEMPLATE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";

/**
 * Everything that can throw or refuse during registration, resolved BEFORE
 * the first write (the D1 acceptance discipline): a failure here leaves
 * nothing committed, while the same failure after the patch would commit a
 * withdrawn source with no recomputation reaction.
 */
function registrationTargets(): { ok: true } | { ok: false; error: ReturnType<typeof validationError> } {
  const eventEntry = events["sources.sourceWithdrawn"];
  if (eventEntry === undefined) {
    return { ok: false, error: validationError("source_withdrawn_event_missing") };
  }
  const executor = executors.find(
    (candidate) => candidate.jobKind === "memory.recompute_dependents",
  );
  if (executor === undefined) {
    return { ok: false, error: validationError("recompute_executor_missing") };
  }
  Schema.decodeUnknownSync(eventEntry.payload)({
    sourceId: REGISTRATION_TEMPLATE_ID,
    reason: "template",
  });
  Schema.decodeUnknownSync(executor.input)({
    rootFindingId: null,
    sourceId: REGISTRATION_TEMPLATE_ID,
    cause: "source_withdrawn",
    reason: "template",
    withdrawnByUserId: REGISTRATION_TEMPLATE_ID,
  });
  Schema.decodeUnknownSync(withdrawSourceEntry.result)({ withdrawnAtMs: 0 });
  return { ok: true };
}

/**
 * Performs the whole withdrawal in the caller's mutation transaction:
 * guards, the lifecycle patch with reason/time/actor, the canonical event
 * and the durable recomputation registration — atomically.
 */
export async function performWithdrawSource(
  tx: MutationCtx,
  context: RequestContext,
  input: WithdrawSourceInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }
  const source = await requireSource(tx.db, input.sourceId, companyId);
  if (source === null) {
    return errorResult(notFoundError("sources"));
  }
  if (source.lifecycle !== "active") {
    // Withdrawal is a one-time explicit transition: an already withdrawn or
    // purged source refuses (the first withdrawal's reason and actor stay).
    return errorResult(
      conflictError(
        source.lifecycle === "withdrawn" ? "source_already_withdrawn" : "source_not_active",
        "sources",
        source._id,
      ),
    );
  }
  const targets = registrationTargets();
  if (!targets.ok) {
    return errorResult(targets.error);
  }

  // --- the atomic commit: patch + event + job, or nothing ------------------
  const nowMs = Date.now();
  await tx.db.patch(source._id, {
    lifecycle: "withdrawn",
    withdrawnReason: input.reason,
    withdrawnAtMs: nowMs,
    withdrawnByUserId: actorUserId,
  });
  // One dedup identity for the event, the job and the logical withdrawal:
  // publisher-side registration and the drain's projection collapse here,
  // and a replayed withdrawal command can never exist (the guard above).
  const dedupKey = `sources.withdrawSource:${source._id}`;
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "sources.sourceWithdrawn",
    payload: { sourceId: source._id, reason: input.reason },
    dedupKey,
  });
  await registerDurableJob(tx, {
    kind: "memory.recompute_dependents",
    input: {
      rootFindingId: null,
      sourceId: source._id,
      cause: "source_withdrawn",
      reason: input.reason,
      withdrawnByUserId: actorUserId,
    },
    companyId: context.actor.companyId,
    sourceId: source._id,
    policy: RECOMPUTE_RETRY_POLICY,
    dedupKey,
  });
  return okResult({ withdrawnAtMs: nowMs });
}

/** Narrow row shape other modules may need from a withdrawn source. */
export interface WithdrawnSourceRow {
  readonly _id: Id<"sources">;
  readonly companyId: Id<"companies">;
  readonly withdrawnReason?: string | undefined;
}
