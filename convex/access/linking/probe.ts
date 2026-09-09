/**
 * Guarded B2 proof fixtures (dev deployment only).
 *
 * Same pattern as the B1 probe (convex/access/identity/probe.ts):
 * queries and mutations cannot read deployment variables, so every entry
 * here is an ACTION that checks `KIERO_B2_PROOF_ENABLED === "1"` and then
 * runs an internal mutation reachable only from this module.
 *
 * Why these exist (honest scope): the emailed-code delivery leg needs a
 * RESEND_API_KEY the owner has not supplied, and the Google OAuth leg
 * needs AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET — both remain BLOCKED as owner
 * actions. The fixtures let the evidence script exercise the REAL
 * ceremony cores with known stand-ins exactly where those external legs
 * sit, while every check the product owns (both-proofs requirement,
 * single-use codes, typed rejections, exactly-once commits, revocation,
 * recovery) runs for real. On a production deployment the guard variable
 * is absent and every entry fails closed.
 *
 * - `b2ProofSetLinkCode`: installs a known code hash on the LIVE actor's
 *   active ceremony (proof-domain address only).
 * - `b2ProofSetEmailChangeCode`: installs a known code hash on the LIVE
 *   actor's pending email-change request (proof-domain NEW address only).
 * - `b2ProofAdvanceGoogleProof`: records a fresh Google first proof on the
 *   LIVE actor's ceremony — the simulated OAuth leg for the blocked
 *   Google credential; the actor's account must already carry the Google
 *   subject a real sign-in would have proven.
 * - `b2ProofRecoverAccount`: runs the REAL recovery core for a
 *   proof-domain account. This is dev evidence tooling, NOT the product
 *   invoker: the checked recovery command stays unregistered until B4
 *   supplies explicit GM authority.
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { isProofFixtureEmail } from "../identity/proofDomain";
import {
  liveSessionStore,
  resolveLiveSession,
} from "../identity/resolution";
import { linkingTx, recoverAccountCore, sha256Hex } from "./cores";

function guardEnabled(): boolean {
  return process.env.KIERO_B2_PROOF_ENABLED === "1";
}

function disabled(): ResultEnvelope {
  return errorResult(unsupportedError("access.b2Proof", "proof_guard_disabled"));
}

const PROOF_CODE_VALIDITY_MS = 15 * 60 * 1000;

export const setLinkCodeInternal = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const live = await resolveActor(ctx);
    if (live === null) {
      return errorResult(unsupportedError("access.b2Proof", "no_live_session"));
    }
    const tx = linkingTx(ctx);
    const attempt = await tx.activeAttemptByUser(live.userId, Date.now());
    if (attempt === null) {
      return errorResult(unsupportedError("access.b2Proof", "no_active_ceremony"));
    }
    if (!isProofFixtureEmail(attempt.email)) {
      return errorResult(unsupportedError("access.b2Proof", "proof_domain_required"));
    }
    await tx.patchAttempt(attempt.id, {
      pendingCodeHash: await sha256Hex(args.code),
      pendingCodeExpiresAtMs: Date.now() + PROOF_CODE_VALIDITY_MS,
    });
    return okResult({ set: true, state: attempt.state });
  },
});

export const setEmailChangeCodeInternal = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const live = await resolveActor(ctx);
    if (live === null) {
      return errorResult(unsupportedError("access.b2Proof", "no_live_session"));
    }
    const tx = linkingTx(ctx);
    const request = await tx.pendingEmailChange(live.userId);
    if (request === null) {
      return errorResult(unsupportedError("access.b2Proof", "no_pending_email_change"));
    }
    if (!isProofFixtureEmail(request.newEmail)) {
      return errorResult(unsupportedError("access.b2Proof", "proof_domain_required"));
    }
    await tx.patchEmailChange(request.id, {
      codeHash: await sha256Hex(args.code),
      expiresAtMs: Date.now() + PROOF_CODE_VALIDITY_MS,
    });
    return okResult({ set: true });
  },
});

export const advanceGoogleProofInternal = internalMutation({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const live = await resolveActor(ctx);
    if (live === null) {
      return errorResult(unsupportedError("access.b2Proof", "no_live_session"));
    }
    const tx = linkingTx(ctx);
    const account = await tx.userById(live.userId);
    if (account === null || account.googleSubject === null) {
      return errorResult(unsupportedError("access.b2Proof", "no_google_identity"));
    }
    const attempt = await tx.activeAttemptByUser(live.userId, Date.now());
    if (
      attempt === null ||
      attempt.targetMethod !== "email_code" ||
      attempt.initiatingMethod !== "google"
    ) {
      return errorResult(unsupportedError("access.b2Proof", "no_active_ceremony"));
    }
    if (!isProofFixtureEmail(attempt.email)) {
      return errorResult(unsupportedError("access.b2Proof", "proof_domain_required"));
    }
    await tx.patchAttempt(attempt.id, {
      state: "awaiting_target_proof",
      firstProofAtMs: Date.now(),
    });
    return okResult({ advanced: true });
  },
});

export const recoverAccountInternal = internalMutation({
  args: { email: v.string(), verificationBasis: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!isProofFixtureEmail(args.email)) {
      return errorResult(unsupportedError("access.b2Proof", "proof_domain_required"));
    }
    const tx = linkingTx(ctx);
    const owners = await tx.usersByEmail(args.email);
    if (owners.length !== 1) {
      return errorResult(unsupportedError("access.b2Proof", "ambiguous_or_missing_account"));
    }
    const target = owners[0];
    if (target === undefined) {
      return errorResult(unsupportedError("access.b2Proof", "ambiguous_or_missing_account"));
    }
    const outcome = await recoverAccountCore(tx, {
      targetUserId: target.id,
      verificationBasis: args.verificationBasis,
      performedBy: "dev-proof",
      nowMs: Date.now(),
    });
    if (outcome.state === "rejected") {
      return errorResult(unsupportedError("access.b2Proof", "no_such_account"));
    }
    return okResult({
      recoveredAtMs: outcome.recoveredAtMs,
      revokedSessions: outcome.revokedSessionIds.length,
      clearedAccounts: outcome.clearedAccountIds.length,
      clearedGoogleSubject: outcome.clearedGoogleSubject,
    });
  },
});

/** Resolves the caller's live session for guarded fixtures (read-only). */
async function resolveActor(ctx: {
  db: Parameters<typeof liveSessionStore>[0];
  auth: { getUserIdentity(): Promise<{ subject: string } | null> };
}): Promise<{ userId: string } | null> {
  const live = await resolveLiveSession(liveSessionStore(ctx.db), ctx.auth, Date.now());
  if (live.tag === "denied") {
    return null;
  }
  return { userId: live.session.userId };
}

export const b2ProofSetLinkCode = action({
  args: { code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.linking.probe.setLinkCodeInternal, {
      code: args.code,
    });
  },
});

export const b2ProofSetEmailChangeCode = action({
  args: { code: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.linking.probe.setEmailChangeCodeInternal, {
      code: args.code,
    });
  },
});

export const b2ProofAdvanceGoogleProof = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.linking.probe.advanceGoogleProofInternal, {});
  },
});

export const b2ProofRecoverAccount = action({
  args: { email: v.string(), verificationBasis: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!guardEnabled()) {
      return disabled();
    }
    return await ctx.runMutation(internal.access.linking.probe.recoverAccountInternal, {
      email: args.email,
      verificationBasis: args.verificationBasis,
    });
  },
});
