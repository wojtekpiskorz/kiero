/**
 * G1 focused verification: the connection lifecycle cores.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/g1/live-proof.mjs) exercises them end to end. What MUST hold
 * structurally is pinned here: the checked start decision per state, the
 * single-use callback correlation, disconnect-during-pending (and the
 * switch-cancel restore), the uncertainty semantics for exchange/refresh,
 * and above all the no-blind-duplicate-calendar rules for unknown
 * create/read outcomes and ambiguous 404s.
 */

import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_TTL_MS,
  availableActions,
  decideCalendarCreateOutcome,
  decideCalendarReadOutcome,
  decideCalendarStep,
  decideCallbackCorrelation,
  decideCompletionFailure,
  decideDisconnect,
  decideExchangeOutcome,
  decideRefreshOutcome,
  decideStartAuthorization,
  type ConnectionRowView,
} from "../../convex/calendar/connection/cores";

const now = 1_000_000;

function row(overrides: Partial<ConnectionRowView>): ConnectionRowView {
  return {
    state: "pending_authorization",
    authorizationMode: "connect",
    authorizationExpiresAtMs: now + AUTHORIZATION_TTL_MS,
    googleCalendarId: null,
    googleAccountSubject: null,
    reconnectReason: null,
    ...overrides,
  };
}

describe("decideStartAuthorization (the checked start)", () => {
  it("admits a fresh connect with no row and refuses other modes then", () => {
    expect(decideStartAuthorization(null, { mode: "connect", acknowledgeUnknownCreation: false }, now)).toEqual({
      kind: "start",
    });
    expect(decideStartAuthorization(null, { mode: "switch", acknowledgeUnknownCreation: false }, now)).toEqual({
      kind: "refuse",
      code: "switch_required",
    });
  });

  it("refuses a second flow while one is live, admits after expiry", () => {
    const pending = row({});
    expect(
      decideStartAuthorization(pending, { mode: "connect", acknowledgeUnknownCreation: false }, now),
    ).toEqual({ kind: "refuse", code: "authorization_already_pending" });
    const expired = row({ authorizationExpiresAtMs: now - 1 });
    expect(
      decideStartAuthorization(expired, { mode: "connect", acknowledgeUnknownCreation: false }, now),
    ).toEqual({ kind: "start" });
  });

  it("admits switch on connected and refuses plain connect", () => {
    const connected = row({ state: "connected", authorizationMode: null });
    expect(
      decideStartAuthorization(connected, { mode: "switch", acknowledgeUnknownCreation: false }, now),
    ).toEqual({ kind: "start" });
    expect(
      decideStartAuthorization(connected, { mode: "connect", acknowledgeUnknownCreation: false }, now),
    ).toEqual({ kind: "refuse", code: "already_connected" });
  });

  it("recovers terminal errors with a plain reconnect", () => {
    for (const reason of ["refresh_failed", "exchange_failed", "scopes_missing", "authorization_denied"] as const) {
      expect(
        decideStartAuthorization(
          row({ state: "error", reconnectReason: reason }),
          { mode: "connect", acknowledgeUnknownCreation: false },
          now,
        ),
      ).toEqual({ kind: "start" });
    }
  });

  it("requires the explicit acknowledgement after an unknown creation", () => {
    const unknown = row({ state: "error", reconnectReason: "creation_unknown" });
    expect(
      decideStartAuthorization(unknown, { mode: "connect", acknowledgeUnknownCreation: false }, now),
    ).toEqual({ kind: "refuse", code: "creation_unresolved" });
    expect(
      decideStartAuthorization(unknown, { mode: "connect", acknowledgeUnknownCreation: true }, now),
    ).toEqual({ kind: "start" });
  });

  it("admits recreate after an ambiguous calendar loss (Odtwórz)", () => {
    const lost = row({ state: "error", reconnectReason: "calendar_access_lost" });
    expect(
      decideStartAuthorization(lost, { mode: "recreate", acknowledgeUnknownCreation: false }, now),
    ).toEqual({ kind: "start" });
  });
});

describe("decideCallbackCorrelation (single-use state)", () => {
  it("rejects unknown, consumed and non-pending states without detail", () => {
    expect(decideCallbackCorrelation(null, now)).toEqual({ kind: "invalid_state" });
    expect(
      decideCallbackCorrelation({ state: "pending_authorization", oauthStateHash: null, authorizationExpiresAtMs: now }, now),
    ).toEqual({ kind: "invalid_state" });
    expect(
      decideCallbackCorrelation({ state: "connected", oauthStateHash: "abc", authorizationExpiresAtMs: now }, now),
    ).toEqual({ kind: "invalid_state" });
    expect(
      decideCallbackCorrelation({ state: "disconnected", oauthStateHash: "abc", authorizationExpiresAtMs: now }, now),
    ).toEqual({ kind: "invalid_state" });
  });

  it("rejects an expired flow and matches a live one", () => {
    expect(
      decideCallbackCorrelation({ state: "pending_authorization", oauthStateHash: "abc", authorizationExpiresAtMs: now - 1 }, now),
    ).toEqual({ kind: "expired" });
    expect(
      decideCallbackCorrelation({ state: "pending_authorization", oauthStateHash: "abc", authorizationExpiresAtMs: now }, now),
    ).toEqual({ kind: "matched" });
  });
});

describe("decideCalendarStep (find-or-create)", () => {
  it("recovers the known calendar only for the SAME Google account", () => {
    expect(
      decideCalendarStep({
        googleCalendarId: "cal-1",
        googleAccountSubject: "sub-1",
        verifiedGoogleSubject: "sub-1",
      }),
    ).toEqual({ kind: "verify_known", calendarId: "cal-1" });
    expect(
      decideCalendarStep({
        googleCalendarId: "cal-1",
        googleAccountSubject: "sub-1",
        verifiedGoogleSubject: "sub-2",
      }),
    ).toEqual({ kind: "create" });
    expect(
      decideCalendarStep({ googleCalendarId: null, googleAccountSubject: null, verifiedGoogleSubject: "sub-1" }),
    ).toEqual({ kind: "create" });
  });
});

describe("uncertainty semantics (exchange, calendar, refresh)", () => {
  const grant = {
    accessToken: "a",
    refreshToken: "r",
    expiresInSeconds: 3600,
    grantedScope: "openid email https://www.googleapis.com/auth/calendar.app.created",
    idToken: null,
  };

  it("rejects a grant with missing scopes before any calendar work", () => {
    const decision = decideExchangeOutcome({ kind: "granted", grant, scopesSatisfied: false });
    expect(decision).toEqual({ proceed: false, outcome: { kind: "error", reason: "scopes_missing" } });
  });

  it("maps definite refusals to exchange_failed and uncertain legs to exchange_unknown", () => {
    expect(decideExchangeOutcome({ kind: "failed", failure: "definite_invalid_request" })).toEqual({
      proceed: false,
      outcome: { kind: "error", reason: "exchange_failed" },
    });
    expect(decideExchangeOutcome({ kind: "failed", failure: "unknown_timeout" })).toEqual({
      proceed: false,
      outcome: { kind: "error", reason: "exchange_unknown" },
    });
    expect(decideExchangeOutcome({ kind: "failed", failure: "unknown_status" })).toEqual({
      proceed: false,
      outcome: { kind: "error", reason: "exchange_unknown" },
    });
  });

  it("never treats an ambiguous 404 as confirmed deletion: only explicit recreate creates", () => {
    expect(decideCalendarReadOutcome({ kind: "ambiguous_gone" }, "connect")).toEqual({
      kind: "error",
      reason: "calendar_access_lost",
    });
    expect(decideCalendarReadOutcome({ kind: "ambiguous_gone" }, "recreate")).toEqual({ kind: "create" });
    expect(decideCalendarReadOutcome({ kind: "reachable" }, "connect")).toEqual({ kind: "reuse" });
    expect(decideCalendarReadOutcome({ kind: "unknown", failure: "unknown_timeout" }, "recreate")).toEqual({
      kind: "error",
      reason: "calendar_read_unknown",
    });
  });

  it("records creation_unknown for an unresolved creation, never a retry", () => {
    expect(decideCalendarCreateOutcome({ kind: "unknown", failure: "unknown_timeout" })).toEqual({
      kind: "error",
      reason: "creation_unknown",
    });
    expect(decideCalendarCreateOutcome({ kind: "created", calendarId: "cal-9" })).toEqual({
      kind: "created",
      calendarId: "cal-9",
    });
    expect(decideCalendarCreateOutcome({ kind: "definitely_failed", failure: "definite_invalid_request" })).toEqual({
      kind: "error",
      reason: "creation_failed",
    });
  });

  it("keeps refresh uncertainty separate from definite loss", () => {
    expect(decideRefreshOutcome({ kind: "granted", scopesSatisfied: true })).toEqual({ kind: "refreshed" });
    expect(decideRefreshOutcome({ kind: "failed", failure: "definite_invalid_request" })).toEqual({
      kind: "definitely_lost",
    });
    expect(decideRefreshOutcome({ kind: "failed", failure: "unknown_timeout" })).toEqual({ kind: "unknown" });
    expect(decideRefreshOutcome({ kind: "failed", failure: "definite_network" })).toEqual({ kind: "unknown" });
  });
});

describe("disconnect and the pending race", () => {
  it("cancels a plain pending flow", () => {
    expect(decideDisconnect(row({}))).toEqual({ kind: "disconnect", recordCleanup: false });
  });

  it("restores the previous binding when a pending SWITCH is cancelled", () => {
    const switchPending = row({
      authorizationMode: "switch",
      googleCalendarId: "cal-1",
      googleAccountSubject: "sub-1",
    });
    expect(decideDisconnect(switchPending)).toEqual({ kind: "cancel_switch" });
  });

  it("stops a connected flow with unconfirmed cleanup", () => {
    expect(decideDisconnect(row({ state: "connected", authorizationMode: null }))).toEqual({
      kind: "disconnect",
      recordCleanup: true,
    });
  });

  it("is idempotent on disconnected rows and no-ops without a row", () => {
    expect(decideDisconnect(row({ state: "disconnected", authorizationMode: null }))).toEqual({ kind: "noop" });
    expect(decideDisconnect(null)).toEqual({ kind: "noop" });
  });

  it("a failed completion restores a pending switch instead of erroring it", () => {
    const switchPending = row({
      authorizationMode: "switch",
      googleCalendarId: "cal-1",
    });
    expect(decideCompletionFailure(switchPending, "exchange_failed")).toEqual({ kind: "restore_connected" });
    expect(decideCompletionFailure(row({}), "exchange_failed")).toEqual({
      kind: "error",
      reason: "exchange_failed",
    });
  });
});

describe("availableActions (the Polish screen's honest controls)", () => {
  it("offers connect when absent, disconnect/switch when connected", () => {
    expect(availableActions(null)).toEqual(["connect"]);
    expect(availableActions(row({ state: "connected", authorizationMode: null }))).toEqual([
      "disconnect",
      "switch",
    ]);
  });

  it("offers only disconnect while a flow is pending", () => {
    expect(availableActions(row({}))).toEqual(["disconnect"]);
  });

  it("offers recreate exactly for the ambiguous calendar loss", () => {
    expect(availableActions(row({ state: "error", reconnectReason: "calendar_access_lost" }))).toEqual([
      "reconnect",
      "recreate",
      "disconnect",
    ]);
    expect(availableActions(row({ state: "error", reconnectReason: "creation_unknown" }))).toEqual([
      "reconnect",
      "disconnect",
    ]);
    expect(availableActions(row({ state: "error", reconnectReason: "refresh_failed" }))).toEqual([
      "reconnect",
      "disconnect",
    ]);
  });
});
