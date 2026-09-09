/**
 * Calendar module surface (architecture "Deep modules": Integrations — the
 * Calendar half; see CONTEXT.md "Kalendarz Kiero w Google").
 * Implements lanes: G1 (connection), G2 (projection), G3 (reconciliation).
 *
 * Kiero → Google one-way projection into a dedicated personal calendar.
 * Actual agreements stay in Kiero. Unknown remote outcomes require
 * reconciliation; another POST is not automatically safe. A personal hide
 * affects only that boss's copy.
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { operationEntry, eventEntry } from "./registration";

/** What a calendar copy projects: a task's deadline or an event's time. */
export const CalendarSubject = Schema.TaggedUnion({
  task: { taskId: tableIdSchema("tasks") },
  event: { eventId: tableIdSchema("events") },
});
export type CalendarSubject = Schema.Schema.Type<typeof CalendarSubject>;

export const calendarOperations = {
  "calendar.connectCalendar": operationEntry({
    kind: "operation",
    name: "calendar.connectCalendar",
    input: Schema.Struct({
      /** Dedicate Google calendar id created on the user's account. */
      googleCalendarId: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ connectionId: tableIdSchema("calendarConnections") }),
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "calendar.disconnectCalendar": operationEntry({
    kind: "operation",
    name: "calendar.disconnectCalendar",
    input: Schema.Struct({ connectionId: tableIdSchema("calendarConnections") }),
    result: Schema.Struct({ connectionId: tableIdSchema("calendarConnections") }),
    errorKinds: ["forbidden", "not_found"],
  }),
  "calendar.setCopyHidden": operationEntry({
    kind: "operation",
    name: "calendar.setCopyHidden",
    input: Schema.Struct({
      copyId: tableIdSchema("calendarCopies"),
      hidden: Schema.Boolean,
    }),
    result: Schema.Struct({ copyId: tableIdSchema("calendarCopies") }),
    errorKinds: ["forbidden", "not_found"],
  }),
  "calendar.reconcileCopy": operationEntry({
    kind: "operation",
    name: "calendar.reconcileCopy",
    input: Schema.Struct({ copyId: tableIdSchema("calendarCopies") }),
    result: Schema.Struct({
      copyId: tableIdSchema("calendarCopies"),
      remoteOutcome: Schema.Literals(["confirmed", "absent", "unknown"]),
    }),
    errorKinds: ["forbidden", "not_found", "unavailable"],
  }),
} as const;

export const calendarEvents = {
  "calendar.connected": eventEntry({
    kind: "event",
    name: "calendar.connected",
    payload: Schema.Struct({
      connectionId: tableIdSchema("calendarConnections"),
      userId: tableIdSchema("users"),
    }),
  }),
  "calendar.disconnected": eventEntry({
    kind: "event",
    name: "calendar.disconnected",
    payload: Schema.Struct({ connectionId: tableIdSchema("calendarConnections") }),
  }),
  "calendar.copyProjected": eventEntry({
    kind: "event",
    name: "calendar.copyProjected",
    payload: Schema.Struct({
      copyId: tableIdSchema("calendarCopies"),
      subject: CalendarSubject,
      desiredRevisionId: tableIdSchema("findingRevisions"),
    }),
  }),
  "calendar.copyOutcomeRecorded": eventEntry({
    kind: "event",
    name: "calendar.copyOutcomeRecorded",
    payload: Schema.Struct({
      copyId: tableIdSchema("calendarCopies"),
      outcome: Schema.Literals(["confirmed", "absent", "unknown"]),
    }),
  }),
} as const;
