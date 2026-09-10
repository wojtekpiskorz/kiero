/**
 * Shared plumbing and people fixtures for the attention lanes' guarded
 * dev-proof surfaces (F1; F2/F4 reuse the same people — the
 * convex/sources/probe_shared.ts precedent).
 *
 * One place for the attention-level fixtures: the second boss of the
 * service company, an extra device session for an existing fixture user,
 * the GM operator (open grant + open alpha activation of the service
 * company) and the revocation flip. Every fixture is idempotent, guarded
 * by the deployment's KIERO_PROBE_ENABLED variable, creates sessions
 * server-side only, and no identity is ever accepted from client input.
 */

import { v } from "convex/values";
import { action, internalMutation, type MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError } from "@kiero/runtime";
import type { ResolutionDb } from "../platform/context";
import {
  SERVICE_EMAIL,
  bridgeContextForEmail,
  probeDisabled,
  probeGuardEnabled,
  serviceIdentityUnavailable,
} from "../sources/probe_shared";

/** The F1 second-boss fixture (company A = the service company). */
export const F1_BOSS_EMAIL = "f1-boss-b@kiero.invalid";

/** The F1 GM fixture operator (open grant + open alpha activation). */
export const F1_GM_EMAIL = "f1-gm@kiero.invalid";

/** Device labels of the seeded sessions (visible in evidence only). */
export const F1_BOSS_DEVICE = "f1-boss-b-bridge";
export const F1_GM_DEVICE = "f1-gm-bridge";

// --- the service company scope (every fixture lives in company A) ------------

/** Resolves the service company id through the service account's chain. */
async function serviceCompanyId(db: ResolutionDb) {
  const company = await bridgeContextForEmail(db, SERVICE_EMAIL);
  if (company === null) {
    return null;
  }
  return { companyId: company.actor.companyId };
}

// --- people fixtures ------------------------------------------------------------

/** Ensures one boss fixture of the service company: user, membership, session. */
export const seedBoss = internalMutation({
  args: { email: v.string(), displayName: v.string(), deviceLabel: v.string() },
  handler: async (ctx, args) => {
    const scope = await serviceCompanyId(ctx.db);
    if (scope === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", scope.companyId);
    if (companyId === null) {
      return serviceIdentityUnavailable();
    }
    let userId = (
      await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", args.email)).first()
    )?._id;
    if (userId === undefined) {
      userId = await ctx.db.insert("users", {
        email: args.email,
        displayName: args.displayName,
        createdAtMs: Date.now(),
      });
    }
    const membership =
      await ctx.db
        .query("memberships")
        .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
        .filter((q) => q.eq(q.field("state"), "active"))
        .first();
    const membershipId =
      membership?._id ??
      (await ctx.db.insert("memberships", {
        companyId,
        userId,
        role: "member",
        state: "active",
        createdAtMs: Date.now(),
      }));
    const sessionId = await ensureDeviceSession(ctx.db, userId, args.deviceLabel);
    return okResult({ companyId, userId, membershipId, sessionId });
  },
});

export const probeSeedBoss = action({
  args: { email: v.string(), displayName: v.string(), deviceLabel: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.attention.probe_shared.seedBoss, {
      email: args.email,
      displayName: args.displayName,
      deviceLabel: args.deviceLabel,
    });
  },
});

/** Ensures one EXTRA device session for an existing fixture user (guarded). */
export const seedDevice = internalMutation({
  args: { email: v.string(), deviceLabel: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) {
      return errorResult(forbiddenError("fixture_user_missing"));
    }
    const sessionId = await ensureDeviceSession(ctx.db, user._id, args.deviceLabel);
    return okResult({ sessionId });
  },
});

export const probeSeedDevice = action({
  args: { email: v.string(), deviceLabel: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.attention.probe_shared.seedDevice, {
      email: args.email,
      deviceLabel: args.deviceLabel,
    });
  },
});

/** Finds or creates one live session row for a user under one device label. */
async function ensureDeviceSession(
  db: MutationCtx["db"],
  userId: Id<"users">,
  deviceLabel: string,
): Promise<string> {
  const session = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", userId))
    .order("desc")
    .filter((q) => q.eq(q.field("deviceLabel"), deviceLabel))
    .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
    .first();
  if (session !== null) {
    return session._id;
  }
  return db.insert("sessions", {
    userId,
    startedAtMs: Date.now(),
    lastSeenAtMs: Date.now(),
    deviceLabel,
  });
}

/**
 * Ensures the GM fixture: a GM user with an OPEN grant and an OPEN alpha
 * activation of the service company, plus a session. Mirrors the B4 row
 * shapes; used only to prove GM reads never write boss state.
 */
export const seedGm = internalMutation({
  args: {},
  handler: async (ctx) => {
    const scope = await serviceCompanyId(ctx.db);
    if (scope === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", scope.companyId);
    if (companyId === null) {
      return serviceIdentityUnavailable();
    }
    let userId = (
      await ctx.db.query("users").withIndex("by_email", (q) => q.eq("email", F1_GM_EMAIL)).first()
    )?._id;
    if (userId === undefined) {
      userId = await ctx.db.insert("users", {
        email: F1_GM_EMAIL,
        displayName: "F1 GM proof",
        createdAtMs: Date.now(),
      });
    }
    const openGrant =
      await ctx.db
        .query("gmAccessGrants")
        .withIndex("by_user_open", (q) => q.eq("userId", userId))
        .filter((q) => q.eq(q.field("closedAtMs"), undefined))
        .first();
    const grantId =
      openGrant?._id ??
      (await ctx.db.insert("gmAccessGrants", {
        userId,
        reason: "F1 dev proof: read-state inspection",
        enteredAtMs: Date.now(),
      }));
    const openActivation =
      await ctx.db
        .query("gmCompanyActivations")
        .withIndex("by_company_open", (q) => q.eq("companyId", companyId))
        .filter((q) => q.eq(q.field("endedAtMs"), undefined))
        .first();
    const activationId =
      openActivation?._id ??
      (await ctx.db.insert("gmCompanyActivations", {
        companyId,
        activatedByUserId: userId,
        activatedAtMs: Date.now(),
      }));
    const sessionId = await ensureDeviceSession(ctx.db, userId, F1_GM_DEVICE);
    return okResult({ companyId, gmUserId: userId, grantId, activationId, sessionId });
  },
});

export const probeSeedGm = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.attention.probe_shared.seedGm, {});
  },
});

/**
 * Revokes one fixture boss's membership in the service company (guarded).
 * The F1 failure evidence for revoked membership: after this, the same
 * live session resolves NO active membership and every attention command
 * through it fails closed. A dev fixture flip, exactly like the D1 seed
 * fixtures — production revocation is B3's audited operation.
 */
export const revokeFixtureMembership = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .first();
    if (user === null) {
      return errorResult(forbiddenError("fixture_user_missing"));
    }
    const scope = await serviceCompanyId(ctx.db);
    if (scope === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", scope.companyId);
    if (companyId === null) {
      return serviceIdentityUnavailable();
    }
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", user._id))
      .filter((q) => q.eq(q.field("state"), "active"))
      .first();
    if (membership === null) {
      return okResult({ alreadyRevoked: true });
    }
    await ctx.db.patch(membership._id, { state: "revoked", revokedAtMs: Date.now() });
    return okResult({ alreadyRevoked: false });
  },
});

export const probeRevokeFixtureMembership = action({
  args: { email: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.attention.probe_shared.revokeFixtureMembership, {
      email: args.email,
    });
  },
});

// --- the sources lane's guard plumbing, re-exported for the attention probes --

export {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../sources/probe_shared";
