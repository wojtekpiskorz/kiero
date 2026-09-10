/**
 * The H4 Convex function surface (generated-call APIs).
 *
 * One public mutation, `dispatchGmProcessing`: the typed GM processing
 * dispatch (inspection, failed-stage retry, linked reanalysis). Every
 * command re-resolves current GM authority inside the transaction through
 * B4's seam (open grant + company + open alpha activation); every effect
 * writes its protected audit row in the same transaction.
 *
 * There is deliberately NO public read here: company internals leave the
 * database only through the audited `operations.inspectProcessingRun`
 * command (B4's rule for GM surfaces). The barebones UI composes B4's
 * `gmOverview` (the actor's own mode state) with this dispatch.
 */

import { v } from "convex/values";
import { mutation } from "../../_generated/server";
import type { ResultEnvelope } from "@kiero/contracts";
import { dispatchGmProcessingCommand } from "./dispatch";

/** The typed GM processing command dispatch (client path). */
export const dispatchGmProcessing = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchGmProcessingCommand(ctx, args.envelope),
});
