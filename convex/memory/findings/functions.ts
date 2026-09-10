/**
 * The C2 Convex function surface (generated-call APIs).
 *
 * One core set, three callable entries (no drift by construction):
 *
 * - `dispatchMemoryCommand` (public mutation): the typed command dispatch
 *   for the findings operations — Convex Auth identity only.
 * - `dispatchMemoryTransaction` (internal mutation): the service-bridge
 *   path (verified service session id; the A3/D1 pattern) used by the
 *   guarded proof actions and, later, by C5's durable executor.
 * - `readCurrentFindings` (public query): the reactive current-memory read;
 *   resolves the actor through the SAME canonical chain and decodes the
 *   scope through the operation's contract schema (Effect decoding at the
 *   untrusted boundary), failing sanitized otherwise. Rows carry their
 *   encoded (wire) value shapes — see ./semantics.ts.
 *
 * `markWithdrawnSource` (internal mutation) exposes the withdrawal marking
 * core over the service bridge: the operation exists now (issue #25's
 * withdrawal-marking proof); C5's recomputation executor and the sources
 * lane's withdraw command drive it in the composed product.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { Schema } from "effect";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import {
  forbiddenError,
  unauthenticatedError,
  validationError,
} from "@kiero/runtime";
import {
  bridgeIdentity,
  resolveRequestContext,
} from "../../platform/context";
import {
  resolveAccessContextFromConvexAuth,
} from "../../access/identity/resolution";
import { internalMutation, mutation, query } from "../../_generated/server";
import { dispatchMemoryCommand } from "./dispatch";
import { readCurrentFindingsEntry } from "./semantics";
import { readCurrentFindingsRows } from "./read";
import { performWithdrawalMarking } from "./withdrawal";

/** The client command path: Convex Auth identity, checked dispatch. */
export const dispatchMemoryCommandEntry = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchMemoryCommand(ctx, args.envelope, undefined),
});

/**
 * The service path's transactional entry: the verified service session id
 * substitutes the bearer-verified identity (the A3 bridge pattern).
 */
export const dispatchMemoryTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchMemoryCommand(ctx, args.envelope, args.serviceSessionId),
});

/** The reactive current-memory read (scope decoded through the contract). */
export const readCurrentFindings = query({
  args: { scope: v.any() },
  handler: async (ctx, args) => {
    // J1 prerequisite repair (the C4 flag): the read path resolves through
    // B1's live-session chain (no provisioning — queries never write), the
    // same pattern B3's public reads use. The platform-generic subject is
    // not a sessions-registry id, so ordinary user tokens previously failed
    // `no_verified_identity` here.
    const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
    if (context === null) {
      throw new ConvexError(unauthenticatedError("no_verified_identity"));
    }
    const decoded = Schema.decodeUnknownSync(readCurrentFindingsEntry.input)({
      scope: args.scope,
    });
    const rows = await readCurrentFindingsRows(ctx.db, context, decoded);
    if (!rows.ok) {
      // The error alternative carries the ClosedError itself: no envelope
      // branch can fall through to empty rows.
      throw new ConvexError(rows.error);
    }
    return rows.rows;
  },
});

/**
 * The withdrawal-marking entry over the service bridge (internal): C5's
 * `memory.recompute_dependents` executor (cause `source_withdrawn`) calls
 * this same core; the guarded probe proves it live today.
 */
export const markWithdrawnSource = internalMutation({
  args: { sourceId: v.string(), reason: v.string(), serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    if (args.reason.trim().length === 0) {
      return errorResult(validationError("withdrawal_reason_empty"));
    }
    return performWithdrawalMarking(ctx, context, args.sourceId, args.reason);
  },
});
