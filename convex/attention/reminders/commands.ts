/**
 * Task-reminder command entries (F4).
 *
 * Two callable entries, one checked dispatch (the lane pattern):
 *
 * - `dispatchRemindersCommand`'s public mutations (the client path; Convex
 *   Auth identity only): `snoozeTaskRemindersCommand` (the personal
 *   snooze) and `evaluateDueRemindersCommand` (an idempotent manual sweep
 *   a member may trigger; harmless and observable).
 * - `snoozeTaskRemindersTransaction` / `evaluateDueRemindersTransaction`
 *   (internal mutations): the service-bridge path with a verified service
 *   session id (the guarded dev-proof surface's fake-clock entry).
 *
 * The durable execution path (scheduler hops, the cron safety net and the
 * event-driven executor job) calls ./evaluate.ts and ./executor.ts
 * directly - the platform pattern, exactly like the outbox drain.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../../_generated/server";
import { dispatchRemindersCommand } from "./dispatch";

/** The personal-snooze client command path (Convex Auth, checked dispatch). */
export const snoozeTaskRemindersCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchRemindersCommand(ctx, args.envelope, undefined),
});

/** The manual evaluator-sweep client command path. */
export const evaluateDueRemindersCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchRemindersCommand(ctx, args.envelope, undefined),
});

/**
 * The service path's transactional entries: the verified service session
 * id substitutes the bearer-verified identity (the A3 bridge pattern).
 */
export const snoozeTaskRemindersTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => dispatchRemindersCommand(ctx, args.envelope, args.serviceSessionId),
});

export const evaluateDueRemindersTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => dispatchRemindersCommand(ctx, args.envelope, args.serviceSessionId),
});
