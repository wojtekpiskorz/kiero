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
 * Scope ruling (PR #94 review round 1): this helper is LANE-LOCAL — the
 * same closure currently sits verbatim in five dispatch files across
 * lanes, and promoting it to `convex/platform/context.ts` (and migrating
 * the other lanes' copies) is a recorded follow-up for the platform owner,
 * deliberately NOT done in this PR.
 */

import type { RequestContext } from "@kiero/runtime";
import type { MutationCtx } from "../_generated/server";
import { bridgeIdentity, identityFromConvexAuth, resolveRequestContext } from "../platform/context";

/**
 * Builds the `resolveContext` dependency for one attention dispatch.
 * `serviceSessionId === undefined` marks the user (Convex Auth) path; a
 * present id marks the service-bridge path.
 */
export function attentionContextResolver(
  serviceSessionId: string | undefined,
): (tx: MutationCtx) => Promise<RequestContext | null> {
  return async (tx) => {
    const identity =
      serviceSessionId === undefined
        ? await identityFromConvexAuth(tx.auth, Date.now())
        : bridgeIdentity(serviceSessionId, Date.now());
    return resolveRequestContext(tx.db, identity);
  };
}
