/**
 * Search feature entry (A4 host wiring point, H3's sanctioned addition).
 *
 * "Szukaj" is the evidence-search route over E5's tenant-safe versioned
 * retrieval: `search.queryEvidence` with the Polish barebones filters
 * (project, author, send-date range) and cursor paging, the coverage
 * disclosure shown verbatim, every hit hydrated against its canonical
 * record before rendering, and the authoritative open through the source
 * deep link or C2's revision history.
 *
 * The consumed operation is the action the surface issues; the hydration
 * reads (D1's source detail, C2's finding history) ride those lanes' own
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
