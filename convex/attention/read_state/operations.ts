/**
 * Read-state mutation transaction (F1): `attention.markSourceRead`.
 *
 * ONE Convex mutation performs the whole thing (the D1 dispatch pattern):
 * resolve + tenant-check the LOGICAL source, decide the transition, write
 * the ONE row this person has for that source, and publish the canonical
 * `attention.sourceReadChanged` event — atomically, or nothing commits.
 *
 * What this transaction deliberately does NOT do:
 *
 * - It never infers read state from delivery, dismissal or notification
 *   clicks (issue 41 scope exclusion; only seeing the entry in Kiero or an
 *   explicit mark reaches this operation).
 * - It never writes another person's row: the row is keyed on the RESOLVED
 *   actor's user id, which the checked dispatch resolved from a verified
 *   identity — never from input.
 * - It never routes through a view: there is no view, project or device
 *   dimension in the key, so "one mutation marks it everywhere for that
 *   person" is structural. A projection appearing or disappearing around
 *   the mark (project links changing) cannot strand a second state.
 *
 * Idempotency: a mark that matches the stored state performs NO write and
 * publishes NO event, so concurrent/repeated marks collapse (Convex OCC
 * serializes conflicting transactions; the loser re-runs and re-decides).
 */

import { Schema } from "effect";
import {
  attentionOperations,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { forbiddenError, notFoundError, type RequestContext } from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import { publishEvent } from "../../platform/publish";
import { decideReadTransition, type ReadStateRow } from "./state";

/** The contract entry this transaction implements (decode/typed authority). */
export const markSourceReadOperation = attentionOperations["attention.markSourceRead"];
export type MarkSourceReadInput = Schema.Schema.Type<typeof markSourceReadOperation.input>;
export type MarkSourceReadResult = Schema.Schema.Type<typeof markSourceReadOperation.result>;

/**
 * Performs the whole mark-read in the caller's transaction. Membership is
 * resolved by the checked dispatch (context), and the source's company is
 * re-checked HERE inside the transaction so a forged cross-company id fails
 * `forbidden` even when the envelope decoded.
 */
export async function performMarkSourceRead(
  tx: MutationCtx,
  context: RequestContext,
  input: MarkSourceReadInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  const userId = tx.db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return errorResult(forbiddenError("actor_scope_unresolved"));
  }
  const sourceId = tx.db.normalizeId("sources", input.sourceId);
  if (sourceId === null) {
    return errorResult(notFoundError("sources", "source_not_found"));
  }

  // Tenant check on the logical source itself (membership was resolved by
  // the dispatch; this re-check rejects forged cross-company ids).
  const source = await tx.db.get(sourceId);
  if (source === null) {
    return errorResult(notFoundError("sources", "source_not_found"));
  }
  if (source.companyId !== companyId) {
    return errorResult(forbiddenError("tenant_scope_mismatch", "sources"));
  }

  // The one row this person has for this logical source (any view, any
  // device — there is no other key).
  const existing = await tx.db
    .query("readStates")
    .withIndex("by_user_source", (q) => q.eq("userId", userId).eq("sourceId", sourceId))
    .first();
  const current: ReadStateRow | null = existing === null ? null : { read: existing.read };
  const transition = decideReadTransition(current, input.read);
  if (transition === "unchanged") {
    // Idempotent: the stored state already says this. No write, no event.
    return okResult(Schema.decodeUnknownSync(markSourceReadOperation.result)({ sourceId }));
  }

  if (existing === null) {
    await tx.db.insert("readStates", {
      companyId,
      userId,
      sourceId,
      read: input.read,
      readAtMs: nowMs,
    });
  } else {
    await tx.db.patch(existing._id, { read: input.read, readAtMs: nowMs });
  }
  // The canonical event publishes in the SAME transaction: subscribers see
  // exactly one event per actual transition. No dedup key: replays of the
  // same desired state never reach this point, and a later genuine
  // transition back is a new occurrence, not a duplicate.
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "attention.sourceReadChanged",
    payload: { userId, sourceId, read: input.read },
  });
  return okResult(Schema.decodeUnknownSync(markSourceReadOperation.result)({ sourceId }));
}
