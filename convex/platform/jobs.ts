/**
 * The durable job executor entry (A3).
 *
 * `runDurableJob` is the single scheduled consumer of every `durableJobs`
 * row. It decodes the job input against the kind's executor schema from the
 * composed A2/A3 registry, applies the common idempotent execution rules and
 * dispatches to the registered implementation:
 *
 * - succeeded rows replay as no-ops (idempotency);
 * - attempts are bounded by the registration's `maxAttempts`;
 * - executors that must leave the transaction return an `external` outcome;
 *   the external action runs separately and records its own outcome
 *   (including uncertain `timeout`/`unknown`, which block blind retries
 *   until reconciliation observes the external system's state).
 *
 * Executor implementations register in ./executors.ts (the composition
 * import point where parallel lanes add their own files).
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { executors } from "@kiero/contracts";
import { backoffDelayMs, isUncertainJobFailure } from "@kiero/runtime";
import { jobExecutors, type JobOutcome } from "./executors";

const RETRY_BACKOFF_BASE_MS = 2_000;

/** Loads, dispatches and records one durable job attempt. */
async function executeJob(ctx: MutationCtx, jobKey: string): Promise<void> {
  const job = await ctx.db
    .query("durableJobs")
    .withIndex("by_jobKey", (q) => q.eq("jobKey", jobKey))
    .first();
  if (job === null) {
    throw new Error(`runDurableJob: no durableJobs row for key ${jobKey}`);
  }
  if (job.state === "succeeded" || job.state === "cancelled") {
    return; // idempotent replay
  }
  if (
    isUncertainJobFailure({
      state: job.state,
      ...(job.externalOutcome === undefined ? {} : { externalOutcome: job.externalOutcome }),
    })
  ) {
    // Failed by uncertainty: only reconciliation may re-queue it. (Rows
    // failed WITHOUT an external outcome are not uncertain; they fall
    // through and are bounded by maxAttempts below.)
    return;
  }
  if (job.attempts >= job.maxAttempts) {
    await ctx.db.patch(job._id, {
      state: "failed",
      lastErrorKind: "max_attempts_exceeded",
      updatedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    return;
  }

  const executorEntry = executors.find((candidate) => candidate.jobKind === job.kind);
  if (executorEntry === undefined) {
    await ctx.db.patch(job._id, {
      state: "failed",
      lastErrorKind: "unsupported_job_kind",
      updatedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(job.inputJson);
  } catch {
    await ctx.db.patch(job._id, {
      state: "failed",
      lastErrorKind: "job_input_not_json",
      updatedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    return;
  }

  await ctx.db.patch(job._id, {
    state: "running",
    attempts: job.attempts + 1,
    updatedAtMs: Date.now(),
  });

  const implementation = jobExecutors[job.kind];
  const outcome: JobOutcome =
    implementation === undefined
      ? { outcome: "failed", errorKind: "not_implemented", retryable: false }
      : await implementation.execute(ctx, job, input);

  switch (outcome.outcome) {
    case "succeeded": {
      await ctx.db.patch(job._id, {
        state: "succeeded",
        externalOutcome: "succeeded",
        updatedAtMs: Date.now(),
        finishedAtMs: Date.now(),
      });
      await implementation?.onSucceeded?.(ctx, job);
      return;
    }
    case "failed": {
      if (outcome.retryable && job.attempts + 1 < job.maxAttempts) {
        await ctx.db.patch(job._id, {
          state: "queued",
          lastErrorKind: outcome.errorKind,
          updatedAtMs: Date.now(),
        });
        await ctx.scheduler.runAfter(
          backoffDelayMs(job.attempts + 1, RETRY_BACKOFF_BASE_MS),
          internal.platform.jobs.runDurableJob,
          { jobKey },
        );
      } else {
        await ctx.db.patch(job._id, {
          state: "failed",
          lastErrorKind: outcome.errorKind,
          updatedAtMs: Date.now(),
          finishedAtMs: Date.now(),
        });
        await implementation?.onFailed?.(ctx, job);
      }
      return;
    }
    case "external": {
      // The effect leaves the transaction: the action records the outcome
      // (succeeded/failed/timeout/unknown) itself. The job stays `running`
      // until that record arrives.
      await ctx.scheduler.runAfter(0, outcome.action, { jobKey });
      return;
    }
  }
}

/** The scheduled durable executor entry (atomic registration target). */
export const runDurableJob = internalMutation({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    await executeJob(ctx, args.jobKey);
  },
});
