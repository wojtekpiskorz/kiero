/**
 * Source acceptance command entries (D1).
 *
 * Two callable entries, one checked dispatch:
 *
 * - `acceptSourceCommand` (public mutation): the client path. Identity comes
 *   from Convex Auth only; without a verified identity the command fails
 *   `unauthenticated` (there is no development-auth shortcut — B1 ships the
 *   sign-in product that issues real identities).
 * - `acceptSourceTransaction` (internal mutation): the service-bridge path
 *   A3 proved (see platform/dispatch.ts `echoTransaction`): the caller
 *   supplies a service session id whose credential was verified BEFORE this
 *   point (the HTTP bridge boundary, or the guarded dev-proof actions). The
 *   session resolves through the SAME canonical resolution and policy.
 *
 * Both run the whole dispatch inside ONE mutation transaction, so the
 * immutable source, its project links, the processing registration rows, the
 * canonical event and the durable job commit atomically — or nothing does.
 */

import { v } from "convex/values";
import { internalMutation, mutation } from "../../_generated/server";
import { dispatchSourcesCommand } from "./dispatch";

/** The client command path: Convex Auth identity, checked dispatch. */
export const acceptSourceCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchSourcesCommand(ctx, args.envelope, undefined),
});

/**
 * The service path's transactional entry: the verified service session id
 * substitutes the bearer-verified identity (the A3 bridge pattern).
 */
export const acceptSourceTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) =>
    dispatchSourcesCommand(ctx, args.envelope, args.serviceSessionId),
});
