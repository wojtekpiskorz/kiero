/**
 * The C1 projects policy: the lane's registration over the platform
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
 * resolves it from the B1 live-session identity through the canonical chain
 * (user -> earliest active membership -> company) the same way B3's
 * membership dispatch does. Cross-company references are then row-level
 * checks inside each transaction (indistinguishable from missing rows).
 */

import {
  membershipPolicy,
  type AccessPolicy,
} from "@kiero/runtime";

/** Bundle-evolution marker for deployment env refreshes (content, not comment). */
export const PROJECTS_LANE_POLICY_MARKER = "c1-env-refresh-2";

/** C1's registered projects policy (the authoritative rule set for this lane). */
export const projectsLanePolicy: AccessPolicy = {
  policyId: "projects.c1-projects-v1",
  authorize: async (context, request) => {
    return await membershipPolicy.authorize(context, request);
  },
};


