/**
 * Task-reminder scheduling model (F4): the PURE decision core the
 * recompute transaction and the due-time evaluator run (issue 44:
 * "durable reminder evaluation from C4 task state and F1 personal
 * preferences").
 *
 * Everything here is deterministic over its inputs - no Convex, no clock,
 * no environment - so the reminder instants, the DST boundaries of the
 * company timezone, the overdue-day arithmetic and the missed-slot policy
 * are unit-testable without a deployment (tests/f4/reminders.test.ts)
 * while ./operations.ts re-runs the SAME functions inside its
 * transactions over live rows (the F2 `delivery/model.ts` precedent).
 *
 * Semantics pinned by the accepted decisions (issue 44's bounded solution,
 * issue 7's notification resolution, CONTEXT.md):
 *
 * - "Przypomnienie o zadaniu" is based on the TASK, never on conversation
 *   read state; its recipient is the task's coordinator ("Koordynator
 *   zadania") or every boss when none is assigned.
 * - For a dated TIME schedule one hour before; for a date-only task
 *   schedule 07:00 in the company timezone ("Strefa czasu firmy": the
 *   reminder times never follow the reader's phone). The 07:00 is
 *   DELIVERY metadata, never an invented task time.
 * - For overdue work ONE current daily summary at 07:00: a date-only term
 *   is overdue only after its company-local day ends, and the FIRST daily
 *   overdue summary is the next day at 07:00 (issue 44 acceptance). A
 *   zoned date/time term is overdue at its instant; its first summary is
 *   the next 07:00 after that instant.
 * - Undated tasks remain only in Co teraz: no reminder slot exists for a
 *   missing or unusable term, and a reminder for a contested date stays
 *   suspended (the dueness `term_unusable` outcomes, C4's rule verbatim).
 * - A newly created or assigned task whose reminder time already passed
 *   gets ONE prompt as soon as quiet hours permit, without replaying every
 *   missed alert: an ideal instant in the past clamps to the recompute
 *   instant (the quiet-hours deferral is F1's seam, applied later).
 */

import type { TaskState } from "@kiero/contracts";
import {
  addDays,
  deriveTaskDueness,
  localDateOfInstant,
  type DueMoment,
  type TemporalBindingView,
  type TermUnusableReason,
} from "@kiero/domain";

/** The company-local minute every date-only reminder and overdue summary fires. */
export const REMINDER_MINUTE_OF_DAY = 7 * 60; // 07:00

/** How long before a zoned date/time deadline the reminder fires. */
export const TIMED_LEAD_MS = 60 * 60 * 1_000;

/** The semantic slot kinds one task's schedule can carry. */
export type ReminderSlotKind = "pre_due" | "overdue";

/**
 * The closed death-reason vocabulary the F4 evaluator records on
 * suppressed task-reminder intents. `muted_task_reminders` is a member of
 * F2's `SUPPRESSED_REASONS` verbatim (the shared column's reserved entry);
 * the rest are F4's own re-check outcomes.
 */
export const TASK_REMINDER_SUPPRESSED_REASONS = [
  "task_unresolved",
  "task_closed",
  "no_deadline",
  "term_unusable",
  "schedule_changed",
  "recipient_changed",
  "membership_revoked",
  "muted_task_reminders",
] as const;
export type TaskReminderSuppressedReason =
  (typeof TASK_REMINDER_SUPPRESSED_REASONS)[number];

/**
 * Every reason a reminder intent may die with: this lane's re-check
 * vocabulary plus the F1 seam's suppression members (only the reminder
 * mute is REACHABLE for the `task_reminder` kind, but the settle call
 * accepts the seam's closed result without a cast).
 */
export type ReminderIntentSuppressedReason =
  | TaskReminderSuppressedReason
  | "own_entry"
  | "already_read"
  | "muted_project"
  | "muted_company_entries";

// ---------------------------------------------------------------------------
// Company-timezone wall-clock arithmetic (DST-correct through Intl).
// ---------------------------------------------------------------------------

/**
 * Parts of one wall-clock time, as produced by Intl in a timezone (the F1
 * `preferences/evaluation.ts` technique, spelled here because that module
 * keeps its formatter private to its own seam).
 */
interface WallTimeParts {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
  readonly minuteOfDay: number;
}

const wallTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function wallTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = wallTimeFormatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  wallTimeFormatterCache.set(timeZone, formatter);
  return formatter;
}

function wallTimeAt(instantMs: number, timeZone: string): WallTimeParts {
  const parts = wallTimeFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      // Unreachable for the part types requested above; fail loudly.
      throw new Error(`reminders model: missing ${type} part`);
    }
    return Number(part.value);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    minuteOfDay: get("hour") * 60 + get("minute"),
  };
}

/** The UTC offset of one timezone at one instant, in milliseconds. */
function timezoneOffsetMs(instantMs: number, timeZone: string): number {
  const wall = wallTimeAt(instantMs, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, 0, wall.minuteOfDay);
  return wallAsUtc - (instantMs - (instantMs % 60_000));
}

/**
 * The instant of one wall-clock minute on one calendar day in a timezone.
 * Two-pass (guess the offset, correct, re-check) so a minute inside or
 * beside a DST transition resolves the way schedulers expect - the same
 * algorithm F1's quiet-hours end resolution uses.
 */
export function instantOfLocalMinute(
  day: string,
  minuteOfDay: number,
  timeZone: string,
): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new Error(`reminders model: not a calendar day: ${day}`);
  }
  const wallAsUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    0,
    minuteOfDay,
  );
  const firstGuess = wallAsUtc - timezoneOffsetMs(wallAsUtc, timeZone);
  return wallAsUtc - timezoneOffsetMs(firstGuess, timeZone);
}

// ---------------------------------------------------------------------------
// Reminder slots.
// ---------------------------------------------------------------------------

/** One semantic reminder slot of one task, as the recompute derives it. */
export interface ReminderSlot {
  readonly reminderKind: ReminderSlotKind;
  /** The un-clamped ideal instant (delivery metadata, never a task time). */
  readonly idealAtMs: number;
  /** The durable due instant (clamped to now when the ideal already passed). */
  readonly dueAtMs: number;
  /** The company-local day the slot identifies (overdue slots only). */
  readonly slotDay: string | null;
}

/** The inputs of one task's schedule derivation. */
export interface ReminderScheduleInput {
  readonly state: TaskState;
  /** Null when the task has no deadline binding. */
  readonly deadline: TemporalBindingView | null;
  readonly nowMs: number;
  readonly companyTimezone: string;
}

/**
 * The derived reminder schedule of one task: closed tasks and unusable or
 * missing terms produce NO slots ("completed/cancelled tasks produce no
 * future reminder"; "a reminder for a contested date stays suspended").
 */
export type ReminderSchedule =
  | { readonly kind: "task_closed" }
  | { readonly kind: "no_deadline" }
  | { readonly kind: "term_unusable"; readonly reason: TermUnusableReason }
  | {
      readonly kind: "scheduled";
      readonly slots: readonly ReminderSlot[];
      /** Stable identity of the bound term, for change detection. */
      readonly termAnchor: string;
    };

/** A stable anchor for one bound term: its local day or its exact instant. */
export function termAnchorOf(due: DueMoment): string {
  return due._tag === "instant" ? `instant:${due.epochMs}` : `day:${due.day}`;
}

/**
 * The FIRST daily overdue summary slot of one term: for a date-only term
 * the day AFTER the term's last local day (the term elapses when that day
 * ends; the first summary is next day at 07:00); for a zoned date/time the
 * next 07:00 strictly after the elapsed instant (which is that day's 07:00
 * when the instant precedes it, else the following day's).
 */
export function firstOverdueSlot(
  due: DueMoment,
  companyTimezone: string,
): { readonly day: string; readonly atMs: number } {
  if (due._tag === "end_of_local_day") {
    const day = addDays(due.day, 1);
    return { day, atMs: instantOfLocalMinute(day, REMINDER_MINUTE_OF_DAY, companyTimezone) };
  }
  const elapsedDay = localDateOfInstant(due.epochMs, companyTimezone);
  const sameDayAt = instantOfLocalMinute(elapsedDay, REMINDER_MINUTE_OF_DAY, companyTimezone);
  if (sameDayAt > due.epochMs) {
    return { day: elapsedDay, atMs: sameDayAt };
  }
  const day = addDays(elapsedDay, 1);
  return { day, atMs: instantOfLocalMinute(day, REMINDER_MINUTE_OF_DAY, companyTimezone) };
}

/** The next daily overdue slot after a delivered one (one per local day). */
export function nextOverdueSlotAfter(
  slotDay: string,
  companyTimezone: string,
): { readonly day: string; readonly atMs: number } {
  const day = addDays(slotDay, 1);
  return { day, atMs: instantOfLocalMinute(day, REMINDER_MINUTE_OF_DAY, companyTimezone) };
}

/** Clamps one ideal instant to the recompute instant (the missed-slot policy). */
function clampedSlot(
  reminderKind: ReminderSlotKind,
  idealAtMs: number,
  slotDay: string | null,
  nowMs: number,
  companyTimezone: string,
): ReminderSlot {
  if (idealAtMs > nowMs) {
    return { reminderKind, idealAtMs, dueAtMs: idealAtMs, slotDay };
  }
  // The ideal already passed (created/assigned/re-bound after it): ONE
  // prompt as soon as quiet hours permit, never a replay. A clamped
  // overdue slot identifies TODAY's summary - the day of its actual
  // delivery - so the next daily slot chains from today, not from a
  // long-gone missed day.
  return {
    reminderKind,
    idealAtMs,
    dueAtMs: nowMs,
    slotDay:
      reminderKind === "overdue" ? localDateOfInstant(nowMs, companyTimezone) : null,
  };
}

/**
 * Derives one task's reminder schedule; a pure function of (state, bound
 * term, recompute instant, company timezone). The dueness rules are C4's
 * verbatim (the task domain owns what a term means); this model owns only
 * WHEN a reminder about it fires.
 */
export function deriveReminderSchedule(input: ReminderScheduleInput): ReminderSchedule {
  const dueness = deriveTaskDueness({
    state: input.state,
    deadline: input.deadline,
    nowMs: input.nowMs,
    companyTimezone: input.companyTimezone,
  });
  switch (dueness.kind) {
    case "closed":
      return { kind: "task_closed" };
    case "no_deadline":
      return { kind: "no_deadline" };
    case "term_unusable":
      return { kind: "term_unusable", reason: dueness.reason };
    case "pending": {
      const due = dueness.due;
      const preDueIdeal =
        due._tag === "instant"
          ? due.epochMs - TIMED_LEAD_MS
          : instantOfLocalMinute(due.day, REMINDER_MINUTE_OF_DAY, input.companyTimezone);
      const overdue = firstOverdueSlot(due, input.companyTimezone);
      return {
        kind: "scheduled",
        slots: [
          clampedSlot("pre_due", preDueIdeal, null, input.nowMs, input.companyTimezone),
          clampedSlot(
            "overdue",
            overdue.atMs,
            overdue.day,
            input.nowMs,
            input.companyTimezone,
          ),
        ],
        termAnchor: termAnchorOf(due),
      };
    }
    case "overdue": {
      // The term already passed: no pre-due reminder exists (its moment is
      // gone), only the daily overdue summary - clamped to one prompt when
      // even its first slot was missed.
      const due = dueness.due;
      const overdue = firstOverdueSlot(due, input.companyTimezone);
      return {
        kind: "scheduled",
        slots: [
          clampedSlot(
            "overdue",
            overdue.atMs,
            overdue.day,
            input.nowMs,
            input.companyTimezone,
          ),
        ],
        termAnchor: termAnchorOf(due),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Slot identity and payloads.
// ---------------------------------------------------------------------------

/**
 * The semantic dedup identity of one reminder slot: task, recipient, slot
 * kind, the task revision the schedule was derived at, and (overdue) the
 * local day the slot identifies. The revision component makes a
 * re-derivation after a task change a FRESH identity, so a recipient
 * removed and later restored gets new reminders while replayed recomputes
 * at the same revision collapse onto the same rows.
 */
export function reminderDedupKey(
  taskId: string,
  userId: string,
  reminderKind: ReminderSlotKind,
  revision: number,
  slotDay: string | null,
): string {
  const dayPart = slotDay === null ? "" : `:${slotDay}`;
  return `task_reminder:${reminderKind}:${taskId}:${userId}:r${revision}${dayPart}`;
}

/** The durable payload one task-reminder intent carries. */
export interface ReminderPayload {
  readonly kind: "task_reminder";
  readonly reminderKind: ReminderSlotKind;
  readonly taskId: string;
  readonly recipientUserId: string;
  /** The effective coordinator the schedule targeted (null = all bosses). */
  readonly coordinatorMembershipId: string | null;
  /** The deadline binding the schedule was derived from (null = none). */
  readonly deadlineFindingId: string | null;
  /** The stable term anchor at derivation time. */
  readonly termAnchor: string;
  /** The task revision the schedule was derived at. */
  readonly revision: number;
  /** The company-local day an overdue slot identifies (else null). */
  readonly slotDay: string | null;
  /** The un-clamped ideal instant (delivery metadata, never a task time). */
  readonly idealAtMs: number;
}

/** The collapsed summary shape recorded on delivered reminder intents. */
export interface ReminderBatchSummary {
  readonly semanticKind: "task_reminder";
  readonly bucket: "task_reminders";
  readonly taskIds: readonly string[];
  readonly reminderKinds: readonly ReminderSlotKind[];
  readonly deliveredAtMs: number;
}

/** The horizon a personal snooze may reach (a sanity bound, not product policy). */
export const MAX_SNOOZE_AHEAD_MS = 30 * 24 * 60 * 60 * 1_000;
