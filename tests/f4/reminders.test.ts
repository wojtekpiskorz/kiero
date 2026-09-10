/**
 * F4 transactional tests: the schedule recompute and the due-time
 * evaluator over the REAL transaction functions with the in-memory db
 * (tests/f4/fixtures.ts on top of tests/d2/harness.ts, the F2 precedent).
 *
 * Covers, against a deterministic clock:
 * - the recompute: slot creation per recipient, the missed-slot policy,
 *   invalidation (date and coordinator changes kill obsolete intents and
 *   clear prior snoozes; unassignment fans out; completion and
 *   cancellation remove future reminders);
 * - the epoch identity (PR #102 review round 1, finding 3): a title-only
 *   edit never re-prompts, while term, recipient and reopen movements
 *   mint fresh slots (including the restore-after-removal case);
 * - the evaluator: the daily overdue roll, ONE collapsed current summary
 *   per recipient, the personal controls (mute, quiet hours, snooze);
 * - the RACE re-checks: assignee or state changed while a reminder sat
 *   due. The FINAL recipient and state decide before F2 delivery.
 *
 * The pure model lives in tests/f4/model.test.ts; the durable edges and
 * the checked dispatch surface live in tests/f4/edges.test.ts.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { parseTableId } from "@kiero/contracts";
import { valueOf } from "../d2/harness";
import { performSnoozeTaskReminders } from "../../convex/attention/reminders/operations";
import {
  T0,
  contextOf,
  datedTask,
  db,
  evaluate,
  pendingOfKind,
  recompute,
  remindersOf,
  revisionOf,
  scheduled,
  seedFirm,
  seedProject,
  seedTask,
  summariesOf,
  tx,
  useFakeContext,
  reviseDeadline,
} from "./fixtures";

beforeEach(() => {
  useFakeContext();
});

// ---------------------------------------------------------------------------
// The recompute: slots, recipients, invalidation, snooze clearing.
// ---------------------------------------------------------------------------

describe("the schedule recompute", () => {
  it("creates the timed and daily slots for the coordinator only", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    await datedTask(
      firm,
      projectId,
      { iso: "2026-09-11T15:00:00.000+02:00[Europe/Warsaw]" },
      firm.membershipA,
      T0,
    );
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
    expect(remindersOf(firm.bossB)).toHaveLength(0);
    expect(remindersOf(firm.bossC)).toHaveLength(0);
    expect(pendingOfKind(firm.bossA, "pre_due").dueAtMs).toBe(
      Date.parse("2026-09-11T12:00:00.000Z"),
    );
  });

  it("an unassigned task targets every boss", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    await datedTask(firm, projectId, { day: "2026-09-11" }, undefined, T0);
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
    expect(remindersOf(firm.bossB, "pending")).toHaveLength(2);
    expect(remindersOf(firm.bossC, "pending")).toHaveLength(2);
  });

  it("an undated task stays only in Co teraz: no intents", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await seedTask(firm, projectId, { coordinatorMembershipId: firm.membershipA });
    const result = await recompute(task.taskId, T0);
    expect(result.status).toBe("no_deadline");
    expect(result.createdIntentIds).toHaveLength(0);
    expect(db().rows("notificationIntents")).toHaveLength(0);
  });

  it("collapses a replayed recompute onto the same semantic intents", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    const second = await recompute(task.taskId, T0 + 1_000);
    expect(second.createdIntentIds).toHaveLength(0);
    expect(remindersOf(firm.bossA)).toHaveLength(2);
  });

  it("schedules the evaluator hop at the earliest slot due", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    const hop = scheduled().find(
      (entry) =>
        typeof entry.args === "object" &&
        entry.args !== null &&
        "nowMs" in entry.args &&
        (entry.args as { nowMs: number }).nowMs === Date.parse("2026-09-11T05:00:00.000Z"),
    );
    expect(hop).toBeDefined();
  });

  it("a coordinator change kills the old intents and clears snoozes; the former coordinator receives no later reminder", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    // A snoozes, then the task is reassigned to B.
    await performSnoozeTaskReminders(
      tx(),
      contextOf(firm, firm.bossA),
      { taskId: parseTableId("tasks", task.taskId)!, untilMs: Date.parse("2026-09-30T10:00:00.000Z") },
      T0,
    );
    await db().patch(task.taskId, {
      coordinatorMembershipId: firm.membershipB,
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      updatedAtMs: T0 + 1,
    });
    const result = await recompute(task.taskId, T0 + 2_000);
    expect(result.snoozesCleared).toBe(1);
    expect(db().rows("reminderSnoozes")).toHaveLength(0);
    // A's slots died with the superseded schedule; B's are ensured.
    expect(remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "schedule_changed",
      "schedule_changed",
    ]);
    expect(remindersOf(firm.bossB, "pending")).toHaveLength(2);
    // And at due time A receives nothing at all.
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(0);
    expect(summariesOf(firm.bossB)).toHaveLength(1);
  });

  it("unassignment fans out to every boss and suppresses the former coordinator's slots", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await db().patch(task.taskId, {
      coordinatorMembershipId: undefined,
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      updatedAtMs: T0 + 1,
    });
    await recompute(task.taskId, T0 + 2_000);
    expect(remindersOf(firm.bossA, "suppressed")).toHaveLength(2);
    expect(remindersOf(firm.bossB, "pending")).toHaveLength(2);
    expect(remindersOf(firm.bossC, "pending")).toHaveLength(2);
  });

  it("a date change clears snoozes and re-derives the slots at the new term", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await performSnoozeTaskReminders(
      tx(),
      contextOf(firm, firm.bossA),
      { taskId: parseTableId("tasks", task.taskId)!, untilMs: Date.parse("2026-09-30T10:00:00.000Z") },
      T0,
    );
    await reviseDeadline(firm, task.deadlineFindingId!, { day: "2026-09-14" });
    await db().patch(task.taskId, {
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      updatedAtMs: T0 + 1,
    });
    const result = await recompute(task.taskId, T0 + 2_000);
    expect(result.snoozesCleared).toBe(1);
    // The superseded schedule's slots died; the fresh ones carry the new term.
    expect(result.suppressedIntentIds).toHaveLength(2);
    const pending = remindersOf(firm.bossA, "pending");
    expect(pending).toHaveLength(2);
    expect(pendingOfKind(firm.bossA, "pre_due").dueAtMs).toBe(
      Date.parse("2026-09-14T05:00:00.000Z"),
    );
    // The snooze is gone: the new slot delivers at its own due time.
    await evaluate(Date.parse("2026-09-14T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
  });

  it("completion removes future reminders and clears the snooze", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await performSnoozeTaskReminders(
      tx(),
      contextOf(firm, firm.bossA),
      { taskId: parseTableId("tasks", task.taskId)!, untilMs: Date.parse("2026-09-30T10:00:00.000Z") },
      T0,
    );
    await db().patch(task.taskId, {
      state: "done",
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      stateChangedAtMs: T0 + 1,
    });
    const result = await recompute(task.taskId, T0 + 2_000);
    expect(result.status).toBe("task_closed");
    expect(result.snoozesCleared).toBe(1);
    expect(remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "task_closed",
      "task_closed",
    ]);
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(0);
  });

  it("cancellation removes future reminders the same way", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await db().patch(task.taskId, {
      state: "cancelled",
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      stateChangedAtMs: T0 + 1,
    });
    const result = await recompute(task.taskId, T0 + 2_000);
    expect(result.status).toBe("task_closed");
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(0);
  });

  it("a contested term suspends the reminders (term_unusable)", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    const finding = (await db().get(task.deadlineFindingId!))!;
    const revision = (await db().get(finding.currentRevisionId as string))!;
    await db().patch(revision._id, { knowledgeState: { _tag: "conflicted" } });
    await db().patch(finding._id, { knowledgeState: { _tag: "conflicted" } });
    const result = await recompute(task.taskId, T0 + 1_000);
    expect(result.status).toBe("term_unusable");
    expect(remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "term_unusable",
      "term_unusable",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The epoch identity (PR #102 review round 1, finding 3): fresh slots ONLY
// on term, recipient or reopen movement; never on a bare revision bump.
// ---------------------------------------------------------------------------

describe("the schedule epoch identity", () => {
  it("a title-only edit after today's delivery prompts nothing and keeps the daily chain", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    // Three days overdue: today's clamped summary delivers at 10:00.
    const nowMs = Date.parse("2026-09-10T10:00:00.000Z");
    const task = await datedTask(firm, projectId, { day: "2026-09-07" }, firm.membershipA, nowMs);
    await evaluate(nowMs);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    // The title-only edit: the work transaction bumps the revision and
    // publishes work.taskChanged, but the term and recipient stand still.
    await db().patch(task.taskId, {
      title: "Przygotować wycenę (poprawiony tytuł)",
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      updatedAtMs: nowMs + 1,
    });
    const editAt = Date.parse("2026-09-10T12:00:00.000Z");
    const result = await recompute(task.taskId, editAt);
    expect(result.createdIntentIds).toHaveLength(0);
    expect(result.suppressedIntentIds).toHaveLength(0);
    await evaluate(editAt);
    // Exactly one clamped overdue prompt per day: the edit added none.
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    // The daily roll survived the edit: tomorrow's summary still fires.
    const pending = remindersOf(firm.bossA, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.dueAtMs).toBe(Date.parse("2026-09-11T05:00:00.000Z"));
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(2);
  });

  it("a timed task edited inside the last hour gets no second pre-due prompt", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(
      firm,
      projectId,
      { iso: "2026-09-11T15:00:00.000+02:00[Europe/Warsaw]" },
      firm.membershipA,
      T0,
    );
    const tMinus1h = Date.parse("2026-09-11T12:00:00.000Z");
    await evaluate(tMinus1h);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    await db().patch(task.taskId, {
      title: "Inny tytuł",
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      updatedAtMs: tMinus1h + 1,
    });
    const editAt = Date.parse("2026-09-11T12:30:00.000Z");
    await recompute(task.taskId, editAt);
    await evaluate(editAt);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    expect(remindersOf(firm.bossA, "pending").map((row) => row.dedupKey)).toEqual([
      expect.stringContaining(":overdue:"),
    ]);
  });

  it("a due-date change mints fresh slots even when the task revision alone did not move", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    // The live-proof S4 shape: the finding is revised WITHOUT touching the
    // task row (a date correction through the memory lane), so the task
    // revision stays 1 while the term anchor moves.
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    await reviseDeadline(firm, task.deadlineFindingId!, { day: "2026-09-14" });
    const result = await recompute(task.taskId, T0 + 2_000);
    expect(result.suppressedIntentIds).toHaveLength(1); // the old pending overdue slot
    // BOTH fresh slots of the new term exist (the revision-keyed identity
    // used to collapse the new pre_due onto the old delivered row).
    const pending = remindersOf(firm.bossA, "pending");
    expect(pending).toHaveLength(2);
    expect(pendingOfKind(firm.bossA, "pre_due").dueAtMs).toBe(
      Date.parse("2026-09-14T05:00:00.000Z"),
    );
    await evaluate(Date.parse("2026-09-14T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(2);
  });

  it("a recipient removed and later restored receives fresh reminders", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    // Removed: unassignment fans out to every boss.
    await db().patch(task.taskId, {
      coordinatorMembershipId: undefined,
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      updatedAtMs: T0 + 1,
    });
    await recompute(task.taskId, T0 + 2_000);
    // Restored: the reassignment back to A mints A's fresh slots (the
    // restore-after-removal case the schedule-epoch identity keeps).
    await db().patch(task.taskId, {
      coordinatorMembershipId: firm.membershipA,
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      updatedAtMs: T0 + 3,
    });
    await recompute(task.taskId, T0 + 4_000);
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
    expect(remindersOf(firm.bossB, "suppressed")).toHaveLength(2); // the fan-out epoch died
    expect(remindersOf(firm.bossC, "suppressed")).toHaveLength(2);
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    expect(summariesOf(firm.bossB)).toHaveLength(0);
  });

  it("reopening a completed task mints fresh reminders", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await db().patch(task.taskId, {
      state: "done",
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      stateChangedAtMs: T0 + 1,
    });
    await recompute(task.taskId, T0 + 2_000);
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(0);
    // Reopen: the return to a scheduled state moves the epoch, so the
    // terminal rows of the closed era cannot swallow the fresh slots.
    await db().patch(task.taskId, {
      state: "todo",
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      stateChangedAtMs: T0 + 3,
    });
    await recompute(task.taskId, T0 + 4_000);
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The evaluator: delivery, daily roll, personal controls.
// ---------------------------------------------------------------------------

describe("the due-time evaluator", () => {
  it("delivers the date-only 07:00 reminder once, then the daily overdue summary the next day", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    await datedTask(firm, projectId, { day: "2026-09-10" }, firm.membershipA, T0);
    // Before the term: only the 07:00 reminder is due on the 10th.
    await evaluate(Date.parse("2026-09-10T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    expect(summariesOf(firm.bossA)[0]!.taskIds).toHaveLength(1);
    expect(remindersOf(firm.bossA, "delivered")).toHaveLength(1);
    // Late on the 10th: nothing new fires (the term has not elapsed).
    await evaluate(Date.parse("2026-09-10T22:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    // The FIRST overdue summary: the 11th at 07:00, one current summary.
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(2);
    const overdue = summariesOf(firm.bossA)[1]!;
    expect(overdue.bucket).toBe("task_reminders");
    // The daily roll re-armed the 12th's slot.
    const rolled = remindersOf(firm.bossA, "pending");
    expect(rolled).toHaveLength(1);
    expect(rolled[0]!.dueAtMs).toBe(Date.parse("2026-09-12T05:00:00.000Z"));
    await evaluate(Date.parse("2026-09-12T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(3);
  });

  it("delivers the timed reminder one hour before the deadline", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    await datedTask(
      firm,
      projectId,
      { iso: "2026-09-11T15:00:00.000+02:00[Europe/Warsaw]" },
      firm.membershipA,
      T0,
    );
    await evaluate(Date.parse("2026-09-11T11:59:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(0);
    await evaluate(Date.parse("2026-09-11T12:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
  });

  it("collapses several due reminders into ONE current summary per recipient", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const t1 = await datedTask(firm, projectId, { day: "2026-09-10" }, firm.membershipA, T0);
    await datedTask(firm, projectId, { day: "2026-09-10" }, firm.membershipA, T0);
    await evaluate(Date.parse("2026-09-10T05:00:00.000Z"));
    const summaries = summariesOf(firm.bossA);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.taskIds).toHaveLength(2);
    expect(new Set(summaries[0]!.taskIds)).toEqual(new Set([t1.taskId, ...summaries[0]!.taskIds]));
    expect(remindersOf(firm.bossA, "delivered")).toHaveLength(2);
    // The terminal events publish once per intent.
    const events = db()
      .rows("outboxEvents")
      .filter((row) => row.eventName === "attention.intentDelivered");
    expect(events).toHaveLength(2);
  });

  it("a task created three days overdue gets ONE prompt now, not a replay per missed day", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const nowMs = Date.parse("2026-09-10T10:00:00.000Z");
    await datedTask(firm, projectId, { day: "2026-09-07" }, firm.membershipA, nowMs);
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(1);
    await evaluate(nowMs);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    // The roll chains from TODAY, not from the missed days.
    expect(remindersOf(firm.bossA, "pending")[0]!.dueAtMs).toBe(
      Date.parse("2026-09-11T05:00:00.000Z"),
    );
  });

  it("a task created after its 07:00 reminder on the due day prompts once immediately", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const nowMs = Date.parse("2026-09-10T10:00:00.000Z"); // 12:00 Warsaw on the due day
    await datedTask(firm, projectId, { day: "2026-09-10" }, firm.membershipA, nowMs);
    const preDue = pendingOfKind(firm.bossA, "pre_due");
    expect(preDue.dueAtMs).toBe(nowMs);
    // The clamped slot schedules its hop at delay 0 (the target instant is
    // the recompute instant), so the prompt needs no cron sweep to fire.
    const hop = scheduled().find(
      (entry) =>
        typeof entry.args === "object" &&
        entry.args !== null &&
        "nowMs" in entry.args &&
        (entry.args as { nowMs: number }).nowMs === nowMs,
    );
    expect(hop).toBeDefined();
    await evaluate(nowMs);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    // The overdue summary keeps its own next-day slot.
    expect(pendingOfKind(firm.bossA, "overdue").dueAtMs).toBe(
      Date.parse("2026-09-11T05:00:00.000Z"),
    );
  });

  it("the conversation mute never touches task reminders; the reminder mute suppresses", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    await db().insert("notificationPreferences", {
      companyId: firm.companyId,
      userId: firm.bossA,
      mutedProjectIds: [projectId], // conversation mute of the task's project
      companyEntriesMuted: false,
      taskRemindersMuted: false,
      hidePreviewContent: false,
      updatedAtMs: T0,
    });
    await db().insert("notificationPreferences", {
      companyId: firm.companyId,
      userId: firm.bossB,
      mutedProjectIds: [],
      companyEntriesMuted: false,
      taskRemindersMuted: true, // the SEPARATE reminder mute
      hidePreviewContent: false,
      updatedAtMs: T0,
    });
    const unassigned = await datedTask(firm, projectId, { day: "2026-09-10" }, undefined, T0);
    void unassigned;
    await evaluate(Date.parse("2026-09-10T05:00:00.000Z"));
    // A muted the conversation, not the reminders: still delivered.
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    // B muted the reminders: suppressed with the seam's reserved reason.
    expect(remindersOf(firm.bossB, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "muted_task_reminders",
    ]);
    // C untouched.
    expect(summariesOf(firm.bossC)).toHaveLength(1);
  });

  it("reading the source changes nothing: a read state row never suppresses a reminder", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const sourceId = await db().insert("sources", {
      companyId: firm.companyId,
      authorUserId: firm.bossB,
      authorText: "Termin na 11 września",
      sentAtMs: T0,
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: T0,
      lifecycle: "active",
    });
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await db().insert("readStates", {
      companyId: firm.companyId,
      userId: firm.bossA,
      sourceId,
      read: true,
      readAtMs: T0 + 1,
    });
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    void task;
  });

  it("quiet hours defer the 07:00 reminder to the personal window's end", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    // A personally quiet 06:00-08:00 Warsaw: the 07:00 reminder defers to 08:00.
    await db().insert("notificationPreferences", {
      companyId: firm.companyId,
      userId: firm.bossA,
      mutedProjectIds: [],
      companyEntriesMuted: false,
      taskRemindersMuted: false,
      hidePreviewContent: false,
      quietHoursStartMinute: 6 * 60,
      quietHoursEndMinute: 8 * 60,
      updatedAtMs: T0,
    });
    await datedTask(firm, projectId, { day: "2026-09-10" }, firm.membershipA, T0);
    await evaluate(Date.parse("2026-09-10T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(0);
    expect(pendingOfKind(firm.bossA, "pre_due").dueAtMs).toBe(
      Date.parse("2026-09-10T06:00:00.000Z"),
    );
    // The overdue slot keeps its own next-day slot (not due yet).
    expect(pendingOfKind(firm.bossA, "overdue").dueAtMs).toBe(
      Date.parse("2026-09-11T05:00:00.000Z"),
    );
    await evaluate(Date.parse("2026-09-10T06:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
  });

  it("the personal snooze defers only THIS person's reminders until the chosen instant", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-10" }, undefined, T0);
    const until = Date.parse("2026-09-10T15:00:00.000Z");
    const result = valueOf(
      await performSnoozeTaskReminders(
        tx(),
        contextOf(firm, firm.bossA),
        { taskId: parseTableId("tasks", task.taskId)!, untilMs: until },
        T0,
      ),
    );
    expect(result).toEqual({ taskId: task.taskId });
    // The snooze event published under its certified name.
    const events = db()
      .rows("outboxEvents")
      .filter((row) => row.eventName === "attention.reminderSnoozed");
    expect(events).toHaveLength(1);
    await evaluate(Date.parse("2026-09-10T05:00:00.000Z"));
    // A deferred to the chosen instant; B and C delivered on time.
    expect(summariesOf(firm.bossA)).toHaveLength(0);
    expect(
      remindersOf(firm.bossA, "pending").map((row) => row.dueAtMs as number).sort((a, b) => a - b),
    ).toEqual([until, Date.parse("2026-09-11T05:00:00.000Z")]);
    expect(summariesOf(firm.bossB)).toHaveLength(1);
    expect(summariesOf(firm.bossC)).toHaveLength(1);
    // Expiry: at the chosen instant A's reminder delivers.
    await evaluate(until);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
  });

  it("rejects a snooze in the past or beyond the horizon", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-10" }, firm.membershipA, T0);
    const past = await performSnoozeTaskReminders(
      tx(),
      contextOf(firm, firm.bossA),
      { taskId: parseTableId("tasks", task.taskId)!, untilMs: T0 - 1 },
      T0,
    );
    expect(past._tag).toBe("error");
    const far = await performSnoozeTaskReminders(
      tx(),
      contextOf(firm, firm.bossA),
      { taskId: parseTableId("tasks", task.taskId)!, untilMs: T0 + 31 * 24 * 60 * 60 * 1_000 },
      T0,
    );
    expect(far._tag).toBe("error");
    expect(db().rows("reminderSnoozes")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Race re-checks: the FINAL recipient and state decide at due time.
// ---------------------------------------------------------------------------

describe("the race re-checks before F2 delivery", () => {
  it("an assignee change while the reminder sat due stops the former coordinator", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    // The work transaction committed (reassignment) but the recompute job
    // has not run yet: the due-time re-check is the backstop.
    await db().patch(task.taskId, { coordinatorMembershipId: firm.membershipB });
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    // Only the pre_due slot was due; the FINAL coordinator decides: A dies.
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason),
    ).toEqual(["recipient_changed"]);
    expect(pendingOfKind(firm.bossA, "overdue")).toBeDefined();
    expect(summariesOf(firm.bossA)).toHaveLength(0);
    // After the recompute, B owns the fresh slots and receives them, while
    // A's still-pending slot dies with the superseded schedule.
    await db().patch(task.taskId, { revisionCounter: (await revisionOf(task.taskId)) + 1 });
    await recompute(task.taskId, T0 + 5_000);
    await evaluate(Date.parse("2026-09-11T05:00:00.001Z"));
    expect(summariesOf(firm.bossB)).toHaveLength(1);
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason).sort(),
    ).toEqual(["recipient_changed", "schedule_changed"]);
  });

  it("a revision bump while the reminder sat due does not kill the slot: only term or recipient movement does", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    // A title-only edit committed (revision 5) but the recompute job has
    // not run yet: the slot's schedule is still the live one, so the due
    // reminder DELIVERS (PR #102 review round 1: the revision alone used
    // to kill it as schedule_changed).
    await db().patch(task.taskId, { revisionCounter: 5, updatedAtMs: T0 + 1 });
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(remindersOf(firm.bossA, "suppressed")).toHaveLength(0);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    // The roll keeps chaining at the unchanged schedule epoch.
    expect(pendingOfKind(firm.bossA, "overdue").dueAtMs).toBe(
      Date.parse("2026-09-12T05:00:00.000Z"),
    );
    void task;
  });

  it("a due-date change while the reminder sat due kills the slot at its own due", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    // The finding moved (the memory lane committed) but the recompute job
    // has not run yet: the re-check re-derives the term and kills the slot.
    await reviseDeadline(firm, task.deadlineFindingId!, { day: "2026-09-14" });
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason),
    ).toEqual(["schedule_changed"]);
    expect(summariesOf(firm.bossA)).toHaveLength(0);
  });

  it("completion between scheduling and due time removes the reminder", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await db().patch(task.taskId, { state: "done", stateChangedAtMs: T0 + 1 });
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason),
    ).toEqual(["task_closed"]);
    expect(pendingOfKind(firm.bossA, "overdue")).toBeDefined();
    expect(summariesOf(firm.bossA)).toHaveLength(0);
    // No future reminder either: the daily slot dies at its own due.
    await evaluate(Date.parse("2026-09-12T05:00:00.000Z"));
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason),
    ).toEqual(["task_closed", "task_closed"]);
    void task;
  });

  it("a revoked member of an unassigned task dies at due time; others still receive", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    await datedTask(firm, projectId, { day: "2026-09-10" }, undefined, T0);
    await db().patch(firm.membershipC, { state: "revoked", revokedAtMs: T0 + 1 });
    await evaluate(Date.parse("2026-09-10T05:00:00.000Z"));
    expect(remindersOf(firm.bossC, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "membership_revoked",
    ]);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    expect(summariesOf(firm.bossB)).toHaveLength(1);
  });
});
