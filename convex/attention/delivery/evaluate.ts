/**
 * The evaluator's scheduled/cron entries (F2): the durable execution side
 * of `attention.evaluateDueIntents` (the platform pattern — native Convex
 * scheduler plus a cron safety net, the A3/I2 outbox-drain precedent).
 *
 * - `evaluateDueIntents` is the SCHEDULED hop: intent creation schedules it
 *   atomically at the batching window close (60 s from durable
 *   acceptance), each sweep schedules the next hop at the earliest future
 *   due time, and the quiet-hours/assignment deferrals reschedule it. The
 *   `nowMs` argument is the TARGET instant (not the wall clock), so the
 *   decisions are deterministic under scheduler jitter; a late hop simply
 *   evaluates with its target instant, which can only widen the collapsed
 *   batch, never replay it.
 * - `evaluateDueIntentsTick` is the CRON safety net: under total scheduler
 *   loss the scheduled kicks disappear, so a once-a-minute sweep keeps the
 *   due intents converging (exactly the outbox drain's cron upgrade). It
 *   evaluates with the wall clock.
 *
 * Both run the SAME transaction (`performEvaluateDueIntents`), which is
 * idempotent: terminal intents are filtered out by the pending-state index
 * range, so duplicate scheduling and worker retries collapse.
 */

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { performEvaluateDueIntents } from "./operations";

/** The scheduled evaluator hop at one target instant. */
export const evaluateDueIntents = internalMutation({
  args: { nowMs: v.float64() },
  handler: async (ctx, args) => performEvaluateDueIntents(ctx, { nowMs: args.nowMs }),
});

/** The cron safety-net sweep with the wall clock. */
export const evaluateDueIntentsTick = internalMutation({
  args: {},
  handler: async (ctx) => performEvaluateDueIntents(ctx, { nowMs: Date.now() }),
});
