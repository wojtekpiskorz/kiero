/**
 * Temporal value contract ("Value contracts", architecture design).
 *
 * Rules encoded here:
 *
 * - Local date, zoned date/time and range are distinct shapes. A date known
 *   only to a month or year never invents a day; a date without a time never
 *   invents an hour.
 * - A zoned date/time carries the zone and resolves to an instant (Effect
 *   `DateTime.Zoned`), stored/encoded as an ISO string with offset and IANA
 *   zone.
 * - The original expression ("jutro", "koniec stycznia") is preserved, plus
 *   precision and role: proposed / internal / agreed / actual.
 * - Ranges keep justified bounds; an open bound stays open (encoded `null`).
 *
 * Candidate contract until A3 certifies the runtime conversion.
 */

import { Schema } from "effect";

const isCalendarDay = (value: string): value is string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const isLeapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const days = daysInMonth[month - 1];
  return month >= 1 && month <= 12 && days !== undefined && day >= 1 && day <= days;
};

/** Calendar day without any time or zone: `YYYY-MM-DD`, verified against the calendar. */
export const LocalDate = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  Schema.refine(isCalendarDay),
  Schema.brand("LocalDate"),
);
export type LocalDate = Schema.Schema.Type<typeof LocalDate>;

/** Calendar month without a day: `YYYY-MM`. */
export const YearMonth = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-(0[1-9]|1[0-2])$/)),
  Schema.brand("YearMonth"),
);
export type YearMonth = Schema.Schema.Type<typeof YearMonth>;

/** Calendar year without a month: `YYYY`. */
export const YearValue = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}$/)),
  Schema.brand("YearValue"),
);
export type YearValue = Schema.Schema.Type<typeof YearValue>;

/** A date whose precision is explicit; no component is invented. */
export const DateOnly = Schema.TaggedUnion({
  day: { day: LocalDate },
  month: { month: YearMonth },
  year: { year: YearValue },
});
export type DateOnly = Schema.Schema.Type<typeof DateOnly>;

/**
 * Zoned date/time with resolved instant ("when justified"). Encoded as an
 * ISO-8601 string carrying offset and named zone, e.g.
 * `2026-01-05T10:30:00.000+01:00[Europe/Warsaw]`; decoded to an exact
 * `DateTime.Zoned` value, so the instant is computed, never parsed twice.
 */
export const ZonedDateTime = Schema.DateTimeZonedFromString;
export type ZonedDateTime = Schema.Schema.Type<typeof ZonedDateTime>;

const RangeBounds = Schema.TaggedStruct("range", {
  start: Schema.NullOr(DateOnly),
  end: Schema.NullOr(DateOnly),
});
type RangeBounds = Schema.Schema.Type<typeof RangeBounds>;

const hasAtLeastOneBound = (value: RangeBounds): value is RangeBounds =>
  value.start !== null || value.end !== null;

/**
 * A range of dates; a bound of `null` is open and stays open. Tagged like
 * the other variants so `TemporalValue.shape` is uniformly discriminable on
 * `_tag` (day | month | year | date_time | range).
 */
export const DateRange = RangeBounds.pipe(Schema.refine(hasAtLeastOneBound));
export type DateRange = Schema.Schema.Type<typeof DateRange>;

/** Meaning of a temporal statement (see issue 8: propozycja / wewnętrzny plan / uzgodniony / faktyczny). */
export const TemporalRole = Schema.Literals([
  "proposed",
  "internal",
  "agreed",
  "actual",
]);
export type TemporalRole = Schema.Schema.Type<typeof TemporalRole>;

/** One temporal finding value: shape + original words + precision + role. */
export const TemporalValue = Schema.Struct({
  shape: Schema.Union([DateOnly, Schema.TaggedStruct("date_time", { value: ZonedDateTime }), DateRange]),
  originalExpression: Schema.NonEmptyString,
  role: TemporalRole,
});
export type TemporalValue = Schema.Schema.Type<typeof TemporalValue>;
