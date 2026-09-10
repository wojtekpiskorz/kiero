/**
 * The photo-normalization durable executor (D5): `processing.normalize_photo`.
 *
 * The architecture's external-call protocol applied to image normalization
 * (the echo template, A3):
 *
 * 1. the transactional half (execute) hands the effect to the external
 *    ACTION — R2 reads/writes and the normalizer never run inside the
 *    transaction that commits the job's state;
 * 2. the action performs one bounded HTTP POST to the configured images
 *    executor (the gateway Worker's `/images/normalize` route, which owns
 *    R2 and the selected normalizer) and records the outcome:
 *    `succeeded`, definite `failed` (typed envelope, retryable only for
 *    `unavailable`), or the UNCERTAIN `timeout`/`unknown`;
 * 3. uncertain outcomes block blind retries everywhere the job can be
 *    replayed; only `reconcileNormalization` — which OBSERVES the
 *    representation rows the executor may have written — may complete the
 *    job without a second call, direct the pending received-byte cleanup,
 *    or allow one more bounded attempt.
 *
 * The one HTTP call implementation (`callImagesExecutor`) is shared by the
 * scheduled action and the guarded proof action, so the live evidence
 * exercises exactly the production path.
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { ResultEnvelope } from "@kiero/contracts";
import { internalAction, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import type { DurableJobDoc, JobExecutor, JobOutcome } from "../../platform/executors";
import {
  executeNormalizationHalf,
  reconcileNormalizationTransaction,
  recordAttemptOutcomeTransaction,
} from "./ledger";

const HTTP_TIMEOUT_MS = 90_000;

export const normalizePhotoExecutor: JobExecutor = {
  jobKind: "processing.normalize_photo",
  execute: async (ctx: MutationCtx, job: DurableJobDoc): Promise<JobOutcome> => {
    const decision = await executeNormalizationHalf(ctx, job);
    if (decision.outcome === "succeeded") {
      return { outcome: "succeeded" };
    }
    if (decision.outcome === "failed") {
      return { outcome: "failed", errorKind: decision.errorKind, retryable: false };
    }
    // The effect leaves the transaction: the action drives the gateway's
    // images executor (R2 + normalizer) and records the outcome itself.
    return { outcome: "external", action: internal.processing.images.executor.runNormalization };
  },
};

/** Where the images crash-window proof stops the drive (guarded proofs only). */
export type ImagesCrashAfter = "record" | "verify";

/**
 * THE one bounded HTTP call to the images executor. Shared by the scheduled
 * action and the guarded proof action so the live evidence runs the exact
 * production path. The optional `urlOverride` exists ONLY for the guarded
 * crash-window proofs: they point the scheduled machinery at a dead endpoint
 * (so no automatic drive interferes) while the proof drive still exercises
 * the real gateway. Returns the classification the outcome recorder needs.
 */
export async function callImagesExecutor(
  jobKey: string,
  crashAfter?: ImagesCrashAfter,
  urlOverride?: string,
): Promise<
  | { kind: "succeeded" }
  | { kind: "failed"; retryable: boolean; errorKind: string }
  | { kind: "timeout" | "unknown"; errorKind: string }
> {
  const target = urlOverride ?? process.env.KIERO_IMAGES_EXECUTOR_URL;
  if (target === undefined || target === "") {
    return { kind: "failed", retryable: false, errorKind: "images_executor_not_configured" };
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
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jobKey, ...(crashAfter === undefined ? {} : { crashAfter }) }),
      signal: controller.signal,
    });
    clearTimeout(deadline);
  } catch (cause) {
    clearTimeout(deadline);
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      // Deadline hit: the executor may or may not have converted and written.
      return { kind: "timeout", errorKind: "images_executor_deadline_exceeded" };
    }
    // Connection-level failure before the request reached the executor.
    return { kind: "failed", retryable: true, errorKind: "images_executor_connection_failed" };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // A crashing executor (the deliberate proof crashes land here) or a
    // proxy that ate the body: the effects may exist — uncertain.
    return { kind: "unknown", errorKind: "images_executor_response_not_json" };
  }
  const decoded = Schema.decodeUnknownOption(ResultEnvelope)(payload);
  if (decoded._tag === "None") {
    return { kind: "unknown", errorKind: "images_executor_response_invalid" };
  }
  const envelope = decoded.value;
  if (envelope._tag === "ok") {
    return { kind: "succeeded" };
  }
  const error = envelope.error;
  // Only the `unavailable` kind carries a retryability statement; every
  // other closed kind is a definite typed outcome of this attempt.
  const retryable = error._tag === "unavailable" && error.retryable;
  return {
    kind: "failed",
    retryable,
    errorKind: `${error._tag}:${error.code}`,
  };
}

/** Records one external attempt's classification on the job row. */
export async function recordImagesOutcome(
  ctx: MutationCtx,
  jobKey: string,
  classification: Awaited<ReturnType<typeof callImagesExecutor>>,
): Promise<void> {
  if (classification.kind === "succeeded") {
    await recordAttemptOutcomeTransaction(ctx, jobKey, "succeeded", false, "");
    return;
  }
  if (classification.kind === "failed") {
    await recordAttemptOutcomeTransaction(
      ctx,
      jobKey,
      "failed",
      classification.retryable,
      classification.errorKind,
    );
    return;
  }
  await recordAttemptOutcomeTransaction(
    ctx,
    jobKey,
    classification.kind,
    false,
    classification.errorKind,
  );
}

/** The scheduled external normalization attempt (the executor's action). */
export const runNormalization = internalAction({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    const classification = await callImagesExecutor(args.jobKey);
    await ctx.runMutation(internal.processing.images.executor.recordOutcome, {
      jobKey: args.jobKey,
      outcome:
        classification.kind === "succeeded"
          ? "succeeded"
          : classification.kind === "failed"
            ? "failed"
            : classification.kind,
      retryable: classification.kind === "failed" ? classification.retryable : false,
      errorKind:
        classification.kind === "succeeded" ? "" : classification.errorKind,
    });
  },
});

/** The mutation half of outcome recording (the action's completion entry). */
export const recordOutcome = internalMutation({
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
    await recordAttemptOutcomeTransaction(
      ctx,
      args.jobKey,
      args.outcome,
      args.retryable,
      args.errorKind,
    );
  },
});

/** The observation-based reconciliation entry (uncertainty's way out). */
export const reconcileNormalization = internalMutation({
  args: { jobKey: v.string() },
  handler: async (ctx, args) => {
    return reconcileNormalizationTransaction(ctx, args.jobKey);
  },
});
