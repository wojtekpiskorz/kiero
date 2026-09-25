/**
 * Data-deletion feature entry: the Polish barebones impact-preview /
 * confirmation / cleanup-status screen, mounted through
 * the host registry. The entry file owns the shape; mounting it is the
 * host-composition edit in ../composition/full.ts.
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { DataDeletionFeature } from "../../../features/data-deletion/DataDeletionFeature";

/** The registered host entry for the permanent-deletion surface. */
export const dataDeletionFeatureEntry = appFeatureEntry({
  featureId: "operations.deletion",
  routePath: "/usuwanie-danych",
  navLabel: "Trwałe usunięcie",
  screenHeading: "Trwałe usunięcie danych",
  consumedOperations: ["sources.purgeSource"],
  implementation: "mounted",
  screen: () => createElement(DataDeletionFeature),
});
