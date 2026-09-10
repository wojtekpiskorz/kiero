/**
 * Notification-preference command entries (F1).
 *
 * Two callable entries, one checked dispatch (the lane pattern):
 *
 * - `changeNotificationPreferencesCommand` (public mutation): the client
 *   path; Convex Auth identity only, honestly `unauthenticated` until B1.
 * - `changeNotificationPreferencesTransaction` (internal mutation): the
 *   service-bridge path with a verified service session id.
 *
 * Both run the whole dispatch inside ONE mutation transaction.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../../_generated/server";
import { dispatchPreferencesCommand } from "./dispatch";

/** The client command path: Convex Auth identity, checked dispatch. */
export const changeNotificationPreferencesCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchPreferencesCommand(ctx, args.envelope, undefined),
});

/**
 * The service path's transactional entry: the verified service session id
 * substitutes the bearer-verified identity (the A3 bridge pattern).
 */
export const changeNotificationPreferencesTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) =>
    dispatchPreferencesCommand(ctx, args.envelope, args.serviceSessionId),
});
