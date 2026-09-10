/**
 * The barebones Calendar connection feature (G1): the Polish entry point
 * for the optional personal Google calendar ("Kalendarz Kiero w Google").
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
 * The authorization start runs server-side (the `startAuthorization`
 * mutation over the same checked decision core as the gateway's route);
 * the browser then follows the returned Google URL. No styling, semantic
 * controls only (the UX/UI track owns presentation).
 */

import { createElement, useMemo, useState, type ReactNode } from "react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { signInCopy } from "../sign-in/state";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { api } from "../../../../../convex/_generated/api";
import type { CalendarConnectionStatus } from "../../../../../convex/calendar/connection/functions";
import type { ResultEnvelope } from "@kiero/contracts";
import { calendarCopy, reasonText } from "./state";

/** One command envelope (the checked dispatch input shape). */
function envelopeOf(operation: string, input: unknown) {
  return { operation, input, expectedRevisions: [] };
}

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
    // inactivity): the honest fallback is the session-ended state.
    return createElement("div", { role: "alert" }, createElement("p", null, signInCopy.sessionEndedNotice));
  }
  if (status.status !== "success") {
    return createElement("p", { role: "status" }, calendarCopy.checkingSession);
  }
  return createElement(ConnectionPanel, { status: status.data });
}

function ConnectionPanel({ status }: { readonly status: CalendarConnectionStatus }): ReactNode {
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

  const children: ReactNode[] = [
    createElement("h1", null, calendarCopy.title),
    createElement("p", null, calendarCopy.intro),
  ];

  if (!status.providerConfigured) {
    children.push(createElement("p", { role: "note" }, calendarCopy.providerNotConfigured));
  }

  // The honest state description.
  switch (status.state) {
    case "unavailable_no_company":
      children.push(createElement("p", null, calendarCopy.noCompanyScope));
      break;
    case "pending_authorization":
      children.push(createElement("p", { role: "status" }, calendarCopy.statePending));
      break;
    case "connected":
      children.push(
        createElement("p", { role: "status" }, calendarCopy.stateConnected(status.googleAccountEmail)),
      );
      if (status.connectedAtMs !== null) {
        children.push(createElement("p", null, calendarCopy.connectedAt(status.connectedAtMs)));
      }
      if (status.cleanupStatus === "unconfirmed") {
        children.push(createElement("p", { role: "note" }, calendarCopy.cleanupUnconfirmed));
      }
      break;
    case "disconnected":
      children.push(createElement("p", null, calendarCopy.stateDisconnected));
      break;
    case "error":
      children.push(createElement("p", { role: "alert" }, reasonText(status.reconnectReason)));
      break;
  }

  // The explicit acknowledgement gate after an unknown creation outcome.
  if (unresolvedCreation) {
    children.push(
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
    children.push(createElement("div", { role: "group" }, ...controls));
  }

  if (notice !== null) {
    children.push(createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text));
  }

  return createElement("section", null, ...children);
}
