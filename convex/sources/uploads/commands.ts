/**
 * Sources uploads callable entries (D2).
 *
 * - `prepareUploadCommand` / `resumeUploadCommand` (public mutations): the
 *   client path over the certified operations. Identity is the caller's
 *   verified Convex Auth session (B1's live-session resolution); without a
 *   verified identity the command fails `unauthenticated`.
 * - `stepTransaction` (internal mutation): the Worker uploads-channel path.
 *   The HTTP boundary (`./http.ts`) forwards the browser's Authorization
 *   header; Convex propagates it into this mutation's `ctx.auth`, and the
 *   SAME user identity resolves — the channel never acts as the service
 *   account.
 * - `uploadStateFor` (internal query): the tenant-scoped session read the
 *   gateway's resume route serves, resolved the same way (read path, no
 *   provisioning).
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation } from "../../_generated/server";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { membershipPolicy, unauthenticatedError } from "@kiero/runtime";
import { resolveAccessContextFromConvexAuth } from "../../access/identity/resolution";
import { dispatchUploadsCommand, dispatchUploadsStep } from "./dispatch";
import { uploadSessionState } from "./ledger";

/** The client command path: Convex Auth identity, checked dispatch. */
export const prepareUploadCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchUploadsCommand(ctx, args.envelope),
});

/** The client resume path: Convex Auth identity, checked dispatch. */
export const resumeUploadCommand = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchUploadsCommand(ctx, args.envelope),
});

/** The Worker uploads-channel transactional entry (the forwarded user identity). */
export const stepTransaction = internalMutation({
  args: { envelope: v.any() },
  handler: async (ctx, args) => dispatchUploadsStep(ctx, args.envelope),
});

/** The tenant-scoped upload-session read (the forwarded user identity). */
export const uploadStateFor = internalQuery({
  args: { uploadId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveAccessContextFromConvexAuth(ctx.db, ctx.auth, Date.now());
    if (context === null) {
      return errorResult(unauthenticatedError());
    }
    const decision = await membershipPolicy.authorize(context, { intent: "read" });
    if (!decision.allowed) {
      return errorResult(decision.error);
    }
    return uploadSessionState(ctx.db, context, args.uploadId);
  },
});
