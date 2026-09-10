/**
 * G4 focused verification, deterministic half: the Calendar settings and
 * sync diagnostics surface (the /kalendarz screen's G4 sections over G2's
 * projectionOverview and G3's syncOverview) with honest Polish copy and no
 * fake data.
 *
 * The issue's component/integration list is covered state by state —
 * disconnected, connecting, healthy, pending, partial failure,
 * reconnect-needed, confirmed deleted, unknown, hidden-copy and
 * cleanup-residue — through the two seams the surface owns:
 *
 * - the pure honest-state mapping (syncStatusLines / syncNextActions /
 *   copyStatusLabel in apps/web/src/features/calendar/state.ts): every
 *   state gets a DISTINCT Polish status, a next action where recovery is
 *   possible, and never a success sentence over pending or failed work;
 * - server-side renders of the REAL panels (createElement only, the A4
 *   pattern) under a dummy Convex provider: semantic structure, control
 *   presence/absence and disabled states per state, the deep-link
 *   contract, and the honesty rules (no blind recreate, no fake
 *   project-scope editor, no two-way sync implication).
 *
 * The live halves (connect, project-scope read, hide restore, disconnect,
 * deep link from a Calendar fixture, stale-command rejections) run in
 * ./live-proof.mjs against the leased dev deployment.
 */

import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { operations } from "@kiero/contracts";
import { subjectLinkPath } from "@kiero/domain";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { ConnectionPanel } from "../../apps/web/src/features/calendar/CalendarFeature";
import {
  CopiesSection,
  DiagnosticsSection,
  ScopeSection,
} from "../../apps/web/src/features/calendar/CalendarSettings";
import {
  calendarCopy,
  copyStatusLabel,
  reasonText,
  settingsCopy,
  subjectHref,
  syncNextActions,
  syncStatusLines,
  type CopyRowView,
  type SyncOverviewView,
} from "../../apps/web/src/features/calendar/state";
import { availableActions } from "../../convex/calendar/connection/cores";
import type { CalendarConnectionStatus } from "../../convex/calendar/connection/functions";

const calendarEntry = appFeatures.find((entry) => entry.featureId === "calendar.connection");

// A dummy client: mutation hooks only close over it during render; nothing
// connects because no render here subscribes to a query.
const dummyClient = new ConvexReactClient("https://proof.invalid.convex.cloud");

function renderPanel(node: ReactNode): string {
  return renderToString(createElement(ConvexProvider, { client: dummyClient, children: node }));
}

/** One syncOverview fixture (the full branch the settings consume). */
function overviewFixture(over: Partial<SyncOverviewView> = {}): SyncOverviewView {
  return {
    state: "connected",
    reconnectNeeded: false,
    reconnectReason: null,
    cleanupRemains: false,
    copies: { total: 3, confirmed: 3, pending: 0, absentWhileProjected: 0 },
    attempts: { recorded: 3, uncertain: 0, failed: 0 },
    lastConfirmedAtMs: Date.parse("2026-09-10T09:30:00.000Z"),
    ...over,
  };
}

/** One projectionOverview copy row fixture. */
function copyFixture(over: Partial<CopyRowView> = {}): CopyRowView {
  return {
    copyId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
    subjectKind: "task",
    subjectId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2t",
    desiredState: "projected",
    summary: "Zadanie: Beton pod fundament",
    hidden: false,
    remoteOutcome: "confirmed",
    ...over,
  };
}

/** One calendarStatus fixture whose actions come from the real cores. */
function connectionFixture(over: Partial<CalendarConnectionStatus> = {}): CalendarConnectionStatus {
  const state: CalendarConnectionStatus["state"] = over.state ?? "connected";
  const reconnectReason = over.reconnectReason ?? null;
  const row: Parameters<typeof availableActions>[0] =
    state === "unavailable_no_company"
      ? null
      : {
          state,
          authorizationMode: null,
          authorizationExpiresAtMs: null,
          googleCalendarId: state === "connected" ? "kiero-proof-calendar" : null,
          googleAccountSubject: state === "connected" ? "proof-subject" : null,
          reconnectReason,
        };
  return {
    state,
    connectionId: null,
    availableActions: availableActions(row),
    googleCalendarId: null,
    googleAccountEmail: null,
    connectedAtMs: null,
    disconnectedAtMs: null,
    authorizationExpiresAtMs: null,
    reconnectReason,
    cleanupStatus: null,
    lastSuccessfulContactMs: null,
    grantedScopes: null,
    credentialStorage: null,
    credentialCapability: state === "connected" ? "ready" : "absent",
    providerConfigured: true,
    ...over,
  };
}

/** The rendered HTML of one enabled/disabled control, if present. */
function control(html: string, label: string): string | null {
  const marker = `>${label}</button>`;
  const at = html.indexOf(marker);
  if (at === -1) {
    return null;
  }
  const tagStart = html.lastIndexOf("<button", at);
  return html.slice(tagStart, at + marker.length);
}

// ---------------------------------------------------------------------------
// The registration seam (A4 composition)
// ---------------------------------------------------------------------------

describe("the calendar settings registration (A4 composition)", () => {
  it("stays mounted at /kalendarz and names exactly the four certified operations G1+G4 consume", () => {
    expect(calendarEntry?.implementation).toBe("mounted");
    expect(calendarEntry?.routePath).toBe("/kalendarz");
    expect(calendarEntry?.consumedOperations).toEqual([
      "calendar.connectCalendar",
      "calendar.disconnectCalendar",
      "calendar.setCopyHidden",
      "calendar.reconcileCopy",
    ]);
    for (const operation of calendarEntry?.consumedOperations ?? []) {
      expect(operation in operations).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 1: every state has a DISTINCT Polish status and a next action
// where recovery is possible.
// ---------------------------------------------------------------------------

/** The diagnostics states the issue's focused verification names. */
const STATE_FIXTURES: readonly [string, SyncOverviewView][] = [
  ["healthy", overviewFixture()],
  [
    "pending",
    overviewFixture({
      copies: { total: 3, confirmed: 1, pending: 2, absentWhileProjected: 0 },
      attempts: { recorded: 3, uncertain: 0, failed: 0 },
    }),
  ],
  [
    "partial failure",
    overviewFixture({
      copies: { total: 3, confirmed: 1, pending: 0, absentWhileProjected: 2 },
      attempts: { recorded: 5, uncertain: 0, failed: 2 },
    }),
  ],
  [
    "reconnect-needed (refresh failed)",
    overviewFixture({ state: "error", reconnectNeeded: true, reconnectReason: "refresh_failed" }),
  ],
  [
    "reconnect-needed (membership lost)",
    overviewFixture({
      state: "disconnected",
      reconnectNeeded: true,
      reconnectReason: "membership_lost",
    }),
  ],
  [
    "confirmed deleted (calendar access lost)",
    overviewFixture({
      state: "error",
      reconnectNeeded: true,
      reconnectReason: "calendar_access_lost",
    }),
  ],
  [
    "nothing synced yet",
    overviewFixture({
      copies: { total: 0, confirmed: 0, pending: 0, absentWhileProjected: 0 },
      attempts: { recorded: 0, uncertain: 0, failed: 0 },
      lastConfirmedAtMs: null,
    }),
  ],
];

describe("every state has a distinct Polish status (criterion 1)", () => {
  it("gives each fixture a non-empty primary status line", () => {
    for (const [name, fixture] of STATE_FIXTURES) {
      const lines = syncStatusLines(fixture);
      expect(lines.length, name).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.text.trim().length, name).toBeGreaterThan(0);
      }
    }
  });

  it("keeps the primary status lines pairwise distinct across the states", () => {
    const primaries = STATE_FIXTURES.map(([, fixture]) => syncStatusLines(fixture)[0]?.text ?? "");
    expect(new Set(primaries).size).toBe(primaries.length);
  });

  it("keeps the ten states the issue names pairwise distinct on screen", () => {
    // Each of the issue's ten states maps to its own Polish sentence on
    // the /kalendarz screen (connection panel, diagnostics or copy row).
    const ten: readonly [string, string][] = [
      ["disconnected", calendarCopy.stateDisconnected],
      ["connecting", calendarCopy.statePending],
      ["healthy", settingsCopy.allConfirmed],
      ["pending", settingsCopy.pendingCopies(2)],
      ["partial failure", settingsCopy.failedAttempts(2)],
      ["reconnect-needed", reasonText("refresh_failed")],
      ["confirmed deleted", reasonText("calendar_access_lost")],
      ["unknown", reasonText("creation_unknown")],
      ["hidden-copy", settingsCopy.copyState.hidden],
      ["cleanup-residue", settingsCopy.cleanupResidueNote],
    ];
    const sentences = ten.map(([, sentence]) => sentence);
    expect(new Set(sentences).size).toBe(sentences.length);
  });

  it("offers a next action exactly where recovery is possible", () => {
    expect(syncNextActions(overviewFixture())).toEqual([]);
    const pending = STATE_FIXTURES[1]?.[1];
    const partial = STATE_FIXTURES[2]?.[1];
    const reconnect = STATE_FIXTURES[3]?.[1];
    if (pending === undefined || partial === undefined || reconnect === undefined) {
      throw new Error("fixtures missing");
    }
    expect(syncNextActions(pending)).toContain("check_now");
    expect(syncNextActions(partial)).toContain("check_now");
    expect(syncNextActions(reconnect)).toContain("reconnect");
    expect(syncNextActions(overviewFixture({ cleanupRemains: true }))).toContain(
      "check_google_manually",
    );
  });

  it("renders the connection-level states with their recovery controls", () => {
    const disconnected = renderPanel(
      createElement(ConnectionPanel, { status: connectionFixture({ state: "disconnected" }) }),
    );
    expect(disconnected).toContain(calendarCopy.stateDisconnected);
    expect(control(disconnected, calendarCopy.connect)).not.toContain("disabled");

    const connecting = renderPanel(
      createElement(ConnectionPanel, {
        status: connectionFixture({ state: "pending_authorization" }),
      }),
    );
    expect(connecting).toContain(calendarCopy.statePending);
    expect(control(connecting, calendarCopy.disconnect)).not.toBeNull();
  });

  it("renders the connected state with the account and the dedicated-calendar fact", () => {
    const connected = renderPanel(
      createElement(ConnectionPanel, {
        status: connectionFixture({
          state: "connected",
          googleAccountEmail: "szef@example.com",
          connectedAtMs: Date.parse("2026-09-10T08:00:00.000Z"),
        }),
      }),
    );
    expect(connected).toContain("szef@example.com");
    expect(connected).toContain(calendarCopy.dedicatedCalendar);
    expect(connected).toContain("osobnym kalendarzu");
  });

  it("renders the confirmed-deleted state with the explicit recreate, never blind", () => {
    const confirmedDeleted = renderPanel(
      createElement(ConnectionPanel, {
        status: connectionFixture({ state: "error", reconnectReason: "calendar_access_lost" }),
      }),
    );
    expect(confirmedDeleted).toContain(reasonText("calendar_access_lost"));
    expect(control(confirmedDeleted, calendarCopy.recreate)).not.toBeNull();
  });

  it("renders the unknown-creation state gated behind the acknowledgement", () => {
    const unknown = renderPanel(
      createElement(ConnectionPanel, {
        status: connectionFixture({ state: "error", reconnectReason: "creation_unknown" }),
      }),
    );
    expect(unknown).toContain(calendarCopy.creationAcknowledgement);
    expect(unknown).toContain('type="checkbox"');
    // The reconnect stays disabled until the boss acknowledges; no recreate.
    expect(control(unknown, calendarCopy.reconnect)).toContain("disabled");
    expect(control(unknown, calendarCopy.recreate)).toBeNull();
  });

  it("renders the cleanup residue in both the connection panel and the diagnostics", () => {
    const withResidue = renderPanel(
      createElement(ConnectionPanel, {
        status: connectionFixture({ state: "connected", cleanupStatus: "unconfirmed" }),
      }),
    );
    expect(withResidue).toContain(calendarCopy.cleanupUnconfirmed);
    const diagnostics = renderPanel(
      createElement(DiagnosticsSection, {
        overview: overviewFixture({ cleanupRemains: true }),
        lastPassState: "idle",
        suspendedReason: null,
      }),
    );
    expect(diagnostics).toContain(settingsCopy.cleanupResidueNote);
    expect(diagnostics).toContain('role="note"');
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: no success over pending/failed work, no two-way implication,
// no blind recreate.
// ---------------------------------------------------------------------------

/** The pending and partial-failure fixtures the honesty rules reuse. */
const pendingFixture: SyncOverviewView = STATE_FIXTURES[1]?.[1] ?? overviewFixture();
const partialFixture: SyncOverviewView = STATE_FIXTURES[2]?.[1] ?? overviewFixture();

describe("honesty rules (criterion 3)", () => {
  it("shows the ONLY success sentence when everything is confirmed", () => {
    const lines = syncStatusLines(overviewFixture()).map((line) => line.text);
    expect(lines).toContain(settingsCopy.allConfirmed);
  });

  it("never shows success while work is pending", () => {
    const lines = syncStatusLines(pendingFixture).map((line) => line.text);
    expect(lines).not.toContain(settingsCopy.allConfirmed);
  });

  it("never shows success while attempts failed or copies are absent", () => {
    const lines = syncStatusLines(partialFixture).map((line) => line.text);
    expect(lines).not.toContain(settingsCopy.allConfirmed);
    expect(lines).toContain(settingsCopy.failedAttempts(2));
  });

  it("carries the one-way-sync explanation in the rendered diagnostics", () => {
    const html = renderPanel(
      createElement(DiagnosticsSection, {
        overview: overviewFixture(),
        lastPassState: "idle",
        suspendedReason: null,
      }),
    );
    expect(html).toContain("w jedną stronę");
    expect(html).toContain("nie zmieniają ustaleń");
    expect(html).toContain(settingsCopy.allConfirmed);
  });

  it("keeps pending and failed work visible with alert semantics", () => {
    const html = renderPanel(
      createElement(DiagnosticsSection, {
        overview: partialFixture,
        lastPassState: "needs_reconcile",
        suspendedReason: "legs_pending",
      }),
    );
    expect(html).toContain(settingsCopy.failedAttempts(2));
    expect(html).toContain(settingsCopy.absentCopies(2));
    expect(html).toContain(settingsCopy.suspendedLine("legs_pending"));
    expect(html).not.toContain(settingsCopy.allConfirmed);
  });

  it("the recreate control appears only after confirmed deletion (G1 cores)", () => {
    const confirmedDeleted = availableActions({
      state: "error",
      authorizationMode: null,
      authorizationExpiresAtMs: null,
      googleCalendarId: null,
      googleAccountSubject: null,
      reconnectReason: "calendar_access_lost",
    });
    expect(confirmedDeleted).toContain("recreate");
    const unknown = availableActions({
      state: "error",
      authorizationMode: null,
      authorizationExpiresAtMs: null,
      googleCalendarId: null,
      googleAccountSubject: null,
      reconnectReason: "creation_unknown",
    });
    expect(unknown).not.toContain("recreate");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: personal scope and hidden items, without fake editability.
// ---------------------------------------------------------------------------

describe("personal scope honesty (criterion 2)", () => {
  it("states the personal character of the selection and of hides", () => {
    expect(settingsCopy.scopeIntro).toContain("osobisty");
    expect(settingsCopy.scopeIntro).toContain("nie zmienia faktów firmy");
    expect(settingsCopy.copiesIntro).toContain("Ukrycie jest osobiste");
    expect(settingsCopy.copiesIntro).toContain("nie anuluje zadania");
  });

  it("renders the honest scope display without any edit control", () => {
    const html = renderPanel(createElement(ScopeSection));
    expect(html).toContain(settingsCopy.scopeAll);
    expect(html).toContain(settingsCopy.scopeEditUnavailable);
    expect(html).toContain(settingsCopy.personalFieldsNote);
    // No fake editor: the certified write interface for narrowing the
    // selection (calendar.setSelection, flagged in G2's report) does not
    // exist yet, so the surface renders no control that could only fail.
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect("calendar.setSelection" in operations).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The copies list: labels, controls per state, deep links, disabled actions.
// ---------------------------------------------------------------------------

describe("the copies list renders per-state labels and controls", () => {
  const mixedCopies: readonly CopyRowView[] = [
    copyFixture(),
    copyFixture({
      copyId: "copy-unknown",
      remoteOutcome: "unknown",
      summary: "Zadanie: Kontrola dachu",
    }),
    copyFixture({
      copyId: "copy-hidden",
      hidden: true,
      remoteOutcome: "confirmed",
    }),
    copyFixture({
      copyId: "copy-withdrawn",
      desiredState: "withdrawn",
      remoteOutcome: "confirmed",
    }),
    copyFixture({
      copyId: "copy-event",
      subjectKind: "event",
      subjectId: "event-1",
      remoteOutcome: "unknown",
    }),
  ];

  it("offers hide only for projected copies and restore only for hidden ones", () => {
    const html = renderPanel(
      createElement(CopiesSection, { copies: mixedCopies, actionsEnabled: true }),
    );
    const hide = html.split(settingsCopy.hideCopy).length - 1;
    const restore = html.split(settingsCopy.restoreCopy).length - 1;
    // Projected non-hidden rows: the task, the unknown roof check and the
    // event (3). Hidden row: restore (1). Withdrawn row: neither.
    expect(hide).toBe(3);
    expect(restore).toBe(1);
    const confirmedCopy = mixedCopies[0];
    if (confirmedCopy === undefined) {
      throw new Error("fixture missing");
    }
    expect(html).toContain(copyStatusLabel(confirmedCopy));
    expect(html).toContain(settingsCopy.copyState.hidden);
    expect(html).toContain(settingsCopy.copyState.withdrawn);
  });

  it("offers check-now exactly for the unconfirmed copies", () => {
    const html = renderPanel(
      createElement(CopiesSection, { copies: mixedCopies, actionsEnabled: true }),
    );
    const checks = html.split(settingsCopy.checkCopy).length - 1;
    expect(checks).toBe(2); // the unknown copy and the unconfirmed event
  });

  it("links every row back to the current Kiero task/event route", () => {
    const html = renderPanel(
      createElement(CopiesSection, { copies: mixedCopies, actionsEnabled: true }),
    );
    expect(html).toContain(`href="/co-teraz?zadanie=${mixedCopies[0]?.subjectId}"`);
    expect(html).toContain('href="/co-teraz?zdarzenie=event-1"');
    expect(html).toContain(settingsCopy.openSubject.task);
    expect(html).toContain(settingsCopy.openSubject.event);
  });

  it("keeps every control enabled while the connection is healthy", () => {
    const html = renderPanel(
      createElement(CopiesSection, { copies: mixedCopies, actionsEnabled: true }),
    );
    expect(html).not.toContain("disabled");
    expect(html).not.toContain(settingsCopy.actionsUnavailableNote);
  });

  it("disables every copy control and says why when the calendar is stopped", () => {
    const html = renderPanel(
      createElement(CopiesSection, { copies: mixedCopies, actionsEnabled: false }),
    );
    expect(html).toContain(settingsCopy.actionsUnavailableNote);
    const anyEnabled = control(html, settingsCopy.checkCopy);
    expect(anyEnabled).toContain("disabled");
  });

  it("uses a semantic list structure (ul/li, headings, honest states)", () => {
    const html = renderPanel(
      createElement(CopiesSection, { copies: mixedCopies, actionsEnabled: true }),
    );
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("<h2");
    expect(html).toContain('role="status"');
  });

  it("says so honestly when there is nothing to show yet", () => {
    const html = renderPanel(createElement(CopiesSection, { copies: [], actionsEnabled: true }));
    expect(html).toContain(settingsCopy.noCopiesYet);
    expect(html).not.toContain("<ul>");
  });
});

// ---------------------------------------------------------------------------
// The deep-link route contract and the remaining vocabulary pins.
// ---------------------------------------------------------------------------

describe("the deep-link contract and vocabulary pins", () => {
  it("equals the domain's subjectLinkPath for both subject kinds (no drift)", () => {
    // One documented cast: the domain view carries eligibility fields the
    // link builder never reads; the link depends on kind + id only.
    const taskSubject = {
      kind: "task",
      taskId: "task-7",
      projectId: "p",
      title: "T",
      state: "todo",
      coordinatorMembershipId: null,
      deadline: null,
    } as Parameters<typeof subjectLinkPath>[0];
    const eventSubject = {
      kind: "event",
      eventId: "event-9",
      projectId: "p",
      title: "E",
      state: "planned",
      time: null,
    } as Parameters<typeof subjectLinkPath>[0];
    expect(subjectHref("task", "task-7")).toBe(subjectLinkPath(taskSubject));
    expect(subjectHref("event", "event-9")).toBe(subjectLinkPath(eventSubject));
  });

  it("explains every machine reconnect reason in Polish (G1's vocabulary, kept)", () => {
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
  });
});
