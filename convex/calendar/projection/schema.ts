/**
 * Calendar projection and sync tables (candidate fragment, A2).
 *
 * Owning implementers: G2 (deterministic projection, personal scope),
 * G3 (reconciliation of writes, unknown outcomes, reconnects).
 * A copy mirrors one task deadline or event time into a personal calendar
 * and links back to the Kiero record. Hiding a copy is personal and never
 * cancels the underlying work. Unknown remote outcomes require
 * reconciliation; another POST is not automatically safe.
 *
 * Tables: calendarCopies, calendarSyncState.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../../schema/shared";
import { CalendarRemoteOutcome } from "@kiero/contracts";

// Vocabulary pin: the copy's remote outcome must equal the contracts-side
// CalendarRemoteOutcome literals exactly (unknown stays first-class), or this
// file fails typecheck.
const calendarRemoteOutcome: ValueValidator<Encoded<typeof CalendarRemoteOutcome>> =
  v.union(
    v.literal("confirmed"),
    v.literal("absent"),
    v.literal("unknown"),
  );

export const calendarProjectionTables = {
  /** One projected calendar entry for one user's connection. */
  calendarCopies: defineTable({
    connectionId: shared.calendarConnectionId,
    userId: shared.userId,
    subjectKind: v.union(v.literal("task"), v.literal("event")),
    taskId: v.optional(shared.taskId),
    eventId: v.optional(shared.workEventId),
    /** Remote id once known; absent while the first POST is unresolved. */
    googleEventId: v.optional(v.string()),
    /** Desired state follows this finding revision; drift triggers sync. */
    desiredRevisionId: shared.findingRevisionId,
    hidden: v.boolean(),
    remoteOutcome: calendarRemoteOutcome,
    updatedAtMs: shared.tsMs,
  })
    .index("by_connection", ["connectionId"])
    .index("by_task", ["taskId"])
    .index("by_event", ["eventId"]),

  /** Reconciliation cursor and pending state of one connection. */
  calendarSyncState: defineTable({
    connectionId: shared.calendarConnectionId,
    state: v.union(
      v.literal("idle"),
      v.literal("syncing"),
      v.literal("needs_reconcile"),
    ),
    cursor: v.optional(v.string()),
    lastSyncedAtMs: v.optional(shared.tsMs),
    updatedAtMs: shared.tsMs,
  }).index("by_connection", ["connectionId"]),
} as const;
