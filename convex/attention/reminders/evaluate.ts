/**
 * The reminder evaluator's scheduled/cron entries (F4): the durable
 * execution side of `attention.evaluateDueReminders` (the F2
 * `delivery/evaluate.ts` pattern - native Convex scheduler plus a cron
 * safety net).
 *
 * - `evaluateDueReminders` is the SCHEDULED hop: the recompute schedules it
 *   atomically at each slot's due instant, each sweep schedules the next
 *   hop at the earliest future due time, and the snooze/quiet-hours
 *   deferrals reschedule it. The `nowMs` argument is the TARGET instant
 *   (not the wall clock), so decisions are deterministic under scheduler
 *   jitter; a late hop evaluates with its target instant, so a clamped
 *   prompt delivers late but exactly once.
 * - `evaluateDueRemindersTick` is the CRON safety net: under total
 *   scheduler loss the scheduled kicks disappear, so a sparse once-every-
 *   five-minutes sweep keeps due reminders converging (the outbox drain's
 *   cadence; the sweep is idempotent through the pending-state index
 *   range). It evaluates with the wall clock.
 *
 * Both run the SAME transaction (`performEvaluateDueReminders`).
 */

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { performEvaluateDueReminders } from "./operations";

/** The scheduled evaluator hop at one target instant. */
export const evaluateDueReminders = internalMutation({
  args: { nowMs: v.float64() },
  handler: async (ctx, args) => performEvaluateDueReminders(ctx, { nowMs: args.nowMs }),
});

/** The cron safety-net sweep with the wall clock. */
export const evaluateDueRemindersTick = internalMutation({
  args: {},
  handler: async (ctx) => performEvaluateDueReminders(ctx, { nowMs: Date.now() }),
});
