/**
 * The external-delivery proof executor (A3): `platform.echo_delivery`.
 *
 * This executor demonstrates the architecture's external-call protocol
 * (source-processing/publication protocol, steps 7-9, at platform level)
 * with an HTTP echo stand-in instead of a live provider (OpenRouter belongs
 * to E2):
 *
 * 1. the transactional half (execute) hands the effect to the delivery
 *    ACTION — external calls never run inside the transaction that commits
 *    the intent;
 * 2. the action performs one bounded HTTP POST to the configured external
 *    target and records the outcome: `succeeded` (2xx), `timeout`/`unknown`
 *    (deadline hit, ambiguous response, or the action itself dying), or
 *    `failed` (connection refused before anything was sent);
 * 3. uncertain outcomes block blind retries: the job fails with
 *    `externalOutcome: timeout|unknown` and only reconciliation — which
 *    OBSERVES the external system's recorded effects — may confirm delivery
 *    (no second call) or allow one (effect provably absent).
 *
 * The echo endpoint records every request it receives in `externalEffects`
 * before answering, so the no-duplicate-effect proof counts rows per dedup
 * key: replays and reconciliations must leave exactly one.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { echoDeliveryInput } from "@kiero/contracts";
import { backoffDelayMs, nextDeliveryState } from "@kiero/runtime";
import { internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { JobExecutor, JobOutcome, DurableJobDoc } from "./executors";

const HTTP_TIMEOUT_MS = 2_000;
const RETRY_BACKOFF_BASE_MS = 2_000;

export const echoExecutor: JobExecutor = {
  jobKind: "platform.echo_delivery",
  execute: async (_ctx, _job): Promise<JobOutcome> => {
    // The effect leaves the transaction (see module docs); the action marks
    // the outbox row in_flight from its own preparation step and decodes the
    // job input against `echoDeliveryInput` (the registry decode authority
    // for this kind, re-checked in prepareAttempt).
    return { outcome: "external", action: internal.platform.echo.deliverEcho };
  },
  onSucceeded: async (ctx, job) => {
    await markOutboxForJob(ctx, job, "delivered");
  },
  onFailed: async (ctx, job) => {
    await markOutboxForJob(ctx, job, "failed");
  },
};

async function markOutboxForJob(
  ctx: import("../_generated/server").MutationCtx,
  job: DurableJobDoc,
  deliveryState: "delivered" | "failed",
): Promise<void> {
  const input = JSON.parse(job.inputJson) as { dedupKey?: string };
  if (input.dedupKey === undefined) {
    return;
  }
  const row = await ctx.db
    .query("outboxEvents")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", input.dedupKey))
    .first();
  if (row !== null) {
    await ctx.db.patch(row._id, { deliveryState, attempts: job.attempts });
  }
}

/** The external delivery action: one bounded HTTP POST, outcome recorded. */
export const deliverEcho = internalAction({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const prepared = await ctx.runMutation(internal.platform.echo.prepareAttempt, {
      jobKey: args.jobKey,
    });
    if (prepared === null) {
      return;
    }
    const target = process.env.KIERO_ECHO_TARGET;
    if (target === undefined || target === "") {
      await ctx.runMutation(internal.platform.echo.completeAttempt, {
        jobKey: args.jobKey,
        outcome: "failed",
        retryable: false,
        errorKind: "echo_target_not_configured",
      });
      return;
    }
    // The deadline uses an explicit AbortController: the Convex action
    // runtime does not guarantee AbortSignal.timeout.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          dedupKey: prepared.dedupKey,
          serviceName: "echo",
          message: prepared.message,
        }),
        signal: controller.signal,
      });
      clearTimeout(deadline);
      if (response.ok) {
        await ctx.runMutation(internal.platform.echo.completeAttempt, {
          jobKey: args.jobKey,
          outcome: "succeeded",
          retryable: false,
          errorKind: "",
        });
        return;
      }
      // A non-2xx answer is ambiguous for an external system that may have
      // performed its effect before failing to respond cleanly: uncertain.
      await ctx.runMutation(internal.platform.echo.completeAttempt, {
        jobKey: args.jobKey,
        outcome: "unknown",
        retryable: false,
        errorKind: "external_status_not_2xx",
      });
    } catch (cause) {
      clearTimeout(deadline);
      if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
        // Deadline hit: the external system may or may not have delivered.
        await ctx.runMutation(internal.platform.echo.completeAttempt, {
          jobKey: args.jobKey,
          outcome: "timeout",
          retryable: false,
          errorKind: "external_deadline_exceeded",
        });
        return;
      }
      // Connection-level failure before a response: not delivered.
      await ctx.runMutation(internal.platform.echo.completeAttempt, {
        jobKey: args.jobKey,
        outcome: "failed",
        retryable: true,
        errorKind: "external_connection_failed",
      });
    }
  },
});

/** Loads and validates the attempt input; marks the outbox row in_flight. */
export const prepareAttempt = internalMutation({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null || job.state !== "running") {
      return null;
    }
    const input = Schema.decodeUnknownSync(echoDeliveryInput)(JSON.parse(job.inputJson));
    const row = await ctx.db
      .query("outboxEvents")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", input.dedupKey))
      .first();
    if (row !== null) {
      await ctx.db.patch(row._id, { deliveryState: "in_flight", attempts: job.attempts });
    }
    return { dedupKey: input.dedupKey, message: input.message };
  },
});

/** Records one delivery attempt's outcome; uncertain outcomes never retry. */
export const completeAttempt = internalMutation({
  args: {
    jobKey: v.string(),
    outcome: v.union(
      v.literal("succeeded"),
      v.literal("failed"),
      v.literal("timeout"),
      v.literal("unknown"),
    ),
    retryable: v.boolean(),
    errorKind: v.string(),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null) {
      return;
    }
    const nowMs = Date.now();
    const input = JSON.parse(job.inputJson) as { dedupKey: string };
    const outboxRow = await ctx.db
      .query("outboxEvents")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", input.dedupKey))
      .first();

    const terminalFailure = async () => {
      await ctx.db.patch(job._id, {
        state: "failed",
        externalOutcome: args.outcome,
        ...(args.errorKind === "" ? {} : { lastErrorKind: args.errorKind }),
        updatedAtMs: nowMs,
        finishedAtMs: nowMs,
      });
      if (outboxRow !== null) {
        await ctx.db.patch(outboxRow._id, { deliveryState: "failed" });
      }
    };

    if (args.outcome === "succeeded") {
      await ctx.db.patch(job._id, {
        state: "succeeded",
        externalOutcome: "succeeded",
        updatedAtMs: nowMs,
        finishedAtMs: nowMs,
      });
      if (outboxRow !== null) {
        await ctx.db.patch(outboxRow._id, { deliveryState: "delivered" });
      }
      return;
    }
    if (args.outcome === "failed" && !args.retryable) {
      await terminalFailure();
      return;
    }

    const transition = nextDeliveryState(
      { outcome: args.outcome, attempts: job.attempts, maxAttempts: job.maxAttempts },
      nowMs,
      RETRY_BACKOFF_BASE_MS,
    );

    switch (transition.to) {
      case "delivered": {
        return; // unreachable for non-succeeded outcomes
      }
      case "in_flight": {
        await ctx.db.patch(job._id, {
          state: "queued",
          ...(args.errorKind === "" ? {} : { lastErrorKind: args.errorKind }),
          updatedAtMs: nowMs,
        });
        if (outboxRow !== null) {
          await ctx.db.patch(outboxRow._id, {
            deliveryState: "pending",
            nextAttemptAtMs: transition.nextAttemptAtMs,
          });
        }
        await ctx.scheduler.runAfter(
          Math.max(transition.nextAttemptAtMs - nowMs, 0),
          internal.platform.jobs.runDurableJob,
          { jobKey: args.jobKey },
        );
        return;
      }
      case "failed": {
        // Uncertain (timeout/unknown) or attempts exhausted: record and stop;
        // reconciliation owns the next move (uncertain) or none (terminal).
        await ctx.db.patch(job._id, {
          state: "failed",
          externalOutcome: args.outcome,
          ...(args.errorKind === "" ? {} : { lastErrorKind: args.errorKind }),
          updatedAtMs: nowMs,
          ...(transition.terminal ? { finishedAtMs: nowMs } : {}),
        });
        if (outboxRow !== null) {
          await ctx.db.patch(outboxRow._id, { deliveryState: "failed" });
        }
        return;
      }
    }
  },
});

/**
 * Reconciliation (the uncertain-outcome protocol): observes the external
 * system's recorded effects for one dedup key and decides WITHOUT a blind
 * retry. Confirmed effect -> job and outbox row complete, no second call.
 * Provably absent effect -> one more bounded attempt may run.
 */
export const reconcileDelivery = internalMutation({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("durableJobs")
      .withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey))
      .first();
    if (job === null || job.state === "succeeded" || job.state === "cancelled") {
      return { reconciled: "not_applicable" as const };
    }
    const input = JSON.parse(job.inputJson) as { dedupKey: string };
    const observed = await ctx.db
      .query("externalEffects")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", input.dedupKey))
      .first();
    const nowMs = Date.now();
    if (observed !== null) {
      // The effect happened; complete without another external call.
      await ctx.db.patch(job._id, {
        state: "succeeded",
        externalOutcome: "succeeded",
        updatedAtMs: nowMs,
        finishedAtMs: nowMs,
      });
      const outboxRow = await ctx.db
        .query("outboxEvents")
        .withIndex("by_dedup", (q) => q.eq("dedupKey", input.dedupKey))
        .first();
      if (outboxRow !== null) {
        await ctx.db.patch(outboxRow._id, { deliveryState: "delivered" });
      }
      return { reconciled: "confirmed_delivered" as const };
    }
    if (job.attempts >= job.maxAttempts) {
      return { reconciled: "max_attempts" as const };
    }
    // No effect was recorded: the delivery provably did not happen.
    await ctx.db.patch(job._id, {
      state: "queued",
      updatedAtMs: nowMs,
    });
    await ctx.scheduler.runAfter(
      backoffDelayMs(job.attempts, RETRY_BACKOFF_BASE_MS),
      internal.platform.jobs.runDurableJob,
      { jobKey: args.jobKey },
    );
    return { reconciled: "retrying" as const };
  },
});

/** Runs one reconciliation from an authorized external caller (probe bridge). */
export async function runReconcile(
  ctx: ActionCtx,
  jobKey: string,
): Promise<{ reconciled: "not_applicable" | "confirmed_delivered" | "max_attempts" | "retrying" }> {
  return ctx.runMutation(internal.platform.echo.reconcileDelivery, { jobKey });
}
