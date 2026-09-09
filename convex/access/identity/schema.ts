/**
 * Access identity tables (candidate fragment, A2).
 *
 * Owning implementer: B1 (sign-in and sessions), B2 (verified linking).
 * Identity is separate from membership: a user row is a person's account;
 * which company they act in lives in `memberships` (membership fragment).
 *
 * Tables: users, sessions.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const identityTables = {
  /** One person's account. Email identity for sign-in codes; Google subject for Google sign-in. */
  users: defineTable({
    email: v.string(),
    googleSubject: v.optional(v.string()),
    displayName: v.string(),
    createdAtMs: shared.tsMs,
  }).index("by_email", ["email"]),

  /** Live session device rows; revocation is immediate and audited (B1/B2). */
  sessions: defineTable({
    userId: shared.userId,
    startedAtMs: shared.tsMs,
    lastSeenAtMs: shared.tsMs,
    deviceLabel: v.string(),
    revokedAtMs: v.optional(shared.tsMs),
  })
    .index("by_user_started", ["userId", "startedAtMs"])
    .index("by_user_active", ["userId", "revokedAtMs"]),
} as const;
