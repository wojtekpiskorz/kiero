/**
 * I4 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, the D1/D3/I3 probe pattern). No business work happens here; the
 * entries let the live evidence run against the REAL dev deployment, the
 * REAL gateway Worker and the REAL EU media bucket.
 *
 * Every entry resolves the CALLER's identity from that caller's own
 * verified Convex Auth credential; no identity is ever accepted from
 * client input and the service account is never substituted.
 *
 * - `probeDeletionState`: the caller's company's deletion ledger rows and
 *   purge stage states (counts and machine states only; never content).
 * - `probePurgeAsCaller`: runs the SAME checked sources dispatch the web
 *   feature uses, as the caller, so the admin/member refusal matrix and
 *   the confirmation guard live on the real deployment.
 * - `probeImpactAsCaller`: the administrator impact preview as the caller.
 * - `probeMediaPurgeCall`: the ONE production HTTP call to the gateway's
 *   purge route, with an explicit URL override (the proof drives the REAL
 *   deployed route without touching deployment env).
 * - `probePurgeTick`: forces the 24-hour tracking pass's decision now.
 */

import { v } from "convex/values";
import { action, internalAction, internalMutation } from "../../_generated/server";
import { api } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { probeDisabled, probeGuardEnabled } from "../../sources/probe_shared";
import { callPurgeRoute } from "./executor";
import { runPurgeOverduePass } from "./functions";

/** The caller's company's deletion ledger and purge stage states. */
export const probeDeletionState = action({
  args: {},
  handler: async (ctx, _args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    // Actions hold no direct db reader; the status core resolves the
    // caller's own company from the caller's own credential through the
    // guarded query surface.
    return await ctx.runQuery(api.operations.deletion.functions.deletionsStatus, {});
  },
});

/** The checked purge dispatch as the caller (the exact web surface). */
export const probePurgeAsCaller = action({
  args: { sourceId: v.string(), confirmation: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return await ctx.runMutation(api.sources.accept.commands.acceptSourceCommand, {
      envelope: {
        operation: "sources.purgeSource",
        input: { sourceId: args.sourceId, confirmation: args.confirmation },
        expectedRevisions: [],
      },
    });
  },
});

/** The administrator impact preview as the caller. */
export const probeImpactAsCaller = action({
  args: { sourceId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return await ctx.runQuery(api.operations.deletion.functions.deletionImpactFor, {
      sourceId: args.sourceId,
    });
  },
});

/** The ONE production gateway purge call, with an explicit URL override. */
export const probeMediaPurgeCall = internalAction({
  args: { deletionRecordId: v.string(), url: v.string() },
  handler: async (_ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return errorResult(unsupportedError("operations.deletion.probe", "probe_guard_disabled"));
    }
    const classification = await callPurgeRoute(args.deletionRecordId, args.url);
    if (classification.kind === "succeeded") {
      return okResult({ succeeded: true });
    }
    return errorResult(unsupportedError("operations.deletion.probe", classification.errorKind));
  },
});

/** Forces the 24-hour tracking pass now (the overdue diagnostic evidence). */
export const probePurgeTick = internalMutation({
  args: {},
  handler: async (ctx, _args) => {
    if (!probeGuardEnabled()) {
      throw new Error("probe guard disabled");
    }
    return { overdue: await runPurgeOverduePass(ctx) };
  },
});
