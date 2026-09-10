/**
 * Search callable entries (E5).
 *
 * - `searchLifecycleCommand` (public mutation): the app path for the two
 *   index-generation operations. Identity comes from Convex Auth only and
 *   resolves through the B1 live-session chain inside the dispatch.
 * - `searchLifecycleTransaction` (internal mutation): the verified service
 *   path (the bridge pattern; guarded dev proofs use it too).
 * - `queryEvidence` (public action): the app read path; the query-side
 *   embedding runs in the action, never in a transaction.
 * - `queryEvidenceFor` (internal action): the verified service read path.
 */

import { v } from "convex/values";
import { action, internalAction, internalMutation, mutation } from "../_generated/server";
import { dispatchSearchLifecycleCommand, dispatchSearchQueryCommand } from "./dispatch";

/** The client lifecycle path: Convex Auth identity, checked dispatch. */
export const searchLifecycleCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchSearchLifecycleCommand(ctx, args.envelope, undefined),
});

/** The service lifecycle path's transactional entry. */
export const searchLifecycleTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) =>
    dispatchSearchLifecycleCommand(ctx, args.envelope, args.serviceSessionId),
});

/** The client query path: Convex Auth identity, checked action dispatch. */
export const queryEvidence = action({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchSearchQueryCommand(ctx, args.envelope, undefined),
});

/** The service query path's action entry. */
export const queryEvidenceFor = internalAction({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) =>
    dispatchSearchQueryCommand(ctx, args.envelope, args.serviceSessionId),
});
