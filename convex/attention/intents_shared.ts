/**
 * Shared notification-intent lifecycle plumbing for the attention lanes
 * (the convex/attention/probe_shared.ts precedent for lane-crossing
 * helpers).
 *
 * PR #102 review round 1, finding 2: the reminder lane (F4) had copied
 * `settleIntent`, `deferIntent`, `settingsOf`, `activeMemberIds`,
 * `scheduleEvaluationAt`, the ensure-by-dedup insert and the
 * sweep/hop skeleton verbatim from F2's `delivery/operations.ts`, leaving
 * about a hundred intent-lifecycle lines maintained twice inside one
 * module (with F3's push transport as the third reader to come). They
 * live once here now. F4 consumes this module; F2's delivery lane
 * migrates its own copies onto it in its own lane, so this file edits no
 * F2-owned path.
 *
 * Everything here is the MECHANICAL half of intent evaluation: rows,
 * dedup, terminal decisions, the scheduled evaluator chain. The semantic
 * half (which intents die, which buckets form, what a delivery summary
 * carries) stays in each lane's own evaluator.
 */

import type { SchedulableFunctionReference } from "convex/server";
import type { MutationCtx } from "../_generated/server";
import type { Id, Doc } from "../_generated/dataModel";
import { publishEvent } from "../platform/publish";
import { preferenceWriteOf } from "./preferences/operations";

/** One notification-intent row (any lane's kind). */
export type NotificationIntent = Doc<"notificationIntents">;

/** How many due intents one evaluator sweep processes (bounded batch). */
export const INTENT_SWEEP_LIMIT = 128;

/** The active members of one company, enumerated through the composite prefix. */
export async function activeMemberIds(
  tx: MutationCtx,
  companyId: Id<"companies">,
): Promise<Id<"users">[]> {
  const rows = await tx.db
    .query("memberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId))
    .filter((q) => q.eq(q.field("state"), "active"))
    .collect();
  return rows.map((row) => row.userId);
}

/** Reads one recipient's current personal settings (defaults when no row). */
export async function settingsOf(
  tx: MutationCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
) {
  const row = await tx.db
    .query("notificationPreferences")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .first();
  return preferenceWriteOf(row ?? null);
}

/**
 * Schedules one evaluator hop at (or slightly after) the given instant.
 * The lane passes its own scheduled mutation and args, so the hop stays
 * within the caller's lane.
 */
export async function scheduleEvaluationAt(
  tx: MutationCtx,
  atMs: number,
  fn: SchedulableFunctionReference,
  args: Record<string, unknown>,
): Promise<void> {
  const delay = Math.max(0, atMs - Date.now());
  await tx.scheduler.runAfter(delay, fn, args);
}

/** One terminal decision about a due intent. */
export type IntentSettlement =
  | { readonly state: "suppressed"; readonly reason: string }
  | { readonly state: "delivered"; readonly deliveryJson: string }
  | { readonly state: "failed"; readonly reason: string };

/**
 * Records one terminal intent decision and publishes the canonical
 * `attention.intentDelivered` event (the outcome field carries all three
 * terminal states; F2's failed arm and the suppress/deliver arms of both
 * lanes share this one writer, so the event shape can never drift
 * between evaluators).
 */
export async function settleIntent(
  tx: MutationCtx,
  intent: NotificationIntent,
  decision: IntentSettlement,
  nowMs: number,
): Promise<void> {
  await tx.db.patch(intent._id, {
    state: decision.state,
    lastEvaluatedAtMs: nowMs,
    ...(decision.state === "delivered"
      ? { deliveryJson: decision.deliveryJson, deliveredAtMs: nowMs }
      : { suppressedReason: decision.reason }),
  });
  await publishEvent(tx, {
    companyId: intent.companyId,
    eventName: "attention.intentDelivered",
    payload: {
      notificationIntentId: intent._id,
      outcome: decision.state === "delivered" ? "delivered" : decision.state,
    },
  });
}

/** Defers one intent to a later instant (snooze / quiet hours / retry). */
export async function deferIntent(
  tx: MutationCtx,
  intent: NotificationIntent,
  dueAtMs: number,
  nowMs: number,
): Promise<void> {
  await tx.db.patch(intent._id, { dueAtMs, lastEvaluatedAtMs: nowMs });
}

/**
 * Inserts one notification intent unless its semantic identity already
 * exists. Duplicate suppression by dedup key: a replayed event, a retried
 * worker or a duplicate registration collapses onto the row, and an
 * existing row keeps its own due time (a snoozed or quiet-hours-deferred
 * row is never re-clamped; first write wins).
 */
export async function ensureIntentByDedup(
  tx: MutationCtx,
  intent: {
    companyId: Id<"companies">;
    recipientUserId: Id<"users">;
    semanticKind: NotificationIntent["semanticKind"];
    taskId?: Id<"tasks"> | null;
    sourceId?: Id<"sources"> | null;
    clarificationId?: Id<"clarifications"> | null;
    dedupKey: string;
    dueAtMs: number;
    payloadJson: string;
  },
): Promise<Id<"notificationIntents"> | null> {
  const existing = await tx.db
    .query("notificationIntents")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", intent.dedupKey))
    .first();
  if (existing !== null) {
    return null;
  }
  return tx.db.insert("notificationIntents", {
    companyId: intent.companyId,
    recipientUserId: intent.recipientUserId,
    semanticKind: intent.semanticKind,
    ...(intent.taskId !== undefined && intent.taskId !== null ? { taskId: intent.taskId } : {}),
    ...(intent.sourceId !== undefined && intent.sourceId !== null
      ? { sourceId: intent.sourceId }
      : {}),
    ...(intent.clarificationId !== undefined && intent.clarificationId !== null
      ? { clarificationId: intent.clarificationId }
      : {}),
    dedupKey: intent.dedupKey,
    state: "pending",
    dueAtMs: intent.dueAtMs,
    payloadJson: intent.payloadJson,
    createdAtMs: Date.now(),
  });
}

/**
 * The due sweep both evaluator lanes open with: every pending intent
 * whose due time has passed, bounded. The caller filters to its own
 * semantic kind; the other lane's intents stay for its own evaluator.
 */
export async function sweepDueIntents(
  tx: MutationCtx,
  nowMs: number,
  limit: number = INTENT_SWEEP_LIMIT,
): Promise<NotificationIntent[]> {
  return tx.db
    .query("notificationIntents")
    .withIndex("by_due", (q) => q.eq("state", "pending").lte("dueAtMs", nowMs))
    .take(limit);
}

/**
 * The durable chain's tail: one scheduled hop at the earliest future due
 * time (bounded collect + reduce over the by_due index's pending range).
 * The lane's `schedule` callback targets its own evaluator function.
 */
export async function scheduleNextPendingHop(
  tx: MutationCtx,
  nowMs: number,
  schedule: (atMs: number) => Promise<void>,
  limit: number = INTENT_SWEEP_LIMIT,
): Promise<void> {
  const remaining = await tx.db
    .query("notificationIntents")
    .withIndex("by_due", (q) => q.eq("state", "pending"))
    .take(limit);
  if (remaining.length > 0) {
    const nextPending = remaining.reduce((first, candidate) =>
      candidate.dueAtMs < first.dueAtMs ? candidate : first,
    );
    if (nextPending.dueAtMs > nowMs) {
      await schedule(nextPending.dueAtMs);
    }
  }
}
