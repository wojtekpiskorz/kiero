/**
 * Data-deletion feature entry (I4): the Polish barebones impact-preview /
 * confirmation / cleanup-status screen issue #56 registers, mounted through
 * the A4 host registry. The entry file owns the shape; mounting it is I4's
 * sanctioned host-composition edit in ../composition/full.ts (the I3
 * precedent).
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
