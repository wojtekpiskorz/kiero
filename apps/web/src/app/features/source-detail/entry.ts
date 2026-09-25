/**
 * Source-detail feature entry (a host wiring point).
 * addition).
 *
 * "Źródło" is the full source-history route: the immutable original with
 * its lifecycle and withdrawal record, every retained representation,
 * transcript/OCR segments with their time/coordinate anchors, the
 * paginated evidence chain with corrections and the recomputation
 * status, and media loads exclusively through the authorized channel.
 * It opens from the canonical `/?zrodlo=<id>` deep link family
 * (`/zrodlo?zrodlo=<id>`), search results and memory evidence links.
 *
 * Consumed operations are the commands the surface issues: the audited
 * withdrawal and the read marking. The dossier/evidence reads ride this
 * lane's own public queries (the sources/read appends).
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
