/**
 * D3 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, the D1/D2 probe pattern; shared plumbing in
 * ../probe_shared.ts).
 *
 * No business work happens here; these entries exist so the D3 evidence can
 * run against the REAL dev deployment, the REAL gateway Worker and the REAL
 * EU R2 bucket. Every entry resolves the CALLER's identity from that
 * caller's own verified Convex Auth credential (the proof script signs in
 * real fixture persons through B1's email-code flow with fixture codes —
 * the B3 evidence pattern); no identity is ever accepted from client input
 * and the service account is never substituted.
 *
 * - `probeMediaAccess`: runs the SAME per-user resolution the HTTP
 *   boundary serves (`mediaAccessFor`) as the caller — the typed-rejection
 *   and non-disclosure matrix (foreign id, missing id, malformed id) live
 *   on the real deployment this way.
 * - `probeSetSourceLifecycle`: fixture control for the source-lifecycle
 *   proofs — moves one of the CALLER'S OWN company's accepted sources to
 *   `withdrawn` or `purged` (the C5/I4 operations own the real lifecycle
 *   commands; this control only lets the evidence reach the states).
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, validationError } from "@kiero/runtime";
import { resolveAccessContextFromConvexAuth } from "../../access/identity/resolution";
import { probeDisabled, probeGuardEnabled } from "../probe_shared";

/** The read surface the caller resolution needs (query and mutation ctx both fit). */
type CallerDb = Parameters<typeof resolveAccessContextFromConvexAuth>[0];
/** The auth surface the caller resolution needs (any Convex ctx fits). */
type CallerAuth = Parameters<typeof resolveAccessContextFromConvexAuth>[1];

/** Resolves the caller's read-side context, or the sanitized refusal. */
async function callerContextOrRefuse(
  db: CallerDb,
  auth: CallerAuth,
): Promise<
  | { ok: true; context: NonNullable<Awaited<ReturnType<typeof resolveAccessContextFromConvexAuth>>> }
  | { ok: false; result: ResultEnvelope }
> {
  const context = await resolveAccessContextFromConvexAuth(db, auth, Date.now());
  if (context === null) {
    return { ok: false, result: errorResult(forbiddenError("no_verified_identity")) };
  }
  return { ok: true, context };
}

/** Runs the per-user media-access resolution as the CALLER (guarded). */
export const probeMediaAccess = action({
  args: { attachmentId: v.optional(v.string()), representationId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return await ctx.runQuery(internal.sources["media_access"].commands.mediaAccessFor, {
      ...(args.attachmentId === undefined ? {} : { attachmentId: args.attachmentId }),
      ...(args.representationId === undefined ? {} : { representationId: args.representationId }),
    });
  },
});

/** Moves one of the caller's own company's sources to a fixture lifecycle. */
export const setSourceLifecycle = internalMutation({
  args: { sourceId: v.string(), lifecycle: v.union(v.literal("withdrawn"), v.literal("purged")) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerContextOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const companyId = ctx.db.normalizeId("companies", resolved.context.actor.companyId);
    const sourceId = ctx.db.normalizeId("sources", args.sourceId);
    if (companyId === null || sourceId === null) {
      return errorResult(validationError("media_reference_malformed"));
    }
    const source = await ctx.db.get(sourceId);
    if (source === null || source.companyId !== companyId) {
      return errorResult(forbiddenError("media_reference_not_found"));
    }
    const nowMs = Date.now();
    await ctx.db.patch(sourceId, {
      lifecycle: args.lifecycle,
      ...(args.lifecycle === "withdrawn"
        ? { withdrawnReason: "d3-proof-fixture", withdrawnAtMs: nowMs }
        : { purgedAtMs: nowMs }),
    });
    return okResult({ sourceId, lifecycle: args.lifecycle });
  },
});

export const probeSetSourceLifecycle = action({
  args: { sourceId: v.string(), lifecycle: v.union(v.literal("withdrawn"), v.literal("purged")) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return await ctx.runMutation(internal.sources["media_access"].probe.setSourceLifecycle, {
      sourceId: args.sourceId,
      lifecycle: args.lifecycle,
    });
  },
});
