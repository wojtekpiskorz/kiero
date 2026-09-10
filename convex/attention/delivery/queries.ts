/**
 * Notification-delivery queries (F2): the due-delivery-intent export F3
 * consumes and the diagnostic status H4/I2 read (issue 42: "export due
 * delivery intents for F3 and diagnostic status for H4/I2").
 *
 * `dueDeliveryIntentsFor` lists the actor's company's intents with their
 * current lifecycle state, semantic identity, suppressed reason and the
 * collapsed delivery summary — the exact rows F3's push transport picks
 * up (state `delivered` = the due delivery decision handed the summary to
 * the adapter seam; F3 owns what happens after, including known/unknown
 * attempt outcomes on `notificationAttempts`).
 *
 * `deliveryStateForSource` narrows to one logical source (tenant-checked),
 * and `myDeliveryIntents` is the personal read (the boss's own intents
 * only; no other person's row is ever visible).
 *
 * Two callable shapes, one checked resolution (the lane pattern): internal
 * queries behind the verified service session (the A3 bridge identity)
 * and public Convex-Auth queries. Nothing here writes boss state.
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, notFoundError, unauthenticatedError } from "@kiero/runtime";
import { internalQuery, query, type QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { resolveBridgeQueryScope, resolveOwnQueryScope } from "../context";

/** One intent as the export/diagnostic surface reports it. */
function intentView(intent: Doc<"notificationIntents">) {
  return {
    intentId: intent._id,
    companyId: intent.companyId,
    recipientUserId: intent.recipientUserId,
    semanticKind: intent.semanticKind,
    sourceId: intent.sourceId ?? null,
    clarificationId: intent.clarificationId ?? null,
    dedupKey: intent.dedupKey,
    state: intent.state,
    dueAtMs: intent.dueAtMs,
    suppressedReason: intent.suppressedReason ?? null,
    delivery: intent.deliveryJson === undefined ? null : (JSON.parse(intent.deliveryJson) as unknown),
    deliveredAtMs: intent.deliveredAtMs ?? null,
    createdAtMs: intent.createdAtMs,
  };
}

/** One company's intents in one lifecycle state, bounded (alpha volume). */
async function companyIntentsInState(
  ctx: QueryCtx,
  companyId: Id<"companies">,
  state: "pending" | "delivered" | "suppressed" | "failed",
): Promise<Doc<"notificationIntents">[]> {
  return ctx.db
    .query("notificationIntents")
    .withIndex("by_due", (q) => q.eq("state", state))
    .filter((q) => q.eq(q.field("companyId"), companyId))
    .take(200);
}

/** The internal bridge-path read: the actor's company's delivery intents. */
export const dueDeliveryIntentsFor = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const [pending, delivered, suppressed, failed] = await Promise.all([
      companyIntentsInState(ctx, scope.companyId, "pending"),
      companyIntentsInState(ctx, scope.companyId, "delivered"),
      companyIntentsInState(ctx, scope.companyId, "suppressed"),
      companyIntentsInState(ctx, scope.companyId, "failed"),
    ]);
    return okResult({
      pending: pending.map(intentView),
      delivered: delivered.map(intentView),
      suppressed: suppressed.map(intentView),
      failed: failed.map(intentView),
    });
  },
});

/** The internal bridge-path read narrowed to one logical source (tenant-checked). */
export const deliveryStateForSource = internalQuery({
  args: { serviceSessionId: v.string(), sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const source = await ctx.db.get(args.sourceId);
    if (source === null) {
      return errorResult(notFoundError("sources", "source_not_found"));
    }
    if (source.companyId !== scope.companyId) {
      return errorResult(forbiddenError("tenant_scope_mismatch", "sources"));
    }
    const rows = await ctx.db
      .query("notificationIntents")
      .withIndex("by_source", (q) => q.eq("sourceId", args.sourceId))
      .take(200);
    return okResult({ intents: rows.map(intentView) });
  },
});

/** The public client path: the caller's OWN intents only (Convex Auth). */
export const myDeliveryIntents = query({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const scope = await resolveOwnQueryScope(ctx);
    if (scope === null) {
      return errorResult(unauthenticatedError());
    }
    const rows = await ctx.db
      .query("notificationIntents")
      .withIndex("by_recipient_state", (q) => q.eq("recipientUserId", scope.userId))
      .take(200);
    return okResult({ intents: rows.map(intentView) });
  },
});
