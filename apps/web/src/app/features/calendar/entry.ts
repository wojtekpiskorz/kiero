/**
 * Calendar feature entry (G1 connection lifecycle + G4 settings and sync
 * diagnostics): the Polish barebones entry point for the optional personal
 * Google calendar ("Kalendarz Kiero w Google").
 *
 * The screen renders the server's typed connection status and its honest
 * availableActions (connect / reconnect / switch / recreate / disconnect);
 * the authorization start runs server-side and the browser follows the
 * returned Google URL. G4 appends the settings surface under the
 * connection panel: sync diagnostics (last success, pending, failed,
 * reconnect-needed, cleanup residue), the personal project scope, and the
 * copies list with personal hide/restore, check-now and the Kiero deep
 * link. Mounting this entry is the lane's sanctioned host-composition
 * touch: one import + one line in ../app-features.ts (G1's, unchanged).
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { CalendarFeature } from "../../../features/calendar/CalendarFeature";

/** The registered host entry for the Calendar settings surface. */
export const calendarFeatureEntry = appFeatureEntry({
  featureId: "calendar.connection",
  routePath: "/kalendarz",
  navLabel: "Kalendarz",
  screenHeading: "Kalendarz Kiero w Google",
  consumedOperations: [
    "calendar.connectCalendar",
    "calendar.disconnectCalendar",
    // G4 additions: the personal hide/restore and the check-this-copy
    // commands the settings surface issues through the typed dispatches.
    "calendar.setCopyHidden",
    "calendar.reconcileCopy",
  ],
  implementation: "mounted",
  screen: () => createElement(CalendarFeature),
});
