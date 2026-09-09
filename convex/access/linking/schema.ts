/**
 * Access linking tables (B2 fragment).
 *
 * Owning implementer: B2 (verified account linking, email change, manual
 * recovery). The linking ceremony is EXPLICIT state, never derived from
 * email equality (docs/research/auth-identity-facts.md): one row per
 * attempt records which method proofs are fresh, and the commit transition
 * happens exactly once per attempt. Convex optimistic concurrency over the
 * row (and the by-email index range a begin reads before inserting)
 * serializes concurrent attempts; there is no second linkage flag anywhere.
 *
 * - `linkingAttempts`: the ceremony ledger. A commit writes
 *   `users.googleSubject` (google direction) or inserts the email-code
 *   provider account (email direction) in the SAME transaction that flips
 *   the row to `committed`, so a failed attempt leaves no partial writes.
 * - `emailChangeRequests`: pending address changes. A confirmation moves
 *   `users.email`, repoints the email-code provider account and rejects
 *   pending ceremonies atomically; a failed confirmation writes nothing.
 * - `accountRecoveries`: the manual-recovery audit record ("podstawa
 *   weryfikacji" + who performed it + what was invalidated). B2 defines
 *   the checked recovery command and keeps its invoker unavailable; B4
 *   supplies the only alpha GM authority.
 *
 * Tables: linkingAttempts, emailChangeRequests, accountRecoveries.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

/** The two sign-in methods a ceremony can attach ("metoda logowania"). */
const linkMethod = v.union(v.literal("google"), v.literal("email_code"));

/** Ceremony lifecycle: proofs pend, the commit is terminal-good. */
const attemptState = v.union(
  /** Waiting for the fresh proof of the account's existing method. */
  v.literal("awaiting_first_proof"),
  /** First proof fresh; waiting for the target-method proof. */
  v.literal("awaiting_target_proof"),
  /** Both proofs done; the methods share one account. */
  v.literal("committed"),
  /** Abandoned, cancelled, superseded or invalidated by recovery. */
  v.literal("rejected"),
);

export const linkingTables = {
  /**
   * One explicit linking ceremony ("łączenie metod"). `email` is the ONE
   * canonical normalized address BOTH methods must prove: the existing
   * method's proof is a fresh code to it, the target method's proof must
   * carry the same address. Attempts are unique per email among active
   * states by construction (begin reads the by_email_state range it then
   * inserts into, so concurrent begins serialize through OCC).
   */
  linkingAttempts: defineTable({
    userId: shared.userId,
    /** The canonical address both methods prove (normalized). */
    email: v.string(),
    /** The method the account already signs in with. */
    initiatingMethod: linkMethod,
    /** The method this ceremony attaches. */
    targetMethod: linkMethod,
    state: attemptState,
    startedAtMs: shared.tsMs,
    /** The whole ceremony (both proofs) must complete inside this window. */
    expiresAtMs: shared.tsMs,
    /** When the initiating method was re-proven fresh (code or OAuth). */
    firstProofAtMs: v.optional(shared.tsMs),
    /** sha256 of the one-time code sent for the pending proof leg. */
    pendingCodeHash: v.optional(v.string()),
    pendingCodeExpiresAtMs: v.optional(shared.tsMs),
    /** The proven Google subject, recorded at commit (google direction). */
    googleSub: v.optional(v.string()),
    committedAtMs: v.optional(shared.tsMs),
    rejectedAtMs: v.optional(shared.tsMs),
    /** Machine-readable rejection cause (auditable, no prose). */
    rejectionCode: v.optional(v.string()),
  })
    .index("by_user_started", ["userId", "startedAtMs"])
    .index("by_email_state", ["email", "state"])
    .index("by_state_started", ["state", "startedAtMs"]),

  /**
   * One pending email-address change: requires recent authentication (the
   * device session started within RECENT_AUTH_MS) plus a code sent to the
   * NEW address. One active request per user; confirmation is atomic and
   * a failed confirmation leaves the old method and sessions untouched.
   */
  emailChangeRequests: defineTable({
    userId: shared.userId,
    /** The requested new address (normalized). */
    newEmail: v.string(),
    /** The address at request time (audit; the move's "from"). */
    previousEmail: v.string(),
    codeHash: v.string(),
    requestedAtMs: shared.tsMs,
    expiresAtMs: shared.tsMs,
    confirmedAtMs: v.optional(shared.tsMs),
  }).index("by_user_requested", ["userId", "requestedAtMs"]),

  /**
   * The manual-recovery ledger ("odzyskanie konta"): verification basis,
   * performer, and exactly what was invalidated. The users row (and with
   * it every membership and authored record) survives; only sessions and
   * method credentials are cleared, so the person must set up a fresh
   * sign-in method while historical actor ids stay stable.
   */
  accountRecoveries: defineTable({
    userId: shared.userId,
    /** GM-recorded verification basis (what proved the person's identity). */
    verificationBasis: v.string(),
    /** Who performed the recovery (GM actor id; "dev-proof" for guarded evidence). */
    performedBy: v.string(),
    performedAtMs: shared.tsMs,
    /** Registry rows revoked by this recovery. */
    revokedSessionIds: v.array(shared.sessionId),
    /** Provider account rows deleted (fresh method setup required). */
    clearedAccountIds: v.array(v.id("authAccounts")),
    /** Whether the linked Google subject was detached. */
    clearedGoogleSubject: v.boolean(),
  }).index("by_user_time", ["userId", "performedAtMs"]),
} as const;
