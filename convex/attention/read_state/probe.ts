/**
 * F1 read-state dev proofs (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the A3 platform and D1 lane probes; shared
 * plumbing lives in convex/sources/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the F1 evidence can
 * run against the REAL dev deployment without a development-auth shortcut:
 * every actor is a server-seeded session resolved through the SAME
 * canonical resolution and authorization seam as production calls, and no
 * identity is ever accepted from client input.
 *
 * - `probeMarkSourceRead`: dispatches one mark envelope through the checked
 *   path as the service identity (or an explicitly seeded session).
 * - `probeReadState`: the unread projection over canonical source ids for
 *   the same identity choices.
 * - `probeGmReadStateOverview`: the audited-GM inspection read of one
 *   company's read states (strictly read-only).
 * - `probeAttentionState`: the tenant-scoped inspection the evidence
 *   scripts assert on (read-state rows plus `attention.sourceReadChanged`
 *   outbox events, proving one event per actual transition).
 * - `probeCrashMarkSourceRead`: performs the FULL mark transaction and then
 *   THROWS before commit, proving rollback of row and event together.
 * - `probeSeedBoss` / `probeSeedDevice` / `probeSeedGm`: idempotent
 *   fixtures (a second boss in the service company; an extra device
 *   session for an existing user; a GM user with an open grant and an open
 *   alpha activation of the service company).
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import {
  CommandEnvelope,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { forbiddenError, membershipPolicy, type RequestContext } from "@kiero/runtime";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import { markSourceReadOperation, performMarkSourceRead } from "./operations";
import {
  SERVICE_EMAIL,
  bridgeContextForEmail,
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../../sources/probe_shared";

/** The F1 second-boss fixture (seeded below; company A = the service company). */
export const F1_BOSS_EMAIL = "f1-boss-b@kiero.invalid";

/** The F1 GM fixture operator (open grant + open alpha activation). */
export const F1_GM_EMAIL = "f1-gm@kiero.invalid";

/** Device labels of the seeded sessions (visible in evidence only). */
export const F1_BOSS_DEVICE = "f1-boss-b-bridge";
export const F1_GM_DEVICE = "f1-gm-bridge";

// --- command + read probes -----------------------------------------------------

/** Dispatches one mark envelope as the service identity (guarded). */
export const probeMarkSourceRead = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.attention.read_state.commands.markSourceReadTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

/** The unread projection for the service or seeded identity (guarded). */
export const probeReadState = action({
  args: { sourceIds: v.array(v.id("sources")), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.read_state.queries.readStateForSourcesFor, {
      serviceSessionId: sessionId,
      sourceIds: args.sourceIds,
    });
  },
});

/** The audited-GM inspection read of one company (guarded, read-only). */
export const probeGmReadStateOverview = action({
  args: { gmSessionId: v.string(), companyId: v.id("companies") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.attention.read_state.queries.gmReadStateOverview, {
      gmSessionId: args.gmSessionId,
      companyId: args.companyId,
    });
  },
});

// --- the crash proof ------------------------------------------------------------

/**
 * The guarded crash mutation: FULL mark transaction, then a deliberate
 * throw so the whole transaction rolls back — read-state row AND canonical
 * event together (the no-partial-commit proof).
 */
export const crashMarkRead = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const command = Schema.decodeUnknownSync(CommandEnvelope)(args.envelope);
    const context: RequestContext | null = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const decision = await membershipPolicy.authorize(context, { intent: "write" });
    if (!decision.allowed) {
      return errorResult(decision.error);
    }
    const input = Schema.decodeUnknownSync(markSourceReadOperation.input)(command.input);
    const result = await performMarkSourceRead(ctx, context, input);
    if (result._tag === "error") {
      return result; // the mark itself failed; nothing was written
    }
    // The row and event were registered inside THIS transaction; throwing
    // aborts both together.
    throw new Error("probe: deliberate failure after read-state registration");
  },
});

/** Runs the crash-proof mark (guarded action wrapper). */
export const probeCrashMarkSourceRead = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    // The internal mutation throws by design; Convex surfaces it as a
    // thrown error from runMutation, which the evidence script expects.
    await ctx.runMutation(internal.attention.read_state.probe.crashMarkRead, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
    return errorResult(forbiddenError("crash_proof_did_not_throw"));
  },
});

// --- fixtures ---------------------------------------------------------------------

/** Ensures one boss fixture of the service company: user, membership, session. */
export const seedBoss = internalMutation({
  args: { email: v.string(), displayName: v.string(), deviceLabel: v.string() },
  handler: async (ctx, args) => {
    const company = await bridgeContextForEmail(ctx.db, SERVICE_EMAIL);
    if (company === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", company.actor.companyId);
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
    const session =
      await ctx.db
        .query("sessions")
        .withIndex("by_user_started", (q) => q.eq("userId", userId))
        .order("desc")
        .filter((q) => q.eq(q.field("deviceLabel"), args.deviceLabel))
        .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
        .first();
    const sessionId =
      session?._id ??
      (await ctx.db.insert("sessions", {
        userId,
        startedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
        deviceLabel: args.deviceLabel,
      }));
    return okResult({ companyId, userId, membershipId, sessionId });
  },
});

export const probeSeedBoss = action({
  args: { email: v.string(), displayName: v.string(), deviceLabel: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.attention.read_state.probe.seedBoss, {
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
    const session =
      await ctx.db
        .query("sessions")
        .withIndex("by_user_started", (q) => q.eq("userId", user._id))
        .order("desc")
        .filter((q) => q.eq(q.field("deviceLabel"), args.deviceLabel))
        .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
        .first();
    const sessionId =
      session?._id ??
      (await ctx.db.insert("sessions", {
        userId: user._id,
        startedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
        deviceLabel: args.deviceLabel,
      }));
    return okResult({ sessionId });
  },
});

export const probeSeedDevice = action({
  args: { email: v.string(), deviceLabel: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.attention.read_state.probe.seedDevice, {
      email: args.email,
      deviceLabel: args.deviceLabel,
    });
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
    const company = await bridgeContextForEmail(ctx.db, SERVICE_EMAIL);
    if (company === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", company.actor.companyId);
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
    return ctx.runMutation(internal.attention.read_state.probe.revokeFixtureMembership, {
      email: args.email,
    });
  },
});

/**
 * Ensures the GM fixture: a GM user with an OPEN grant and an OPEN alpha
 * activation of the service company, plus a session. Mirrors the B4 row
 * shapes; used only to prove GM reads never write boss state.
 */
export const seedGm = internalMutation({
  args: {},
  handler: async (ctx) => {
    const company = await bridgeContextForEmail(ctx.db, SERVICE_EMAIL);
    if (company === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", company.actor.companyId);
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
    const session =
      await ctx.db
        .query("sessions")
        .withIndex("by_user_started", (q) => q.eq("userId", userId))
        .order("desc")
        .filter((q) => q.eq(q.field("deviceLabel"), F1_GM_DEVICE))
        .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
        .first();
    const sessionId =
      session?._id ??
      (await ctx.db.insert("sessions", {
        userId,
        startedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
        deviceLabel: F1_GM_DEVICE,
      }));
    return okResult({ companyId, gmUserId: userId, grantId, activationId, sessionId });
  },
});

export const probeSeedGm = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.attention.read_state.probe.seedGm, {});
  },
});

// --- inspection --------------------------------------------------------------------

/** Tenant-scoped read-state + event inspection for the evidence scripts. */
export const attentionState = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const context = await resolveRequestContext(ctx.db, bridgeIdentity(args.serviceSessionId, Date.now()));
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const rows = await ctx.db
      .query("readStates")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const events = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .filter((q) => q.eq(q.field("eventName"), "attention.sourceReadChanged"))
      .collect();
    return okResult({
      companyId,
      readStates: rows.map((row) => ({
        userId: row.userId,
        sourceId: row.sourceId,
        read: row.read,
        readAtMs: row.readAtMs,
      })),
      readChangedEvents: events.map((row) => ({
        eventId: row.eventId,
        deliveryState: row.deliveryState,
      })),
    });
  },
});

export const probeAttentionState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.attention.read_state.probe.attentionState, {
      serviceSessionId: sessionId,
    });
  },
});
