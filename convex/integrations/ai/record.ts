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

/** Publishes one sanitized provider-call completion event (outbox transaction). */
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
  },
  handler: async (ctx, args) => {
    // publishEvent decodes the payload against the event's registry schema
    // (the contracts authority) and writes the outbox row in this mutation's
    // transaction. The dedup key is unique per call: each executed call is a
    // distinct event; replay protection for the CAUSING operation lives in
    // that operation's own idempotency, not here.
    await publishEvent(ctx, {
      companyId: args.companyId,
      eventName: "integrations.providerCallCompleted",
      payload: {
        routeId: args.routeId,
        actualModel: args.actualModel,
        outcome: args.outcome,
      },
      dedupKey: `integrations.modelCall:${crypto.randomUUID()}`,
    });
  },
});
