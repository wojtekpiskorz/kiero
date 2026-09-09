/**
 * Membership feature entry (B3): the FIRST mounted host feature — the
 * sanctioned sign-in wiring point (issue #22 names mounting B1's sign-in
 * into the A4 host as this lane's host-composition edit).
 *
 * An unauthenticated visitor reaches sign-in here (B1's state machine and
 * copy, composed JSX-free from ../sign-in/state.ts so this registry chain
 * stays importable by the node test programs); an authenticated member
 * reaches the membership surface (company admission, invitations, roles,
 * administration transfer). All operations go through the checked dispatch
 * entries in convex/access/membership/functions.ts.
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { MembershipFeature } from "../../../features/membership/MembershipFeature";

/** The registered host entry for the membership surface. */
export const membershipFeatureEntry = appFeatureEntry({
  featureId: "access.membership",
  routePath: "/firma",
  navLabel: "Firma",
  screenHeading: "Firma i członkostwo",
  consumedOperations: [
    "access.resolveCurrentAccess",
    "access.createCompany",
    "access.createInvitation",
    "access.acceptInvitation",
    "access.rejectInvitation",
    "access.revokeInvitation",
    "access.changeMembershipRole",
    "access.transferAdministration",
    "access.revokeMembership",
  ],
  implementation: "mounted",
  screen: () => createElement(MembershipFeature),
});
