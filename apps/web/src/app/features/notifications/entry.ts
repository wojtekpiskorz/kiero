/**
 * Notifications feature entry (F3): the Polish barebones settings screen
 * for web push (issue #43's "The Polish barebones settings screen shows
 * permission/subscription state, allows enabling or removing this
 * device, and explains recovery without blocking normal use").
 *
 * The screen renders the server's typed push state and drives every
 * durable change through the checked dispatch; the browser half (push
 * permission, subscribe) runs through the owned push module. Mounting
 * this entry is F3's sanctioned host-composition edit: one import + one
 * line in ../app-features.ts.
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { NotificationsFeature } from "../../../features/notifications/NotificationsFeature";

/** The registered host entry for the notifications settings surface. */
export const notificationsFeatureEntry = appFeatureEntry({
  featureId: "attention.push",
  routePath: "/powiadomienia",
  navLabel: "Powiadomienia",
  screenHeading: "Powiadomienia",
  consumedOperations: ["attention.registerPushSubscription", "attention.revokePushSubscription"],
  implementation: "mounted",
  screen: () => createElement(NotificationsFeature),
});
