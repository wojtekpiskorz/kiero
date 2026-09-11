/**
 * Task-reminder queries (F4): the task/reminder projections H2's "Co
 * teraz" surface consumes (issue 44: "emit ... task/reminder projections
 * for H2") and the diagnostic reads the probes assert on.
 *
 * `myTaskReminders` is the personal read: the caller's own task-reminder
 * intents (their lifecycle state, due time, suppressed reason and the
 * collapsed delivery summary) together with their OWN active snoozes. No
 * other person's row is ever visible, and nothing here writes boss state.
 * The schedule anchors are the company-side diagnostic read
 * (`taskReminderOverviewFor`, the verified service-bridge path the
 * guarded probes use).
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError } from "@kiero/runtime";
import { internalQuery, query, type QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { resolveBridgeQueryScope, resolveOwnQueryScope } from "../context";

/** One reminder intent as the projection reports it. */
function reminderIntentView(intent: Doc<"notificationIntents">) {
  return {
    intentId: intent._id,
    companyId: intent.companyId,
    recipientUserId: intent.recipientUserId,
    taskId: intent.taskId ?? null,
    semanticKind: intent.semanticKind,
    dedupKey: intent.dedupKey,
    state: intent.state,
    dueAtMs: intent.dueAtMs,
    suppressedReason: intent.suppressedReason ?? null,
    delivery: intent.deliveryJson === undefined ? null : (JSON.parse(intent.deliveryJson) as unknown),
    deliveredAtMs: intent.deliveredAtMs ?? null,
    createdAtMs: intent.createdAtMs,
  };
}

/** One schedule anchor as the diagnostic read reports it. */
function scheduleView(anchor: Doc<"reminderSchedules">) {
  return {
    taskId: anchor.taskId,
    companyId: anchor.companyId,
    coordinatorMembershipId: anchor.coordinatorMembershipId ?? null,
    deadlineFindingId: anchor.deadlineFindingId ?? null,
    termAnchor: anchor.termAnchor ?? null,
    scheduleEpoch: anchor.scheduleEpoch ?? 0,
    status: anchor.status,
    pendingKeys: [...anchor.pendingKeys],
    revision: anchor.revision,
    updatedAtMs: anchor.updatedAtMs,
  };
}

/**
 * One lifecycle state's bounded slice of the caller's task-reminder
 * intents. Each state queries the `by_recipient_state` index with `state`
 * BOUND (the index's second field exists for exactly this): nothing prunes
 * `notificationIntents`, and the index orders states lexicographically, so
 * a recipient-prefix-only window fills with delivered history (`delivered`
 * sorts before `pending`) and the pending queue would go silently empty
 * (PR #102 review round 1, finding 4). Per-state windows keep the pending
 * slice complete no matter how much history accumulates.
 */
async function remindersInState(
  ctx: QueryCtx,
  userId: Id<"users">,
  state: "pending" | "delivered" | "suppressed",
) {
  const rows = await ctx.db
    .query("notificationIntents")
    .withIndex("by_recipient_state", (q) => q.eq("recipientUserId", userId).eq("state", state))
    .take(200);
  return rows.filter((row) => row.semanticKind === "task_reminder").map(reminderIntentView);
}

/**
 * The wire row shapes of `myTaskReminders`' ok value (H2 append, flagged
 * additive export: the personal projection imports the server's own types
 * instead of hand-declaring a twin).
 */
export interface ReminderIntentWireRow {
  readonly intentId: string;
  readonly companyId: string;
  readonly recipientUserId: string;
  readonly taskId: string | null;
  readonly semanticKind: string;
  readonly dedupKey: string;
  readonly state: string;
  readonly dueAtMs: number;
  readonly suppressedReason: string | null;
  readonly delivery: unknown;
  readonly deliveredAtMs: number | null;
  readonly createdAtMs: number;
}

export interface ReminderSnoozeWireRow {
  readonly taskId: string;
  readonly untilMs: number;
  readonly updatedAtMs: number;
}

export interface MyTaskRemindersWire {
  readonly intents: readonly ReminderIntentWireRow[];
  readonly snoozes: readonly ReminderSnoozeWireRow[];
}

/**
 * The public client path: the caller's OWN reminder intents and active
 * snoozes (the H2 personal projection; read-only).
 */
export const myTaskReminders = query({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const scope = await resolveOwnQueryScope(ctx);
    if (scope === null) {
      return errorResult(unauthenticatedError());
    }
    const [pending, delivered, suppressed] = await Promise.all([
      remindersInState(ctx, scope.userId, "pending"),
      remindersInState(ctx, scope.userId, "delivered"),
      remindersInState(ctx, scope.userId, "suppressed"),
    ]);
    const snoozes = await ctx.db
      .query("reminderSnoozes")
      .withIndex("by_user_task", (q) => q.eq("userId", scope.userId))
      .take(200);
    return okResult({
      intents: [...pending, ...delivered, ...suppressed],
      snoozes: snoozes.map((row) => ({
        taskId: row.taskId,
        untilMs: row.untilMs,
        updatedAtMs: row.updatedAtMs,
      })),
    });
  },
});

/** The internal bridge-path diagnostic read: the actor's company's reminder state. */
export const taskReminderOverviewFor = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const scope = await resolveBridgeQueryScope(ctx, args.serviceSessionId);
    if (scope === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const schedules = await ctx.db
      .query("reminderSchedules")
      .withIndex("by_company", (q) => q.eq("companyId", scope.companyId))
      .take(200);
    const snoozes = await companySnoozes(ctx, scope.companyId);
    const intents = (
      await ctx.db
        .query("notificationIntents")
        .withIndex("by_due", (q) => q.eq("state", "pending"))
        .take(200)
    ).filter((row) => row.semanticKind === "task_reminder" && row.companyId === scope.companyId);
    const delivered = (
      await ctx.db
        .query("notificationIntents")
        .withIndex("by_due", (q) => q.eq("state", "delivered"))
        .take(200)
    ).filter((row) => row.semanticKind === "task_reminder" && row.companyId === scope.companyId);
    const suppressed = (
      await ctx.db
        .query("notificationIntents")
        .withIndex("by_due", (q) => q.eq("state", "suppressed"))
        .take(200)
    ).filter((row) => row.semanticKind === "task_reminder" && row.companyId === scope.companyId);
    return okResult({
      schedules: schedules.map(scheduleView),
      snoozes,
      pending: intents.map(reminderIntentView),
      delivered: delivered.map(reminderIntentView),
      suppressed: suppressed.map(reminderIntentView),
    });
  },
});

/** One company's snooze rows as the diagnostic read reports them. */
async function companySnoozes(ctx: QueryCtx, companyId: Id<"companies">) {
  const rows = await ctx.db
    .query("reminderSnoozes")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .take(200);
  return rows.map((row) => ({
    taskId: row.taskId,
    userId: row.userId,
    untilMs: row.untilMs,
    updatedAtMs: row.updatedAtMs,
  }));
}
