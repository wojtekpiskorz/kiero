/**
 * GM access feature entry (B4): the audited operator surface — enter/exit
 * GM mode with basis, company inspection, account recovery, onboarding,
 * activation, administrator restoration and alpha ending, all through the
 * checked dispatch entries in convex/access/gm/functions.ts.
 *
 * The GM tab is visible to every signed-in person; the surface itself
 * fails closed honestly for anyone without an open GM grant (the entry
 * action additionally checks the deployment's operator designation).
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { GmAccessFeature } from "../../../features/gm/access/GmAccessFeature";

/** The registered host entry for the GM access surface. */
export const gmAccessFeatureEntry = appFeatureEntry({
  featureId: "access.gm",
  routePath: "/gm",
  navLabel: "GM",
  screenHeading: "GM — dostęp operatora",
  consumedOperations: [
    "access.enterGmMode",
    "access.exitGmMode",
    "access.resolveCurrentAccess",
    "access.recoverAccount",
    "access.gmInspectCompany",
    "access.gmOnboardCompany",
    "access.gmActivateCompany",
    "access.gmRestoreAdministrator",
    "access.gmEndCompanyAlpha",
  ],
  implementation: "mounted",
  screen: () => createElement(GmAccessFeature),
});
