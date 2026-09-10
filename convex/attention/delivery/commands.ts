/**
 * Notification-delivery command entries (F2).
 *
 * Two callable entries, one checked dispatch (the lane pattern):
 *
 * - `evaluateDueIntentsCommand` (public mutation): the client path; Convex
 *   Auth identity only. An evaluation sweep is idempotent, so a member
 *   triggering it manually is harmless and observable.
 * - `evaluateDueIntentsTransaction` (internal mutation): the service-bridge
 *   path with a verified service session id (the guarded dev-proof
 *   surface's fake-clock entry).
 *
 * The durable execution path (scheduler hops, the cron safety net and the
 * event-driven executor job) calls ./evaluate.ts and ./executor.ts
 * directly — the platform pattern, exactly like the outbox drain.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../../_generated/server";
import { dispatchDeliveryCommand } from "./dispatch";

/** The client command path: Convex Auth identity, checked dispatch. */
export const evaluateDueIntentsCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchDeliveryCommand(ctx, args.envelope, undefined),
});

/**
 * The service path's transactional entry: the verified service session id
 * substitutes the bearer-verified identity (the A3 bridge pattern).
 */
export const evaluateDueIntentsTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => dispatchDeliveryCommand(ctx, args.envelope, args.serviceSessionId),
});
