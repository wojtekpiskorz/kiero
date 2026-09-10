/**
 * Images channel callable entries (D5): the internal mutations behind the
 * service-credential HTTP boundary (`./http.ts`) and the probe surface
 * (`./probe.ts`).
 *
 * There is deliberately NO public mutation here: the images channel is the
 * executor's own recording path, and user-facing reads live in the guarded
 * probe until D3/E4 build the certified surfaces. Every entry is scoped by
 * `jobKey` and re-derives tenancy from the job row inside its transaction
 * (see ./ledger.ts for the authority model).
 */

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import {
  cleanupReceivedTransaction,
  prepareNormalizationTransaction,
  reconcileNormalizationTransaction,
  recordNormalizationTransaction,
  verifyNormalizationTransaction,
} from "./ledger";

/** prepare: marks the in-progress rows, returns the executor's plan. */
export const prepareStep = internalMutation({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => prepareNormalizationTransaction(ctx, args.jobKey),
});

/** record: writes the unverified rows (or the original exception row). */
export const recordStep = internalMutation({
  args: { jobKey: v.string(), attachmentId: v.string(), outcome: v.any() },
  handler: async (ctx, args) =>
    recordNormalizationTransaction(ctx, args.jobKey, args.attachmentId, args.outcome),
});

/** verify: stamps verifiedAtMs on cross-checked evidence, publishes events. */
export const verifyStep = internalMutation({
  args: {
    jobKey: v.string(),
    attachmentId: v.string(),
    retained: v.any(),
    thumbnail: v.any(),
  },
  handler: async (ctx, args) =>
    verifyNormalizationTransaction(
      ctx,
      args.jobKey,
      args.attachmentId,
      args.retained,
      args.thumbnail,
    ),
});

/** cleanup: marks the received bytes removed (after the R2 delete). */
export const cleanupStep = internalMutation({
  args: { jobKey: v.string(), attachmentId: v.string() },
  handler: async (ctx, args) => cleanupReceivedTransaction(ctx, args.jobKey, args.attachmentId),
});

/** reconcile: observes the rows; completes, directs cleanup, or retries. */
export const reconcileStep = internalMutation({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => reconcileNormalizationTransaction(ctx, args.jobKey),
});
