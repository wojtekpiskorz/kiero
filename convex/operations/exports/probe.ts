/**
 * I3 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, the D1/D3 probe pattern). No business work happens here; the
 * entries let the live evidence run against the REAL dev deployment, the
 * REAL gateway Worker, the REAL export Worker and the REAL EU bucket.
 *
 * Every entry resolves the CALLER's identity from that caller's own
 * verified Convex Auth credential; no identity is ever accepted from
 * client input and the service account is never substituted.
 *
 * - `probeExportsState`: the caller's company's export rows and links (the
 *   evidence compares rows to downloads).
 * - `probeRequestExportAsCaller`: runs the SAME checked dispatch the web
 *   feature uses (`dispatchExports`) as the caller, so the admin/member
 *   refusal matrix lives on the real deployment.
 * - `probeInvalidateForPurgedSource`: the eager invalidation seam I4 will
 *   call, as a guarded internal action for the immediacy evidence.
 * - `probeSweepExpiry`: forces the expiry sweep's decision for one export.
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { api, internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { validationError } from "@kiero/runtime";
import { probeDisabled, probeGuardEnabled } from "../../sources/probe_shared";
import { expireExportCore, invalidateExportsForSourceCore } from "./lifecycle";



/** The caller's company's export rows plus links (never object keys). */
export const probeExportsState = action({
  args: {},
  handler: async (ctx, _args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    // Actions hold no direct db reader; the guarded query resolves the
    // caller's own company from the caller's own credential.
    return await ctx.runQuery(internal.operations["exports"].functions.probeStateInternal, {});
  },
});

/** The checked dispatch as the caller (the exact web surface). */
export const probeRequestExportAsCaller = action({
  args: {},
  handler: async (ctx, _args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return await ctx.runMutation(api.operations["exports"].functions.dispatchExports, {
      envelope: { operation: "operations.requestExport", input: {}, expectedRevisions: [] },
    });
  },
});

/** The eager invalidation seam (I4's consumer edge), as an internal mutation. */
export const probeInvalidateForPurgedSource = internalMutation({
  args: { sourceId: v.id("sources"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!probeGuardEnabled()) {
      throw new Error("probe guard disabled");
    }
    return await invalidateExportsForSourceCore(ctx, args.sourceId, args.reason ?? "source_purged", Date.now());
  },
});

/** Forces the expiry sweep's decision for one export of the caller's company. */
export const probeSweepExpiry = internalMutation({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args) => {
    if (!probeGuardEnabled()) {
      throw new Error("probe guard disabled");
    }
    return { outcome: await expireExportCore(ctx, args.exportId, Date.now()) };
  },
});

/** A thin action wrapper so proofs can call the guarded sweeps by id. */
export const probeSweepExpiryAction = action({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const state = await ctx.runQuery(internal.operations["exports"].functions.probeStateInternal, {});
    if (state._tag !== "ok") {
      return state;
    }
    const mine = (state.value as { exports: { exportId: string }[] }).exports;
    if (!mine.some((row) => row.exportId === args.exportId)) {
      return errorResult(validationError("export_not_found"));
    }
    await ctx.runMutation(internal.operations["exports"].probe.probeSweepExpiry, { exportId: args.exportId });
    return okResult({ swept: true });
  },
});

/** A thin action wrapper so proofs can drive the eager invalidation seam. */
export const probeInvalidateForSourceAction = action({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    // The eager seam is company-scoped by construction (links come from
    // this company's exports); the guarded guard still applies.
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return okResult(
      await ctx.runMutation(internal.operations["exports"].probe.probeInvalidateForPurgedSource, {
        sourceId: args.sourceId,
        reason: "source_purged",
      }),
    );
  },
});

/**
 * Fixture control for the expiry evidence: moves one of the CALLER'S OWN
 * company's available exports past its window (the real 24-hour clock is
 * not waitable in a proof run) and then runs the same sweep decision the
 * scheduler would. The row's `availableUntilMs` is the only field touched.
 */
export const probeForceExpire = internalMutation({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args) => {
    if (!probeGuardEnabled()) {
      throw new Error("probe guard disabled");
    }
    const row = await ctx.db.get(args.exportId);
    if (row === null) {
      throw new Error("export not found");
    }
    if (row.state === "available") {
      await ctx.db.patch(args.exportId, { availableUntilMs: Date.now() - 1 });
    }
    return { outcome: await expireExportCore(ctx, args.exportId, Date.now()) };
  },
});

/** The action wrapper so proofs can drive the guarded expiry fixture. */
export const probeForceExpireAction = action({
  args: { exportId: v.id("exports") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const state = await ctx.runQuery(internal.operations["exports"].functions.probeStateInternal, {});
    if (state._tag !== "ok") {
      return state;
    }
    const mine = (state.value as { exports: { exportId: string }[] }).exports;
    if (!mine.some((row) => row.exportId === args.exportId)) {
      return errorResult(validationError("export_not_found"));
    }
    await ctx.runMutation(internal.operations["exports"].probe.probeForceExpire, { exportId: args.exportId });
    return okResult({ expired: true });
  },
});
