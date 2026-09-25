/**
 * Search feature entry.
 *
 * "Szukaj" is the evidence-search route over the tenant-safe versioned
 * retrieval: `search.queryEvidence` with the Polish barebones filters
 * (project, author, send-date range) and cursor paging, the coverage
 * disclosure shown verbatim, every hit hydrated against its canonical
 * record before rendering, and the authoritative open through the source
 * deep link or the revision history.
 *
 * The consumed operation is the action the surface issues; the hydration
 * reads (the source detail, the finding history) ride those lanes' own
 * public queries.
 */

import { createElement } from "react";
import { appFeatureEntry, type AppFeatureEntry } from "../../registry";
import { SearchFeature } from "../../../features/search/SearchFeature";

/** The registered host entry for the search surface. */
export const searchFeatureEntry: AppFeatureEntry = appFeatureEntry({
  featureId: "search.evidence",
  routePath: "/szukaj",
  navLabel: "Szukaj",
  screenHeading: "Szukaj",
  consumedOperations: ["search.queryEvidence"],
  implementation: "mounted",
  screen: () => createElement(SearchFeature),
});
