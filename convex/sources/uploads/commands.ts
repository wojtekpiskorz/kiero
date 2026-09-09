/**
 * Sources uploads callable entries (D2).
 *
 * - `prepareUploadCommand` / `resumeUploadCommand` (public mutations): the
 *   client path over the certified operations. Identity comes from Convex
 *   Auth only; without a verified identity the command fails
 *   `unauthenticated` (B1 ships the sign-in product that issues identities).
 * - `stepTransaction` (internal mutation): the Worker uploads-channel path.
 *   The caller is the HTTP boundary (./http.ts), which verified the service
 *   bearer credential BEFORE this point; the session resolves through the
 *   SAME canonical resolution and policy.
 * - `uploadStateFor` (internal query): the tenant-scoped session read the
 *   gateway's resume route and the guarded probes consume.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "../../_generated/server";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, membershipPolicy } from "@kiero/runtime";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import { dispatchUploadsCommand, dispatchUploadsStep } from "./dispatch";
import { uploadSessionState } from "./ledger";

/** The client command path: Convex Auth identity, checked dispatch. */
export const prepareUploadCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchUploadsCommand(ctx, args.envelope, undefined),
});

/** The client resume path: Convex Auth identity, checked dispatch. */
export const resumeUploadCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchUploadsCommand(ctx, args.envelope, undefined),
});

/** The Worker uploads-channel transactional entry (verified service session). */
export const stepTransaction = internalMutation({
  args: { envelope: v.any(), serviceSessionId: v.string() },
  handler: async (ctx, args) => dispatchUploadsStep(ctx, args.envelope, args.serviceSessionId),
});

/** The tenant-scoped upload-session read (verified service session). */
export const uploadStateFor = internalQuery({
  args: { uploadId: v.string(), serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return errorResult(forbiddenError("no_verified_identity"));
    }
    const decision = await membershipPolicy.authorize(context, { intent: "read" });
    if (!decision.allowed) {
      return errorResult(decision.error);
    }
    return uploadSessionState(ctx.db, context, args.uploadId);
  },
});
