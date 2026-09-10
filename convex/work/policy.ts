/**
 * The C4 work policy: the lane's registration over the platform
 * authorization seam.
 *
 * Every work operation is ordinary collaborative boss work — any active
 * member of the firm records tasks, checks points, changes states and
 * records events ("Szef" is the user group; the admin/member distinction
 * governs membership administration, not work). The decisions therefore
 * remain the certified platform semantics: a resolved context is required
 * (`unauthenticated` without one) and the tenant scope must match the
 * actor's resolved company.
 *
 * The company scope itself never comes from client input: the dispatch
 * resolves it from the B1 live-session identity through the canonical chain
 * (user -> earliest active membership -> company), exactly as C1's projects
 * dispatch does. Cross-company references are then row-level checks inside
 * each transaction (indistinguishable from missing rows).
 */

import { membershipPolicy, type AccessPolicy } from "@kiero/runtime";

/** C4's registered work policy (the authoritative rule set for this lane). */
export const workLanePolicy: AccessPolicy = {
  policyId: "work.c4-work-v1",
  authorize: async (context, request) => {
    return await membershipPolicy.authorize(context, request);
  },
};
