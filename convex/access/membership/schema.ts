/**
 * Access membership tables (A2 candidate, certified by A3; B3 amendment).
 *
 * Owning implementer: B3 (membership, invitations, administrator transfer).
 * A company is separate from the accounts of the bosses who belong to it;
 * equal email addresses and contacts never confer membership. The structure
 * supports multiple memberships but a v1 ordinary user has one active firm.
 *
 * B3 amendment (issue #22):
 *
 * - `invitations` carries the acceptance code as a server-side SHA-256
 *   hash (`codeHash`), the issuing administrator, and a `rejected` state
 *   (the invitee declines) alongside pending/accepted/revoked/expired.
 *   The code itself exists only in the delivery email — never in results,
 *   rows or logs.
 * - `memberships` is unchanged in shape: revocation keeps the row (state
 *   `revoked`), so leaving company A before joining B preserves A's data
 *   and authorship; historical and future memberships coexist while the
 *   v1 resolution treats the earliest ACTIVE row as the one active firm.
 *
 * Tables: companies, memberships, invitations.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../../schema/shared";
import { MembershipRole } from "@kiero/contracts";

// Vocabulary pin: roles must equal the contracts-side MembershipRole
// literals exactly, or this file fails typecheck.
const membershipRole: ValueValidator<Encoded<typeof MembershipRole>> = v.union(
  v.literal("admin"),
  v.literal("member"),
);

export const membershipTables = {
  /** The firm: shared projects and knowledge of the bosses ("Firma", CONTEXT.md). */
  companies: defineTable({
    name: v.string(),
    /** One shared time context for deadlines, arrears, quiet hours ("Strefa czasu firmy"). */
    timezone: v.string(),
    defaultCurrency: v.string(),
    createdAtMs: shared.tsMs,
  }),

  /** A boss's access and role in one company; revocation keeps history. */
  memberships: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    role: membershipRole,
    state: v.union(v.literal("active"), v.literal("revoked")),
    createdAtMs: shared.tsMs,
    revokedAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_user", ["companyId", "userId"])
    .index("by_user", ["userId"]),

  /** Targeted invitation to one person, with expiry and revocation. */
  invitations: defineTable({
    companyId: shared.companyId,
    /** Normalized target address; only its controller may accept. */
    email: v.string(),
    role: membershipRole,
    state: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired"),
      v.literal("rejected"),
    ),
    /** SHA-256 hex of the single-use acceptance code (never the code). */
    codeHash: v.string(),
    expiresAtMs: shared.tsMs,
    createdAtMs: shared.tsMs,
    /** The administrator who issued the invitation. */
    issuedByUserId: shared.userId,
    acceptedMembershipId: v.optional(shared.membershipId),
    revokedAtMs: v.optional(shared.tsMs),
    rejectedAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_state", ["companyId", "state"])
    .index("by_email", ["email"]),
} as const;
