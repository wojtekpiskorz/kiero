/**
 * Pure temporal resolution rules for findings (C2, "Value contracts":
 * temporal values; issue 8: "Daty względne").
 *
 * A relative expression ("jutro", "w piątek") is resolved ONCE, against the
 * SOURCE's immutable send time in the source's timezone snapshot — never
 * against the time the agent happens to run. The resolver therefore takes no
 * "now": the same (expression, sentAtMs, timezone) triple always yields the
 * same concrete calendar day, so a retry days later cannot move a resolved
 * date, and the stored TemporalValue keeps the original expression and its
 * precision (a day stays a day; no hour is ever invented).
 */

/** A calendar day, `YYYY-MM-DD`, verified against the real calendar. */
export type ResolvedDay = string;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Polish weekday names in ISO order (Monday first). */
const WEEKDAYS = [
  "poniedziałek",
  "wtorek",
  "środa",
  "czwartek",
  "piątek",
  "sobota",
  "niedziela",
] as const;

const SIMPLE_OFFSETS: Readonly<Record<string, number>> = {
  "przedwczoraj": -2,
  "wczoraj": -1,
  "dziś": 0,
  "dzisiaj": 0,
  "jutro": 1,
  "pojutrze": 2,
};

/**
 * The local calendar date of one instant in one IANA zone, as `YYYY-MM-DD`.
 * Uses the zone's actual rules (DST included); pure in (instant, zone).
 */
export function localDateOfInstant(epochMs: number, timeZone: string): ResolvedDay {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.format(new Date(epochMs));
  return parts; // en-CA numeric formatting is exactly YYYY-MM-DD.
}

/**
 * Adds whole days to a `YYYY-MM-DD` date, staying on the calendar (UTC-noon
 * arithmetic cannot cross a DST boundary into another date).
 */
export function addDays(day: ResolvedDay, days: number): ResolvedDay {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new Error(`addDays: not a calendar day: ${day}`);
  }
  const utcNoon = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0,
  );
  return new Date(utcNoon + days * DAY_MS).toISOString().slice(0, 10);
}

/** The ISO weekday (1 = Monday … 7 = Sunday) of a `YYYY-MM-DD` date. */
export function isoWeekday(day: ResolvedDay): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new Error(`isoWeekday: not a calendar day: ${day}`);
  }
  const utcNoon = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    12,
    0,
    0,
  );
  const sundayBased = new Date(utcNoon).getUTCDay(); // 0 = Sunday
  return sundayBased === 0 ? 7 : sundayBased;
}

// ---------------------------------------------------------------------------
// Wall-clock instants (DST-correct through Intl).
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

/** The wall-clock parts of one instant in one timezone. */
function wallTimeAt(instantMs: number, timeZone: string): WallTimeParts {
  const parts = wallTimeFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: string): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      // Unreachable for the part types requested above; fail loudly.
      throw new Error(`temporal: missing ${type} part`);
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
 * The instant of one wall-clock minute on one calendar day in a timezone:
 * the exact inverse of `localDateOfInstant` at whole minutes. Two-pass
 * (guess the offset, correct, re-check) so a minute inside or beside a DST
 * transition resolves the way schedulers expect. One definition shared by
 * every scheduling reader of this package (F1's quiet-hours windows and
 * F4's reminder slots); private per-lane copies would drift.
 */
export function instantOfLocalMinute(
  day: ResolvedDay,
  minuteOfDay: number,
  timeZone: string,
): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new Error(`instantOfLocalMinute: not a calendar day: ${day}`);
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

/** The outcome of trying to read one relative expression. */
export type RelativeResolution =
  | { readonly matched: true; readonly day: ResolvedDay; readonly offsetDays: number }
  | { readonly matched: false; readonly reason: "unrecognized_expression" };

/**
 * Resolves one relative expression against the anchor (source send day in the
 * source's timezone). Bounded vocabulary: day words, weekdays ("w piątek" /
 * "piątek" mean the NEXT such weekday, at least tomorrow) and "za N dni" /
 * "za tydzień / dwa tygodnie". Anything else is unmatched — it becomes an
 * explicit question, never a guessed date.
 */
export function resolveRelativeDay(
  originalExpression: string,
  sentAtMs: number,
  timeZone: string,
): RelativeResolution {
  const normalized = originalExpression
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const anchorDay = localDateOfInstant(sentAtMs, timeZone);

  const simple = SIMPLE_OFFSETS[normalized];
  if (simple !== undefined) {
    return { matched: true, day: addDays(anchorDay, simple), offsetDays: simple };
  }

  const weekdayForm = /^(?:w|we)\s+([a-ząćęłńóśźż]+)$/u.exec(normalized);
  const bareWeekday = weekdayForm === null ? normalized : weekdayForm[1];
  const weekdayIndex = WEEKDAYS.findIndex((name) => name === bareWeekday);
  if (weekdayIndex !== -1) {
    const target = weekdayIndex + 1;
    const ahead = (target - isoWeekday(anchorDay) + 7) % 7;
    // "w piątek" said on a Friday is the NEXT Friday, not today: a bare
    // weekday names a day still coming.
    const offset = ahead === 0 ? 7 : ahead;
    return { matched: true, day: addDays(anchorDay, offset), offsetDays: offset };
  }

  const inDays = /^za\s+(\d+)\s+dni$/u.exec(normalized);
  if (inDays !== null) {
    const count = Number(inDays[1]);
    if (count > 0 && count <= 365) {
      return { matched: true, day: addDays(anchorDay, count), offsetDays: count };
    }
    return { matched: false, reason: "unrecognized_expression" };
  }

  const inWeeks = /^za\s+(?:dwa|trzy|cztery)\s+tygodni[ye]$/u.exec(normalized);
  if (inWeeks !== null) {
    const words: Readonly<Record<string, number>> = { "dwa": 2, "trzy": 3, "cztery": 4 };
    const weeks = words[inWeeks[1] ?? ""];
    if (weeks !== undefined) {
      const offset = weeks * 7;
      return { matched: true, day: addDays(anchorDay, offset), offsetDays: offset };
    }
  }

  const inOneWeek = /^za\s+tydzień$/u.exec(normalized);
  if (inOneWeek !== null) {
    return { matched: true, day: addDays(anchorDay, 7), offsetDays: 7 };
  }

  // "w X dni" is intentionally not folded into "za X dni": only the listed
  // forms are trusted; everything else asks.
  return { matched: false, reason: "unrecognized_expression" };
}

/** Whether an expression is covered by the bounded relative vocabulary. */
export function isRelativeExpression(originalExpression: string): boolean {
  return resolveRelativeDay(originalExpression, 0, "UTC").matched;
}
