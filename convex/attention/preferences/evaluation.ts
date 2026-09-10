/**
 * Personal notification-preference evaluation (F1): the PURE seam F2/F4
 * consume at delivery time (issue 41: "Provide query functions for unread
 * projections and delivery eligibility").
 *
 * Everything here is deterministic over its inputs — no Convex, no clock,
 * no environment — so the quiet-hour windows, the DST boundaries of the
 * company timezone and the suppression matrix are unit-testable without a
 * deployment (tests/f1/preferences.test.ts) while F2 re-runs the SAME
 * functions inside its evaluator with live rows.
 *
 * Semantics pinned by the accepted notification decision (issue 7
 * resolution) and CONTEXT.md:
 *
 * - Quiet hours DEFER push delivery; information stays available in the
 *   app ("Godziny ciszy": Kiero odkłada wysyłkę push).
 * - The window is interpreted in the COMPANY timezone, never the device's
 *   ("Strefa czasu firmy": nie zmienia się ze strefą telefonu), so the
 *   minute-of-day computation is DST-correct through Intl.
 * - The default window is 20:00–06:00 for every boss until changed
 *   personally ("Domyślne godziny ciszy to 20:00–6:00 każdego dnia").
 * - Reading does not complete a task and does not suppress task reminders
 *   ("Przeczytanie rozmowy ... nie wyłącza dalszych przypomnień"), while an
 *   already-seen source entry leaves the notification batch.
 * - The author is not notified of their own entry, but MAY be notified of
 *   an agent clarification about it.
 * - Conversation mutes apply to source-entry notifications by scope;
 *   task-reminder mute is a separate personal control (F4's evaluation
 *   consumes the same stored field).
 */

/** A quiet-hours window as minute-of-day bounds [start, end) in local time. */
export interface QuietHoursWindow {
  readonly startMinuteOfDay: number;
  readonly endMinuteOfDay: number;
}

/** The company default window (issue 7: 20:00–06:00, wrapping midnight). */
export const DEFAULT_QUIET_HOURS: QuietHoursWindow = {
  startMinuteOfDay: 20 * 60,
  endMinuteOfDay: 6 * 60,
};

/** The neutral personal settings every unset preference resolves to. */
export const DEFAULT_PERSONAL_SETTINGS = {
  mutedProjectIds: [] as readonly string[],
  companyEntriesMuted: false,
  taskRemindersMuted: false,
  hidePreviewContent: false,
} as const;

/** The stored personal settings shape the evaluation consumes. */
export interface PersonalNotificationSettings {
  readonly mutedProjectIds: readonly string[];
  readonly companyEntriesMuted: boolean;
  readonly taskRemindersMuted: boolean;
  readonly hidePreviewContent: boolean;
  /**
   * The personal quiet-hours override. `null` means "not set", which
   * resolves to the company default window (never to "no quiet hours":
   * the decision defines the default as always present until changed).
   */
  readonly quietHours: QuietHoursWindow | null;
}

/** What kind of attention delivery is being decided. */
export type DeliveryKind =
  | "source_entry"
  | "clarification"
  | "task_reminder";

/** How the entry being notified was classified for this recipient. */
export type EntryScope = "project" | "company";

/** The inputs of one personal delivery decision. */
export interface DeliveryDecisionInput {
  readonly kind: DeliveryKind;
  readonly scope: EntryScope;
  /** Projects the entry is linked to (empty for company entries). */
  readonly projectIds: readonly string[];
  /** Whether the recipient authored the underlying source entry. */
  readonly isAuthor: boolean;
  /**
   * Current read state of the underlying source entry for this person
   * (attention read-state row; task reminders deliberately ignore it).
   */
  readonly read: boolean;
  readonly nowMs: number;
  /** The company timezone the quiet-hours window is interpreted in. */
  readonly companyTimezone: string;
  readonly settings: PersonalNotificationSettings | null;
}

/** One personal delivery decision: send, suppress, or defer to an instant. */
export type PersonalDeliveryDecision =
  | { readonly decision: "eligible" }
  | {
      readonly decision: "suppressed";
      readonly reason:
        | "own_entry"
        | "already_read"
        | "muted_project"
        | "muted_company_entries"
        | "muted_task_reminders";
    }
  | {
      readonly decision: "deferred";
      readonly reason: "quiet_hours";
      /** The instant the quiet-hours window ends (re-evaluate then). */
      readonly untilMs: number;
    };

// ---------------------------------------------------------------------------
// Company-timezone wall-clock arithmetic (DST-correct through Intl).
// ---------------------------------------------------------------------------

/** Parts of one wall-clock time, as produced by Intl in a timezone. */
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
  // `h23` keeps 0-23 hours (no 24:00) so minuteOfDay is always 0-1439.
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

/** Whether a timezone name is a real IANA zone (fail closed for callers). */
export function isValidTimezone(zone: string): boolean {
  try {
    wallTimeFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of one instant in one timezone. */
function wallTimeAt(instantMs: number, timeZone: string): WallTimeParts {
  const parts = wallTimeFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      // Unreachable for the part types requested above; fail loudly.
      throw new Error(`evaluation: missing ${type} part`);
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

/**
 * The minute-of-day of one instant in one timezone (0-1439). DST-correct:
 * the wall time comes from Intl at that exact instant, so both offsets of a
 * fall-back night resolve to their own local minutes.
 */
export function minuteOfDayInZone(instantMs: number, timeZone: string): number {
  return wallTimeAt(instantMs, timeZone).minuteOfDay;
}

/** The UTC offset of one timezone at one instant, in milliseconds. */
function timezoneOffsetMs(instantMs: number, timeZone: string): number {
  const wall = wallTimeAt(instantMs, timeZone);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, 0, wall.minuteOfDay);
  return wallAsUtc - (instantMs - (instantMs % 60_000));
}

/**
 * Converts a wall-clock time in a timezone to its UTC instant. Two-pass
 * (guess the offset, correct, re-check) so times inside a DST transition
 * night resolve to the closer instant the way schedulers expect.
 */
function wallTimeToInstantMs(
  wall: Omit<WallTimeParts, "minuteOfDay"> & { readonly minuteOfDay: number },
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, 0, wall.minuteOfDay);
  const firstGuess = wallAsUtc - timezoneOffsetMs(wallAsUtc, timeZone);
  const secondGuess = wallAsUtc - timezoneOffsetMs(firstGuess, timeZone);
  return secondGuess;
}

/**
 * Whether a minute-of-day sits inside a quiet-hours window. The window is
 * half-open [start, end): the start minute is quiet, the end minute is not.
 * A window may wrap midnight (20:00–06:00).
 */
export function isWithinQuietHours(minuteOfDay: number, window: QuietHoursWindow): boolean {
  if (window.startMinuteOfDay === window.endMinuteOfDay) {
    // A degenerate window means "the whole day is quiet" under half-open
    // bounds only when it wraps; the personal-change operation rejects
    // equal bounds, so this arm is unreachable from stored settings and
    // exists only to keep the pure function total.
    return true;
  }
  if (window.startMinuteOfDay < window.endMinuteOfDay) {
    return minuteOfDay >= window.startMinuteOfDay && minuteOfDay < window.endMinuteOfDay;
  }
  // Wrapping window (e.g. 20:00–06:00): quiet after start OR before end.
  return minuteOfDay >= window.startMinuteOfDay || minuteOfDay < window.endMinuteOfDay;
}

/** The quiet-hours window that currently applies for one person. */
export function effectiveQuietHours(
  settings: PersonalNotificationSettings | null,
): QuietHoursWindow {
  return settings?.quietHours ?? DEFAULT_QUIET_HOURS;
}

/**
 * The next instant at or after `nowMs` whose local minute equals the
 * window's end minute: the moment quiet hours stop deferring delivery.
 * Searches forward across up to three local days, so a DST shift inside
 * the night resolves to the correct absolute instant. Candidates are
 * minute-aligned (wall-clock precision): an instant already inside the end
 * minute returns that minute's start.
 */
export function nextQuietHoursEndMs(
  nowMs: number,
  timeZone: string,
  window: QuietHoursWindow,
): number {
  const wall = wallTimeAt(nowMs, timeZone);
  for (let dayOffset = 0; dayOffset < 4; dayOffset += 1) {
    const dayStartUtc = Date.UTC(wall.year, wall.month - 1, wall.day, 0, 0) + dayOffset * 86_400_000;
    // Normalize through Date.UTC to let month/day overflow correctly.
    const normalized = new Date(dayStartUtc);
    const candidate = wallTimeToInstantMs(
      {
        year: normalized.getUTCFullYear(),
        month: normalized.getUTCMonth() + 1,
        day: normalized.getUTCDate(),
        minuteOfDay: window.endMinuteOfDay,
      },
      timeZone,
    );
    if (candidate >= nowMs) {
      return candidate;
    }
  }
  // Unreachable: four local days always contain the end minute after now.
  throw new Error("evaluation: quiet-hours end not found within four days");
}

// ---------------------------------------------------------------------------
// The personal delivery decision (the eligibility seam).
// ---------------------------------------------------------------------------

/**
 * Decides one notification's personal delivery: eligible now, suppressed by
 * a personal control, or deferred until quiet hours end. ORDER matters and
 * mirrors the decision text: suppression reasons are checked before the
 * quiet-hours deferral so a suppressed notification is never deferred (and
 * a deferred one is re-evaluated by F2 after the window, when a read or
 * mute can still suppress it).
 */
export function decidePersonalDelivery(input: DeliveryDecisionInput): PersonalDeliveryDecision {
  const settings = input.settings ?? {
    ...DEFAULT_PERSONAL_SETTINGS,
    quietHours: null,
  };

  // The author is not notified of their own entry (but may be notified of
  // an agent clarification about it, or of their own task's reminder).
  if (input.kind === "source_entry" && input.isAuthor) {
    return { decision: "suppressed", reason: "own_entry" };
  }

  // Reading removes a source entry from the notification batch; it never
  // suppresses task reminders ("reading a source does not complete a task").
  if (input.kind !== "task_reminder" && input.read) {
    return { decision: "suppressed", reason: "already_read" };
  }

  // Conversation mutes apply to source-entry notifications by scope. A
  // mixed-project source is muted when the recipient muted ANY of its
  // projects ("trzeba uwzględnić obserwowanie i wyciszenia odbiorcy");
  // company entries carry their own separate personal mute.
  if (input.kind === "source_entry") {
    if (input.scope === "project") {
      const muted = new Set(settings.mutedProjectIds);
      if (input.projectIds.some((projectId) => muted.has(projectId))) {
        return { decision: "suppressed", reason: "muted_project" };
      }
    } else if (settings.companyEntriesMuted) {
      return { decision: "suppressed", reason: "muted_company_entries" };
    }
  }

  // The task-reminder mute is the separate personal control F4 evaluates
  // with the same stored field.
  if (input.kind === "task_reminder" && settings.taskRemindersMuted) {
    return { decision: "suppressed", reason: "muted_task_reminders" };
  }

  // Quiet hours defer push delivery in the company timezone; the window
  // never hides information in the app, so this is a deferral, not a
  // suppression.
  const window = effectiveQuietHours(input.settings);
  const minute = minuteOfDayInZone(input.nowMs, input.companyTimezone);
  if (isWithinQuietHours(minute, window)) {
    return {
      decision: "deferred",
      reason: "quiet_hours",
      untilMs: nextQuietHoursEndMs(input.nowMs, input.companyTimezone, window),
    };
  }
  return { decision: "eligible" };
}
