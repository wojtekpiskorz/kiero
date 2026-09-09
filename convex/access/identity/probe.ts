/**
 * Guarded B1 proof fixtures (dev deployment only).
 *
 * Same pattern as the A3 probe (convex/platform/probe.ts): queries and
 * mutations cannot read deployment variables, so every entry here is an
 * ACTION that checks `KIERO_B1_PROOF_ENABLED === "1"` and then runs an
 * internal mutation that is only reachable from this module.
 *
 * Why these exist (honest scope): the emailed-code delivery leg needs a
 * RESEND_API_KEY the owner has not supplied yet, so no proof can read a
 * code from a mailbox. The fixtures let the evidence script exercise the
 * REAL verification, session and token code paths with a fixture-issued
 * code value; the delivery leg itself stays explicitly BLOCKED. On a
 * production deployment the guard variable is absent and every entry
 * fails closed.
 *
 * - `b1ProofSetCode`: replaces the pending verification code of an
 *   email-code account (created by a real issuance) with a known code,
 *   hashed exactly like the library hashes codes.
 * - `b1ProofAgeSession`: moves a registry row's trusted activity time
 *   (30-day inactivity proofs).
 * - `b1ProofDropUpstreamSession`: deletes the mirrored authSessions row
 *   (upstream signed-out revocation proof).
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";

const OTP_MAX_AGE_SECONDS = 15 * 60;

function guardEnabled(): boolean {
  return process.env.KIERO_B1_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("access.b1Proof", "proof_guard_disabled"));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const setFixtureCode = internalMutation({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "email_code").eq("providerAccountId", args.email),
      )
      .unique();
    if (account === null) {
      return errorResult(unsupportedError("access.b1Proof", "no_email_code_account"));
    }
    const existing = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", account._id))
      .unique();
    if (existing !== null) {
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("authVerificationCodes", {
      accountId: account._id,
      provider: "email_code",
      code: await sha256Hex(args.code),
      expirationTime: Date.now() + OTP_MAX_AGE_SECONDS * 1000,
      emailVerified: args.email,
    });
    return okResult({ set: true });
  },
});

export const ageRegistrySession = internalMutation({
  args: { sessionId: v.id("sessions"), lastSeenAtMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const row = await ctx.db.get(args.sessionId);
    if (row === null) {
      return errorResult(unsupportedError("access.b1Proof", "no_registry_row"));
    }
    await ctx.db.patch(args.sessionId, { lastSeenAtMs: args.lastSeenAtMs });
    return okResult({ aged: true });
  },
});

export const dropUpstreamSession = internalMutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const row = await ctx.db.get(args.sessionId);
    if (row === null) {
      return errorResult(unsupportedError("access.b1Proof", "no_registry_row"));
    }
    if (row.authSessionId !== undefined) {
      await ctx.db.delete(row.authSessionId);
    }
    return okResult({ dropped: true });
  },
});

export const b1ProofSetCode = action({
  args: { email: v.string(), code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.identity.probe.setFixtureCode, {
      email: args.email,
      code: args.code,
    });
  },
});

export const b1ProofAgeSession = action({
  args: { sessionId: v.id("sessions"), lastSeenAtMs: v.float64() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.identity.probe.ageRegistrySession, {
      sessionId: args.sessionId,
      lastSeenAtMs: args.lastSeenAtMs,
    });
  },
});

export const b1ProofDropUpstreamSession = action({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.identity.probe.dropUpstreamSession, {
      sessionId: args.sessionId,
    });
  },
});
