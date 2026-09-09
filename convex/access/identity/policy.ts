/**
 * The B1 access policy, registered over the platform default.
 *
 * The A3 authorization seam (packages/runtime/src/context.ts) says B1/B3
 * register the authoritative implementation over `membershipPolicy`. The
 * live-session guarantees — upstream session existence, explicit
 * revocation, the 30-day inactivity rule — are enforced BEFORE the policy
 * runs, in the identity resolution (./resolution.ts): a denied session
 * resolves NO context, and `membershipPolicy` (which this policy
 * composes) fails `unauthenticated` on null context. That ordering is the
 * product rule: an upstream token that still verifies never reaches role
 * checks once its app session is revoked or inactive.
 *
 * Role, tenant-scope, admin and GM semantics stay the platform defaults
 * until B3 replaces this registration with the authoritative rule set
 * (last-admin constraints, invitation admission, GM audit integration).
 */

import {
  membershipPolicy,
  type AccessPolicy,
  type AccessRequest,
  type AuthorizationDecision,
  type RequestContext,
} from "@kiero/runtime";

/**
 * B1's registered policy: delegates to the platform default after the
 * live-session resolution has already gated the context. Swapping this
 * object (not the resolution) is how B3 takes over authorization.
 */
export const liveSessionPolicy: AccessPolicy = {
  policyId: "access.b1-live-session-v1",
  authorize: async (
    context: RequestContext | null,
    request: AccessRequest,
  ): Promise<AuthorizationDecision> => {
    // Pre-condition owned by B1's resolution: a context exists only for a
    // live, unrevoked, active session. Documented, not re-checked here —
    // the resolution is the single authority for session validity.
    return await membershipPolicy.authorize(context, request);
  },
};
