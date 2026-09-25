/**
 * Membership feature entry: the FIRST mounted host feature — the
 * sign-in wiring point.
 *
 * An unauthenticated visitor reaches sign-in here (the state machine and
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
