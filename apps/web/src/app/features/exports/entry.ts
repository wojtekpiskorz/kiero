/**
 * Exports feature entry: the Polish barebones status/download screen
 * mounted through the host registry. The entry file
 * owns the shape; mounting it is the one-line host-composition
 * edit in ../app-features.ts.
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
