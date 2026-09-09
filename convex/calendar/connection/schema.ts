/**
 * Calendar connection table (candidate fragment, A2).
 *
 * Owning implementer: G1 (optional authorization and connection lifecycle).
 * Connection lifecycle is separate from sign-in: a boss connects a personal
 * dedicated Google calendar ("Kalendarz Kiero w Google"). Kiero holds the
 * authoritative agreements; the calendar only projects them one way.
 *
 * Tables: calendarConnections.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const calendarConnectionTables = {
  /** One boss's optional dedicated Google calendar connection. */
  calendarConnections: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    googleCalendarId: v.string(),
    state: v.union(
      v.literal("connected"),
      v.literal("disconnected"),
      v.literal("error"),
    ),
    connectedAtMs: shared.tsMs,
    disconnectedAtMs: v.optional(shared.tsMs),
  })
    .index("by_user", ["userId"])
    .index("by_company", ["companyId"]),
} as const;
