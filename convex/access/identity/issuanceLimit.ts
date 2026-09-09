/**
 * Per-identifier issuance throttle for sign-in code emails (B1).
 *
 * @convex-dev/auth 0.0.95 rate-limits VERIFICATION failures
 * (`authRateLimits` via `isSignInRateLimited`) but not code ISSUANCE:
 * every `signIn("email_code", { email })` sends an email, so an
 * unauthenticated client could bomb arbitrary addresses and drain the
 * Resend quota. This module is the missing send-side gate.
 *
 * Mechanism: one `authRateLimits` row per identifier
 * (`issuance:email_code:<normalized email>` — the `issuance:` prefix
 * keeps it disjoint from the library's verification rows, which use the
 * bare address). Budget of ISSUANCE_MAX_ATTEMPTS sends, recovering one
 * slot every ISSUANCE_RECOVERY_INTERVAL_MS. Blocked attempts do NOT
 * rewrite the row (otherwise a blocked caller would keep pushing the
 * recovery window and starve the honest user forever).
 *
 * The decision core is pure and unit-tested; the row read/write lives in
 * the auth entry's createOrUpdateUser (it runs at issuance time, BEFORE
 * any user/code row is created or email attempted).
 */

/** Sends allowed per full budget. */
export const ISSUANCE_MAX_ATTEMPTS = 5;
/** One allowance slot recovers per this interval. */
export const ISSUANCE_RECOVERY_INTERVAL_MS = 6 * 60 * 1000;

/** The projection of an authRateLimits row the decision consumes. */
export interface IssuanceLimitRow {
  readonly lastAttemptTime: number;
  readonly attemptsLeft: number;
}

/** The decision: allowed now, plus the row to persist when allowed. */
export interface IssuanceDecision {
  readonly allowed: boolean;
  /** Only meaningful (and only written) when allowed. */
  readonly next: IssuanceLimitRow;
}

/** Pure issuance-budget decision over one identifier's row. */
export function decideIssuance(row: IssuanceLimitRow | null, nowMs: number): IssuanceDecision {
  if (row === null) {
    return {
      allowed: true,
      next: { lastAttemptTime: nowMs, attemptsLeft: ISSUANCE_MAX_ATTEMPTS - 1 },
    };
  }
  const recoveredSlots = Math.max(
    0,
    Math.floor((nowMs - row.lastAttemptTime) / ISSUANCE_RECOVERY_INTERVAL_MS),
  );
  const effective = Math.min(ISSUANCE_MAX_ATTEMPTS, row.attemptsLeft + recoveredSlots);
  return {
    allowed: effective > 0,
    next: { lastAttemptTime: nowMs, attemptsLeft: Math.max(0, effective - 1) },
  };
}

/**
 * Machine marker for the throttled-issuance error the auth entry throws;
 * the client classifies it as `too_many_attempts`. The web feature's
 * twin literal is pinned equal by tests/b1.
 */
export const ISSUANCE_RATE_LIMITED_MARKER = "[kiero:issuance_rate_limited]";
