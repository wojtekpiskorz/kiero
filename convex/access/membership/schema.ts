/**
 * Access membership tables (candidate fragment, A2).
 *
 * Owning implementer: B3 (membership, invitations, administrator transfer).
 * A company is separate from the accounts of the bosses who belong to it;
 * equal email addresses and contacts never confer membership. The structure
 * supports multiple memberships but a v1 ordinary user has one active firm.
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
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
    state: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired"),
    ),
    expiresAtMs: shared.tsMs,
    createdAtMs: shared.tsMs,
    acceptedMembershipId: v.optional(shared.membershipId),
    revokedAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_state", ["companyId", "state"])
    .index("by_email", ["email"]),
} as const;
