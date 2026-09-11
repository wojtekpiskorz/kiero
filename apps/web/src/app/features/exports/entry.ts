/**
 * Exports feature entry (I3): the Polish barebones status/download screen
 * issue #55 requires, mounted through the A4 host registry. The entry file
 * owns the shape; mounting it is I3's sanctioned one-line host-composition
 * edit in ../app-features.ts (the F3/D4 precedent).
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { ExportsFeature } from "../../../features/exports/ExportsFeature";

/** The registered host entry for the firm-export surface. */
export const exportsFeatureEntry = appFeatureEntry({
  featureId: "operations.exports",
  routePath: "/eksport",
  navLabel: "Eksport",
  screenHeading: "Eksport danych firmy",
  consumedOperations: ["operations.requestExport"],
  implementation: "mounted",
  screen: () => createElement(ExportsFeature),
});
