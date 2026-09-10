/**
 * Temporal bindings and derived dueness (C4 domain half, pure).
 *
 * Tasks and events bind to temporal FINDINGS by reference ("Zdarzenie i
 * zadanie mogą korzystać z tej samej daty i źródła; nie utrzymują
 * rozbieżnych kopii wspólnego ustalenia"): the bound finding's CURRENT
 * revision is the only place the date lives. Everything here reads that
 * value in its wire form and derives; nothing here stores a verdict.
 *
 * Rules encoded here:
 *
 * - Deadline roles ("Value contracts": proposed / internal / agreed /
 *   actual): a task deadline is a term still ahead, so the three
 *   forward-looking roles bind; `actual` (faktyczne wykonanie) records
 *   when something happened and is not a deadline. An event's time may
 *   carry any role — a planned delivery has an agreed date, an occurred
 *   one an actual date.
 * - "Zadanie po terminie" (CONTEXT.md): an open task (not Wykonane, not
 *   Anulowane) whose term passed. A date-only term (day, month, year,
 *   range end) elapses AFTER THAT PERIOD ENDS IN THE COMPANY TIMEZONE —
 *   the comparison is between local calendar days, never between an
 *   invented midnight instant and the clock; a zoned date/time elapses
 *   at its instant. Czeka does not suspend it ("stan zadania Czeka nie
 *   przesuwa terminów").
 * - A term the memory does not currently KNOW (unknown / conflicted /
 *   not_applicable, or a value that stopped being temporal, or an
 *   open-ended range) is UNUSABLE, not overdue: "przypomnienie oparte na
 *   spornej, arbitralnie wybranej dacie pozostaje wstrzymane". Unusable
 *   is reported as its own outcome so consumers can show the obstacle.
 * - "Stan zdarzenia": a planned event whose time elapsed is reported as
 *   `planned_elapsed_unconfirmed` — still planned, visibly past its date,
 *   awaiting explicit occurrence or cancellation evidence. Nothing here
 *   produces an occurred verdict.
 */

import { Schema } from "effect";
import {
  FindingValue,
  type EventOccurrenceState,
  type KnowledgeState,
  type TaskState,
  type TemporalRole,
  type TemporalValue,
} from "@kiero/contracts";
import { localDateOfInstant } from "../findings/temporal";
import { isClosedTaskState } from "./taskState";

/** A temporal value as stored/transported (the contract's encoded form). */
export type TemporalValueWire = Schema.Codec.Encoded<typeof TemporalValue>;

/** A knowledge state as stored/transported (the contract's encoded form). */
export type KnowledgeStateWire = Schema.Codec.Encoded<typeof KnowledgeState>;

type DateOnlyWire = Extract<TemporalValueWire["shape"], { _tag: "day" | "month" | "year" }>;

const decodeFindingValue = Schema.decodeUnknownSync(FindingValue);
const encodeFindingValue = Schema.encodeSync(FindingValue);

/**
 * The temporal payload of one stored finding value, or null when the value
 * is not a temporal finding (or not a finding value at all). Goes through
 * the contract codec both ways, so the narrowing is checked, not cast.
 */
export function temporalValueOf(value: unknown): TemporalValueWire | null {
  let decoded: ReturnType<typeof decodeFindingValue>;
  try {
    decoded = decodeFindingValue(value);
  } catch {
    return null;
  }
  if (decoded._tag !== "temporal") {
    return null;
  }
  const wire = encodeFindingValue(decoded);
  return wire._tag === "temporal" ? wire.temporal : null;
}

// ---------------------------------------------------------------------------
// Binding-time role rules
// ---------------------------------------------------------------------------

/** The roles a task deadline may carry (a term still ahead). */
export const DEADLINE_ROLES: readonly TemporalRole[] = ["proposed", "internal", "agreed"];

/** What is being bound: a task's deadline or an event's known time. */
export type TemporalBindingKind = "task_deadline" | "event_time";

/** Outcome of checking one finding's current value for a binding. */
export type TemporalBindingCheck =
  | { readonly ok: true; readonly temporal: TemporalValueWire }
  | { readonly ok: false; readonly code: "finding_not_temporal" | "deadline_role_actual" };

/**
 * Checks that a finding's CURRENT value can be bound as a deadline or an
 * event time. The knowledge state is deliberately not checked here: a
 * conflicted or unknown term may still be THE referenced term (the
 * derivation below reports it unusable rather than overdue).
 */
export function checkTemporalBinding(
  kind: TemporalBindingKind,
  currentValue: unknown,
): TemporalBindingCheck {
  const temporal = temporalValueOf(currentValue);
  if (temporal === null) {
    return { ok: false, code: "finding_not_temporal" };
  }
  if (kind === "task_deadline" && temporal.role === "actual") {
    return { ok: false, code: "deadline_role_actual" };
  }
  return { ok: true, temporal };
}

// ---------------------------------------------------------------------------
// Term end and elapse
// ---------------------------------------------------------------------------

/**
 * When a term ends: the last LOCAL calendar day of a date-precision term
 * (the term elapses once that day is over in the company timezone), or an
 * exact instant for a zoned date/time.
 */
export type DueMoment =
  | { readonly _tag: "end_of_local_day"; readonly day: string }
  | { readonly _tag: "instant"; readonly epochMs: number };

/** The last calendar day (`YYYY-MM-DD`) of a `YYYY-MM` month. */
export function lastDayOfMonth(yearMonth: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (match === null) {
    throw new Error(`lastDayOfMonth: not a calendar month: ${yearMonth}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  // Day 0 of the next month is the last day of this month (UTC arithmetic
  // on a pure calendar value; no zone is involved).
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${match[1]}-${match[2]}-${String(last).padStart(2, "0")}`;
}

function endOfDateOnly(bound: DateOnlyWire): DueMoment {
  switch (bound._tag) {
    case "day":
      return { _tag: "end_of_local_day", day: bound.day };
    case "month":
      return { _tag: "end_of_local_day", day: lastDayOfMonth(bound.month) };
    case "year":
      return { _tag: "end_of_local_day", day: `${bound.year}-12-31` };
  }
}

/** Why a bound term cannot serve as a due moment. */
export type TermUnusableReason =
  | "unknown"
  | "conflicted"
  | "not_applicable"
  | "not_temporal"
  | "role_actual"
  | "open_ended"
  | "invalid_instant";

/**
 * The due moment of one temporal value: a range's END bound is its term
 * (an open end has no term to pass); a zoned date/time is parsed to its
 * instant from the ISO offset (the bracketed zone name is presentation).
 */
export function dueMomentOf(
  temporal: TemporalValueWire,
): { readonly ok: true; readonly due: DueMoment } | { readonly ok: false; readonly reason: "open_ended" | "invalid_instant" } {
  const shape = temporal.shape;
  switch (shape._tag) {
    case "day":
    case "month":
    case "year":
      return { ok: true, due: endOfDateOnly(shape) };
    case "range":
      if (shape.end === null) {
        return { ok: false, reason: "open_ended" };
      }
      return { ok: true, due: endOfDateOnly(shape.end) };
    case "date_time": {
      const iso = shape.value.replace(/\[[^\]]*\]$/, "");
      const epochMs = Date.parse(iso);
      if (Number.isNaN(epochMs)) {
        return { ok: false, reason: "invalid_instant" };
      }
      return { ok: true, due: { _tag: "instant", epochMs } };
    }
  }
}

/**
 * Whether a due moment has passed at `nowMs`, judged in the company
 * timezone: a local-day term has passed once today (in that zone) is a
 * LATER calendar day; an instant term has passed once the clock is past it.
 */
export function hasElapsed(due: DueMoment, nowMs: number, companyTimezone: string): boolean {
  switch (due._tag) {
    case "end_of_local_day":
      return localDateOfInstant(nowMs, companyTimezone) > due.day;
    case "instant":
      return nowMs > due.epochMs;
  }
}

// ---------------------------------------------------------------------------
// Derived task dueness
// ---------------------------------------------------------------------------

/** The bound finding's current knowledge state and (temporal) value. */
export interface TemporalBindingView {
  readonly knowledgeState: KnowledgeStateWire;
  /** Null when the current value is not temporal (the binding went stale). */
  readonly temporal: TemporalValueWire | null;
}

export interface TaskDuenessInput {
  readonly state: TaskState;
  /** Null when the task has no deadline binding. */
  readonly deadline: TemporalBindingView | null;
  readonly nowMs: number;
  readonly companyTimezone: string;
}

/**
 * The derived dueness of one task. `closed` tasks are never overdue; a
 * missing or unusable term is reported as such (never silently "fine");
 * `overdue` is "Zadanie po terminie" exactly as the glossary defines it.
 */
export type TaskDueness =
  | { readonly kind: "closed" }
  | { readonly kind: "no_deadline" }
  | { readonly kind: "term_unusable"; readonly reason: TermUnusableReason }
  | { readonly kind: "pending"; readonly due: DueMoment }
  | { readonly kind: "overdue"; readonly due: DueMoment };

function usableTerm(
  binding: TemporalBindingView,
  kind: TemporalBindingKind,
): { readonly ok: true; readonly due: DueMoment } | { readonly ok: false; readonly reason: TermUnusableReason } {
  if (binding.knowledgeState._tag !== "known") {
    return { ok: false, reason: binding.knowledgeState._tag };
  }
  if (binding.temporal === null) {
    return { ok: false, reason: "not_temporal" };
  }
  if (kind === "task_deadline" && binding.temporal.role === "actual") {
    return { ok: false, reason: "role_actual" };
  }
  return dueMomentOf(binding.temporal);
}

/** Derives dueness; a pure function of (record, bound term, now, zone). */
export function deriveTaskDueness(input: TaskDuenessInput): TaskDueness {
  if (isClosedTaskState(input.state)) {
    return { kind: "closed" };
  }
  if (input.deadline === null) {
    return { kind: "no_deadline" };
  }
  const term = usableTerm(input.deadline, "task_deadline");
  if (!term.ok) {
    return { kind: "term_unusable", reason: term.reason };
  }
  return hasElapsed(term.due, input.nowMs, input.companyTimezone)
    ? { kind: "overdue", due: term.due }
    : { kind: "pending", due: term.due };
}

// ---------------------------------------------------------------------------
// Derived event timing
// ---------------------------------------------------------------------------

export interface EventTimingInput {
  readonly state: EventOccurrenceState;
  /** Null when the event has no time binding. */
  readonly time: TemporalBindingView | null;
  readonly nowMs: number;
  readonly companyTimezone: string;
}

/**
 * The derived timing of one event. A planned event past its time is
 * `planned_elapsed_unconfirmed`: still planned, awaiting explicit evidence.
 * There is no outcome that says "occurred" unless the STATE says so.
 */
export type EventTiming =
  | { readonly kind: "occurred" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "planned_no_time" }
  | { readonly kind: "planned_time_unusable"; readonly reason: TermUnusableReason }
  | { readonly kind: "planned_upcoming"; readonly due: DueMoment }
  | { readonly kind: "planned_elapsed_unconfirmed"; readonly due: DueMoment };

/** Derives event timing; a pure function of (record, bound time, now, zone). */
export function deriveEventTiming(input: EventTimingInput): EventTiming {
  if (input.state === "occurred") {
    return { kind: "occurred" };
  }
  if (input.state === "cancelled") {
    return { kind: "cancelled" };
  }
  if (input.time === null) {
    return { kind: "planned_no_time" };
  }
  const term = usableTerm(input.time, "event_time");
  if (!term.ok) {
    return { kind: "planned_time_unusable", reason: term.reason };
  }
  return hasElapsed(term.due, input.nowMs, input.companyTimezone)
    ? { kind: "planned_elapsed_unconfirmed", due: term.due }
    : { kind: "planned_upcoming", due: term.due };
}
