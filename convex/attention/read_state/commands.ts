/**
 * Read-state command entries.
 *
 * Two callable entries, one checked dispatch:
 *
 * - `markSourceReadCommand` (public mutation): the client path. Identity
 *   comes from Convex Auth only; without a verified identity the command
 *   fails `unauthenticated` (sign-in issues real
 *   identities).
 * - `markSourceReadTransaction` (internal mutation): the service-bridge
 *   path the platform proved — the caller supplies a service session id whose
 *   credential was verified BEFORE this point (the HTTP bridge boundary,
 *   or the guarded dev-proof actions).
 *
 * Both run the whole dispatch inside ONE mutation transaction, so the
 * read-state row and the canonical event commit together — or nothing does.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../../_generated/server";
import { dispatchReadStateCommand } from "./dispatch";

/** The client command path: Convex Auth identity, checked dispatch. */
export const markSourceReadCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchReadStateCommand(ctx, args.envelope, undefined),
});

/**
 * The service path's transactional entry: the verified service session id
 * substitutes the bearer-verified identity (the bridge pattern).
 */
export const markSourceReadTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) =>
    dispatchReadStateCommand(ctx, args.envelope, args.serviceSessionId),
});
