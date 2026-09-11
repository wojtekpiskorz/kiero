/**
 * Source-detail feature entry (A4 host wiring point, H3's sanctioned
 * addition).
 *
 * "Źródło" is the full source-history route: the immutable original with
 * its lifecycle and withdrawal record, every retained representation,
 * transcript/OCR segments with their time/coordinate anchors, the
 * paginated evidence chain with corrections and C5's recomputation
 * status, and media loads exclusively through D3's authorized channel.
 * It opens from the canonical `/?zrodlo=<id>` deep link family
 * (`/zrodlo?zrodlo=<id>`), search results and memory evidence links.
 *
 * Consumed operations are the commands the surface issues: C5's audited
 * withdrawal and F1's read marking. The dossier/evidence reads ride this
 * lane's own public queries (the H3-flagged sources/read appends).
 */

import { createElement } from "react";
import { appFeatureEntry, type AppFeatureEntry } from "../../registry";
import { SourceDetailFeature } from "../../../features/source-detail/SourceDetailFeature";

/** The registered host entry for the source-history surface. */
export const sourceDetailFeatureEntry: AppFeatureEntry = appFeatureEntry({
  featureId: "source.detail",
  routePath: "/zrodlo",
  navLabel: "Źródło",
  screenHeading: "Źródło",
  consumedOperations: ["sources.withdrawSource", "attention.markSourceRead"],
  implementation: "mounted",
  screen: () => createElement(SourceDetailFeature),
});
