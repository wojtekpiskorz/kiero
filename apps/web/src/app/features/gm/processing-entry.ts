/**
 * GM processing feature entry (H4): the audited processing inspector and
 * the GM retry controls; inspection of one processing run (canonical
 * stages, attempts with the approved model route, versions, derived
 * changes, I2 redacted diagnostics, derived blockers), failed-stage retry
 * that preserves run identity, and deliberate reanalysis as a linked new
 * run; through the checked dispatch entries in
 * convex/operations/processing/functions.ts under B4's explicit GM mode.
 *
 * Like B4's GM tab, this surface is visible to every signed-in person and
 * fails closed honestly for anyone without an open GM grant; it consumes
 * B4's gmOverview read for the mode state and issues no source-read
 * marking and no usage mutation.
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { GmProcessingFeature } from "../../../features/gm/processing/GmProcessingFeature";

/** The registered host entry for the GM processing surface. */
export const gmProcessingFeatureEntry = appFeatureEntry({
  featureId: "operations.processing",
  routePath: "/gm-przetwarzanie",
  navLabel: "GM — przetwarzanie",
  screenHeading: "GM — inspekcja przetwarzania",
  consumedOperations: [
    "operations.inspectProcessingRun",
    "operations.retryProcessingStep",
    "operations.requestReanalysis",
  ],
  implementation: "mounted",
  screen: () => createElement(GmProcessingFeature),
});
