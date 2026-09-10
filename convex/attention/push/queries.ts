/**
 * Web Push queries (F3): the Polish settings screen's server read.
 *
 * `pushState` is the authenticated personal read: the deployment's
 * application server key (the PUBLIC half of the VAPID pair; the private
 * half never leaves the environment), whether the deployment can send at
 * all, and the actor's OWN subscriptions with their device labels and
 * enabled/disabled state. The browser's notification PERMISSION is a
 * client-side fact the screen reads locally and shows next to this
 * server state; the two together are the honest permission/subscription
 * picture the bounded solution requires.
 *
 * Identity follows the canonical resolution (Convex Auth -> live session
 * -> user -> active membership); the resolved session id also marks
 * which subscription row belongs to THIS device.
 */

import { ConvexError } from "convex/values";
import { v } from "convex/values";
import { internalQuery, query } from "../../_generated/server";
import { identityFromConvexAuth, resolveRequestContext } from "../../platform/context";
import { unauthenticatedError } from "@kiero/runtime";
import { subscriptionViewsOf } from "./operations";
import { vapidConfig } from "./functions";

/** The one shape both push-state reads return (the screen's server half). */
async function pushStateForContext(
  db: Parameters<typeof subscriptionViewsOf>[0],
  actor: { readonly userId: string; readonly sessionId: string },
) {
  const keys = vapidConfig();
  const userId = db.normalizeId("users", actor.userId);
  if (userId === null) {
    return null;
  }
  const subscriptions = await subscriptionViewsOf(db, userId);
  return {
    /** Whether this deployment holds a usable VAPID keypair. */
    vapidConfigured: keys !== null,
    /** The PUBLIC application server key the browser subscribes with. */
    applicationServerKey: keys?.publicKeyBase64Url ?? null,
    subscriptions: subscriptions.map((view) => ({
      subscriptionId: view.subscriptionId,
      deviceLabel: view.deviceLabel,
      createdAtMs: view.createdAtMs,
      revokedAtMs: view.revokedAtMs,
      thisDevice: view.boundSessionId === actor.sessionId,
    })),
  };
}

/** The settings screen's server state (the public client path). */
export const pushState = query({
  args: {},
  handler: async (ctx) => {
    const identity = await identityFromConvexAuth(ctx.auth, Date.now());
    const context = await resolveRequestContext(ctx.db, identity);
    if (context === null) {
      throw new ConvexError(unauthenticatedError("no_live_session_push"));
    }
    const state = await pushStateForContext(ctx.db, context.actor);
    if (state === null) {
      throw new ConvexError(unauthenticatedError("no_live_session_push"));
    }
    return state;
  },
});

/** The bridge-path variant of the same read (guarded dev proofs). */
export const pushStateForSession = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args) => {
    const context = await resolveRequestContext(ctx.db, {
      issuer: "service-bridge",
      subject: args.serviceSessionId,
      verifiedAtMs: Date.now(),
    });
    if (context === null) {
      return null;
    }
    return pushStateForContext(ctx.db, context.actor);
  },
});
