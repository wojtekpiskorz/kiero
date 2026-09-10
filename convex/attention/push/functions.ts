/**
 * The F3 Convex function surface (generated-call APIs).
 *
 * `runPushDeliveryAttempt` is the durable `attention.deliver_push`
 * executor's action half (the G3 prepare -> leg -> record template): the
 * transport POST leaves the transaction, so the mutation pair
 * (preparePushDelivery / completePushLegs) owns every durable decision
 * while this action only performs the bounded provider legs.
 *
 * `pushSafetyNetTick` is the cron safety net (the F2 evaluator-cron and
 * I2 outbox-cron precedent): under total scheduler loss, or after a job
 * exhausted its bounded attempts with retryable legs left, stale pending
 * per-device rows keep converging; the same tick runs the revocation
 * hygiene pass that persists the honest disabled state for subscriptions
 * whose session or membership died (delivery already denied both
 * structurally in the prepare).
 *
 * `pushState` (the settings screen read) lives in ./queries.ts.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { backoffDelayMs } from "@kiero/runtime";
import {
  deliverOneWebPush,
  runtimeCrypto,
  vapidKeysOf,
  PUSH_HTTP_TIMEOUT_MS,
} from "./protocol";
import { ttlSecondsOf, type LegResult } from "./model";
import {
  performPreparePushDelivery,
  performCompletePushLegs,
  performPushHygiene,
  performStalePendingIntentIds,
} from "./operations";

/** The deployment's VAPID key material, or null when not configured. */
export function vapidConfig(): ReturnType<typeof vapidKeysOf> {
  return vapidKeysOf(
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
    process.env.WEB_PUSH_VAPID_SUBJECT,
  );
}

// ---------------------------------------------------------------------------
// The mutation pair (durable decisions only).
// ---------------------------------------------------------------------------

/** Prepares one intent's per-device legs (live re-checks + payload). */
export const preparePushDelivery = internalMutation({
  args: { intentId: v.id("notificationIntents") },
  handler: async (ctx, args) => performPreparePushDelivery(ctx, args.intentId),
});

/** Settles leg results (attempt ledger, rows, terminal subscription death). */
export const completePushLegs = internalMutation({
  args: {
    results: v.array(
      v.object({
        deliveryId: v.id("pushDeliveries"),
        subscriptionId: v.id("pushSubscriptions"),
        report: v.object({
          kind: v.string(),
          cause: v.optional(v.string()),
        }),
      }),
    ),
  },
  handler: async (ctx, args) =>
    performCompletePushLegs(
      ctx,
      args.results.map((result) => ({
        deliveryId: result.deliveryId,
        subscriptionId: result.subscriptionId,
        report: normalizeReport(result.report),
      })),
    ),
});

/** Narrows the wire-decoded report object back to the leg vocabulary. */
function normalizeReport(report: {
  kind: string;
  cause?: string;
}): LegResult["report"] {
  switch (report.kind) {
    case "delivered":
    case "gone":
    case "rejected":
    case "unauthorized":
    case "retry_later":
      return { kind: report.kind };
    default:
      return report.cause === "timeout"
        ? { kind: "unknown", cause: "timeout" }
        : { kind: "unknown" };
  }
}

/** Records the delivery job's terminal/queued state (the G3 completion). */
export const completePushJob = internalMutation({
  args: {
    jobKey: v.string(),
    outcome: v.union(v.literal("succeeded"), v.literal("failed")),
    errorKind: v.optional(v.string()),
    retryable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null || job.state !== "running") {
      return;
    }
    const nowMs = Date.now();
    if (args.outcome === "succeeded") {
      await ctx.db.patch(job._id, {
        state: "succeeded",
        externalOutcome: "succeeded",
        updatedAtMs: nowMs,
        finishedAtMs: nowMs,
      });
      return;
    }
    const retryable = args.retryable ?? false;
    if (retryable && job.attempts < job.maxAttempts) {
      await ctx.db.patch(job._id, {
        state: "queued",
        lastErrorKind: args.errorKind ?? "push_delivery_failed",
        updatedAtMs: nowMs,
      });
      await ctx.scheduler.runAfter(
        backoffDelayMs(job.attempts, 2_000),
        internal.platform.jobs.runDurableJob,
        { jobKey: args.jobKey },
      );
      return;
    }
    await ctx.db.patch(job._id, {
      state: "failed",
      lastErrorKind: args.errorKind ?? "push_delivery_failed",
      updatedAtMs: nowMs,
      finishedAtMs: nowMs,
    });
  },
});

/** The job-row read the executor action starts from (the G3 shape). */
export const jobInputForPush = internalQuery({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null || job.state !== "running") {
      return null;
    }
    let input: { notificationIntentId?: unknown } = {};
    try {
      input = JSON.parse(job.inputJson) as typeof input;
    } catch {
      return null;
    }
    const intentId =
      typeof input.notificationIntentId === "string"
        ? (ctx.db.normalizeId("notificationIntents", input.notificationIntentId) as
            | Id<"notificationIntents">
            | null)
        : null;
    if (intentId === null) {
      return null;
    }
    return { intentId };
  },
});

// ---------------------------------------------------------------------------
// The one-intent delivery driver (shared by the job action and the cron).
// ---------------------------------------------------------------------------

/** What one intent's delivery pass concluded. */
interface IntentPassResult {
  readonly succeeded: boolean;
  readonly errorKind: string | null;
  readonly retryable: boolean;
}

/** Runs prepare -> bounded legs -> record for ONE intent. */
async function deliverOneIntent(ctx: ActionCtx, intentId: Id<"notificationIntents">): Promise<IntentPassResult> {
  const prepared = await ctx.runMutation(internal.attention.push.functions.preparePushDelivery, {
    intentId,
  });
  if (prepared.kind !== "prepared") {
    // Honest denial (no live rights, no enabled device) or nothing pending:
    // no notification leaves, and that is the correct outcome, not a failure.
    return { succeeded: true, errorKind: null, retryable: false };
  }
  const keys = vapidConfig();
  if (keys === null) {
    // Deterministic configuration failure: no leg ran, so the pending rows
    // stay untouched for the safety net once the keys exist.
    return { succeeded: false, errorKind: "vapid_keys_missing", retryable: false };
  }
  const nowMs = Date.now();
  const results: LegResult[] = [];
  for (const leg of prepared.legs) {
    const report = await deliverOneWebPush(runtimeCrypto(), {
      endpoint: leg.endpoint,
      p256dhBase64Url: leg.p256dhKeyBase64,
      authBase64Url: leg.authKeyBase64,
      payloadJson: leg.payloadJson,
      ttlSeconds: ttlSecondsOf(),
      keys,
      nowMs,
      timeoutMs: PUSH_HTTP_TIMEOUT_MS,
    });
    results.push({ deliveryId: leg.deliveryId as Id<"pushDeliveries">, subscriptionId: leg.subscriptionId as Id<"pushSubscriptions">, report });
  }
  const completion = await ctx.runMutation(internal.attention.push.functions.completePushLegs, {
    results: results.map((result) => ({
      deliveryId: result.deliveryId as Id<"pushDeliveries">,
      subscriptionId: result.subscriptionId as Id<"pushSubscriptions">,
      report:
        result.report.kind === "unknown"
          ? { kind: result.report.kind, ...(result.report.cause === undefined ? {} : { cause: result.report.cause }) }
          : { kind: result.report.kind },
    })),
  });
  if (completion.pendingRemaining > 0) {
    return { succeeded: false, errorKind: "push_retry_later", retryable: true };
  }
  return { succeeded: true, errorKind: null, retryable: false };
}

// ---------------------------------------------------------------------------
// The callable entries.
// ---------------------------------------------------------------------------

/** The durable executor's action half: one intent, one job completion. */
export const runPushDeliveryAttempt = internalAction({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.runQuery(internal.attention.push.functions.jobInputForPush, {
      jobKey: args.jobKey,
    });
    if (job === null) {
      return;
    }
    const pass = await deliverOneIntent(ctx, job.intentId);
    await ctx.runMutation(internal.attention.push.functions.completePushJob, {
      jobKey: args.jobKey,
      outcome: pass.succeeded ? "succeeded" : "failed",
      ...(pass.errorKind === null ? {} : { errorKind: pass.errorKind }),
      ...(pass.retryable ? { retryable: true } : {}),
    });
  },
});

/** The cron safety net: hygiene pass + stale pending rows, bounded. */
export const pushSafetyNetTick = internalAction({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(internal.attention.push.functions.pushHygiene, {});
    const intentIds = await ctx.runMutation(
      internal.attention.push.functions.stalePendingIntentIds,
      {},
    );
    for (const intentId of intentIds) {
      const pass = await deliverOneIntent(ctx, intentId);
      if (!pass.succeeded && !pass.retryable) {
        console.error(
          `push safety net: intent ${intentId} failed terminally (${pass.errorKind ?? "unknown"})`,
        );
      }
    }
  },
});

/** The hygiene pass as a mutation (shared with the tick). */
export const pushHygiene = internalMutation({
  args: {},
  handler: async (ctx) => performPushHygiene(ctx),
});

/** The stale-pending input as a mutation (shared with the tick). */
export const stalePendingIntentIds = internalMutation({
  args: {},
  handler: async (ctx) => performStalePendingIntentIds(ctx),
});

/**
 * ONE intent's delivery as an explicit internal action (the guarded proof
 * entry and the focused verification driver; the executor job runs the
 * same pass with its own job completion).
 */
export const runOneIntentDelivery = internalAction({
  args: { intentId: v.id("notificationIntents") },
  handler: async (ctx, args): Promise<IntentPassResult> => deliverOneIntent(ctx, args.intentId),
});
