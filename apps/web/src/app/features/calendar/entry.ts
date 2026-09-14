/**
 * Calendar feature entry (G1 connection lifecycle + G4 settings and sync
 * diagnostics): the Polish barebones entry point for the optional personal
 * Google calendar ("Kalendarz Kiero w Google").
 *
 * R16 (issue #198) withholds this surface from the v1 PWA composition: the
 * owner deferred the Google Calendar integration beyond v1 (ADR
 * docs/adr/calendar-deferral-2026-09.md). The entry switches to the
 * registry's pending state, so the composition's mounted filter drops it
 * from routes and navigation while the integrated G-series code (screen,
 * backend, contracts) stays intact for the future lane that remounts it.
 */

import { appFeatureEntry } from "../../registry";

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
    // G5 addition (issue #107): the personal project-selection write the
    // scope section's editor issues (G4's own pin-amendment precedent).
    "calendar.setSelection",
  ],
  implementation: "pending",
  pendingNote:
    "Kalendarz Kiero w Google nie jest dostępny w tej wersji: podłączanie kalendarza Google zostało odroczone na późniejszą wersję Kiero. Ustalenia z terminami pozostają w Kiero, a ta funkcja wróci po dokończeniu integracji.",
});
