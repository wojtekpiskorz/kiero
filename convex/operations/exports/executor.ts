/**
 * The firm-export durable executor (I3): `exports.build_archive`.
 *
 * The architecture's external-call protocol (the D5 echo template) applied
 * to archive assembly:
 *
 * 1. the transactional half (`execute`) moves the export row to
 *    `building` under a fresh build token — the only attempt allowed to
 *    publish — and hands the effect to the external ACTION (R2 reads and
 *    the archive writer never run inside a transaction);
 * 2. the action performs ONE bounded HTTP POST to the configured export
 *    executor (the export Worker's `/exports/build` route, which owns the
 *    bucket) with the deployment's service credential, then records the
 *    classified outcome: `succeeded`, definite `failed` (retryable only for
 *    `unavailable`), or the UNCERTAIN `timeout`/`unknown`;
 * 3. uncertain outcomes never re-POST blindly: reconciliation OBSERVES the
 *    export row (a publish that landed already made it `available`, which
 *    completes the job; a row still `building` after an uncertain attempt
 *    is marked `failed` with its sanitized kind — a later request starts a
 *    fresh export).
 *
 * The Worker's own publish call (not this action) is what moves the row to
 * `available`; the action only completes the job row. The one HTTP call
 * implementation (`callExportExecutor`) is shared with the guarded proof
 * action, so the live evidence exercises exactly the production path.
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { ResultEnvelope } from "@kiero/contracts";
import { backoffDelayMs } from "@kiero/runtime";
import { internalAction, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import type { DurableJobDoc, JobExecutor, JobOutcome } from "../../platform/executors";
import { beginBuildCore, failBuildCore } from "./lifecycle";

const HTTP_TIMEOUT_MS = 120_000;
const RETRY_BACKOFF_BASE_MS = 5_000;

export const buildArchiveExecutor: JobExecutor = {
  jobKind: "exports.build_archive",
  execute: async (ctx: MutationCtx, job: DurableJobDoc): Promise<JobOutcome> => {
    const input = JSON.parse(job.inputJson) as { exportId: string };
    const exportId = ctx.db.normalizeId("exports", input.exportId);
    if (exportId === null) {
      // A malformed job input (no valid export id): nothing to build.
      return { outcome: "succeeded" };
    }
    const begun = await beginBuildCore(ctx, exportId, Date.now());
    if (begun === null) {
      // Terminal row (already available/expired/invalidated/failed): the
      // replay is a no-op, never a second archive.
      return { outcome: "succeeded" };
    }
    // The effect leaves the transaction: the action drives the export
    // Worker (bucket + archive writer) and records the outcome itself.
    return { outcome: "external", action: internal.operations.exports.executor.runBuild };
  },
};

export type BuildClassification =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly retryable: boolean; readonly errorKind: string }
  | { readonly kind: "timeout" | "unknown"; readonly errorKind: string };

/**
 * THE one bounded HTTP call to the export executor. Shared by the
 * scheduled action and the guarded proof action. The Worker carries the
 * buildToken minted by this attempt; only it can publish.
 */
export async function callExportExecutor(
  jobKey: string,
  exportId: string,
  buildToken: string,
  urlOverride?: string,
): Promise<BuildClassification> {
  const target = urlOverride ?? process.env.KIERO_EXPORT_EXECUTOR_URL;
  if (target === undefined || target === "") {
    return { kind: "failed", retryable: false, errorKind: "export_executor_not_configured" };
  }
  const token = process.env.KIERO_SERVICE_TOKEN;
  if (token === undefined || token === "") {
    return { kind: "failed", retryable: false, errorKind: "service_credential_missing" };
  }
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jobKey, exportId, buildToken }),
      signal: controller.signal,
    });
    clearTimeout(deadline);
  } catch (cause) {
    clearTimeout(deadline);
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      return { kind: "timeout", errorKind: "export_executor_deadline_exceeded" };
    }
    return { kind: "failed", retryable: true, errorKind: "export_executor_connection_failed" };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { kind: "unknown", errorKind: "export_executor_response_not_json" };
  }
  const decoded = Schema.decodeUnknownOption(ResultEnvelope)(payload);
  if (decoded._tag === "None") {
    return { kind: "unknown", errorKind: "export_executor_response_invalid" };
  }
  if (decoded.value._tag === "ok") {
    return { kind: "succeeded" };
  }
  const error = decoded.value.error;
  const retryable = error._tag === "unavailable" && error.retryable;
  return { kind: "failed", retryable, errorKind: `${error._tag}:${error.code}` };
}

/** The scheduled external build attempt (the executor's action). */
export const runBuild = internalAction({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const loaded = await ctx.runQuery(internal.operations.exports.functions.jobExportFor, { jobKey: args.jobKey });
    if (loaded === null) {
      await ctx.runMutation(internal.operations.exports.executor.recordOutcome, {
        jobKey: args.jobKey,
        outcome: "failed",
        retryable: false,
        errorKind: "job_row_missing",
        exportId: "",
        buildToken: "",
      });
      return;
    }
    const exportRow = await ctx.runQuery(internal.operations.exports.functions.buildAttemptFor, {
      exportId: loaded.exportId,
    });
    if (exportRow === null || exportRow.state !== "building" || exportRow.buildToken === null) {
      // Terminal before the call (reconciled publish or invalidation).
      await ctx.runMutation(internal.operations.exports.executor.recordOutcome, {
        jobKey: args.jobKey,
        outcome: "succeeded",
        retryable: false,
        errorKind: "",
        exportId: loaded.exportId,
        buildToken: "",
      });
      return;
    }
    const classification = await callExportExecutor(args.jobKey, loaded.exportId, exportRow.buildToken);
    // Reconcile by observation: the Worker's publish may have landed while
    // the answer was in flight.
    const after = await ctx.runQuery(internal.operations.exports.functions.buildAttemptFor, {
      exportId: loaded.exportId,
    });
    const effective =
      classification.kind !== "succeeded" && after !== null && after.state === "available"
        ? ({ kind: "succeeded" } as const)
        : classification;
    await ctx.runMutation(internal.operations.exports.executor.recordOutcome, {
      jobKey: args.jobKey,
      outcome: effective.kind === "succeeded" ? "succeeded" : effective.kind === "failed" ? "failed" : effective.kind,
      retryable: effective.kind === "failed" ? effective.retryable : false,
      errorKind: effective.kind === "succeeded" ? "" : effective.errorKind,
      exportId: loaded.exportId,
      buildToken: exportRow.buildToken,
    });
  },
});

/** The mutation half of outcome recording (the action's completion entry). */
export const recordOutcome = internalMutation({
  args: {
    jobKey: v.string(),
    outcome: v.union(v.literal("succeeded"), v.literal("failed"), v.literal("timeout"), v.literal("unknown")),
    retryable: v.boolean(),
    errorKind: v.string(),
    exportId: v.string(),
    buildToken: v.string(),
  },
  handler: async (ctx, args) => {
    await recordBuildOutcome(ctx, args);
  },
});

/** Records one external attempt's classification on the job and export rows. */
export async function recordBuildOutcome(
  ctx: MutationCtx,
  args: {
    readonly jobKey: string;
    readonly outcome: "succeeded" | "failed" | "timeout" | "unknown";
    readonly retryable: boolean;
    readonly errorKind: string;
    readonly exportId: string;
    readonly buildToken: string;
  },
): Promise<void> {
  const job = await ctx.db.query("durableJobs").withIndex("by_jobKey", (q) => q.eq("jobKey", args.jobKey)).first();
  if (job === null || job.state === "succeeded" || job.state === "cancelled") {
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
  const terminalFailure = async (uncertain: boolean): Promise<void> => {
    await ctx.db.patch(job._id, {
      state: "failed",
      externalOutcome: uncertain ? args.outcome : "failed",
      ...(args.errorKind === "" ? {} : { lastErrorKind: args.errorKind }),
      updatedAtMs: nowMs,
      finishedAtMs: nowMs,
    });
    if (args.exportId !== "" && args.buildToken !== "") {
      const exportId = ctx.db.normalizeId("exports", args.exportId);
      if (exportId !== null) {
        await failBuildCore(ctx, exportId, args.buildToken, args.errorKind, nowMs);
      }
    }
  };
  if (args.outcome === "failed" && args.retryable && job.attempts < job.maxAttempts) {
    await ctx.db.patch(job._id, { state: "queued", lastErrorKind: args.errorKind, updatedAtMs: nowMs });
    await ctx.scheduler.runAfter(
      backoffDelayMs(job.attempts + 1, RETRY_BACKOFF_BASE_MS),
      internal.platform.jobs.runDurableJob,
      { jobKey: args.jobKey },
    );
    return;
  }
  if (args.outcome === "failed" && !args.retryable) {
    await terminalFailure(false);
    return;
  }
  // Uncertain (timeout/unknown): no blind retry; the export row is failed
  // (a fresh request starts a fresh export), the job stays failed with its
  // uncertain external outcome recorded.
  await terminalFailure(true);
}
