/**
 * Attention-lane dispatch context resolution (F1, review round 1).
 *
 * The identity-to-context closure every attention dispatch needs, spelled
 * ONCE for this lane: without a service session id, Convex Auth is the
 * only identity source; with one, the A3 service-bridge identity (verified
 * before this point) substitutes the bearer-verified identity. Both feed
 * the SAME canonical resolution (session -> user -> one active membership
 * -> company). There is no development-auth shortcut.
 *
 * Scope ruling (PR #94 review round 1): this helper is LANE-LOCAL: the
 * same closure currently sits verbatim in five dispatch files across
 * lanes, and promoting it to `convex/platform/context.ts` (and migrating
 * the other lanes' copies) is a recorded follow-up for the platform owner,
 * deliberately NOT done in this PR.
 *
 * J2 identity repair (the gap H2 recorded on its public reads): the user
 * path no longer resolves through the platform-generic
 * `identityFromConvexAuth`, because a real Convex Auth token's subject is
 * `<userId>|<authSessions id>` (not a sessions-registry id), so
 * which made every ordinary user token fail `unauthenticated` here. The user path
 * now maps the auth-session subject through B1's live-session chain
 * (`resolveAccessContextFromConvexAuth` on reads,
 * `resolveAccessContextWithProvisioning` on dispatch: the same fold-in
 * J1 applied to C2's and D1's public entries), which is what makes the
 * notification-click -> /co-teraz flows work end to end.
 */

import type { RequestContext } from "@kiero/runtime";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { bridgeIdentity, resolveRequestContext } from "../platform/context";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextFromConvexAuth,
  resolveAccessContextWithProvisioning,
} from "../access/identity/resolution";

/** One resolved actor scope: the company and user every query below reads. */
export interface ActorScope {
  readonly companyId: Id<"companies">;
  readonly userId: Id<"users">;
}

/** Narrows a resolved context into a query scope (null when unresolvable). */
export async function scopeOfContext(
  db: QueryCtx["db"],
  context: RequestContext | null,
): Promise<ActorScope | null> {
  if (context === null) {
    return null;
  }
  const companyId = db.normalizeId("companies", context.actor.companyId);
  const userId = db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return null;
  }
  return { companyId, userId };
}

/** Resolves the caller's query scope from Convex Auth (the user path). */
export async function resolveOwnQueryScope(ctx: QueryCtx): Promise<ActorScope | null> {
  const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
  return scopeOfContext(ctx.db, context);
}

/** Resolves the caller's query scope from a verified service session (bridge path). */
export async function resolveBridgeQueryScope(
  ctx: QueryCtx,
  serviceSessionId: string,
): Promise<ActorScope | null> {
  const context = await resolveRequestContext(ctx.db, bridgeIdentity(serviceSessionId, Date.now()));
  return scopeOfContext(ctx.db, context);
}

/**
 * Builds the `resolveContext` dependency for one attention dispatch.
 * `serviceSessionId === undefined` marks the user (Convex Auth) path; a
 * present id marks the service-bridge path.
 */
export function attentionContextResolver(
  serviceSessionId: string | undefined,
): (tx: MutationCtx) => Promise<RequestContext | null> {
  return async (tx) => {
    if (serviceSessionId === undefined) {
      return resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL);
    }
    return resolveRequestContext(tx.db, bridgeIdentity(serviceSessionId, Date.now()));
  };
}
