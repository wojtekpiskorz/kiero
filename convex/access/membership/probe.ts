/**
 * Guarded B3 proof fixtures (dev deployment only).
 *
 * Same pattern as the A3 platform probes and B1's identity probes: an
 * ACTION checks the deployment guard variable and runs an internal
 * mutation reachable only from this module. The invitation-code leg needs
 * the same honest-scoped treatment B1's OTP got: invitation emails go
 * through the Resend adapter, whose key this deployment does not carry, so
 * the evidence script installs a KNOWN code for a proof-domain invitation
 * and exercises the REAL admission path end to end. The code fixture can
 * only ever target `@kiero.invalid` addresses (the guard alone would be an
 * invitation-takeover primitive otherwise).
 *
 * - `b3ProofSetInvitationCode`: replaces one invitation's code hash with
 *   the hash of a known code (proof-domain invitations only).
 * - `b3ProofExpireInvitation`: moves one invitation's expiry into the past
 *   (the expiry-refusal proof).
 * - `b3ProofCompanyState`: the tenant-scoped inspection read the evidence
 *   asserts on (members with roles, invitations with states, admin count).
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { isProofFixtureEmail } from "../identity/proofDomain";
import { sha256Hex } from "./cores";

function guardEnabled(): boolean {
  return process.env.KIERO_B3_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("access.b3Proof", "proof_guard_disabled"));
}

export const setInvitationCodeInternal = internalMutation({
  args: { invitationId: v.id("invitations"), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const invitation = await ctx.db.get(args.invitationId);
    if (invitation === null || !isProofFixtureEmail(invitation.email)) {
      return errorResult(unsupportedError("access.b3Proof", "proof_domain_required"));
    }
    if (invitation.state !== "pending") {
      return errorResult(unsupportedError("access.b3Proof", "invitation_not_pending"));
    }
    await ctx.db.patch(args.invitationId, { codeHash: await sha256Hex(args.code) });
    return okResult({ set: true });
  },
});

export const expireInvitationInternal = internalMutation({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const invitation = await ctx.db.get(args.invitationId);
    if (invitation === null) {
      return errorResult(unsupportedError("access.b3Proof", "invitation_not_found"));
    }
    await ctx.db.patch(args.invitationId, { expiresAtMs: Date.now() - 1 });
    return okResult({ expired: true });
  },
});

export const companyStateInternal = internalMutation({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_company_user", (q) => q.eq("companyId", args.companyId))
      .collect();
    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_company_state", (q) => q.eq("companyId", args.companyId))
      .collect();
    const activeAdmins = memberships.filter(
      (row) => row.state === "active" && row.role === "admin",
    );
    return okResult({
      memberships: memberships
        .map((row) => ({
          membershipId: row._id,
          userId: row.userId,
          role: row.role,
          state: row.state,
          createdAtMs: row.createdAtMs,
          revokedAtMs: row.revokedAtMs ?? null,
        }))
        .sort((a, b) => a.createdAtMs - b.createdAtMs),
      invitations: invitations
        .map((row) => ({
          invitationId: row._id,
          email: row.email,
          role: row.role,
          state: row.state,
          expiresAtMs: row.expiresAtMs,
        }))
        .sort((a, b) => a.email.localeCompare(b.email)),
      activeAdminCount: activeAdmins.length,
    });
  },
});

/** Installs a known acceptance code for a proof-domain invitation (guarded). */
export const b3ProofSetInvitationCode = action({
  args: { invitationId: v.id("invitations"), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.membership.probe.setInvitationCodeInternal, {
      invitationId: args.invitationId,
      code: args.code,
    });
  },
});

/** Moves one invitation's expiry into the past (guarded). */
export const b3ProofExpireInvitation = action({
  args: { invitationId: v.id("invitations") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.membership.probe.expireInvitationInternal, {
      invitationId: args.invitationId,
    });
  },
});

/** Inspects one company's membership/invitation state (guarded). */
export const b3ProofCompanyState = action({
  args: { companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.membership.probe.companyStateInternal, {
      companyId: args.companyId,
    });
  },
});

export const userByEmailInternal = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!isProofFixtureEmail(args.email)) {
      return errorResult(unsupportedError("access.b3Proof", "proof_domain_required"));
    }
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email.trim().toLowerCase()))
      .first();
    if (user === null) {
      return errorResult(unsupportedError("access.b3Proof", "user_not_found"));
    }
    return okResult({ userId: user._id });
  },
});

/** Resolves a proof-domain fixture person's user id (guarded). */
export const b3ProofUserByEmail = action({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.membership.probe.userByEmailInternal, {
      email: args.email,
    });
  },
});
