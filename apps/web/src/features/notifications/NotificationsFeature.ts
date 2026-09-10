/**
 * The barebones web push settings feature (F3): the Polish screen the
 * bounded solution requires - permission/subscription state, enabling or
 * removing THIS device, and recovery guidance that never blocks normal
 * use of Kiero.
 *
 * JSX-free on purpose (createElement only): the host feature registry
 * chain is imported by the node test programs (the A4/B3/G1 pattern).
 * The server half comes from the authenticated `pushState` query (own
 * subscriptions, PUBLIC application server key); the browser half
 * (permission, subscribe/unsubscribe) runs through the owned push module
 * (../../pwa/push.ts) and every durable change goes through the checked
 * dispatch (`attention.registerPushSubscription` /
 * `attention.revokePushSubscription`), which binds the subscription to
 * the resolved user, session and company server-side.
 */

import { createElement, useMemo, useState, type ReactNode } from "react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { api } from "../../../../../convex/_generated/api";
import type { ResultEnvelope } from "@kiero/contracts";
import {
  currentPushPermission,
  enablePushOnThisDevice,
  removePushSubscriptionLocally,
} from "../../pwa/push";
import { notificationsCopy as copy } from "./state";

/** One command envelope (the checked dispatch input shape). */
function envelopeOf(operation: string, input: unknown) {
  return { operation, input, expectedRevisions: [] };
}

/** The feature root: mounted by the host entry at /powiadomienia. */
export function NotificationsFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state !== "configured") {
    return createElement(
      "section",
      null,
      createElement("h1", null, copy.title),
      createElement(
        "p",
        null,
        config.connection.state === "misconfigured"
          ? copy.connectionMisconfigured
          : copy.connectionUnconfigured,
      ),
    );
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(NotificationsGate),
  });
}

function NotificationsGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: NotificationsSurface });
}

function NotificationsSurface(): ReactNode {
  const state = useQueryState({
    query: api.attention.push.queries.pushState,
    args: {},
  });
  if (state.status === "error") {
    return createElement("div", { role: "alert" }, createElement("p", null, copy.sessionEndedNotice));
  }
  if (state.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  return createElement(PushPanel, { state: state.data as PushStateView });
}

/** The pushState query's shape (the server half of the screen). */
interface PushStateView {
  readonly vapidConfigured: boolean;
  readonly applicationServerKey: string | null;
  readonly subscriptions: readonly {
    readonly subscriptionId: string;
    readonly deviceLabel: string;
    readonly createdAtMs: number;
    readonly revokedAtMs: number | null;
    readonly thisDevice: boolean;
  }[];
}

function PushPanel({ state }: { readonly state: PushStateView }): ReactNode {
  const dispatch = useMutation(api.attention.push.commands.dispatchPush);
  const [permission, setPermission] = useState(() => currentPushPermission());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const thisDeviceRow =
    state.subscriptions.find((row) => row.thisDevice && row.revokedAtMs === null) ?? null;
  const serverReady = state.vapidConfigured && state.applicationServerKey !== null;

  async function runEnable(): Promise<void> {
    if (!serverReady) {
      setNotice({ kind: "error", text: copy.serverNotConfigured });
      return;
    }
    setBusy(true);
    const outcome = await enablePushOnThisDevice({
      applicationServerKey: state.applicationServerKey ?? "",
    });
    setPermission(currentPushPermission());
    if (outcome.status === "denied") {
      setBusy(false);
      setNotice({ kind: "error", text: copy.deniedNotice });
      return;
    }
    if (outcome.status === "unsupported") {
      setBusy(false);
      setNotice({ kind: "error", text: copy.unsupportedNotice });
      return;
    }
    try {
      const result: ResultEnvelope = await dispatch({
        envelope: envelopeOf("attention.registerPushSubscription", {
          endpoint: outcome.subscription.endpoint,
          p256dhKeyBase64: outcome.subscription.p256dhKeyBase64,
          authKeyBase64: outcome.subscription.authKeyBase64,
          deviceLabel: "To urządzenie",
        }),
      });
      setBusy(false);
      setNotice(
        result._tag === "ok"
          ? { kind: "ok", text: copy.registeredNotice }
          : { kind: "error", text: result.error.message },
      );
    } catch {
      setBusy(false);
      setNotice({ kind: "error", text: copy.unexpectedFailure });
    }
  }

  async function runRemove(subscriptionId: string): Promise<void> {
    setBusy(true);
    await removePushSubscriptionLocally();
    try {
      const result: ResultEnvelope = await dispatch({
        envelope: envelopeOf("attention.revokePushSubscription", { pushSubscriptionId: subscriptionId }),
      });
      setBusy(false);
      setNotice(
        result._tag === "ok"
          ? { kind: "ok", text: copy.removedNotice }
          : { kind: "error", text: result.error.message },
      );
    } catch {
      setBusy(false);
      setNotice({ kind: "error", text: copy.unexpectedFailure });
    }
  }

  const children: ReactNode[] = [
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement("p", null, `${copy.permissionLabel}: ${permissionText(permission)}`),
  ];

  if (permission === "denied") {
    children.push(createElement("p", { role: "note" }, copy.permissionDeniedRecovery));
  }
  if (!serverReady) {
    children.push(createElement("p", { role: "note" }, copy.serverNotConfigured));
  }

  children.push(createElement("h2", null, copy.devicesHeading));
  if (state.subscriptions.length === 0) {
    children.push(createElement("p", null, copy.noDevices));
  } else {
    const items: ReactNode[] = state.subscriptions.map((row) =>
      createElement(
        "li",
        { key: row.subscriptionId },
        createElement("span", null, row.revokedAtMs === null ? copy.deviceEnabled(row.deviceLabel) : copy.deviceDisabled(row.deviceLabel)),
        row.thisDevice ? createElement("span", null, ` (${copy.thisDevice})`) : null,
        row.revokedAtMs === null && row.thisDevice
          ? createElement(
              "button",
              {
                type: "button",
                disabled: busy,
                onClick: () => {
                  if (globalThis.confirm === undefined || globalThis.confirm(copy.removeConfirm)) {
                    void runRemove(row.subscriptionId);
                  }
                },
              },
              copy.removeButton,
            )
          : null,
      ),
    );
    children.push(createElement("ul", null, ...items));
  }

  const controls: ReactNode[] = [];
  if (thisDeviceRow === null) {
    controls.push(
      createElement(
        "button",
        { type: "button", disabled: busy || !serverReady, onClick: () => void runEnable() },
        busy ? copy.enabling : copy.enableButton,
      ),
    );
  }
  if (controls.length > 0) {
    children.push(createElement("div", { role: "group" }, ...controls));
  }
  children.push(createElement("p", { role: "note" }, copy.privacyNote));
  if (notice !== null) {
    children.push(
      createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
    );
  }
  return createElement("section", null, ...children);
}

function permissionText(permission: string): string {
  switch (permission) {
    case "granted":
      return copy.permissionGranted;
    case "denied":
      return copy.permissionDenied;
    case "unavailable":
      return copy.permissionUnavailable;
    default:
      return copy.permissionDefault;
  }
}
