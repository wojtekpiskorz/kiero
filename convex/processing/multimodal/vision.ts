/**
 * The vision-extraction stage (E4): one bounded provider pass over ONE
 * retained image representation, through E2's vision adapter (GLM then
 * Gemini; never the text-only route), with the typed partial-safe
 * refusals.
 *
 * Composition (external-effect discipline, the echo template): the ACTION
 * resolves the representation bytes through the order's channel and makes
 * the provider call; the MUTATION records the outcome idempotently — the
 * immutable extraction version, its image_region fragments (regions
 * validated against the representation's OWN width/height, the coordinate
 * space) and the durable observations record. A crash between the two
 * re-runs the provider pass once (bounded by the workflow step's retry
 * policy) and the record stays idempotent.
 *
 * Honest failure states (all leave the image input pending, resumable):
 * - both vision routes failing (`vision_routes_failed:<kind>`) — never a
 *   fake complete, never terminal;
 * - the byte channel refusing (the media executor does not serve image
 *   reads yet: `image_read_channel_refused:<code>`; a NAMED prerequisite
 *   for the executor/container lane);
 * - the probe-armed fixture forcing both routes unavailable
 *   (`vision_route_unavailable_armed`) — the deterministic live-proof
 *   channel for "the image pending";
 * - provider regions failing the coordinate-space validation
 *   (`image_region_invalid`) — the fail-closed typed refusal, never a
 *   clamped or negative anchor.
 */

import { v } from "convex/values";
import { Schema } from "effect";
import { runVisionExtraction, type OpenRouterCredentials } from "@kiero/providers";
import { base64ToBytes } from "@kiero/media-worker/wav";
import {
  VisionExtractionOutput,
  validateImageRegion,
} from "@kiero/agent";
import { internalAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { sha256HexOfBytes } from "../audio/segmentation";
import {
  JOIN_VISION_STEP_KIND,
  recordJoinStep,
  visionUnavailableArmed,
} from "./journal";

/** The Polish vision instruction (part of the pipeline version). */
export const VISION_INSTRUCTION = [
  "Odczytaj z tego zdjęcia wszystkie czytelne informacje budowlane: kwoty, wymiary,",
  "daty, nazwy, numery i krótkie opisy. Dla każdej informacji podaj dokładny prostokątny",
  "obszar zdjęcia (piksele, współrzędne lewego górnego rogu), z którego ją odczytano.",
  "Nie wymyślaj danych: zwróć wyłącznie to, co rzeczywiście widać.",
].join(" ");

/** One vision pass's serializable outcome (decoded journal args shape). */
export interface VisionPassOutcome {
  readonly kind: "complete" | "already_complete" | "failed";
  readonly observations?:
    | readonly {
        readonly text: string;
        readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
      }[]
    | undefined;
  readonly readConfidence?: number | undefined;
  readonly servedModels?: readonly string[] | undefined;
  readonly errorKind?: string | undefined;
  readonly providerAttempts?:
    | readonly {
        readonly model: string;
        readonly outcome: "succeeded" | "failed" | "timeout" | "unknown";
        readonly errorKind?: string | undefined;
        readonly startedAtMs: number;
        readonly finishedAtMs: number;
      }[]
    | undefined;
}

const visionOutcomeSchema = Schema.Struct({
  kind: Schema.Literals(["complete", "already_complete", "failed"]),
  observations: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        text: Schema.String,
        region: Schema.Struct({
          x: Schema.Number,
          y: Schema.Number,
          width: Schema.Number,
          height: Schema.Number,
        }),
      }),
    ),
  ),
  readConfidence: Schema.optionalKey(Schema.Number),
  servedModels: Schema.optionalKey(Schema.Array(Schema.String)),
  errorKind: Schema.optionalKey(Schema.String),
  providerAttempts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        model: Schema.String,
        outcome: Schema.Literals(["succeeded", "failed", "timeout", "unknown"]),
        errorKind: Schema.optionalKey(Schema.String),
        startedAtMs: Schema.Number,
        finishedAtMs: Schema.Number,
      }),
    ),
  ),
});

/** Reads the OpenRouter key (presence only, never the value). */
function openRouterCredentials(): OpenRouterCredentials | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return null;
  }
  return { apiKey };
}

/** The supported vision mime types of E2's inline image content parts. */
type VisionMime = "image/png" | "image/jpeg" | "image/webp";

function visionMimeOf(mimeType: string | undefined): VisionMime | null {
  if (mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp") {
    return mimeType;
  }
  return null;
}

/**
 * Resolves one representation's bytes through the order's channel. The
 * production channel asks the configured media executor for an image read
 * (`op: "image"`, the named prerequisite extension); its closed protocol
 * refuses unknown ops today, which maps to the typed resumable refusal.
 */
async function resolveImageBytes(
  channel: "media_worker" | "proof_inline",
  objectKey: string,
  proofImageBase64: string | undefined,
  proofBytesSha256: string | undefined,
  contentHash: string,
): Promise<{ ok: true; base64: string; mimeType: VisionMime | null } | { ok: false; code: string }> {
  if (channel === "proof_inline") {
    if (proofImageBase64 === undefined || proofBytesSha256 === undefined) {
      return { ok: false, code: "proof_stash_missing" };
    }
    const sha = await sha256HexOfBytes(base64ToBytes(proofImageBase64));
    // The ledger records contentHash in its prefixed form (`sha256:<hex>`).
    const recordedHash = contentHash.replace(/^sha256:/, "");
    if (sha !== proofBytesSha256 || sha !== recordedHash) {
      return { ok: false, code: "proof_stash_hash_mismatch" };
    }
    return { ok: true, base64: proofImageBase64, mimeType: null };
  }
  const base = process.env.KIERO_MEDIA_WORKER_URL;
  const token = process.env.KIERO_MEDIA_WORKER_TOKEN;
  if (base === undefined || base === "" || token === undefined || token === "") {
    return { ok: false, code: "image_read_channel_not_configured" };
  }
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}/image`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "image", objectKey }),
    });
  } catch {
    return { ok: false, code: "image_read_channel_unreachable" };
  }
  if (!response.ok) {
    return { ok: false, code: `image_read_channel_refused:${response.status}` };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "image_read_channel_malformed_response" };
  }
  const imageBase64 = (body as { imageBase64?: unknown }).imageBase64;
  const mimeType = (body as { mimeType?: unknown }).mimeType;
  if (typeof imageBase64 !== "string" || typeof mimeType !== "string") {
    return { ok: false, code: "image_read_channel_malformed_response" };
  }
  return { ok: true, base64: imageBase64, mimeType: visionMimeOf(mimeType) };
}

/** Everything one vision pass needs, through one internal query. */
export const visionWork = internalQuery({
  args: { orderId: v.id("visionOrders") },
  handler: async (ctx, args) => {
    const order = await ctx.db.get(args.orderId);
    if (order === null) {
      return { order: null } as const;
    }
    const representation = await ctx.db.get(order.representationId);
    const armed = await visionUnavailableArmed(ctx.db, order.processingRunId);
    return {
      order,
      ...(representation === null ? {} : { representation }),
      ...(armed ? { visionUnavailableArmed: true as const } : {}),
    } as const;
  },
});

/** The bounded provider pass for one vision order (ACTION: external). */
export const attemptVisionExtraction = internalAction({
  args: { orderId: v.id("visionOrders") },
  handler: async (ctx, args): Promise<VisionPassOutcome> => {
    const work = await ctx.runQuery(internal.processing.multimodal.vision.visionWork, {
      orderId: args.orderId,
    });
    const order = work.order;
    if (order === null) {
      return { kind: "failed", errorKind: "vision_order_row_missing" };
    }
    if (order.state === "complete" || order.state === "failed") {
      return { kind: "already_complete" };
    }
    // The deterministic fixture: both vision routes forced unavailable.
    if (work.visionUnavailableArmed === true) {
      return { kind: "failed", errorKind: "vision_route_unavailable_armed" };
    }
    const representation = work.representation;
    if (representation === undefined) {
      return { kind: "failed", errorKind: "representation_row_missing" };
    }
    const bytes = await resolveImageBytes(
      order.bytesChannel,
      representation.objectKey,
      order.proofImageBase64,
      order.proofBytesSha256,
      representation.contentHash,
    );
    if (!bytes.ok) {
      return { kind: "failed", errorKind: bytes.code };
    }
    const mimeType = bytes.mimeType ?? visionMimeOf(representation.mimeType);
    if (mimeType === null) {
      return { kind: "failed", errorKind: "image_mime_type_unsupported" };
    }
    const credentials = openRouterCredentials();
    if (credentials === null) {
      return { kind: "failed", errorKind: "provider_key_not_configured" };
    }
    const call = await runVisionExtraction(credentials, {
      images: [{ base64: bytes.base64, mimeType }],
      instruction: VISION_INSTRUCTION,
      outputSchema: VisionExtractionOutput,
    });
    const providerAttempts = call.record.attempts.map((attempt) => ({
      model: attempt.requestedModel,
      outcome:
        attempt.outcome === "succeeded"
          ? ("succeeded" as const)
          : attempt.failureKind === "deadline_exceeded" || attempt.failureKind === "connection_failed"
            ? ("unknown" as const)
            : ("failed" as const),
      ...(attempt.failureKind === undefined ? {} : { errorKind: attempt.failureKind }),
      startedAtMs: attempt.startedAtMs,
      finishedAtMs: attempt.finishedAtMs,
    }));
    if (call.outcome.outcome === "failed") {
      // Both image routes failed: pending, resumable — never fake-complete.
      return {
        kind: "failed",
        errorKind: `vision_routes_failed:${call.outcome.failure.kind}`,
        providerAttempts,
      };
    }
    const value = call.outcome.value;
    if (!("readConfidence" in value) || !("observations" in value)) {
      return { kind: "failed", errorKind: "vision_tool_turn_unexpected", providerAttempts };
    }
    return {
      kind: "complete",
      observations: value.observations.map((observation) => ({
        text: observation.text,
        region: observation.region,
      })),
      readConfidence: value.readConfidence,
      servedModels: call.record.attempts
        .filter((attempt) => attempt.outcome === "succeeded")
        .map((attempt) => attempt.requestedModel),
      providerAttempts,
    };
  },
});

/** The idempotent outcome checkpoint mutation. */
export const recordVisionOutcome = internalMutation({
  args: { orderId: v.id("visionOrders"), outcome: v.any(), stepSequence: v.float64() },
  handler: async (ctx, args) =>
    recordVisionOutcomeTransaction(ctx, {
      orderId: args.orderId,
      outcome: args.outcome,
      stepSequence: args.stepSequence,
    }),
});

/** The outcome checkpoint transaction (idempotent; testable). */
export async function recordVisionOutcomeTransaction(
  ctx: MutationCtx,
  params: { orderId: Id<"visionOrders">; outcome: unknown; stepSequence: number },
): Promise<{ ok: boolean; state?: string | undefined; extractionId?: string | undefined }> {
  const outcome: VisionPassOutcome = Schema.decodeUnknownSync(visionOutcomeSchema)(params.outcome);
  const order = await ctx.db.get(params.orderId);
  if (order === null) {
    return { ok: false };
  }
  if (order.state === "complete" || outcome.kind === "already_complete") {
    return { ok: true, state: order.state, extractionId: order.extractionId };
  }
  const nowMs = Date.now();
  if (outcome.kind === "failed") {
    // Honest pending with the sanitized reason (resumable; D6's pattern).
    await ctx.db.patch(order._id, {
      state: "pending",
      ...(outcome.errorKind === undefined ? {} : { lastErrorKind: outcome.errorKind }),
      updatedAtMs: nowMs,
    });
    await recordVisionAttempts(ctx, order, params.stepSequence, outcome);
    await recordJoinStep(ctx.db, order.processingRunId, params.stepSequence, JOIN_VISION_STEP_KIND, {
      state: "failed",
      output: { orderId: order._id, error: outcome.errorKind ?? "vision_failed" },
    });
    return { ok: true, state: "pending" };
  }

  // Complete: validate every region against the representation's own
  // dimensions (the coordinate-space authority) BEFORE minting anything.
  const representation = await ctx.db.get(order.representationId);
  if (representation === null) {
    await ctx.db.patch(order._id, {
      state: "pending",
      lastErrorKind: "representation_row_missing",
      updatedAtMs: nowMs,
    });
    return { ok: true, state: "pending" };
  }
  const observations = outcome.observations ?? [];
  for (const observation of observations) {
    const check = validateImageRegion(observation.region, {
      width: representation.width ?? 0,
      height: representation.height ?? 0,
    });
    if (!check.valid) {
      // Fail-closed typed refusal: an invalid region never becomes an anchor.
      await ctx.db.patch(order._id, {
        state: "pending",
        lastErrorKind: `image_region_invalid:${check.reason}`,
        updatedAtMs: nowMs,
      });
      await recordJoinStep(ctx.db, order.processingRunId, params.stepSequence, JOIN_VISION_STEP_KIND, {
        state: "failed",
        output: { orderId: order._id, error: `image_region_invalid:${check.reason}` },
      });
      return { ok: true, state: "pending" };
    }
  }

  // The immutable extraction version (idempotent: one per order).
  const extractionId = await ctx.db.insert("extractions", {
    sourceId: order.sourceId,
    representationId: order.representationId,
    kind: "vision",
    pipelineVersion: order.pipelineVersion,
    model: (outcome.servedModels ?? []).join("|") || "unknown",
    provider: "openrouter",
    ...(outcome.readConfidence === undefined ? {} : { confidence: outcome.readConfidence }),
    processingRunId: order.processingRunId,
    createdAtMs: nowMs,
  });
  for (const observation of observations) {
    await ctx.db.insert("sourceFragments", {
      extractionId,
      sourceId: order.sourceId,
      anchor: { _tag: "image_region", ...observation.region },
      createdAtMs: nowMs,
    });
  }
  await ctx.db.patch(order._id, {
    state: "complete",
    extractionId,
    lastErrorKind: undefined,
    observationsJson: JSON.stringify(observations),
    finishedAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await recordVisionAttempts(ctx, order, params.stepSequence, outcome);
  await recordJoinStep(ctx.db, order.processingRunId, params.stepSequence, JOIN_VISION_STEP_KIND, {
    state: "succeeded",
    output: {
      orderId: order._id,
      extractionId,
      observations: observations.length,
      representationId: order.representationId,
    },
  });
  return { ok: true, state: "complete", extractionId };
}

/** One processingAttempts row per provider attempt of this pass. */
async function recordVisionAttempts(
  ctx: MutationCtx,
  order: Doc<"visionOrders">,
  stepSequence: number,
  outcome: VisionPassOutcome,
): Promise<void> {
  const attempts = outcome.providerAttempts ?? [];
  if (attempts.length === 0) {
    return;
  }
  const existingStep = await ctx.db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) =>
      q.eq("runId", order.processingRunId).eq("sequence", stepSequence),
    )
    .collect();
  const ours = existingStep.find((row) => row.stepKind === JOIN_VISION_STEP_KIND);
  const stepId =
    ours?._id ??
    (await ctx.db.insert("processingSteps", {
      runId: order.processingRunId,
      stepKind: JOIN_VISION_STEP_KIND,
      sequence: stepSequence,
      state: "running",
      startedAtMs: Date.now(),
    }));
  const existingAttempts = await ctx.db
    .query("processingAttempts")
    .withIndex("by_step_attempt", (q) => q.eq("stepId", stepId))
    .collect();
  let attemptNo = existingAttempts.length;
  for (const attempt of attempts) {
    attemptNo += 1;
    await ctx.db.insert("processingAttempts", {
      stepId: stepId as Id<"processingSteps">,
      attempt: attemptNo,
      outcome: attempt.outcome,
      provider: "openrouter",
      model: attempt.model,
      ...(attempt.errorKind === undefined ? {} : { errorKind: attempt.errorKind }),
      startedAtMs: attempt.startedAtMs,
      finishedAtMs: attempt.finishedAtMs,
    });
  }
}
