/**
 * "Co teraz" feature entry (A4 host wiring point; H2's mount).
 *
 * Reachable straight from the module entries, without a mandatory
 * dashboard: the current obligations of the firm and of the signed-in
 * boss. H2 replaces this lane's pending placeholder with the real
 * per-user screen: assigned and unassigned open work (closed projects'
 * remaining obligations included), events awaiting explicit confirmation,
 * open questions across firm and project memory, and F4's personal
 * reminder/snooze state. The route owns G4's parity-pinned deep links
 * (`/co-teraz?zadanie=<id>` / `?zdarzenie=<id>`, subjectLinkPath).
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { NowFeature } from "../../../features/now/NowFeature";

/** The registered host entry for the "Co teraz" surface. */
export const coTerazFeatureEntry = appFeatureEntry({
  featureId: "attention.now",
  routePath: "/co-teraz",
  navLabel: "Co teraz",
  screenHeading: "Co teraz",
  consumedOperations: [
    "work.changeTaskState",
    "work.changeEventState",
    "attention.snoozeTaskReminders",
    "memory.resolveClarification",
  ],
  implementation: "mounted",
  screen: () => createElement(NowFeature),
});
