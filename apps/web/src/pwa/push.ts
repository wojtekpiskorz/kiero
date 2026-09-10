/**
 * The web push module (F3 owns this file; the composition slot in
 * apps/web/src/app/pwa/composition.ts names it).
 *
 * Two halves:
 *
 * - `webPushEntry` is the composition seam's PushEntryModule: registering
 *   it together with the service worker script keeps the "a service
 *   worker is registered only through this composition" rule intact. Its
 *   register() hook deliberately does NOT request permission or
 *   subscribe: permission must come from the user's own action on the
 *   settings screen (a user gesture, which iOS Safari requires), and
 *   surprising boot-time prompts are not the barebones contract.
 * - `enablePushOnThisDevice` / `removePushOnThisDevice` are the screen's
 *   operations: ask the browser, subscribe against the server-provided
 *   PUBLIC application server key, and hand the subscription to the
 *   checked `attention.registerPushSubscription` command (the server
 *   binds it to the current user, session and company - this module never
 *   asserts who the subscription belongs to).
 *
 * DOM globals are touched only inside functions and only behind
 * existence guards, so the node-side test programs can import the entry
 * chain without a DOM lib (the A4 pattern).
 */

import type { PushEntryModule, ServiceWorkerRegistrationHandle } from "../app/pwa/composition";

/** The composition slot this module fills (featureId-shaped id). */
export const webPushEntry: PushEntryModule = {
  moduleId: "attention.push",
  register: async (_registration: ServiceWorkerRegistrationHandle): Promise<void> => {
    // Intentionally passive: subscription lifecycle is user-driven from
    // the Polish settings screen (see the module doc). The worker being
    // active is what the composition needs from this hook.
  },
};

/** What enabling push on this device concluded. */
export type EnablePushOutcome =
  | {
      readonly status: "granted";
      readonly subscription: {
        readonly endpoint: string;
        readonly p256dhKeyBase64: string;
        readonly authKeyBase64: string;
      };
    }
  | { readonly status: "denied" }
  | { readonly status: "unsupported" };

/** The minimal structural browser surface this module needs. */
interface PushSubscriptionLike {
  readonly endpoint: string;
  readonly toJSON: () => {
    readonly endpoint?: string;
    readonly keys?: { readonly p256dh?: string; readonly auth?: string };
  };
  unsubscribe(): Promise<boolean>;
}

interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: {
    readonly userVisibleOnly: boolean;
    readonly applicationServerKey: Uint8Array;
  }): Promise<PushSubscriptionLike>;
}

interface ServiceWorkerReady {
  readonly pushManager: PushManagerLike;
}

interface NotificationLike {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

function browserSurface(): {
  readonly serviceWorker: { readonly ready: Promise<ServiceWorkerReady> } | undefined;
  readonly notification: NotificationLike | undefined;
} | null {
  const holder = globalThis as {
    navigator?: {
      serviceWorker?: { readonly ready: Promise<ServiceWorkerReady> };
    };
  };
  const notification = (globalThis as { Notification?: NotificationLike }).Notification;
  const navigator = holder.navigator;
  if (navigator === undefined) {
    return null;
  }
  return {
    serviceWorker: navigator.serviceWorker,
    notification,
  };
}

/** The current notification permission, when a browser exposes one. */
export function currentPushPermission(): NotificationPermission | "unavailable" {
  const surface = browserSurface();
  if (surface === null || surface.notification === undefined) {
    return "unavailable";
  }
  return surface.notification.permission;
}

/** Decodes unpadded base64url into the byte array subscribe consumes. */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

/** One subscription's protocol fields, narrowed from toJSON(). */
function subscriptionFields(subscription: PushSubscriptionLike): {
  endpoint: string;
  p256dh: string;
  auth: string;
} | null {
  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
    return null;
  }
  return { endpoint, p256dh, auth };
}

/**
 * Asks the browser for permission and subscribes this device against the
 * server's PUBLIC application server key. An existing subscription is
 * reused (browser renewal keeps its endpoint). The result is handed to
 * the checked register command by the caller; nothing here talks to the
 * server.
 */
export async function enablePushOnThisDevice(input: {
  readonly applicationServerKey: string;
}): Promise<EnablePushOutcome> {
  const surface = browserSurface();
  if (surface === null || surface.serviceWorker === undefined || surface.notification === undefined) {
    return { status: "unsupported" };
  }
  const permissionState = await surface.notification.requestPermission();
  if (permissionState !== "granted") {
    return { status: "denied" };
  }
  const ready = await surface.serviceWorker.ready;
  const existing = await ready.pushManager.getSubscription();
  const subscription =
    existing !== null
      ? existing
      : await ready.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(input.applicationServerKey),
        });
  const fields = subscriptionFields(subscription);
  if (fields === null) {
    return { status: "unsupported" };
  }
  return {
    status: "granted",
    subscription: {
      endpoint: fields.endpoint,
      p256dhKeyBase64: fields.p256dh,
      authKeyBase64: fields.auth,
    },
  };
}

/**
 * Removes this browser's subscription locally (the push service stops
 * holding it). The server-side row is disabled by the caller through the
 * checked revoke command, so the settings screen stays the honest source
 * of state on both halves.
 */
export async function removePushSubscriptionLocally(): Promise<void> {
  const surface = browserSurface();
  if (surface === null || surface.serviceWorker === undefined) {
    return;
  }
  const ready = await surface.serviceWorker.ready;
  const existing = await ready.pushManager.getSubscription();
  if (existing !== null) {
    await existing.unsubscribe();
  }
}
