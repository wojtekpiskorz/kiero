/**
 * F4 focused tests: the task-reminder scheduling model, recompute and
 * due-time evaluator (issue 44's focused verification), over the REAL
 * transaction functions with the in-memory db (tests/d2/harness.ts - the
 * F2 precedent).
 *
 * Covers, against a deterministic clock:
 * - the slot arithmetic: timed (one hour before), date-only (07:00 in the
 *   company timezone), undated (no slot), overdue (the daily 07:00 summary,
 *   first one the day after the term's local day) and the DST nights;
 * - the missed-slot policy: a task created after its reminder time gets
 *   ONE prompt as soon as quiet hours permit, never a replay;
 * - invalidation: date and coordinator changes kill obsolete intents and
 *   clear prior snoozes (the former coordinator receives no later
 *   reminder); unassignment targets every boss; completion and
 *   cancellation remove future reminders while reading a source alone
 *   changes nothing;
 * - the personal controls stay independent: conversation mutes never
 *   touch reminders, the reminder mute suppresses, quiet hours defer,
 *   and one person's snooze never touches another boss's reminder;
 * - the RACE re-checks: assignee or state changed while a reminder sat
 *   due - the FINAL recipient and state decide before F2 delivery;
 * - the durable edges: the outbox projections and the executor, plus the
 *   C4 integration (a boss-created own task still gets its reminder).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ActorContext, parseTableId } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import {
  REMINDER_MINUTE_OF_DAY,
  TIMED_LEAD_MS,
  deriveReminderSchedule,
  firstOverdueSlot,
  instantOfLocalMinute,
  nextOverdueSlotAfter,
  reminderDedupKey,
} from "../../convex/attention/reminders/model";
import {
  performEvaluateDueReminders,
  performRecomputeTaskReminders,
  performSnoozeTaskReminders,
} from "../../convex/attention/reminders/operations";
import { taskRemindersExecutor } from "../../convex/attention/reminders/executor";
import { performChangeTask } from "../../convex/work/operations";
import { projectEventToJobInputs } from "../../convex/platform/outbox";
import { dispatchCommand, membershipPolicy } from "@kiero/runtime";
import { okResult } from "@kiero/contracts";
import { remindersHandlers } from "../../convex/attention/reminders/dispatch";
import { asTx, fakeCtx, valueOf, type FakeCtx } from "../d2/harness";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TABLES = [
  "companies",
  "users",
  "memberships",
  "projects",
  "findings",
  "findingRevisions",
  "tasks",
  "notificationIntents",
  "notificationPreferences",
  "readStates",
  "reminderSchedules",
  "reminderSnoozes",
  "outboxEvents",
  "durableJobs",
  "workRevisions",
  "sources",
] as const;

/** Warsaw anchors: September 2026 is CEST (UTC+2). */
const T0 = Date.parse("2026-09-09T10:00:00.000Z"); // 12:00 Warsaw: outside quiet hours
const WARSAW = "Europe/Warsaw";

let ctx: FakeCtx;
const tx = () => asTx(ctx);

interface Firm {
  readonly companyId: string;
  readonly bossA: string; // the (re)assigned coordinator
  readonly bossB: string; // the reassignment target / second boss
  readonly bossC: string; // the third boss (unassigned fan-out)
  readonly membershipA: string;
  readonly membershipB: string;
  readonly membershipC: string;
}

async function seedFirm(): Promise<Firm> {
  const companyId = await ctx.db.insert("companies", {
    name: "F4 test firm",
    timezone: WARSAW,
    defaultCurrency: "PLN",
    createdAtMs: T0,
  });
  const bosses = await Promise.all(
    ["f4-a", "f4-b", "f4-c"].map(async (label) => {
      const userId = await ctx.db.insert("users", {
        email: `${label}@kiero.invalid`,
        displayName: label,
        createdAtMs: T0,
      });
      const membershipId = await ctx.db.insert("memberships", {
        companyId,
        userId,
        role: "member",
        state: "active",
        createdAtMs: T0,
      });
      return { userId, membershipId };
    }),
  );
  return {
    companyId,
    bossA: bosses[0]!.userId,
    bossB: bosses[1]!.userId,
    bossC: bosses[2]!.userId,
    membershipA: bosses[0]!.membershipId,
    membershipB: bosses[1]!.membershipId,
    membershipC: bosses[2]!.membershipId,
  };
}

async function seedProject(firm: Firm, name = "Banan"): Promise<string> {
  return ctx.db.insert("projects", {
    companyId: firm.companyId,
    displayName: name,
    stage: "inquiry",
    createdAtMs: T0,
  });
}

/** One KNOWN temporal deadline finding (date-only day or zoned date/time). */
async function seedDeadline(
  firm: Firm,
  projectId: string,
  term: { readonly day: string } | { readonly iso: string },
): Promise<string> {
  const shape =
    "day" in term
      ? { _tag: "day" as const, day: term.day }
      : { _tag: "date_time" as const, value: term.iso };
  const findingId = await ctx.db.insert("findings", {
    companyId: firm.companyId,
    scopeKind: "project",
    scopeProjectId: projectId,
    semanticKey: `f4-term-${shape._tag}-${Date.now()}-${Math.random()}`,
    knowledgeState: { _tag: "known" },
    revisionCounter: 1,
    updatedAtMs: T0,
  });
  const revisionId = await ctx.db.insert("findingRevisions", {
    findingId,
    revision: 1,
    value: {
      _tag: "temporal",
      temporal: { shape, originalExpression: "f4 test term", role: "agreed" },
    },
    knowledgeState: { _tag: "known" },
    origin: "publication",
    recordedByUserId: firm.bossA,
    recordedAtMs: T0,
  });
  await ctx.db.patch(findingId, { currentRevisionId: revisionId });
  return findingId;
}

/** Revises the finding's CURRENT term in place (a date correction). */
async function reviseDeadline(
  firm: Firm,
  findingId: string,
  term: { readonly day: string } | { readonly iso: string },
): Promise<void> {
  const finding = (await ctx.db.get(findingId))!;
  const shape =
    "day" in term
      ? { _tag: "day" as const, day: term.day }
      : { _tag: "date_time" as const, value: term.iso };
  const revisionId = await ctx.db.insert("findingRevisions", {
    findingId,
    revision: (finding.revisionCounter as number) + 1,
    value: {
      _tag: "temporal",
      temporal: { shape, originalExpression: "f4 corrected term", role: "agreed" },
    },
    knowledgeState: { _tag: "known" },
    origin: "correction",
    recordedByUserId: firm.bossA,
    recordedAtMs: T0,
  });
  await ctx.db.patch(findingId, {
    currentRevisionId: revisionId,
    revisionCounter: (finding.revisionCounter as number) + 1,
    updatedAtMs: T0,
  });
}

interface TaskFixture {
  readonly taskId: string;
  readonly deadlineFindingId: string | null;
}

/** One task row with optional deadline binding and coordinator. */
async function seedTask(
  firm: Firm,
  projectId: string,
  options: {
    readonly deadlineFindingId?: string | undefined;
    readonly coordinatorMembershipId?: string | undefined;
    readonly state?: "todo" | "in_progress" | "waiting" | "done" | "cancelled";
    readonly revisionCounter?: number;
  } = {},
): Promise<TaskFixture> {
  const taskId = await ctx.db.insert("tasks", {
    companyId: firm.companyId,
    projectId,
    title: "Przygotować wycenę",
    state: options.state ?? "todo",
    ...(options.coordinatorMembershipId !== undefined
      ? { coordinatorMembershipId: options.coordinatorMembershipId }
      : {}),
    ...(options.deadlineFindingId !== undefined
      ? { deadlineFindingId: options.deadlineFindingId }
      : {}),
    revisionCounter: options.revisionCounter ?? 1,
    createdAtMs: T0,
    updatedAtMs: T0,
    stateChangedAtMs: T0,
  });
  return { taskId, deadlineFindingId: options.deadlineFindingId ?? null };
}

/** The task row's current revision (the fake row is unknown-typed). */
async function revisionOf(taskId: string): Promise<number> {
  const row = await ctx.db.get(taskId);
  return (row?.revisionCounter as number | undefined) ?? 1;
}

/** The recompute transaction, unwrapped. */
async function recompute(taskId: string, nowMs: number) {
  return valueOf(await performRecomputeTaskReminders(tx(), taskId as never, nowMs)) as {
    status: string;
    recipientCount: number;
    createdIntentIds: string[];
    suppressedIntentIds: string[];
    snoozesCleared: number;
  };
}

/** The evaluator sweep, unwrapped. */
async function evaluate(nowMs: number) {
  return valueOf(await performEvaluateDueReminders(tx(), { nowMs })) as {
    evaluatedIntentIds: string[];
  };
}

/** One boss's task-reminder intents in one state, sorted by dedup key. */
function remindersOf(userId: string, state?: string) {
  return ctx.db
    .rows("notificationIntents")
    .filter(
      (row) =>
        row.recipientUserId === userId &&
        row.semanticKind === "task_reminder" &&
        (state === undefined || row.state === state),
    )
    .sort((a, b) => String(a.dedupKey).localeCompare(String(b.dedupKey)));
}

/** The DISTINCT collapsed summaries delivered to one boss. */
function summariesOf(userId: string) {
  const distinct = new Set(
    remindersOf(userId, "delivered").map((row) => String(row.deliveryJson)),
  );
  return [...distinct].map((json) => JSON.parse(json));
}

/** The PENDING reminder intent of one (user, kind). */
function pendingOfKind(userId: string, kind: "pre_due" | "overdue") {
  return ctx.db
    .rows("notificationIntents")
    .find(
      (row) =>
        row.recipientUserId === userId &&
        row.semanticKind === "task_reminder" &&
        row.state === "pending" &&
        JSON.parse(String(row.payloadJson)).reminderKind === kind,
    )!;
}

/** One dated task with a coordinator, recomputed at `nowMs`. */
async function datedTask(
  firm: Firm,
  projectId: string,
  term: { readonly day: string } | { readonly iso: string },
  coordinatorMembershipId: string | undefined,
  nowMs: number,
): Promise<TaskFixture> {
  const deadlineFindingId = await seedDeadline(firm, projectId, term);
  const task = await seedTask(firm, projectId, {
    deadlineFindingId,
    coordinatorMembershipId,
  });
  await recompute(task.taskId, nowMs);
  return task;
}

beforeEach(() => {
  ctx = fakeCtx([...TABLES]);
});

// ---------------------------------------------------------------------------
// The pure model: slot arithmetic, DST, identity.
// ---------------------------------------------------------------------------

describe("the pure reminder-slot arithmetic", () => {
  it("07:00 instants resolve DST-correct in the company timezone", () => {
    expect(instantOfLocalMinute("2026-09-11", REMINDER_MINUTE_OF_DAY, WARSAW)).toBe(
      Date.parse("2026-09-11T05:00:00.000Z"), // CEST
    );
    // The fall-back night (2026-10-25 03:00 CEST -> 02:00 CET): the 25th's
    // 07:00 is CET, one absolute hour later than the CEST days around it.
    expect(instantOfLocalMinute("2026-10-24", REMINDER_MINUTE_OF_DAY, WARSAW)).toBe(
      Date.parse("2026-10-24T05:00:00.000Z"),
    );
    expect(instantOfLocalMinute("2026-10-25", REMINDER_MINUTE_OF_DAY, WARSAW)).toBe(
      Date.parse("2026-10-25T06:00:00.000Z"),
    );
    // The spring-forward night (2026-03-29 02:00 CET -> 03:00 CEST).
    expect(instantOfLocalMinute("2026-03-28", REMINDER_MINUTE_OF_DAY, WARSAW)).toBe(
      Date.parse("2026-03-28T06:00:00.000Z"), // CET
    );
    expect(instantOfLocalMinute("2026-03-29", REMINDER_MINUTE_OF_DAY, WARSAW)).toBe(
      Date.parse("2026-03-29T05:00:00.000Z"), // CEST
    );
  });

  it("the first overdue summary of a date-only term is next day at 07:00", () => {
    const slot = firstOverdueSlot({ _tag: "end_of_local_day", day: "2026-09-10" }, WARSAW);
    expect(slot.day).toBe("2026-09-11");
    expect(slot.atMs).toBe(Date.parse("2026-09-11T05:00:00.000Z"));
  });

  it("the first overdue summary of a timed term is the next 07:00 after the instant", () => {
    // 15:00 Warsaw on the 11th: that day's 07:00 already passed.
    const slot = firstOverdueSlot(
      { _tag: "instant", epochMs: Date.parse("2026-09-11T13:00:00.000Z") },
      WARSAW,
    );
    expect(slot.day).toBe("2026-09-12");
    expect(slot.atMs).toBe(Date.parse("2026-09-12T05:00:00.000Z"));
    // 06:30 Warsaw on the 11th: that day's 07:00 is still ahead.
    const early = firstOverdueSlot(
      { _tag: "instant", epochMs: Date.parse("2026-09-11T04:30:00.000Z") },
      WARSAW,
    );
    expect(early.day).toBe("2026-09-11");
    expect(early.atMs).toBe(Date.parse("2026-09-11T05:00:00.000Z"));
  });

  it("the daily roll chains one local day at a time", () => {
    const next = nextOverdueSlotAfter("2026-10-25", WARSAW);
    expect(next.day).toBe("2026-10-26");
    expect(next.atMs).toBe(Date.parse("2026-10-26T06:00:00.000Z"));
  });

  it("a timed deadline schedules one hour before; a date-only 07:00 on its day", () => {
    const timed = deriveReminderSchedule({
      state: "todo",
      deadline: {
        knowledgeState: { _tag: "known" },
        temporal: {
          shape: { _tag: "date_time", value: "2026-09-11T15:00:00.000+02:00[Europe/Warsaw]" },
          originalExpression: "f4",
          role: "agreed",
        },
      },
      nowMs: T0,
      companyTimezone: WARSAW,
    });
    expect(timed.kind).toBe("scheduled");
    if (timed.kind !== "scheduled") throw new Error("unreachable");
    expect(timed.slots.map((slot) => slot.reminderKind)).toEqual(["pre_due", "overdue"]);
    expect(timed.slots[0]!.dueAtMs).toBe(Date.parse("2026-09-11T13:00:00.000Z") - TIMED_LEAD_MS);
    expect(timed.slots[1]!.slotDay).toBe("2026-09-12");

    const dayOnly = deriveReminderSchedule({
      state: "todo",
      deadline: {
        knowledgeState: { _tag: "known" },
        temporal: {
          shape: { _tag: "day", day: "2026-09-11" },
          originalExpression: "f4",
          role: "agreed",
        },
      },
      nowMs: T0,
      companyTimezone: WARSAW,
    });
    if (dayOnly.kind !== "scheduled") throw new Error("unreachable");
    expect(dayOnly.slots[0]!.dueAtMs).toBe(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(dayOnly.slots[1]!.slotDay).toBe("2026-09-12");
  });

  it("closed, undated and contested tasks schedule nothing", () => {
    const base = {
      deadline: {
        knowledgeState: { _tag: "known" },
        temporal: {
          shape: { _tag: "day", day: "2026-09-11" },
          originalExpression: "f4",
          role: "agreed",
        },
      },
      nowMs: T0,
      companyTimezone: WARSAW,
    } as const;
    expect(deriveReminderSchedule({ ...base, state: "done" }).kind).toBe("task_closed");
    expect(deriveReminderSchedule({ ...base, state: "cancelled" }).kind).toBe("task_closed");
    expect(
      deriveReminderSchedule({ ...base, state: "todo", deadline: null }).kind,
    ).toBe("no_deadline");
    expect(
      deriveReminderSchedule({
        ...base,
        state: "todo",
        deadline: { knowledgeState: { _tag: "conflicted" }, temporal: base.deadline.temporal },
      }).kind,
    ).toBe("term_unusable");
  });

  it("an ideal in the past clamps to the recompute instant as ONE prompt", () => {
    const nowMs = Date.parse("2026-09-10T10:00:00.000Z");
    const schedule = deriveReminderSchedule({
      state: "todo",
      deadline: {
        knowledgeState: { _tag: "known" },
        temporal: {
          shape: { _tag: "day", day: "2026-09-10" },
          originalExpression: "f4",
          role: "agreed",
        },
      },
      nowMs,
      companyTimezone: WARSAW,
    });
    if (schedule.kind !== "scheduled") throw new Error("unreachable");
    const preDue = schedule.slots.find((slot) => slot.reminderKind === "pre_due")!;
    expect(preDue.idealAtMs).toBe(Date.parse("2026-09-10T05:00:00.000Z"));
    expect(preDue.dueAtMs).toBe(nowMs);
  });

  it("the dedup identity binds task, recipient, kind, revision and day", () => {
    expect(reminderDedupKey("t1", "u1", "pre_due", 3, null)).toBe(
      "task_reminder:pre_due:t1:u1:r3",
    );
    expect(reminderDedupKey("t1", "u1", "overdue", 3, "2026-09-11")).toBe(
      "task_reminder:overdue:t1:u1:r3:2026-09-11",
    );
  });
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
    expect(ctx.db.rows("notificationIntents")).toHaveLength(0);
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
    const hop = ctx.scheduled.find(
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
    await ctx.db.patch(task.taskId, {
      coordinatorMembershipId: firm.membershipB,
      revisionCounter: (await revisionOf(task.taskId)) + 1,
      updatedAtMs: T0 + 1,
    });
    const result = await recompute(task.taskId, T0 + 2_000);
    expect(result.snoozesCleared).toBe(1);
    expect(ctx.db.rows("reminderSnoozes")).toHaveLength(0);
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
    await ctx.db.patch(task.taskId, {
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
    await ctx.db.patch(task.taskId, {
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
    await ctx.db.patch(task.taskId, {
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
    await ctx.db.patch(task.taskId, {
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
    const finding = (await ctx.db.get(task.deadlineFindingId!))!;
    const revision = (await ctx.db.get(finding.currentRevisionId as string))!;
    await ctx.db.patch(revision._id, { knowledgeState: { _tag: "conflicted" } });
    await ctx.db.patch(finding._id, { knowledgeState: { _tag: "conflicted" } });
    const result = await recompute(task.taskId, T0 + 1_000);
    expect(result.status).toBe("term_unusable");
    expect(remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "term_unusable",
      "term_unusable",
    ]);
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
    const events = ctx.db
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
    const hop = ctx.scheduled.find(
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
    await ctx.db.insert("notificationPreferences", {
      companyId: firm.companyId,
      userId: firm.bossA,
      mutedProjectIds: [projectId], // conversation mute of the task's project
      companyEntriesMuted: false,
      taskRemindersMuted: false,
      hidePreviewContent: false,
      updatedAtMs: T0,
    });
    await ctx.db.insert("notificationPreferences", {
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
    const sourceId = await ctx.db.insert("sources", {
      companyId: firm.companyId,
      authorUserId: firm.bossB,
      authorText: "Termin na 11 września",
      sentAtMs: T0,
      sentAtTimezone: WARSAW,
      fullyAcceptedAtMs: T0,
      lifecycle: "active",
    });
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await ctx.db.insert("readStates", {
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
    await ctx.db.insert("notificationPreferences", {
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
    const events = ctx.db
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
    expect(ctx.db.rows("reminderSnoozes")).toHaveLength(0);
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
    await ctx.db.patch(task.taskId, { coordinatorMembershipId: firm.membershipB });
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    // Only the pre_due slot was due; the FINAL coordinator decides: A dies.
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason),
    ).toEqual(["recipient_changed"]);
    expect(pendingOfKind(firm.bossA, "overdue")).toBeDefined();
    expect(summariesOf(firm.bossA)).toHaveLength(0);
    // After the recompute, B owns the fresh slots and receives them, while
    // A's still-pending slot dies with the superseded schedule.
    await ctx.db.patch(task.taskId, { revisionCounter: (await revisionOf(task.taskId)) + 1 });
    await recompute(task.taskId, T0 + 5_000);
    await evaluate(Date.parse("2026-09-11T05:00:00.001Z"));
    expect(summariesOf(firm.bossB)).toHaveLength(1);
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason).sort(),
    ).toEqual(["recipient_changed", "schedule_changed"]);
  });

  it("a revision bump while the reminder sat due kills the superseded schedule's slots", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await ctx.db.patch(task.taskId, { revisionCounter: 5, updatedAtMs: T0 + 1 });
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason),
    ).toEqual(["schedule_changed"]);
    expect(pendingOfKind(firm.bossA, "overdue")).toBeDefined();
    expect(summariesOf(firm.bossA)).toHaveLength(0);
    // The not-yet-due slot of the superseded schedule dies at its own due.
    await evaluate(Date.parse("2026-09-12T05:00:00.000Z"));
    expect(
      remindersOf(firm.bossA, "suppressed").map((row) => row.suppressedReason),
    ).toEqual(["schedule_changed", "schedule_changed"]);
    void task;
  });

  it("completion between scheduling and due time removes the reminder", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const task = await datedTask(firm, projectId, { day: "2026-09-11" }, firm.membershipA, T0);
    await ctx.db.patch(task.taskId, { state: "done", stateChangedAtMs: T0 + 1 });
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
    await ctx.db.patch(firm.membershipC, { state: "revoked", revokedAtMs: T0 + 1 });
    await evaluate(Date.parse("2026-09-10T05:00:00.000Z"));
    expect(remindersOf(firm.bossC, "suppressed").map((row) => row.suppressedReason)).toEqual([
      "membership_revoked",
    ]);
    expect(summariesOf(firm.bossA)).toHaveLength(1);
    expect(summariesOf(firm.bossB)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The durable edges: projections, executor, the C4 integration.
// ---------------------------------------------------------------------------

describe("the outbox projections", () => {
  it("projects the work events onto the reminder job with the row's identity", () => {
    const taskChanged = projectEventToJobInputs(
      "work.taskChanged",
      { taskId: "k task 1" },
      "work.taskChanged:ktask1:2",
    );
    expect(taskChanged).toHaveLength(1);
    expect(taskChanged[0]).toMatchObject({
      kind: "job",
      jobKind: "attention.schedule_task_reminders",
      input: { trigger: "task_changed", taskId: "k task 1", findingId: null },
      dedupKey: "work.taskChanged:ktask1:2",
    });
    const stateChanged = projectEventToJobInputs(
      "work.taskStateChanged",
      { taskId: "k task 1", fromState: "todo", toState: "done" },
      "work.taskStateChanged:ktask1:2",
    );
    expect(stateChanged[0]).toMatchObject({
      kind: "job",
      input: { trigger: "task_changed" },
    });
    const revised = projectEventToJobInputs(
      "memory.findingRevised",
      { findingId: "kfinding1", revisionId: "krevision9", supersedesRevisionId: null },
      "memory.findingRevised:krevision9",
    );
    // The event fans out to C5's recompute walk AND F4's reminder edge.
    expect(revised).toHaveLength(2);
    const reminderEdge = revised.find(
      (projection) =>
        projection.kind === "job" && projection.jobKind === "attention.schedule_task_reminders",
    )!;
    expect(reminderEdge).toMatchObject({
      kind: "job",
      input: { trigger: "finding_revised", taskId: null, findingId: "kfinding1" },
      // Payload-derived identity: the event fans out to C5's edge under the
      // row's key, and one dedup key may never carry two job kinds.
      dedupKey: "attention.schedule_task_reminders:finding:kfinding1:krevision9",
    });
  });
});

describe("the reminder executor", () => {
  it("recomputes the task's schedule from the job input", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const deadlineFindingId = await seedDeadline(firm, projectId, { day: "2026-09-11" });
    const task = await seedTask(firm, projectId, {
      deadlineFindingId,
      coordinatorMembershipId: firm.membershipA,
    });
    const outcome = await taskRemindersExecutor.execute(tx(), jobOf("k1"), {
      trigger: "task_changed",
      taskId: task.taskId,
      findingId: null,
    });
    expect(outcome).toEqual({ outcome: "succeeded" });
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
  });

  it("recomputes every task bound to a revised deadline finding", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const deadlineFindingId = await seedDeadline(firm, projectId, { day: "2026-09-11" });
    const t1 = await seedTask(firm, projectId, { deadlineFindingId });
    const t2 = await seedTask(firm, projectId, { deadlineFindingId });
    await recompute(t1.taskId, T0);
    await recompute(t2.taskId, T0);
    // The correction moves the term; the finding_revised job recomputes both.
    await reviseDeadline(firm, deadlineFindingId, { day: "2026-09-15" });
    const outcome = await taskRemindersExecutor.execute(tx(), jobOf("k2"), {
      trigger: "finding_revised",
      taskId: null,
      findingId: deadlineFindingId,
    });
    expect(outcome).toEqual({ outcome: "succeeded" });
    for (const task of [t1, t2]) {
      const bossRow = ctx.db
        .rows("notificationIntents")
        .filter((row) => row.taskId === task.taskId && row.state === "pending");
      expect(bossRow).toHaveLength(6); // 3 bosses x 2 slots, unassigned tasks
      const anchor = ctx.db
        .rows("reminderSchedules")
        .find((row) => row.taskId === task.taskId)!;
      expect(anchor.termAnchor).toBe("day:2026-09-15");
    }
  });

  it("fails closed on malformed input", async () => {
    const outcome = await taskRemindersExecutor.execute(tx(), jobOf("k3"), {
      trigger: "task_changed",
      taskId: null,
      findingId: null,
    });
    expect(outcome).toMatchObject({ outcome: "failed", errorKind: "task_id_missing" });
  });
});

describe("the C4 integration: a boss-created own task still gets its reminder", () => {
  it("creates and delivers the creating boss's reminder through the real work transaction", async () => {
    const firm = await seedFirm();
    const projectId = await seedProject(firm);
    const deadlineFindingId = await seedDeadline(firm, projectId, { day: "2026-09-11" });
    // The boss creates their OWN task and coordinates it themselves (the
    // source-entry author exclusion deliberately does not exist here).
    const created = await performChangeTask(tx(), contextOf(firm, firm.bossA), {
      taskId: null,
      projectId: parseTableId("projects", projectId)!,
      title: "Zadanie szefa",
      executorContactId: null,
      coordinatorMembershipId: parseTableId("memberships", firm.membershipA)!,
      deadlineFindingId: parseTableId("findings", deadlineFindingId)!,
      expectedRevision: 1,
    });
    expect(created._tag).toBe("ok");
    const taskId = (valueOf(created) as { taskId: string }).taskId;
    const taskRow = (await ctx.db.get(taskId))!;
    expect(taskRow.coordinatorMembershipId).toBe(firm.membershipA);
    // The canonical task event the durable edge consumes.
    const events = ctx.db
      .rows("outboxEvents")
      .filter((row) => row.eventName === "work.taskChanged");
    expect(events).toHaveLength(1);
    // The recompute runs (the executor's transaction) and the CREATING
    // boss receives their own reminder, unlike a source entry.
    await recompute(taskId, T0);
    expect(remindersOf(firm.bossA, "pending")).toHaveLength(2);
    await evaluate(Date.parse("2026-09-11T05:00:00.000Z"));
    expect(summariesOf(firm.bossA)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The checked dispatch surface.
// ---------------------------------------------------------------------------

describe("the reminder handler registration", () => {
  it("registers exactly the two contract operations of this lane", () => {
    const handlers = remindersHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "attention.evaluateDueReminders",
      "attention.snoozeTaskReminders",
    ]);
    for (const binding of Object.values(handlers)) {
      expect(binding.intent).toBe("write");
    }
  });

  it("fails closed on invented reminder operations", async () => {
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextOfFixture(),
        policy: membershipPolicy,
        handlers: {
          "attention.snoozeTaskReminders": { intent: "write", run: async () => okResult({}) },
        },
      },
      null,
      { operation: "attention.clearTaskReminders", input: {}, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("unknown_operation");
    }
  });

  it("never invokes the handler when the contract rejects the input", async () => {
    const handlerRun = { called: false };
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextOfFixture(),
        policy: membershipPolicy,
        handlers: {
          "attention.snoozeTaskReminders": {
            intent: "write",
            run: async () => {
              handlerRun.called = true;
              return okResult({});
            },
          },
        },
      },
      null,
      { operation: "attention.snoozeTaskReminders", input: { taskId: 42 }, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    expect(handlerRun.called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixture helpers that need the seeded fake ids.
// ---------------------------------------------------------------------------

/** A context fixture independent of the seeded firm (the dispatch surface). */
function contextOfFixture(): RequestContext {
  return contextOf(
    {
      companyId: "k0000company00000000000",
      bossA: "k0000user00000000000000",
      bossB: "k0001user00000000000000",
      bossC: "k0002user00000000000000",
      membershipA: "k0000membership00000000",
      membershipB: "k0001membership00000000",
      membershipC: "k0002membership00000000",
    },
    "k0000user00000000000000",
  );
}

/** One request context for a seeded boss (canonical actor shape). */
function contextOf(firm: Firm, userId: string): RequestContext {
  return {
    actor: Schema.decodeUnknownSync(ActorContext)({
      userId: parseTableId("users", userId),
      companyId: parseTableId("companies", firm.companyId),
      membershipRole: "member",
      isGm: false,
      sessionId: parseTableId("sessions", "k0000session00000000"),
      via: "user",
    }),
    resolvedAtMs: T0,
  };
}

/** One durable-job row stand-in (only kind/jobKey are read). */
function jobOf(jobKey: string) {
  return {
    _id: "kjob",
    jobKey,
    kind: "attention.schedule_task_reminders",
    state: "running",
    attempts: 1,
    maxAttempts: 3,
    inputJson: "{}",
    createdAtMs: T0,
    updatedAtMs: T0,
  } as never;
}
