/**
 * The B2 Convex function surface (generated-call APIs).
 *
 * B1's doctrine, unchanged: TWO entry ways, ONE core. The typed command
 * seam (`access.linkVerifiedMethod` through dispatchAccess) is the
 * read-only confirmation; the identity-layer functions here are the
 * write surface (they run the same cores — ./ceremony.ts,
 * ./emailChange.ts, ./sessionControls.ts — with the same live-session
 * resolution, and work before any membership exists). Every function
 * enforces the live-session rules first: an upstream token whose session
 * is gone, revoked or 30-days inactive is denied. The live session is
 * resolved ONCE per invocation and the snapshot is reused for the
 * company scope and the recent-authentication clock.
 *
 * Code delivery follows B1's honest pattern: the code is staged (hashed)
 * in an internal mutation, then emailed from the action; on delivery
 * failure the action fails loudly with the machine marker and a retry
 * stages a FRESH code (the pending hash is replaced, never duplicated).
 * The plain code never crosses to the client.
 *
 * There is deliberately NO recovery entry here: the checked recovery
 * command's invoker stays unavailable until B4 supplies GM authority
 * (see ./operations.ts); only the guarded dev proof (./probe.ts) runs it.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { action, internalMutation, mutation, query } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { unauthenticatedError } from "@kiero/runtime";
import {
  deliverApplicationEmail,
  deliveryFailureCopy,
  EMAIL_DELIVERY_FAILED_MARKER,
} from "../../integrations/email/send";
import {
  liveSessionIdentity,
  liveSessionStore,
  resolveLiveSession,
  type LiveSessionDenial,
  type LiveSessionSnapshot,
} from "../identity/resolution";
import { resolveRequestContext } from "../../platform/context";
import type { QueryCtx } from "../../_generated/server";
import {
  beginLinkingCore,
  cancelLinkingCore,
  linkingStatusCore,
  stageProofCodeCore,
  verifyProofCodeCore,
} from "./ceremony";
import { confirmEmailChangeCore, stageEmailChangeCore } from "./emailChange";
import { revokeOtherSessionsCore } from "./sessionControls";
import { linkingStore, linkingTx } from "./storeAdapter";
import { LINK_REJECTED_MARKER, linkingRejectionCopy, type LinkRejectionCode } from "./policy";

/** The sanitized denial error every protected function fails with. */
function denialError(reason: LiveSessionDenial): never {
  throw new ConvexError(unauthenticatedError(`no_live_session_${reason}`));
}

/**
 * The typed rejection thrown to clients: machine marker + typed code in
 * brackets + Polish copy. Classification keys on the marker and the code
 * token, never the prose.
 */
function linkRejected(code: LinkRejectionCode): never {
  throw new ConvexError(`${LINK_REJECTED_MARKER}[${code}] ${linkingRejectionCopy[code]}`);
}

/** Resolves the caller's live session ONCE, or fails sanitized (read-only). */
async function requireLiveSession(
  db: QueryCtx["db"],
  auth: { getUserIdentity(): Promise<{ subject: string } | null> },
): Promise<LiveSessionSnapshot> {
  const live = await resolveLiveSession(liveSessionStore(db), auth, Date.now());
  if (live.tag === "denied") {
    denialError(live.reason);
  }
  return live.session;
}

/**
 * The canonical company scope for revocation events, from the SAME
 * resolved live-session snapshot (live session -> user -> earliest active
 * membership -> company, the A3 chain B1's revokeSession uses); null when
 * no membership exists.
 */
async function companyIdForEvent(
  db: QueryCtx["db"],
  session: LiveSessionSnapshot,
): Promise<string | null> {
  const context = await resolveRequestContext(db, liveSessionIdentity(session, Date.now()));
  return context === null ? null : context.actor.companyId;
}

/** Authenticated: the actor's linking state (methods + pending ceremony). */
export const linkingStatus = query({
  args: {},
  handler: async (ctx) => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    return await linkingStatusCore(linkingStore(ctx.db), {
      userId: session.userId,
      nowMs: Date.now(),
    });
  },
});

/** Authenticated: open the ceremony attaching a method to the account. */
export const beginLinking = mutation({
  args: { targetMethod: v.union(v.literal("google"), v.literal("email_code")) },
  handler: async (ctx, args) => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const outcome = await beginLinkingCore(linkingTx(ctx), {
      actorUserId: session.userId,
      targetMethod: args.targetMethod,
      nowMs: Date.now(),
    });
    if (!outcome.ok) {
      linkRejected(outcome.code);
    }
    return { begun: true };
  },
});

/** Authenticated: cancel the actor's active ceremony. */
export const cancelLinking = mutation({
  args: {},
  handler: async (ctx) => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    return await cancelLinkingCore(linkingTx(ctx), {
      actorUserId: session.userId,
      nowMs: Date.now(),
    });
  },
});

/** Internal: stage a ceremony proof code (hash only) for the live actor. */
export const stageProofCode = internalMutation({
  args: {},
  handler: async (ctx): Promise<
    | { ok: true; email: string; code: string; expiresAtMs: number }
    | { ok: false; code: LinkRejectionCode }
  > => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const staged = await stageProofCodeCore(linkingTx(ctx), {
      actorUserId: session.userId,
      nowMs: Date.now(),
    });
    if (!staged.ok) {
      return { ok: false, code: staged.code };
    }
    return {
      ok: true,
      email: staged.value.email,
      code: staged.value.code,
      expiresAtMs: staged.value.expiresAtMs,
    };
  },
});

/** Authenticated action: deliver the ceremony's proof code by email. */
export const sendProofCode = action({
  args: {},
  handler: async (ctx): Promise<{ sent: true }> => {
    const staged = await ctx.runMutation(internal.access.linking.functions.stageProofCode, {});
    if (!staged.ok) {
      linkRejected(staged.code);
    }
    const outcome = await deliverApplicationEmail(staged.email, {
      kind: "method_link_code",
      code: staged.code,
      expiresAtMs: staged.expiresAtMs,
    });
    const copy = deliveryFailureCopy(outcome);
    if (copy !== null) {
      // Fail loudly and sanitized; retry stages a fresh code (B1 pattern).
      throw new Error(`${EMAIL_DELIVERY_FAILED_MARKER} ${copy}`);
    }
    return { sent: true };
  },
});

/** Authenticated: verify a ceremony proof code (first leg or commit). */
export const verifyProofCode = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const outcome = await verifyProofCodeCore(linkingTx(ctx), {
      actorUserId: session.userId,
      code: args.code,
      nowMs: Date.now(),
    });
    if (!outcome.ok) {
      linkRejected(outcome.code);
    }
    return { leg: outcome.value.leg, linked: outcome.value.linked };
  },
});

/** Internal: stage an email-change code (hash only) for the live actor. */
export const stageEmailChange = internalMutation({
  args: { newEmail: v.string() },
  handler: async (ctx, args): Promise<
    | { ok: true; email: string; code: string; expiresAtMs: number }
    | { ok: false; code: LinkRejectionCode }
  > => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const staged = await stageEmailChangeCore(linkingTx(ctx), {
      actorUserId: session.userId,
      newEmail: args.newEmail,
      // The trusted device-session start time (the recent-auth clock),
      // from the SAME resolved snapshot — no second read.
      sessionStartedAtMs: session.startedAtMs,
      nowMs: Date.now(),
    });
    if (!staged.ok) {
      return { ok: false, code: staged.code };
    }
    return {
      ok: true,
      email: staged.value.email,
      code: staged.value.code,
      expiresAtMs: staged.value.expiresAtMs,
    };
  },
});

/** Authenticated action: request an email change (code to the NEW address). */
export const requestEmailChange = action({
  args: { newEmail: v.string() },
  handler: async (ctx, args): Promise<{ requested: true }> => {
    const staged = await ctx.runMutation(internal.access.linking.functions.stageEmailChange, {
      newEmail: args.newEmail,
    });
    if (!staged.ok) {
      linkRejected(staged.code);
    }
    const outcome = await deliverApplicationEmail(staged.email, {
      kind: "email_change_code",
      code: staged.code,
      expiresAtMs: staged.expiresAtMs,
    });
    const copy = deliveryFailureCopy(outcome);
    if (copy !== null) {
      throw new Error(`${EMAIL_DELIVERY_FAILED_MARKER} ${copy}`);
    }
    return { requested: true };
  },
});

/** Authenticated: confirm an email change with the code from the new address. */
export const confirmEmailChange = mutation({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const outcome = await confirmEmailChangeCore(linkingTx(ctx), {
      actorUserId: session.userId,
      code: args.code,
      nowMs: Date.now(),
    });
    if (!outcome.ok) {
      linkRejected(outcome.code);
    }
    return { newEmail: outcome.value.newEmail, changedAtMs: outcome.value.changedAtMs };
  },
});

/** Authenticated: revoke every OTHER device session through B1's core. */
export const revokeOtherSessions = mutation({
  args: {},
  handler: async (ctx) => {
    // ONE resolution drives both the revocation scope and the canonical
    // event's company scope (previously resolved twice with different
    // failure policies — the review's finding 3).
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const companyId = await companyIdForEvent(ctx.db, session);
    return await revokeOtherSessionsCore(linkingTx(ctx), {
      actorUserId: session.userId,
      currentSessionId: session.sessionId,
      nowMs: Date.now(),
      companyIdForEvent: companyId,
    });
  },
});
