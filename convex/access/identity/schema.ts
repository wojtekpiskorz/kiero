/**
 * Access identity tables (A2 candidate, certified by A3; B1 amendment).
 *
 * Owning implementer: B1 (sign-in and sessions), B2 (verified linking).
 * Identity is separate from membership: a user row is a person's account;
 * which company they act in lives in `memberships` (membership fragment).
 *
 * B1 amendment (Convex Auth integration, candidate per Q186):
 *
 * - `users` is the SINGLE person table shared with Convex Auth: the library
 *   reads/writes it through this fragment's fields and the required `email`
 *   index (`email` + `_creationTime`). All user writes still go through
 *   B1's `createOrUpdateUser` policy (./userPolicy.ts); the library's
 *   implicit same-email linking is never used.
 * - `sessions` is the app-owned live-session registry ("sesje urządzeń"):
 *   one row per device session, with trusted activity time and explicit
 *   revocation state. It is keyed by the Convex Auth `authSessions` id it
 *   mirrors; service-bridge sessions (A3) carry no `authSessionId`.
 * - The `auth*` tables are the Convex Auth provider tables, registered here
 *   so the deployment owns them in one fragment. They are internal to the
 *   auth integration: no Kiero operation exposes them directly (the
 *   architecture keeps provider tables owned by their package).
 *
 * Tables: users, sessions, authSessions, authAccounts, authRefreshTokens,
 * authVerificationCodes, authVerifiers, authRateLimits.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { shared } from "../../schema/shared";

/**
 * The Convex Auth provider tables, taken verbatim from the pinned library.
 * `users` is intentionally NOT taken from the library: the Kiero `users`
 * table above extends the same shape with app-owned required fields, and
 * the library's own definition of that table is looser than the inventory.
 */
const {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- named for clarity: `users` is defined below, not reused
  users: _libraryUsers,
  ...providerTables
} = authTables;

export const identityTables = {
  /**
   * One person's account ("Szef" is a person, not an account of a company).
   * Email identity for sign-in codes; Google subject for Google sign-in.
   * Email-code and Google identities are never auto-linked by address
   * (docs/research/auth-identity-facts.md); verified linking is B2's.
   */
  users: defineTable({
    email: v.string(),
    googleSubject: v.optional(v.string()),
    displayName: v.string(),
    /** When the email address was proven (email-code verification time). */
    emailVerificationTime: v.optional(v.float64()),
    createdAtMs: shared.tsMs,
  })
    // App-side by-email read; `createdAtMs` only breaks the tie with the
    // library's same-prefix `email` index (Convex rejects duplicate-field
    // indexes, and prefix equality is what queries rely on).
    .index("by_email", ["email", "createdAtMs"])
    // Required by Convex Auth's user lookup (`_creationTime` is appended
    // automatically by Convex, so the field list is just `email`).
    .index("email", ["email"]),

  /**
   * Live session device rows; revocation is immediate and audited (B1/B2).
   * `lastSeenAtMs` is trusted activity time: bumped by authenticated
   * writes, checked against the 30-day inactivity rule on every resolution.
   */
  sessions: defineTable({
    userId: shared.userId,
    startedAtMs: shared.tsMs,
    lastSeenAtMs: shared.tsMs,
    deviceLabel: v.string(),
    /** The mirrored Convex Auth session; absent for service-bridge sessions. */
    authSessionId: v.optional(v.id("authSessions")),
    revokedAtMs: v.optional(shared.tsMs),
  })
    .index("by_user_started", ["userId", "startedAtMs"])
    .index("by_user_active", ["userId", "revokedAtMs"])
    .index("by_authSession", ["authSessionId"]),

  ...providerTables,
} as const;
