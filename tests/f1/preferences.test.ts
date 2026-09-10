/**
 * F1 focused tests: the personal notification-preference evaluation seam
 * (pure matrices incl. quiet-hour boundaries and company-timezone DST).
 *
 * These pin the exact functions F2's evaluator and F4's reminder
 * evaluation call at delivery time: minute-of-day resolution in the
 * company timezone, half-open quiet-hour windows (which may wrap
 * midnight), the deferral instant across DST transitions, and the
 * suppression matrix by delivery kind/scope/author/read/mute.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONAL_SETTINGS,
  DEFAULT_QUIET_HOURS,
  decidePersonalDelivery,
  effectiveQuietHours,
  isWithinQuietHours,
  isValidTimezone,
  minuteOfDayInZone,
  nextQuietHoursEndMs,
  type PersonalNotificationSettings,
} from "../../convex/attention/preferences/evaluation";
import { dedupeProjectIds, patchIsEmpty } from "../../convex/attention/preferences/operations";

const WARSAW = "Europe/Warsaw";
const P1 = "k57d0000000000000000000000000p01";
const P2 = "k57d0000000000000000000000000p02";

const settings = (overrides: Partial<PersonalNotificationSettings>): PersonalNotificationSettings => ({
  ...DEFAULT_PERSONAL_SETTINGS,
  quietHours: null,
  ...overrides,
});

const iso = (value: string) => Date.parse(value);

describe("minute-of-day in the company timezone (DST-correct)", () => {
  it("resolves the wall clock of one instant per zone", () => {
    const instant = iso("2026-09-09T10:30:00.000Z");
    expect(minuteOfDayInZone(instant, "UTC")).toBe(10 * 60 + 30);
    expect(minuteOfDayInZone(instant, WARSAW)).toBe(12 * 60 + 30); // CEST +2
    expect(minuteOfDayInZone(instant, "America/New_York")).toBe(6 * 60 + 30); // EDT -4
  });

  it("walks the repeated wall hour of the fall-back night without invented minutes", () => {
    // Europe/Warsaw 2026-10-25: 03:00 CEST -> 02:00 CET (transition 01:00Z).
    // The local 02:15 wall minute exists twice, one hour apart.
    expect(minuteOfDayInZone(iso("2026-10-25T00:15:00.000Z"), WARSAW)).toBe(2 * 60 + 15);
    expect(minuteOfDayInZone(iso("2026-10-25T01:15:00.000Z"), WARSAW)).toBe(2 * 60 + 15);
  });

  it("validates timezone names fail-closed", () => {
    expect(isValidTimezone(WARSAW)).toBe(true);
    expect(isValidTimezone("not/a-zone")).toBe(false);
  });
});

describe("quiet-hour window membership (half-open, may wrap midnight)", () => {
  const night = { startMinuteOfDay: 20 * 60, endMinuteOfDay: 6 * 60 };

  it("treats the start minute as quiet and the end minute as free", () => {
    expect(isWithinQuietHours(19 * 60 + 59, night)).toBe(false);
    expect(isWithinQuietHours(20 * 60, night)).toBe(true);
    expect(isWithinQuietHours(6 * 60 - 1, night)).toBe(true);
    expect(isWithinQuietHours(6 * 60, night)).toBe(false);
  });

  it("covers both sides of a wrapping window", () => {
    expect(isWithinQuietHours(23 * 60, night)).toBe(true);
    expect(isWithinQuietHours(2 * 60, night)).toBe(true);
    expect(isWithinQuietHours(12 * 60, night)).toBe(false);
  });

  it("handles a same-day window", () => {
    const day = { startMinuteOfDay: 9 * 60, endMinuteOfDay: 17 * 60 };
    expect(isWithinQuietHours(8 * 60 + 59, day)).toBe(false);
    expect(isWithinQuietHours(9 * 60, day)).toBe(true);
    expect(isWithinQuietHours(16 * 60 + 59, day)).toBe(true);
    expect(isWithinQuietHours(17 * 60, day)).toBe(false);
  });

  it("applies the company default until a personal window exists", () => {
    expect(DEFAULT_QUIET_HOURS).toEqual({ startMinuteOfDay: 1200, endMinuteOfDay: 360 });
    expect(effectiveQuietHours(null)).toEqual(DEFAULT_QUIET_HOURS);
    expect(effectiveQuietHours(settings({ quietHours: null }))).toEqual(DEFAULT_QUIET_HOURS);
    const personal = { startMinuteOfDay: 540, endMinuteOfDay: 1020 };
    expect(effectiveQuietHours(settings({ quietHours: personal }))).toEqual(personal);
  });
});

describe("quiet-hour deferral instants across the company timezone", () => {
  it("defers a 20:00 local mark to the next 06:00 local (same CEST offset)", () => {
    const now = iso("2026-09-09T18:00:00.000Z"); // 20:00 Warsaw (CEST)
    const until = nextQuietHoursEndMs(now, WARSAW, DEFAULT_QUIET_HOURS);
    expect(until).toBe(iso("2026-09-10T04:00:00.000Z")); // 06:00 CEST
  });

  it("defers a late-night mark to the same day's 06:00 local", () => {
    const now = iso("2026-09-09T03:59:59.999Z"); // 05:59:59.999 Warsaw
    const until = nextQuietHoursEndMs(now, WARSAW, DEFAULT_QUIET_HOURS);
    expect(until).toBe(iso("2026-09-09T04:00:00.000Z"));
  });

  it("returns the end minute itself when asked exactly at the boundary", () => {
    const now = iso("2026-09-09T04:00:00.000Z"); // exactly 06:00 Warsaw
    expect(nextQuietHoursEndMs(now, WARSAW, DEFAULT_QUIET_HOURS)).toBe(now);
  });

  it("crosses the fall-back night with the post-transition offset", () => {
    // 2026-10-25: quiet ends 06:00 CET (one hour AFTER the repeated hour),
    // so the deferral target is 05:00Z, not the naive 04:00Z.
    const now = iso("2026-10-24T23:00:00.000Z"); // 01:00 CEST on the 25th
    const until = nextQuietHoursEndMs(now, WARSAW, DEFAULT_QUIET_HOURS);
    expect(until).toBe(iso("2026-10-25T05:00:00.000Z"));
  });

  it("crosses the spring-forward night with the post-transition offset", () => {
    // 2027-03-28: quiet ends 06:00 CEST, so the target is 04:00Z, not 05:00Z.
    const now = iso("2027-03-27T23:30:00.000Z"); // 00:30 CET on the 28th
    const until = nextQuietHoursEndMs(now, WARSAW, DEFAULT_QUIET_HOURS);
    expect(until).toBe(iso("2027-03-28T04:00:00.000Z"));
  });
});

describe("the personal delivery decision matrix", () => {
  it("defers inside the default window and frees exactly at the boundary", () => {
    const base = { kind: "source_entry", scope: "project", projectIds: [P1], isAuthor: false, read: false } as const;
    const at = (nowMs: number) =>
      decidePersonalDelivery({ ...base, nowMs, companyTimezone: WARSAW, settings: null });
    expect(at(iso("2026-09-09T17:59:00.000Z"))).toEqual({ decision: "eligible" }); // 19:59
    const deferred = at(iso("2026-09-09T18:00:00.000Z")); // 20:00
    expect(deferred).toEqual({
      decision: "deferred",
      reason: "quiet_hours",
      untilMs: iso("2026-09-10T04:00:00.000Z"),
    });
    expect(at(iso("2026-09-09T04:00:00.000Z"))).toEqual({ decision: "eligible" }); // 06:00
  });

  it("never notifies the author of their own entry, but may ask them a clarification", () => {
    const now = iso("2026-09-09T10:00:00.000Z");
    expect(
      decidePersonalDelivery({
        kind: "source_entry",
        scope: "company",
        projectIds: [],
        isAuthor: true,
        read: false,
        nowMs: now,
        companyTimezone: WARSAW,
        settings: null,
      }),
    ).toEqual({ decision: "suppressed", reason: "own_entry" });

    const clarification = decidePersonalDelivery({
      kind: "clarification",
      scope: "company",
      projectIds: [],
      isAuthor: true,
      read: false,
      nowMs: now,
      companyTimezone: WARSAW,
      settings: null,
    });
    expect(clarification.decision).toBe("eligible"); // agent question may reach the author
  });

  it("removes an already-read source entry from the batch", () => {
    const decision = decidePersonalDelivery({
      kind: "source_entry",
      scope: "project",
      projectIds: [P1],
      isAuthor: false,
      read: true,
      nowMs: iso("2026-09-09T10:00:00.000Z"),
      companyTimezone: WARSAW,
      settings: null,
    });
    expect(decision).toEqual({ decision: "suppressed", reason: "already_read" });
  });

  it("never lets reading a task suppress its reminder", () => {
    const decision = decidePersonalDelivery({
      kind: "task_reminder",
      scope: "project",
      projectIds: [P1],
      isAuthor: false,
      read: true,
      nowMs: iso("2026-09-09T10:00:00.000Z"),
      companyTimezone: WARSAW,
      settings: null,
    });
    expect(decision).toEqual({ decision: "eligible" });
  });

  it("suppresses a source entry when ANY of its projects is muted (mixed-project source)", () => {
    const decision = decidePersonalDelivery({
      kind: "source_entry",
      scope: "project",
      projectIds: [P1, P2],
      isAuthor: false,
      read: false,
      nowMs: iso("2026-09-09T10:00:00.000Z"),
      companyTimezone: WARSAW,
      settings: settings({ mutedProjectIds: [P2] }),
    });
    expect(decision).toEqual({ decision: "suppressed", reason: "muted_project" });
  });

  it("keeps company-entry mute separate from project mutes", () => {
    const company = decidePersonalDelivery({
      kind: "source_entry",
      scope: "company",
      projectIds: [],
      isAuthor: false,
      read: false,
      nowMs: iso("2026-09-09T10:00:00.000Z"),
      companyTimezone: WARSAW,
      settings: settings({ mutedProjectIds: [P1] }),
    });
    expect(company).toEqual({ decision: "eligible" }); // project mute does not hit company entries

    const mutedCompany = decidePersonalDelivery({
      kind: "source_entry",
      scope: "company",
      projectIds: [],
      isAuthor: false,
      read: false,
      nowMs: iso("2026-09-09T10:00:00.000Z"),
      companyTimezone: WARSAW,
      settings: settings({ companyEntriesMuted: true }),
    });
    expect(mutedCompany).toEqual({ decision: "suppressed", reason: "muted_company_entries" });
  });

  it("keeps the task-reminder mute separate from conversation mutes", () => {
    const reminder = decidePersonalDelivery({
      kind: "task_reminder",
      scope: "project",
      projectIds: [P1],
      isAuthor: false,
      read: false,
      nowMs: iso("2026-09-09T10:00:00.000Z"),
      companyTimezone: WARSAW,
      settings: settings({ mutedProjectIds: [P1] }),
    });
    expect(reminder).toEqual({ decision: "eligible" }); // conversation mute is not the reminder mute

    const mutedReminder = decidePersonalDelivery({
      kind: "task_reminder",
      scope: "project",
      projectIds: [P1],
      isAuthor: false,
      read: false,
      nowMs: iso("2026-09-09T10:00:00.000Z"),
      companyTimezone: WARSAW,
      settings: settings({ taskRemindersMuted: true }),
    });
    expect(mutedReminder).toEqual({ decision: "suppressed", reason: "muted_task_reminders" });
  });

  it("prefers suppression over deferral inside quiet hours", () => {
    const decision = decidePersonalDelivery({
      kind: "source_entry",
      scope: "project",
      projectIds: [P1],
      isAuthor: false,
      read: true,
      nowMs: iso("2026-09-09T18:30:00.000Z"), // 20:30 Warsaw: quiet
      companyTimezone: WARSAW,
      settings: null,
    });
    expect(decision).toEqual({ decision: "suppressed", reason: "already_read" });
  });

  it("defers clarifications through quiet hours (agent utterances obey them)", () => {
    const decision = decidePersonalDelivery({
      kind: "clarification",
      scope: "company",
      projectIds: [],
      isAuthor: true,
      read: false,
      nowMs: iso("2026-09-09T18:30:00.000Z"), // 20:30 Warsaw
      companyTimezone: WARSAW,
      settings: null,
    });
    expect(decision).toEqual({
      decision: "deferred",
      reason: "quiet_hours",
      untilMs: iso("2026-09-10T04:00:00.000Z"),
    });
  });

  it("respects a personal window over the company default", () => {
    const decision = decidePersonalDelivery({
      kind: "task_reminder",
      scope: "project",
      projectIds: [P1],
      isAuthor: false,
      read: false,
      nowMs: iso("2026-09-09T07:30:00.000Z"), // 09:30 Warsaw: inside personal 09-17
      companyTimezone: WARSAW,
      settings: settings({ quietHours: { startMinuteOfDay: 9 * 60, endMinuteOfDay: 17 * 60 } }),
    });
    expect(decision).toEqual({
      decision: "deferred",
      reason: "quiet_hours",
      untilMs: iso("2026-09-09T15:00:00.000Z"), // 17:00 CEST
    });
  });
});

describe("preference patch shape (independent controls)", () => {
  it("de-duplicates muted project ids order-preserving", () => {
    expect(dedupeProjectIds([P1, P2, P1])).toEqual([P1, P2]);
    expect(dedupeProjectIds([])).toEqual([]);
  });

  it("rejects an empty patch (nothing to change)", () => {
    expect(patchIsEmpty({})).toBe(true);
    expect(patchIsEmpty({ companyEntriesMuted: true })).toBe(false);
    expect(patchIsEmpty({ quietHours: null })).toBe(false);
  });
});
