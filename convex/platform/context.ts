/**
 * Actor/session/tenant request context resolution (A3).
 *
 * The canonical resolution every checked operation goes through:
 * verified identity -> live `sessions` row -> `users` row -> one active
 * `memberships` row -> `companies` row -> validated `ActorContext`.
 *
 * Identity sources (exactly two, both verified server-side):
 * - `identityFromConvexAuth`: Convex Auth identity from `ctx.auth` (the user
 *   path; B1 owns the sign-in product that issues it).
 * - the Worker service bridge: the bearer credential verified at the HTTP
 *   boundary (see ./http.ts); the resulting identity maps to the service
 *   account's own session row.
 *
 * There is NO development-auth shortcut: nothing here reads a user or company
 * from client input, and a missing/revoked/incomplete chain resolves to
 * `null`, which the checked path fails `unauthenticated`.
 */

import { Schema } from "effect";
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { ActorContext } from "@kiero/contracts";
import type { VerifiedIdentity, RequestContext } from "@kiero/runtime";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** Reads identity claims from Convex Auth; null when unauthenticated. */
export async function identityFromConvexAuth(
  auth: { getUserIdentity(): Promise<{ subject: string } | null> },
  nowMs: number,
): Promise<VerifiedIdentity | null> {
  const identity = await auth.getUserIdentity();
  if (identity === null) {
    return null;
  }
  return { issuer: "convex-auth", subject: identity.subject, verifiedAtMs: nowMs };
}

/**
 * Constructs the service-bridge identity AFTER the bearer credential check
 * has passed (http.ts). The subject is the service account's session row id.
 */
export function bridgeIdentity(serviceSessionId: string, nowMs: number): VerifiedIdentity {
  return { issuer: "service-bridge", subject: serviceSessionId, verifiedAtMs: nowMs };
}

/** The DB reader surface resolution needs (satisfied by any Convex ctx.db). */
export type ResolutionDb = QueryCtx["db"];

/**
 * Resolves the request context from a verified identity.
 * Returns null for any broken chain (no session, revoked session, missing
 * user/company, no active membership).
 */
export async function resolveRequestContext(
  db: ResolutionDb,
  identity: VerifiedIdentity | null,
): Promise<RequestContext | null> {
  if (identity === null) {
    return null;
  }
  const sessionId = db.normalizeId("sessions", identity.subject);
  if (sessionId === null) {
    return null; // not a well-formed Convex id (A2 note: normalizeId is the check)
  }
  const session = await db.get(sessionId);
  if (session === null || session.revokedAtMs !== undefined) {
    return null;
  }
  const user = await db.get(session.userId);
  if (user === null) {
    return null;
  }
  const memberships = await db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", session.userId))
    .collect();
  const active = memberships
    .filter((membership) => membership.state === "active")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const membership = active[0];
  if (membership === undefined) {
    // v1: the earliest active membership is the user's one active firm
    // ("Członkostwo w firmie", CONTEXT.md); B3 owns the authoritative rule.
    return null;
  }
  const company = await db.get(membership.companyId);
  if (company === null) {
    return null;
  }
  const grants = await db
    .query("gmAccessGrants")
    .withIndex("by_user_open", (q) => q.eq("userId", session.userId))
    .collect();
  const isGm = grants.some((grant) => grant.closedAtMs === undefined);

  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: session.userId,
    companyId: membership.companyId,
    membershipRole: membership.role,
    isGm,
    sessionId: sessionId,
    via: "user",
  });
  return { actor, resolvedAtMs: identity.verifiedAtMs };
}

/**
 * Internal query: resolve the request context for a verified service
 * session. Returns the Convex-normalized company id alongside the actor so
 * action-side callers can pass typed ids without a db handle.
 */
export const resolveServiceContext = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db.normalizeId("sessions", args.sessionId);
    if (session === null) {
      return null;
    }
    const context = await resolveRequestContext(ctx.db, bridgeIdentity(session, Date.now()));
    if (context === null) {
      return null;
    }
    return {
      actor: context.actor,
      resolvedAtMs: context.resolvedAtMs,
      normalizedCompanyId: ctx.db.normalizeId("companies", context.actor.companyId),
    };
  },
});

/**
 * E4 amendment: the author's live session row. Background analysis
 * pipelines (E3's text analysis, E4's join) act within the source author's
 * firm permissions through a server-resolved session, never client input,
 * never a fabricated identity. The newest live session wins; the indexed
 * scan stops at the first hit, so a long-lived author costs one read.
 */
export async function authorSessionId(
  db: ResolutionDb,
  authorUserId: Id<"users">,
): Promise<Id<"sessions"> | null> {
  const session = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", authorUserId))
    .order("desc")
    .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
    .first();
  return session?._id ?? null;
}
