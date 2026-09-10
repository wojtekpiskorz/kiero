/**
 * Task-reminder transactions (F4): the durable schedule recompute, the
 * due-time evaluator and the personal snooze (issue 44's bounded
 * solution).
 *
 * Everything runs inside ONE Convex mutation transaction per call:
 *
 * - `performRecomputeTaskReminders` - the durable reaction to every task
 *   change (and to a revision of a bound deadline finding): it derives the
 *   task's CURRENT semantic reminder slots (timed: one hour before;
 *   date-only: 07:00 company-local; overdue: the daily 07:00 summary),
 *   ensures one `task_reminder` intent per recipient (the effective
 *   coordinator, or every active boss when unassigned), kills the pending
 *   intents of the superseded schedule, and CLEARS prior snoozes when the
 *   due date or the coordinator changed (or the task closed).
 * - `performEvaluateDueReminders` - the evaluator: at due time it
 *   re-reads the task (state, coordinator, deadline anchor, schedule
 *   epoch) so the FINAL recipient and state decide, re-arms the next
 *   daily overdue slot, applies the personal snooze, then hands the batch
 *   to F1's `decidePersonalDelivery` seam (mute suppresses; quiet hours
 *   defer) and delivers ONE collapsed current summary per recipient.
 *   Reading a source changes nothing here: task reminders never consult
 *   read state.
 * - `performSnoozeTaskReminders` - the personal snooze command: one row
 *   per user and task until a chosen instant; the shared deadline and
 *   other bosses' reminders are never touched.
 */

import { Schema } from "effect";
import {
  attentionOperations,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  forbiddenError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import {
  deriveEffectiveCoordinator,
  isClosedTaskState,
  temporalValueOf,
  type KnowledgeStateWire,
  type TemporalValueWire,
} from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { publishEvent } from "../../platform/publish";
import { decidePersonalDelivery, isValidTimezone } from "../preferences/evaluation";
import {
  activeMemberIds,
  deferIntent,
  ensureIntentByDedup,
  scheduleEvaluationAt,
  scheduleNextPendingHop,
  settleIntent,
  settingsOf,
  sweepDueIntents,
} from "../intents_shared";
import {
  MAX_SNOOZE_AHEAD_MS,
  deriveReminderSchedule,
  nextOverdueSlotAfter,
  reminderDedupKey,
  type ReminderBatchSummary,
  type ReminderPayload,
  type ReminderSlot,
  type TaskReminderSuppressedReason,
} from "./model";

/** The reminder evaluator's own scheduled hop (shared chain helper target). */
const reminderHop = internal.attention.reminders.evaluate.evaluateDueReminders;

/** Schedules this lane's evaluator hop at (or slightly after) `atMs`. */
function scheduleReminderHop(tx: MutationCtx, atMs: number): Promise<void> {
  return scheduleEvaluationAt(tx, atMs, reminderHop, { nowMs: atMs });
}

/** The contract entries this lane implements (decode/typed authority). */
export const evaluateDueRemindersOperation =
  attentionOperations["attention.evaluateDueReminders"];
export type EvaluateDueRemindersInput = Schema.Schema.Type<
  typeof evaluateDueRemindersOperation.input
>;
export const snoozeTaskRemindersOperation =
  attentionOperations["attention.snoozeTaskReminders"];
export type SnoozeTaskRemindersInput = Schema.Schema.Type<
  typeof snoozeTaskRemindersOperation.input
>;

/** The bound deadline finding's current knowledge state and temporal value. */
interface DeadlineBinding {
  readonly knowledgeState: KnowledgeStateWire;
  readonly temporal: TemporalValueWire | null;
}

/** The term view the schedule derivation consumes (C4's binding shape). */
type DeadlineView = Pick<DeadlineBinding, "knowledgeState" | "temporal">;

/** Reads one deadline binding's current value (the C4 work-read precedent). */
async function readDeadlineBinding(
  tx: MutationCtx,
  findingId: Id<"findings">,
): Promise<DeadlineBinding | null> {
  const finding = await tx.db.get(findingId);
  if (finding === null || finding.currentRevisionId === undefined) {
    return null;
  }
  const revision = await tx.db.get(finding.currentRevisionId);
  if (revision === null) {
    return null;
  }
  return { knowledgeState: revision.knowledgeState, temporal: temporalValueOf(revision.value) };
}

/** One pending task-reminder intent row. */
type ReminderIntent = Doc<"notificationIntents">;

/** The task facts every reminder decision is derived from. */
interface TaskScheduleRead {
  readonly task: Doc<"tasks">;
  readonly companyTimezone: string;
  readonly companyId: Id<"companies">;
  /** The effective coordinator's USER (null when unassigned or revoked). */
  readonly coordinatorUserId: Id<"users"> | null;
  readonly deadline: DeadlineView | null;
}

/** Reads one task with its company timezone, effective coordinator and term. */
async function readTaskSchedule(
  tx: MutationCtx,
  taskId: Id<"tasks">,
): Promise<
  { readonly ok: true; readonly read: TaskScheduleRead } | { readonly ok: false; readonly code: string }
> {
  const task = await tx.db.get(taskId);
  if (task === null) {
    return { ok: false, code: "task_not_found" };
  }
  const company = await tx.db.get(task.companyId);
  if (company === null || !isValidTimezone(company.timezone)) {
    return { ok: false, code: "company_unresolvable" };
  }
  let coordinatorUserId: Id<"users"> | null = null;
  if (task.coordinatorMembershipId !== undefined) {
    const membership = await tx.db.get(task.coordinatorMembershipId);
    if (membership !== null) {
      const effective = deriveEffectiveCoordinator({
        membershipId: membership._id,
        state: membership.state,
      });
      coordinatorUserId = effective === null ? null : membership.userId;
    }
  }
  const deadline =
    task.deadlineFindingId === undefined
      ? null
      : ((await readDeadlineBinding(tx, task.deadlineFindingId)) ?? {
          // A dangling binding reads as unknown, exactly like the work read.
          knowledgeState: { _tag: "unknown", reason: "finding_revision_missing" } as const,
          temporal: null,
        });
  return {
    ok: true,
    read: {
      task,
      companyTimezone: company.timezone,
      companyId: task.companyId,
      coordinatorUserId,
      deadline,
    },
  };
}

/** Inserts one reminder intent unless its semantic identity already exists. */
async function ensureReminderIntent(
  tx: MutationCtx,
  intent: {
    companyId: Id<"companies">;
    recipientUserId: Id<"users">;
    dedupKey: string;
    dueAtMs: number;
    payload: ReminderPayload;
  },
): Promise<Id<"notificationIntents"> | null> {
  const taskId = tx.db.normalizeId("tasks", intent.payload.taskId);
  return ensureIntentByDedup(tx, {
    companyId: intent.companyId,
    recipientUserId: intent.recipientUserId,
    semanticKind: "task_reminder",
    ...(taskId !== null ? { taskId } : {}),
    dedupKey: intent.dedupKey,
    dueAtMs: intent.dueAtMs,
    payloadJson: JSON.stringify(intent.payload),
  });
}

/** The suppression reason a superseded schedule's intents die with. */
function staleReasonOf(
  scheduleKind: "task_closed" | "no_deadline" | "term_unusable" | "scheduled",
): TaskReminderSuppressedReason {
  switch (scheduleKind) {
    case "task_closed":
      return "task_closed";
    case "no_deadline":
      return "no_deadline";
    case "term_unusable":
      return "term_unusable";
    case "scheduled":
      return "schedule_changed";
  }
}

/** The schedule derivation over one read at `nowMs` (thin, for readability). */
function scheduleOf(read: TaskScheduleRead, nowMs: number) {
  return deriveReminderSchedule({
    state: read.task.state,
    deadline: read.deadline,
    nowMs,
    companyTimezone: read.companyTimezone,
  });
}

// ---------------------------------------------------------------------------
// The schedule recompute (the event reaction).
// ---------------------------------------------------------------------------

/**
 * Recomputes one task's reminder schedule at `nowMs`: derives the CURRENT
 * semantic slots, ensures the recipients' intents, kills the superseded
 * schedule's pending intents and clears snoozes when the due date or the
 * coordinator changed (or the task closed). Idempotent at one schedule
 * epoch: recomputes that change nothing collapse onto the same rows, so a
 * task edit that leaves the term and the recipients alone (a title-only
 * edit, which still bumps the task revision) never re-prompts.
 */
export async function performRecomputeTaskReminders(
  tx: MutationCtx,
  taskId: Id<"tasks">,
  nowMs: number,
): Promise<ResultEnvelope> {
  const read = await readTaskSchedule(tx, taskId);
  if (!read.ok) {
    return errorResult(forbiddenError(read.code));
  }
  const { task, companyId, coordinatorUserId } = read.read;
  const schedule = scheduleOf(read.read, nowMs);

  const anchor = await tx.db
    .query("reminderSchedules")
    .withIndex("by_task", (q) => q.eq("taskId", task._id))
    .first();

  // --- snooze invalidation: the schedule those snoozes deferred is gone ----
  const currentCoordinator: Id<"memberships"> | null =
    coordinatorUserId === null ? null : (task.coordinatorMembershipId ?? null);
  const currentTermAnchor = schedule.kind === "scheduled" ? schedule.termAnchor : null;
  const scheduleInvalidated =
    anchor !== null &&
    ((anchor.coordinatorMembershipId ?? null) !== currentCoordinator ||
      (anchor.deadlineFindingId ?? null) !== (task.deadlineFindingId ?? null) ||
      (anchor.termAnchor ?? null) !== currentTermAnchor ||
      (schedule.kind === "task_closed" && anchor.status === "scheduled"));
  let snoozesCleared = 0;
  if (scheduleInvalidated) {
    const stale = await tx.db
      .query("reminderSnoozes")
      .withIndex("by_task", (q) => q.eq("taskId", task._id))
      .collect();
    for (const row of stale) {
      await tx.db.delete(row._id);
      snoozesCleared += 1;
    }
  }

  // --- the schedule epoch: fresh slot identity ONLY on real movement ------
  // The dedup identity binds this counter, never the task revision: a
  // title-only edit bumps the revision but leaves the term and recipients
  // alone, so its recompute collapses onto the same rows and never
  // re-prompts (PR #102 review round 1, finding 3). The epoch moves
  // exactly when the schedule's meaning does: the term anchor, the bound
  // finding, the effective coordinator, or a return to a scheduled state
  // after closure, suspension or a missing term (which is all the
  // restore-after-removal case needs to mint fresh reminders).
  const epochMoves =
    anchor === null ||
    (anchor.coordinatorMembershipId ?? null) !== currentCoordinator ||
    (anchor.deadlineFindingId ?? null) !== (task.deadlineFindingId ?? null) ||
    (anchor.termAnchor ?? null) !== currentTermAnchor ||
    (anchor.status !== "scheduled" && schedule.kind === "scheduled");
  const scheduleEpoch =
    anchor === null
      ? 0
      : epochMoves
        ? (anchor.scheduleEpoch ?? 0) + 1
        : (anchor.scheduleEpoch ?? 0);

  // --- the desired slot set per recipient ------------------------------------
  const recipients: Id<"users">[] =
    coordinatorUserId !== null ? [coordinatorUserId] : await activeMemberIds(tx, companyId);
  const slots: ReminderSlot[] = schedule.kind === "scheduled" ? [...schedule.slots] : [];
  const desiredKeys = new Set<string>();
  const createdIntentIds: Id<"notificationIntents">[] = [];
  if (schedule.kind === "scheduled") {
    for (const userId of recipients) {
      for (const slot of slots) {
        const key = reminderDedupKey(
          task._id,
          userId,
          slot.reminderKind,
          scheduleEpoch,
          slot.slotDay,
        );
        desiredKeys.add(key);
        const id = await ensureReminderIntent(tx, {
          companyId,
          recipientUserId: userId,
          dedupKey: key,
          dueAtMs: slot.dueAtMs,
          payload: {
            kind: "task_reminder",
            reminderKind: slot.reminderKind,
            taskId: task._id,
            recipientUserId: userId,
            coordinatorMembershipId: currentCoordinator,
            deadlineFindingId: task.deadlineFindingId ?? null,
            termAnchor: schedule.termAnchor,
            scheduleEpoch,
            slotDay: slot.slotDay,
            idealAtMs: slot.idealAtMs,
          },
        });
        if (id !== null) {
          createdIntentIds.push(id);
        }
      }
    }
  }

  // --- kill the superseded schedule's pending intents (point lookups) -------
  // A key survives when it is still desired OR its row belongs to the
  // CURRENT epoch: the daily roll's chained slots are not in the desired
  // set (the recompute derives the first overdue day, the roll owns the
  // later ones), but they are the same schedule and must live on through
  // edits that changed nothing. Everything else pending belongs to the
  // superseded schedule and dies.
  const suppressedIntentIds: Id<"notificationIntents">[] = [];
  const keptKeys: string[] = [];
  const reason = staleReasonOf(schedule.kind);
  for (const key of anchor?.pendingKeys ?? []) {
    if (desiredKeys.has(key)) {
      continue;
    }
    const stale = await tx.db
      .query("notificationIntents")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", key))
      .first();
    if (stale === null) {
      continue;
    }
    const stalePayload = JSON.parse(stale.payloadJson) as ReminderPayload;
    if (stale.state === "pending" && stalePayload.scheduleEpoch === scheduleEpoch) {
      keptKeys.push(key);
      continue;
    }
    if (stale.state === "pending") {
      await settleIntent(tx, stale, { state: "suppressed", reason }, nowMs);
      suppressedIntentIds.push(stale._id);
    }
  }

  // --- the anchor upsert ------------------------------------------------------
  // The identity fields are written EXPLICITLY on the patch, undefined
  // included: Convex patches delete undefined keys, so an unassigned
  // coordinator, an unbound finding or a suspended term clears the stored
  // value instead of leaving a stale one behind (a stale value would make
  // a remove-and-restore round trip compare equal and skip the fresh
  // epoch). The insert spells the optional keys conditionally instead,
  // because inserts reject explicit undefined values.
  if (anchor === null) {
    await tx.db.insert("reminderSchedules", {
      taskId: task._id,
      companyId,
      ...(currentCoordinator !== null ? { coordinatorMembershipId: currentCoordinator } : {}),
      ...(task.deadlineFindingId !== undefined ? { deadlineFindingId: task.deadlineFindingId } : {}),
      ...(currentTermAnchor !== null ? { termAnchor: currentTermAnchor } : {}),
      scheduleEpoch,
      status: schedule.kind,
      pendingKeys: [...desiredKeys, ...keptKeys],
      revision: task.revisionCounter,
      updatedAtMs: nowMs,
    });
  } else {
    await tx.db.patch(anchor._id, {
      coordinatorMembershipId: currentCoordinator ?? undefined,
      deadlineFindingId: task.deadlineFindingId,
      termAnchor: currentTermAnchor ?? undefined,
      scheduleEpoch,
      status: schedule.kind,
      pendingKeys: [...desiredKeys, ...keptKeys],
      revision: task.revisionCounter,
      updatedAtMs: nowMs,
    });
  }

  // --- the durable chain: one hop at the earliest due ------------------------
  // A CLAMPED slot (due == now) schedules the hop at delay 0, so the
  // one-prompt-now policy needs no cron sweep to converge. The clamp only
  // ever reaches a FRESH row (the epoch identity collapses unchanged
  // schedules onto their existing rows), which is exactly the accepted
  // "newly created or assigned task" scope of the missed-slot policy.
  let earliestDue: number | null = null;
  for (const slot of slots) {
    if (earliestDue === null || slot.dueAtMs < earliestDue) {
      earliestDue = slot.dueAtMs;
    }
  }
  if (earliestDue !== null) {
    await scheduleReminderHop(tx, Math.max(earliestDue, nowMs));
  }

  return okResult({
    taskId: task._id,
    status: schedule.kind,
    recipientCount: recipients.length,
    createdIntentIds,
    suppressedIntentIds,
    snoozesCleared,
  });
}

// ---------------------------------------------------------------------------
// The due-time evaluator.
// ---------------------------------------------------------------------------

/** The live task facts one due intent is re-checked against. */
type TaskRecheck =
  | { readonly outcome: "die"; readonly reason: TaskReminderSuppressedReason }
  | { readonly outcome: "pass"; readonly read: TaskScheduleRead };

/**
 * THE due-time re-check: the FINAL recipient, state, term and schedule
 * epoch decide, never the payload's snapshot (issue 44's race acceptance:
 * the assignee or state changed while the reminder sat due).
 */
async function recheckTaskAtDue(
  tx: MutationCtx,
  payload: ReminderPayload,
  recipientUserId: Id<"users">,
): Promise<TaskRecheck> {
  const taskId = tx.db.normalizeId("tasks", payload.taskId);
  if (taskId === null) {
    return { outcome: "die", reason: "task_unresolved" };
  }
  const read = await readTaskSchedule(tx, taskId);
  if (!read.ok) {
    return { outcome: "die", reason: "task_unresolved" };
  }
  const { task, coordinatorUserId } = read.read;
  if (isClosedTaskState(task.state)) {
    // Completion or cancellation removes future reminders; reading the
    // source alone never did anything here (read state is never read).
    return { outcome: "die", reason: "task_closed" };
  }
  // The slot's schedule epoch must still be the anchor's CURRENT one: a
  // term, recipient or reopen movement re-minted the schedule and this
  // slot belongs to the superseded one. The task revision alone no longer
  // kills a slot (a title edit suppresses nothing; the termAnchor and
  // coordinator comparisons below catch real movement even before the
  // recompute job runs).
  const anchor = await tx.db
    .query("reminderSchedules")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .first();
  if (anchor === null || (anchor.scheduleEpoch ?? 0) !== payload.scheduleEpoch) {
    return { outcome: "die", reason: "schedule_changed" };
  }
  // nowMs 0 only separates usable terms from unusable ones here (the
  // pending/overdue split is irrelevant: the comparison is the anchor).
  const schedule = scheduleOf(read.read, 0);
  if (schedule.kind !== "scheduled") {
    return { outcome: "die", reason: staleReasonOf(schedule.kind) };
  }
  if (schedule.termAnchor !== payload.termAnchor) {
    // The bound term's value moved (the finding was revised); the stale
    // slot dies and the recompute's fresh slots take over.
    return { outcome: "die", reason: "schedule_changed" };
  }
  const currentCoordinator: Id<"memberships"> | null =
    coordinatorUserId === null ? null : (task.coordinatorMembershipId ?? null);
  if (currentCoordinator !== payload.coordinatorMembershipId) {
    // The former coordinator receives no later reminder.
    return { outcome: "die", reason: "recipient_changed" };
  }
  if (currentCoordinator === null) {
    // Unassigned tasks address every boss: a revoked member's reminder dies.
    const membership = await tx.db
      .query("memberships")
      .withIndex("by_company_user", (q) =>
        q.eq("companyId", read.read.companyId).eq("userId", recipientUserId),
      )
      .filter((q) => q.eq(q.field("state"), "active"))
      .first();
    if (membership === null) {
      return { outcome: "die", reason: "membership_revoked" };
    }
  }
  return { outcome: "pass", read: read.read };
}

/** Re-arms the next daily overdue slot after a due one (one per local day). */
async function rearmNextOverdueSlot(
  tx: MutationCtx,
  args: {
    readonly companyId: Id<"companies">;
    readonly recipientUserId: Id<"users">;
    readonly payload: ReminderPayload;
    readonly companyTimezone: string;
    readonly nowMs: number;
  },
): Promise<void> {
  const { payload } = args;
  if (payload.reminderKind !== "overdue" || payload.slotDay === null) {
    return;
  }
  const next = nextOverdueSlotAfter(payload.slotDay, args.companyTimezone);
  const dueAtMs = next.atMs > args.nowMs ? next.atMs : args.nowMs;
  // The roll keeps the slot's schedule epoch (the due-time re-check already
  // matched it against the anchor's live one): the chained slot is the SAME
  // schedule, so a later recompute that changes nothing collapses onto it
  // instead of killing the daily chain.
  const key = reminderDedupKey(
    payload.taskId,
    args.recipientUserId,
    "overdue",
    payload.scheduleEpoch,
    next.day,
  );
  await ensureReminderIntent(tx, {
    companyId: args.companyId,
    recipientUserId: args.recipientUserId,
    dedupKey: key,
    dueAtMs,
    payload: {
      ...payload,
      reminderKind: "overdue",
      slotDay: next.day,
      idealAtMs: next.atMs,
    },
  });
  // Bookkeeping: the anchor's kill list tracks the rolled slot.
  const taskId = tx.db.normalizeId("tasks", payload.taskId);
  if (taskId === null) {
    return;
  }
  const anchor = await tx.db
    .query("reminderSchedules")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .first();
  if (anchor !== null && !anchor.pendingKeys.includes(key)) {
    await tx.db.patch(anchor._id, {
      pendingKeys: [...anchor.pendingKeys, key],
      updatedAtMs: args.nowMs,
    });
  }
}

/** One bucket of due reminder intents sharing a recipient and company. */
interface ReminderBucket {
  readonly companyId: Id<"companies">;
  readonly recipientUserId: Id<"users">;
  readonly intents: ReminderIntent[];
}

/**
 * The evaluator: re-checks and delivers every due task-reminder intent at
 * `nowMs` (the caller-owned target instant - deterministic under scheduler
 * jitter, the F2 evaluator's contract).
 */
export async function performEvaluateDueReminders(
  tx: MutationCtx,
  input: EvaluateDueRemindersInput,
): Promise<ResultEnvelope> {
  const nowMs = input.nowMs;
  const due = await sweepDueIntents(tx, nowMs);

  const buckets = new Map<string, ReminderBucket>();
  const touched: Id<"notificationIntents">[] = [];

  for (const intent of due) {
    // Only this lane's kind: F2's intents stay for F2's evaluator.
    if (intent.semanticKind !== "task_reminder") {
      continue;
    }
    touched.push(intent._id);
    const payload = JSON.parse(intent.payloadJson) as ReminderPayload;

    const recheck = await recheckTaskAtDue(tx, payload, intent.recipientUserId);
    if (recheck.outcome === "die") {
      await settleIntent(tx, intent, { state: "suppressed", reason: recheck.reason }, nowMs);
      continue;
    }
    const read = recheck.read;

    // The slot expired; tomorrow's daily summary exists regardless of the
    // personal decision on TODAY's (an unmute takes effect next day).
    await rearmNextOverdueSlot(tx, {
      companyId: read.companyId,
      recipientUserId: intent.recipientUserId,
      payload,
      companyTimezone: read.companyTimezone,
      nowMs,
    });

    // The personal snooze: reminders about this task defer for THIS person
    // until the chosen instant (other bosses' reminders are untouched).
    const taskId = tx.db.normalizeId("tasks", payload.taskId);
    const snooze =
      taskId === null
        ? null
        : await tx.db
            .query("reminderSnoozes")
            .withIndex("by_user_task", (q) =>
              q.eq("userId", intent.recipientUserId).eq("taskId", taskId),
            )
            .first();
    if (snooze !== null && snooze.untilMs > nowMs) {
      await deferIntent(tx, intent, snooze.untilMs, nowMs);
      continue;
    }

    const mapKey = `${intent.companyId}|${intent.recipientUserId}`;
    const bucket = buckets.get(mapKey);
    if (bucket === undefined) {
      buckets.set(mapKey, {
        companyId: intent.companyId,
        recipientUserId: intent.recipientUserId,
        intents: [intent],
      });
    } else {
      bucket.intents.push(intent);
    }
  }

  for (const bucket of buckets.values()) {
    // Every bucket member passed the due-time re-check, which resolved this
    // company and validated its timezone in THIS transaction, so no
    // failed-arm company read exists here (PR #102 review round 1: the
    // old `company_unresolvable` branch was unreachable and, unlike F2's
    // failed arm, published no event; it is gone).
    const company = (await tx.db.get(bucket.companyId))!;

    // The personal delivery decision (F1's seam, the shared gate): the
    // task-reminder mute suppresses; quiet hours defer. Read state is
    // deliberately NOT consulted (reading never completes a task).
    const decision = decidePersonalDelivery({
      kind: "task_reminder",
      scope: "company",
      projectIds: [],
      // The seam reads isAuthor/read only for source entries; a boss MAY
      // be reminded of their own task (no author exclusion exists here).
      isAuthor: false,
      read: false,
      nowMs,
      companyTimezone: company.timezone,
      settings: await settingsOf(tx, bucket.companyId, bucket.recipientUserId),
    });

    if (decision.decision === "suppressed") {
      for (const intent of bucket.intents) {
        await settleIntent(tx, intent, { state: "suppressed", reason: decision.reason }, nowMs);
      }
      continue;
    }
    if (decision.decision === "deferred") {
      for (const intent of bucket.intents) {
        await deferIntent(tx, intent, decision.untilMs, nowMs);
      }
      continue;
    }

    // Eligible: ONE collapsed current summary per recipient and company.
    const deliveryJson = JSON.stringify({
      semanticKind: "task_reminder",
      bucket: "task_reminders",
      taskIds: bucket.intents.flatMap((intent) =>
        intent.taskId !== undefined ? [intent.taskId] : [],
      ),
      reminderKinds: bucket.intents.map((intent) => {
        const payload = JSON.parse(intent.payloadJson) as ReminderPayload;
        return payload.reminderKind;
      }),
      deliveredAtMs: nowMs,
    } satisfies ReminderBatchSummary);
    for (const intent of bucket.intents) {
      await settleIntent(tx, intent, { state: "delivered", deliveryJson }, nowMs);
    }
  }

  const evaluatedIntentIds = [...new Set(touched)];

  // The durable chain: one scheduled hop at the earliest future due time.
  await scheduleNextPendingHop(tx, nowMs, (atMs) => scheduleReminderHop(tx, atMs));

  return okResult(
    Schema.decodeUnknownSync(evaluateDueRemindersOperation.result)({
      evaluatedIntentIds,
    }),
  );
}

// ---------------------------------------------------------------------------
// The personal snooze command.
// ---------------------------------------------------------------------------

/**
 * Snoozes THIS person's reminders about one task until a chosen instant.
 * The task's shared due date and other bosses' reminders are never
 * touched; a later due-date or coordinator change clears the snooze.
 */
export async function performSnoozeTaskReminders(
  tx: MutationCtx,
  context: RequestContext,
  input: SnoozeTaskRemindersInput,
  nowMs: number = Date.now(),
): Promise<ResultEnvelope> {
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  const userId = tx.db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return errorResult(forbiddenError("actor_scope_unresolved"));
  }
  const taskId = tx.db.normalizeId("tasks", input.taskId);
  if (taskId === null) {
    return errorResult(notFoundError("tasks", "task_not_found"));
  }
  const task = await tx.db.get(taskId);
  if (task === null || task.companyId !== companyId) {
    return errorResult(notFoundError("tasks", "task_not_found"));
  }
  if (input.untilMs <= nowMs) {
    return errorResult(validationError("snooze_until_not_in_future"));
  }
  if (input.untilMs - nowMs > MAX_SNOOZE_AHEAD_MS) {
    return errorResult(validationError("snooze_until_too_far"));
  }

  const existing = await tx.db
    .query("reminderSnoozes")
    .withIndex("by_user_task", (q) => q.eq("userId", userId).eq("taskId", taskId))
    .first();
  if (existing === null) {
    await tx.db.insert("reminderSnoozes", {
      companyId,
      userId,
      taskId,
      untilMs: input.untilMs,
      updatedAtMs: nowMs,
    });
  } else {
    await tx.db.patch(existing._id, { untilMs: input.untilMs, updatedAtMs: nowMs });
  }

  // The snooze applies to reminders ALREADY scheduled too: this person's
  // pending intents for this task defer to the chosen instant.
  const pending = await tx.db
    .query("notificationIntents")
    .withIndex("by_recipient_state", (q) =>
      q.eq("recipientUserId", userId).eq("state", "pending"),
    )
    .filter((q) =>
      q.eq(q.field("taskId"), taskId) &&
      q.eq(q.field("semanticKind"), "task_reminder"),
    )
    .collect();
  // The semanticKind predicate keeps the defer inside THIS lane's intents:
  // taskId is an optional column on the shared table, and a future lane
  // writing it would otherwise have its intents silently deferred by a
  // task snooze (independent review, round 2).
  for (const intent of pending) {
    if (intent.dueAtMs < input.untilMs) {
      await tx.db.patch(intent._id, { dueAtMs: input.untilMs });
    }
  }
  await scheduleReminderHop(tx, input.untilMs);

  await publishEvent(tx, {
    companyId,
    eventName: "attention.reminderSnoozed",
    payload: { userId, taskId },
  });
  return okResult(Schema.decodeUnknownSync(snoozeTaskRemindersOperation.result)({ taskId }));
}
