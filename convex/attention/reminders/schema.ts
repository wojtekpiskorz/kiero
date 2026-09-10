/**
 * Task-reminder scheduling tables (F4, issue 44).
 *
 * Owning implementer: F4 (convex/attention/reminders/**). The durable
 * reminder INTENTS themselves live in F2's `notificationIntents` under the
 * certified `task_reminder` kind (F2's evaluator explicitly leaves that
 * kind to this lane); the two tables here are this lane's own state:
 *
 * - `reminderSchedules`: ONE row per task, the schedule anchor the
 *   recompute transaction maintains. It records the coordinator and term
 *   the CURRENT slots were derived from (so a due-date or coordinator
 *   change is DETECTABLE and clears prior snoozes), the schedule status,
 *   and the dedup keys of the intents it last ensured - the exact key set
 *   the NEXT recompute may have to kill when the schedule moves (the
 *   notification-intent table has by-design no task index; point lookups
 *   by dedup key keep the invalidation bounded).
 * - `reminderSnoozes`: "Odroczenie przypomnień" - ONE row per user and
 *   task holding the chosen instant until which THIS person's reminders
 *   about THIS task are suspended. It never touches the task's deadline
 *   or another boss's reminders (CONTEXT.md).
 *
 * Tables: reminderSchedules, reminderSnoozes.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

/** The schedule status vocabulary (mirrors the pure model's outcomes). */
const scheduleStatus = v.union(
  v.literal("scheduled"),
  v.literal("task_closed"),
  v.literal("no_deadline"),
  v.literal("term_unusable"),
);

export const remindersTables = {
  /**
   * The per-task reminder schedule anchor (one row per task, maintained by
   * the recompute transaction). `pendingKeys` is bookkeeping, not truth:
   * the evaluator re-checks every intent against the live task rows at
   * due time, so a lost anchor row can never resurrect a stale reminder.
   */
  reminderSchedules: defineTable({
    taskId: shared.taskId,
    companyId: shared.companyId,
    /** The effective coordinator the current slots target; absent = all bosses. */
    coordinatorMembershipId: v.optional(shared.membershipId),
    /** The deadline binding the current slots were derived from; absent = none. */
    deadlineFindingId: v.optional(shared.findingId),
    /** Stable anchor of the bound term (local day or instant) at derivation. */
    termAnchor: v.optional(v.string()),
    status: scheduleStatus,
    /** The dedup keys this schedule last ensured (the next recompute's kill list). */
    pendingKeys: v.array(v.string()),
    /** The task revision the schedule was derived at. */
    revision: shared.counter,
    updatedAtMs: shared.tsMs,
  })
    .index("by_task", ["taskId"])
    .index("by_company", ["companyId", "updatedAtMs"]),

  /**
   * One personal snooze of one task's reminders ("Odroczenie przypomnień"):
   * the person's reminders about this task defer until `untilMs`. Cleared
   * (all users) when the task's due date or coordinator changes, and when
   * the task closes - a snooze never outlives the schedule it deferred.
   */
  reminderSnoozes: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    taskId: shared.taskId,
    /** The chosen instant the suspension lasts until. */
    untilMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
  })
    .index("by_user_task", ["userId", "taskId"])
    .index("by_task", ["taskId"])
    .index("by_company", ["companyId", "updatedAtMs"]),
} as const;
