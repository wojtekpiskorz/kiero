/**
 * The projects policy: the lane's registration over the platform
 * authorization seam.
 *
 * Every projects operation is ordinary collaborative boss work — any active
 * member of the firm identifies projects, assigns codenames, changes stages,
 * pauses, and keeps the contact catalog ("Szef" is the user group; the
 * admin/member distinction governs membership administration, not project
 * work). The decisions therefore remain the certified platform semantics:
 * a resolved context is required (`unauthenticated` without one) and the
 * tenant scope must match the actor's resolved company.
 *
 * The company scope itself never comes from client input: the dispatch
 * resolves it from the live-session identity through the canonical chain
 * (user -> earliest active membership -> company) the same way the
 * membership dispatch does. Cross-company references are then row-level
 * checks inside each transaction (indistinguishable from missing rows).
 */

import {
  membershipPolicy,
  type AccessPolicy,
} from "@kiero/runtime";

/** Bundle-evolution marker for deployment env refreshes (content, not comment). */
export const PROJECTS_LANE_POLICY_MARKER = "c1-env-refresh-2";

/** the registered projects policy (the authoritative rule set for this lane). */
export const projectsLanePolicy: AccessPolicy = {
  policyId: "projects.c1-projects-v1",
  authorize: async (context, request) => {
    return await membershipPolicy.authorize(context, request);
  },
};


