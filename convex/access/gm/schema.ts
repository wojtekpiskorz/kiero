/**
 * Audited GM access tables (A2 candidate, certified by A3).
 *
 * Owning implementer: B4 (explicit audited GM access). GM is a global
 * operator permission separate from company membership; entry is explicit,
 * reason-carrying and audited, and GM activity stays out of alpha success
 * metrics.
 *
 * Tables: gmAccessGrants.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const gmTables = {
  /** One audited GM mode interval. Open grants are the current GM sessions. */
  gmAccessGrants: defineTable({
    userId: shared.userId,
    reason: v.string(),
    enteredAtMs: shared.tsMs,
    closedAtMs: v.optional(shared.tsMs),
  })
    .index("by_user_open", ["userId", "closedAtMs"])
    .index("by_entered", ["enteredAtMs"]),
} as const;
