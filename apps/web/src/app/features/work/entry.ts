/**
 * Work feature entry (A4 host wiring point, H2's sanctioned addition).
 *
 * "Praca" is the record surface for project work: tasks with one-level
 * checklists, coordinator/executor responsibility, bound term findings and
 * explicit states (Do zrobienia, W toku, Czeka z powodem, Wykonane,
 * Anulowane), plus events whose occurrence is only ever an explicit
 * command. Every change rides C4's checked dispatch; the route accepts
 * the same ?zadanie/?zdarzenie record-focus keys the /co-teraz screen
 * links in with.
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { WorkFeature } from "../../../features/work/WorkFeature";

/** The registered host entry for the work records surface. */
export const workFeatureEntry = appFeatureEntry({
  featureId: "work.records",
  routePath: "/praca",
  navLabel: "Praca",
  screenHeading: "Praca",
  consumedOperations: [
    "work.changeTask",
    "work.changeTaskState",
    "work.changeChecklistItem",
    "work.promoteChecklistItem",
    "work.changeEvent",
    "work.changeEventState",
  ],
  implementation: "mounted",
  screen: () => createElement(WorkFeature),
});
