/**
 * G1 focused verification: the Calendar connection screen (the Polish
 * barebones entry point) renders through the real A4 host registry with
 * honest copy and no fake data.
 *
 * The mounted surface needs a backend session for its live status, so the
 * headless render covers the states reachable without one (unconfigured /
 * misconfigured connection) plus the registry wiring itself: the entry is
 * mounted at /kalendarz, names exactly the two certified connection
 * operations, and the lifecycle copy (the full control vocabulary,
 * including the explicit recreate and the unknown-creation
 * acknowledgement) is pinned as stable product text. The live lifecycle
 * itself is proven by tests/g1/live-proof.mjs against the deployment.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { resolveFeatureScreen } from "../../apps/web/src/app/feature-pending";
import { AppServicesProvider } from "../../apps/web/src/app/providers";
import { loadAppConfig } from "../../apps/web/src/app/config";
import { calendarCopy, reasonText } from "../../apps/web/src/features/calendar/state";
import { availableActions } from "../../convex/calendar/connection/cores";

const calendarEntry = appFeatures.find((entry) => entry.featureId === "calendar.connection");

function renderCalendar(config = loadAppConfig({})): string {
  if (calendarEntry === undefined) {
    throw new Error("calendar.connection feature is not registered");
  }
  return renderToString(
    createElement(AppServicesProvider, {
      services: { config },
      children: createElement(resolveFeatureScreen(calendarEntry)),
    }),
  );
}

describe("the calendar feature registration (A4 composition)", () => {
  it("is mounted at /kalendarz with the Polish nav label and heading", () => {
    expect(calendarEntry?.implementation).toBe("mounted");
    expect(calendarEntry?.routePath).toBe("/kalendarz");
    expect(calendarEntry?.navLabel).toBe("Kalendarz");
    expect(calendarEntry?.screenHeading).toBe("Kalendarz Kiero w Google");
  });

  it("consumes exactly the certified calendar operations (G1's two, plus G4's copy commands, plus G5's selection write)", () => {
    // G4 (issue #48) appended the settings surface's copy commands to the
    // SAME entry G1 registered: the minimal flagged amendment of this pin.
    // G5 (issue #107) appended the project-selection write the same way.
    expect(calendarEntry?.consumedOperations).toEqual([
      "calendar.connectCalendar",
      "calendar.disconnectCalendar",
      "calendar.setCopyHidden",
      "calendar.reconcileCopy",
      "calendar.setSelection",
    ]);
  });
});

describe("the calendar screen without a backend (honest states)", () => {
  it("renders the unconfigured state with the configuration seam named", () => {
    const html = renderCalendar();
    expect(html).toContain("Kalendarz Kiero w Google");
    expect(html).toContain("VITE_CONVEX_URL");
  });

  it("renders the misconfigured state", () => {
    const html = renderCalendar(loadAppConfig({ VITE_CONVEX_URL: "not a url" }));
    expect(html).toContain("jest nieprawidłowy");
  });
});

describe("the control vocabulary maps the server's availableActions", () => {
  it("offers exactly the five lifecycle controls in Polish", () => {
    const labels = [calendarCopy.connect, calendarCopy.reconnect, calendarCopy.switchAccount, calendarCopy.recreate, calendarCopy.disconnect];
    expect(labels).toEqual(["Połącz kalendarz", "Połącz ponownie", "Zmień konto Google", "Odtwórz kalendarz", "Odłącz"]);
  });

  it("keeps every machine reconnect reason explainable in Polish", () => {
    for (const reason of [
      "authorization_denied",
      "authorization_expired",
      "exchange_failed",
      "exchange_unknown",
      "scopes_missing",
      "creation_failed",
      "creation_unknown",
      "calendar_read_unknown",
      "calendar_access_lost",
      "refresh_failed",
      "membership_lost",
    ]) {
      expect(reasonText(reason)).not.toBe(calendarCopy.unknownReason);
    }
    expect(reasonText("something_new")).toBe(calendarCopy.unknownReason);
  });

  it("the acknowledgement copy exists for the unresolved-creation gate", () => {
    expect(calendarCopy.creationAcknowledgement).toContain("mógł już zostać utworzony");
    // The server offers reconnect exactly where the screen needs the gate.
    expect(availableActions({ state: "error", authorizationMode: null, authorizationExpiresAtMs: null, googleCalendarId: null, googleAccountSubject: null, reconnectReason: "creation_unknown" })).toContain("reconnect");
  });
});
