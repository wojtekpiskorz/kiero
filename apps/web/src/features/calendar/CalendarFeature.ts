/**
 * The barebones Calendar feature: G1's connection lifecycle plus G4's
 * settings and sync diagnostics, the Polish entry point for the optional
 * personal Google calendar ("Kalendarz Kiero w Google").
 *
 * JSX-free on purpose (createElement only): the host feature registry
 * chain is imported by the node test programs, which compile without a
 * JSX flag (the A4/B3 pattern). The screen renders the server's honest
 * typed status (convex/calendar/connection/functions.ts `calendarStatus`)
 * and exposes exactly the lifecycle operations that status offers:
 * connect, reconnect, switch account, explicit recreate (Odtwórz) after a
 * confirmed deletion, and disconnect. Nothing here touches Kiero identity:
 * disconnect is a stop of the connection, never of the sign-in.
 *
 * G4 appends ./CalendarSettings.ts under the connection panel: the sync
 * diagnostics and personal copy management over G2/G3's reads and the
 * certified `calendar.setCopyHidden` / `calendar.reconcileCopy` commands.
 * The shared dispatch envelope and the session-ended fallback come from
 * H1's company gate module (the lane-by-lane migration it invites).
 *
 * The authorization start runs server-side (the `startAuthorization`
 * mutation over the same checked decision core as the gateway's route);
 * the browser then follows the returned Google URL. No styling, semantic
 * controls only (the UX/UI track owns presentation).
 */

import { createElement, useMemo, useState, type ReactNode } from "react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import { SessionEnded, envelopeOf } from "../company/CompanyGate";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { api } from "../../../../../convex/_generated/api";
import type { CalendarConnectionStatus } from "../../../../../convex/calendar/connection/functions";
import type { ResultEnvelope } from "@kiero/contracts";
import { calendarCopy, reasonText } from "./state";
import { CalendarSettings } from "./CalendarSettings";

/** One start mode, derived from the action the server offers. */
type StartMode = "connect" | "switch" | "recreate";

/** The feature root: mounted by the host entry at /kalendarz. */
export function CalendarFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state === "unconfigured") {
    return createElement(
      "section",
      null,
      createElement("h1", null, calendarCopy.title),
      createElement("p", null, calendarCopy.connectionUnconfigured),
    );
  }
  if (config.connection.state === "misconfigured") {
    return createElement(
      "section",
      null,
      createElement("h1", null, calendarCopy.title),
      createElement("p", null, calendarCopy.connectionMisconfigured),
    );
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(CalendarGate),
  });
}

function CalendarGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: CalendarSurface });
}

// ---------------------------------------------------------------------------
// The connection surface (query-driven).
// ---------------------------------------------------------------------------

function CalendarSurface(): ReactNode {
  const status = useQueryState({
    query: api.calendar.connection.functions.calendarStatus,
    args: {},
  });
  if (status.status === "error") {
    // The session stopped resolving (revocation, upstream sign-out,
    // inactivity): the shared session-ended fallback with the way back
    // to sign-in (H1's company gate module).
    return createElement(SessionEnded);
  }
  if (status.status !== "success") {
    return createElement("p", { role: "status" }, calendarCopy.checkingSession);
  }
  return createElement(
    ConnectionPanel,
    { status: status.data },
    // The G4 settings ride along whenever the actor's connection row
    // exists (its own reads decide what to render inside); copy commands
    // are served only while G1 reports a healthy connected row.
    createElement(CalendarSettings, { actionsEnabled: status.data.state === "connected" }),
  );
}

export function ConnectionPanel({
  status,
  children,
}: {
  readonly status: CalendarConnectionStatus;
  /** The settings continuation (G4), rendered under the lifecycle panel. */
  readonly children?: ReactNode;
}): ReactNode {
  const start = useMutation(api.calendar.connection.functions.startAuthorization);
  const dispatch = useMutation(api.calendar.connection.functions.dispatchCalendar);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const unresolvedCreation =
    status.state === "error" && status.reconnectReason === "creation_unknown";

  async function runStart(mode: StartMode): Promise<void> {
    setBusy(true);
    setNotice({ kind: "ok", text: calendarCopy.redirecting });
    try {
      const result: ResultEnvelope = await start({
        mode,
        ...(unresolvedCreation ? { acknowledgeUnknownCreation: acknowledged } : {}),
      });
      if (result._tag === "error") {
        setBusy(false);
        setNotice({ kind: "error", text: result.error.message });
        return;
      }
      const value = result.value as { authorizationUrl?: unknown };
      if (typeof value.authorizationUrl === "string" && typeof window !== "undefined") {
        window.location.href = value.authorizationUrl;
      }
    } catch {
      setBusy(false);
      setNotice({ kind: "error", text: calendarCopy.unexpectedFailure });
    }
  }

  async function runDisconnect(): Promise<void> {
    if (status.connectionId === null) {
      return;
    }
    if (typeof window !== "undefined" && !window.confirm(calendarCopy.disconnectConfirm)) {
      return;
    }
    setBusy(true);
    try {
      const result: ResultEnvelope = await dispatch({
        envelope: envelopeOf("calendar.disconnectCalendar", { connectionId: status.connectionId }),
      });
      setBusy(false);
      setNotice(
        result._tag === "ok"
          ? { kind: "ok", text: calendarCopy.disconnectedNotice }
          : { kind: "error", text: result.error.message },
      );
    } catch {
      setBusy(false);
      setNotice({ kind: "error", text: calendarCopy.unexpectedFailure });
    }
  }

  const body: ReactNode[] = [
    createElement("h1", null, calendarCopy.title),
    createElement("p", null, calendarCopy.intro),
  ];

  if (!status.providerConfigured) {
    body.push(createElement("p", { role: "note" }, calendarCopy.providerNotConfigured));
  }

  // The honest state description.
  switch (status.state) {
    case "unavailable_no_company":
      body.push(createElement("p", null, calendarCopy.noCompanyScope));
      break;
    case "pending_authorization":
      body.push(createElement("p", { role: "status" }, calendarCopy.statePending));
      break;
    case "connected":
      body.push(
        createElement("p", { role: "status" }, calendarCopy.stateConnected(status.googleAccountEmail)),
      );
      // The dedicated calendar fact (G4): Kiero never writes into the
      // boss's main Google calendar.
      body.push(createElement("p", null, calendarCopy.dedicatedCalendar));
      if (status.connectedAtMs !== null) {
        body.push(createElement("p", null, calendarCopy.connectedAt(status.connectedAtMs)));
      }
      if (status.cleanupStatus === "unconfirmed") {
        body.push(createElement("p", { role: "note" }, calendarCopy.cleanupUnconfirmed));
      }
      break;
    case "disconnected":
      body.push(createElement("p", null, calendarCopy.stateDisconnected));
      break;
    case "error":
      body.push(createElement("p", { role: "alert" }, reasonText(status.reconnectReason)));
      break;
  }

  // The explicit acknowledgement gate after an unknown creation outcome.
  if (unresolvedCreation) {
    body.push(
      createElement("label", null,
        createElement("input", {
          type: "checkbox",
          checked: acknowledged,
          onChange: (event: { target: { checked: boolean } }) => setAcknowledged(event.target.checked),
        }),
        ` ${calendarCopy.creationAcknowledgement}`,
      ),
    );
  }

  // Controls: exactly what the server's availableActions offers.
  const actions = status.availableActions;
  const controls: ReactNode[] = [];
  if (actions.includes("connect")) {
    controls.push(createElement("button", { type: "button", disabled: busy, onClick: () => void runStart("connect") }, calendarCopy.connect));
  }
  if (actions.includes("reconnect")) {
    controls.push(createElement("button", { type: "button", disabled: busy || (unresolvedCreation && !acknowledged), onClick: () => void runStart("connect") }, calendarCopy.reconnect));
  }
  if (actions.includes("switch")) {
    controls.push(createElement("button", { type: "button", disabled: busy, onClick: () => void runStart("switch") }, calendarCopy.switchAccount));
  }
  if (actions.includes("recreate")) {
    controls.push(createElement("button", { type: "button", disabled: busy, onClick: () => void runStart("recreate") }, calendarCopy.recreate));
  }
  if (actions.includes("disconnect")) {
    controls.push(createElement("button", { type: "button", disabled: busy, onClick: () => void runDisconnect() }, calendarCopy.disconnect));
  }
  if (controls.length > 0) {
    body.push(createElement("div", { role: "group" }, ...controls));
  }

  if (notice !== null) {
    body.push(createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text));
  }

  if (children !== undefined) {
    body.push(children);
  }

  return createElement("section", null, ...body);
}
