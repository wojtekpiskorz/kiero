/**
 * Source project reassignment command entries (E7, issue #115).
 *
 * The same two-entry shape the accept lane proved (see
 * ../accept/commands.ts), both over the ONE checked sources dispatch:
 *
 * - `reassignSourceCommand` (public mutation): the client path. Identity
 *   comes from the live Convex Auth session chain the J1 repair wired into
 *   the dispatch (B1's sign-in product issues the identities).
 * - `reassignSourceTransaction` (internal mutation): the service-bridge
 *   path whose credential was verified BEFORE this point (the HTTP bridge
 *   boundary, or the guarded dev-proof actions).
 *
 * Both run the whole dispatch inside ONE mutation transaction, so the link
 * set change, the canonical `sources.sourceReassigned` event and the
 * durable scope re-assessment registration commit atomically.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../../_generated/server";
import { dispatchSourcesCommand } from "../accept/dispatch";

/** The client command path: Convex Auth identity, checked dispatch. */
export const reassignSourceCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchSourcesCommand(ctx, args.envelope, undefined),
});

/**
 * The service path's transactional entry: the verified service session id
 * substitutes the bearer-verified identity (the A3 bridge pattern).
 */
export const reassignSourceTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) =>
    dispatchSourcesCommand(ctx, args.envelope, args.serviceSessionId),
});
