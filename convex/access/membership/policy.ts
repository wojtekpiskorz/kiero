/**
 * The B3 membership policy: the authoritative access rule set the platform
 * seam names ("B1/B3 supply the authoritative access rules by registering a
 * policy through this seam", packages/runtime/src/context.ts).
 *
 * B1's registered policy (convex/access/identity/policy.ts) documents that
 * it delegates to the platform default "until B3 replaces this registration
 * with the authoritative rule set (last-admin constraints, invitation
 * admission, GM audit integration)". THIS object is that replacement for
 * the membership lane's dispatch: every B3 command resolves through it.
 *
 * What decides where:
 *
 * - Session liveness (upstream existence, revocation, the 30-day
 *   inactivity rule) is enforced BEFORE the policy, by the B1 identity
 *   resolution the dispatch composes; a denied session resolves NO context
 *   and fails `unauthenticated` here.
 * - Intent, tenant-scope, admin and GM semantics decide HERE, over the
 *   RESOLVED context (never client input). The decisions match the
 *   platform defaults on purpose — they were already the certified
 *   semantics — with the B3 additions documented below.
 * - The domain invariants the issue names (the one-active-company rule,
 *   last-admin constraints, invitation admission, single use) are
 *   TRANSACTIONAL invariants: they cannot be decided from a request
 *   snapshot because they are races by definition. They live in the cores
 *   (./cores.ts) every handler runs inside ONE Convex transaction, and
 *   this policy is the gate in front of them. "Every consumer checks
 *   current authorization independently" — the resolution re-reads the
 *   membership rows on every request; nothing is cached.
 *
 * B1's own dispatch keeps its policy object (its operations carry no B3
 * rules); B2/B4 register theirs. Swapping this object remains how a later
 * lane supersedes these rules.
 */

import {
  membershipPolicy,
  type AccessPolicy,
} from "@kiero/runtime";

/** B3's registered membership policy (the authoritative rule set). */
export const membershipLanePolicy: AccessPolicy = {
  policyId: "access.b3-membership-v1",
  authorize: async (context, request) => {
    // Pre-condition owned by the composed resolution: a context exists only
    // for a live, unrevoked, active session with an active membership (the
    // canonical chain B1's identity source feeds). A membership-less
    // verified person never reaches this policy through the company-scoped
    // dispatch — their entry way is the admission surface (./dispatch.ts).
    return await membershipPolicy.authorize(context, request);
  },
};
