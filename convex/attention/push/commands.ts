/**
 * Web Push command entries (F3): the client mutation path and the
 * service-bridge transactional entry (the F2 commands precedent).
 *
 * - `dispatchPushCommand` (public mutation): the settings screen's path;
 *   Convex Auth identity only.
 * - `dispatchPushTransaction` (internal mutation): the service-bridge
 *   path with a verified service session id (the guarded dev-proof
 *   surface's entry).
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../../_generated/server";
import { dispatchPushCommand } from "./dispatch";

/** The client command path: Convex Auth identity, checked dispatch. */
export const dispatchPush = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchPushCommand(ctx, args.envelope, undefined),
});

/**
 * The service path's transactional entry: the verified service session id
 * substitutes the bearer-verified identity (the A3 bridge pattern).
 */
export const dispatchPushTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => dispatchPushCommand(ctx, args.envelope, args.serviceSessionId),
});
