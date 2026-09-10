/**
 * F4 pure model tests: the reminder-slot arithmetic (issue 44), no
 * transaction, no harness (the transactional suites live in
 * reminders.test.ts and edges.test.ts over tests/d2/harness.ts; the split
 * is PR #102 review round 1).
 *
 * Covers the slot arithmetic against fixed instants: timed (one hour
 * before), date-only (07:00 company-local), the DST nights, the first
 * daily overdue summary boundaries, the missed-slot clamp, and the
 * epoch-keyed dedup identity (PR #102 review round 1, finding 3: the
 * identity binds the schedule epoch, never the task revision).
 */

import { describe, expect, it } from "vitest";
import { instantOfLocalMinute, localDateOfInstant } from "@kiero/domain";
import {
  REMINDER_MINUTE_OF_DAY,
  TIMED_LEAD_MS,
  deriveReminderSchedule,
  firstOverdueSlot,
  nextOverdueSlotAfter,
  reminderDedupKey,
} from "../../convex/attention/reminders/model";

/** Warsaw anchors: September 2026 is CEST (UTC+2). */
const T0 = Date.parse("2026-09-09T10:00:00.000Z");
const WARSAW = "Europe/Warsaw";

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

  it("instantOfLocalMinute is the exact inverse of localDateOfInstant", () => {
    // The shared domain helper (packages/domain/findings/temporal.ts):
    // sampled minutes of every day around BOTH 2026 DST transitions in
    // Warsaw map to instants whose local date is the input day.
    for (const day of ["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30"]) {
      for (const minute of [0, 3 * 60, 12 * 60 + 30, 23 * 60 + 59]) {
        const instant = instantOfLocalMinute(day, minute, WARSAW);
        expect(localDateOfInstant(instant, WARSAW)).toBe(day);
      }
    }
    for (const day of ["2026-10-24", "2026-10-25", "2026-10-26"]) {
      for (const minute of [0, 3 * 60, 12 * 60 + 30, 23 * 60 + 59]) {
        const instant = instantOfLocalMinute(day, minute, WARSAW);
        expect(localDateOfInstant(instant, WARSAW)).toBe(day);
      }
    }
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

  it("the dedup identity binds task, recipient, kind, schedule epoch and day", () => {
    expect(reminderDedupKey("t1", "u1", "pre_due", 3, null)).toBe(
      "task_reminder:pre_due:t1:u1:e3",
    );
    expect(reminderDedupKey("t1", "u1", "overdue", 3, "2026-09-11")).toBe(
      "task_reminder:overdue:t1:u1:e3:2026-09-11",
    );
    // Epoch, not revision: two epochs of the same slot differ (a term or
    // recipient change minted a fresh schedule), and the epoch component
    // never collides across its own day-part suffixes.
    expect(reminderDedupKey("t1", "u1", "overdue", 1, "2026-09-11")).not.toBe(
      reminderDedupKey("t1", "u1", "overdue", 12, "2026-09-11"),
    );
  });
});
