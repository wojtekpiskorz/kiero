/**
 * The B1 Convex function surface (generated-call APIs).
 *
 * Two entry ways, one core each (no drift by construction):
 *
 * - `dispatchAccessCommand` (./operations.ts) is the typed command seam
 *   for B2/B3/GM — it needs the full actor chain (membership), which no
 *   B1 user has yet;
 * - the functions here are the identity-layer surface the barebones app
 *   uses BEFORE any company exists: provider availability, session
 *   provisioning, current access resolution, the device session registry
 *   and self-service revocation. They run the same
 *   resolution/revocation cores, so behavior is identical through both
 *   entry ways.
 *
 * Protected reads (resolveCurrentAccess, listMySessions) enforce the
 * live-session rules read-only: an upstream token whose session is gone,
 * revoked or 30-days inactive is denied even though it still verifies
 * cryptographically.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query } from "../../_generated/server";
import { AccessSnapshot, type ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError, forbiddenError } from "@kiero/runtime";
import { providerAvailabilityFromEnv } from "./providerAvailability";
import {
  DEFAULT_DEVICE_LABEL,
  resolveLiveSession,
  provisionOrRefreshLiveSession,
  resolveAccessContextFromConvexAuth,
  liveSessionIdentity,
  SESSION_INACTIVITY_LIMIT_MS,
  type LiveSessionDenial,
} from "./resolution";
import { dispatchAccessCommand, revokeSessionCore } from "./operations";
import { resolveRequestContext } from "../../platform/context";
import type { Id } from "../../_generated/dataModel";

/** The sanitized denial error every protected read fails with. */
function denialError(reason: LiveSessionDenial): never {
  throw new ConvexError(unauthenticatedError(`no_live_session_${reason}`));
}

const MAX_DEVICE_LABEL_LENGTH = 80;

/** Sanitizes an optional client device label (bounded, defaults pl-PL). */
function deviceLabelOf(input: string | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > MAX_DEVICE_LABEL_LENGTH) {
    return DEFAULT_DEVICE_LABEL;
  }
  return trimmed;
}

/** Public: which sign-in methods this deployment offers (honest states). */
export const providerAvailability = query({
  args: {},
  handler: () => providerAvailabilityFromEnv(process.env),
});

/**
 * Authenticated: provision the app session registry row for the current
 * Convex Auth session (idempotent) and refresh trusted activity time.
 * The client calls this right after sign-in and on app load.
 */
export const ensureSessionRegistry = mutation({
  args: { deviceLabel: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const live = await provisionOrRefreshLiveSession(
      ctx.db,
      ctx.auth,
      Date.now(),
      deviceLabelOf(args.deviceLabel),
    );
    if (live.tag === "denied") {
      return { state: "denied" as const, reason: live.reason };
    }
    return {
      state: "live" as const,
      sessionId: live.session.sessionId,
      lastSeenAtMs: live.session.lastSeenAtMs,
    };
  },
});

/** The contract operation's semantics at the identity layer (NullOr). */
export const resolveCurrentAccess = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const live = await resolveLiveSession(ctx.db, ctx.auth, Date.now());
    if (live.tag === "denied") {
      denialError(live.reason);
    }
    if (args.sessionId !== live.session.sessionId) {
      throw new ConvexError(forbiddenError("session_scope_mismatch", "session"));
    }
    const context = await resolveRequestContext(
      ctx.db,
      liveSessionIdentity(live.session, Date.now()),
    );
    if (context === null) {
      // A verified person without an active membership resolves to null
      // (the contract's NullOr): sign-in never confers company access.
      return null;
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      return null;
    }
    const company = await ctx.db.get(companyId);
    if (company === null) {
      return null;
    }
    return Schema.encodeSync(AccessSnapshot)(
      Schema.decodeUnknownSync(AccessSnapshot)({
        userId: context.actor.userId,
        companyId: context.actor.companyId,
        membershipRole: context.actor.membershipRole,
        isGm: context.actor.isGm,
        companyTimezone: company.timezone,
        defaultCurrency: company.defaultCurrency,
      }),
    );
  },
});

/** One device session registry row, as the barebones UI shows it. */
export interface SessionRegistryEntry {
  readonly sessionId: Id<"sessions">;
  readonly deviceLabel: string;
  readonly startedAtMs: number;
  readonly lastSeenAtMs: number;
  readonly revokedAtMs: number | null;
  readonly isCurrent: boolean;
  /** Whether the mirrored upstream session still authenticates. */
  readonly upstreamState: "live" | "gone" | "expired" | "inactive";
}

/** Authenticated: the actor's device sessions with honest live state. */
export const listMySessions = query({
  args: {},
  handler: async (ctx): Promise<SessionRegistryEntry[]> => {
    const live = await resolveLiveSession(ctx.db, ctx.auth, Date.now());
    if (live.tag === "denied") {
      denialError(live.reason);
    }
    const nowMs = Date.now();
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_user_started", (q) => q.eq("userId", live.session.userId))
      .order("desc")
      .collect();
    const entries: SessionRegistryEntry[] = [];
    for (const row of rows) {
      // Service-bridge rows (no mirrored authSession) read as gone: they
      // never authenticate through the user path this list belongs to.
      const upstream =
        row.authSessionId === undefined ? null : await ctx.db.get(row.authSessionId);
      let upstreamState: SessionRegistryEntry["upstreamState"] = "gone";
      if (upstream !== null && upstream.userId === row.userId) {
        upstreamState =
          upstream.expirationTime <= nowMs
            ? "expired"
            : row.revokedAtMs === undefined &&
                nowMs - row.lastSeenAtMs > SESSION_INACTIVITY_LIMIT_MS
              ? "inactive"
              : "live";
      }
      entries.push({
        sessionId: row._id,
        deviceLabel: row.deviceLabel,
        startedAtMs: row.startedAtMs,
        lastSeenAtMs: row.lastSeenAtMs,
        revokedAtMs: row.revokedAtMs ?? null,
        isCurrent: row._id === live.session.sessionId,
        upstreamState,
      });
    }
    return entries;
  },
});

/**
 * The typed command dispatch entry (the A3 seam with B1's identity source
 * and policy): the same checked path for UI and future agent commands.
 * Envelope validation is delegated to the contract schemas (A3 ruling),
 * so the Convex-level argument stays `unknown` by design.
 */
export const dispatchAccess = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchAccessCommand(ctx, args.envelope),
});

/** The barebones identity-layer full-chain resolution (A3 canonical path). */
export const accessContextProbe = query({
  args: {},
  handler: async (ctx) => {
    const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
    return context === null ? null : { userId: context.actor.userId, companyId: context.actor.companyId };
  },
});

/**
 * Authenticated: self-service revocation of one of the actor's own
 * sessions (the current device's "Wyloguj to urządzenie", or a remote
 * device's row). Result envelope matches the typed dispatch entry.
 */
export const revokeSession = mutation({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const live = await resolveLiveSession(ctx.db, ctx.auth, Date.now());
    if (live.tag === "denied") {
      denialError(live.reason);
    }
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", live.session.userId))
      .filter((q) => q.eq(q.field("state"), "active"))
      .order("asc")
      .first();
    const outcome = await revokeSessionCore(ctx, {
      actorUserId: live.session.userId,
      targetSessionId: args.sessionId,
      nowMs: Date.now(),
      companyIdForEvent: membership === null ? null : membership.companyId,
    });
    return outcome.result;
  },
});
