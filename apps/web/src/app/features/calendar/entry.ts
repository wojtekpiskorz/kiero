/**
 * Calendar connection feature entry (G1): the Polish barebones entry point
 * for the optional personal Google calendar (issue #45's "A Polish
 * unstyled entry point exposes connect, reconnect, switch account, and
 * explicit recreate-after-confirmed-deletion operations").
 *
 * The screen renders the server's typed connection status and its honest
 * availableActions (connect / reconnect / switch / recreate / disconnect);
 * the authorization start runs server-side and the browser follows the
 * returned Google URL. Mounting this entry is G1's sanctioned host-
 * composition edit: one import + one line in ../app-features.ts.
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { CalendarFeature } from "../../../features/calendar/CalendarFeature";

/** The registered host entry for the Calendar connection surface. */
export const calendarFeatureEntry = appFeatureEntry({
  featureId: "calendar.connection",
  routePath: "/kalendarz",
  navLabel: "Kalendarz",
  screenHeading: "Kalendarz Kiero w Google",
  consumedOperations: ["calendar.connectCalendar", "calendar.disconnectCalendar"],
  implementation: "mounted",
  screen: () => createElement(CalendarFeature),
});
