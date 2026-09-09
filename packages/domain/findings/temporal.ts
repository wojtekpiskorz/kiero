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
