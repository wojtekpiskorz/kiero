/**
 * The provider-call completion record (E2).
 *
 * One outbox event per dispatched model call, carrying only the sanitized
 * route/model/outcome vocabulary of the declared
 * `integrations.providerCallCompleted` contract: no prompts, transcripts,
 * tool arguments, tokens or provider payloads. No consumer edge is
 * registered yet (later J joins own cross-module edges), so the drain marks
 * these rows delivered once written — the durable, inspectable trace of the
 * call at event granularity until the pipeline lanes record per-step
 * `processingAttempts` rows.
 */

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { publishEvent } from "../../platform/publish";

/**
 * Publishes one sanitized provider-call completion event (outbox
 * transaction).
 *
 * `dedupKey` carries the CAUSING command's operation identity (its
 * idempotency key, threaded from the dispatch envelope): a retry or replay
 * of the dispatching action reuses the caller's key and the outbox
 * publication collapses instead of writing a duplicate event. Without a
 * caller-supplied identity each executed call is a distinct event and a
 * fresh key is generated.
 */
export const recordProviderCall = internalMutation({
  args: {
    companyId: v.string(),
    routeId: v.string(),
    actualModel: v.string(),
    outcome: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("timeout_unknown"),
    ),
    dedupKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // publishEvent decodes the payload against the event's registry schema
    // (the contracts authority) and writes the outbox row in this
    // mutation's transaction.
    await publishEvent(ctx, {
      companyId: args.companyId,
      eventName: "integrations.providerCallCompleted",
      payload: {
        routeId: args.routeId,
        actualModel: args.actualModel,
        outcome: args.outcome,
      },
      dedupKey: args.dedupKey ?? `integrations.modelCall:${crypto.randomUUID()}`,
    });
  },
});
