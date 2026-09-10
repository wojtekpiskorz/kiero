/**
 * The STT order transaction (D6): one resumable transcript order over one
 * accepted audio attachment, registered through the checked durable path.
 *
 * What this transaction proves structurally (same pattern as D1's
 * acceptance): every step that can throw resolves BEFORE the first insert —
 * executor lookup and input decode templates first, then validation reads,
 * then the atomic commit of the order row plus the durable
 * `processing.transcribe_segment` registration. An abort at any point
 * leaves no order orphan and no orphan work.
 *
 * Semantics:
 * - One order = one future immutable extraction VERSION over the
 *   attachment. Ordering again with the SAME segmentation config replays
 *   the SAME order (idempotent, and for a definite-failed job the
 *   registration re-queues it — the sanctioned resume). A DIFFERENT config
 *   creates a NEW order; completed versions are never touched.
 * - No new source message is ever created (CONTEXT.md "Wiadomość
 *   źródłowa"): the order references the accepted attachment and its
 *   verified representation.
 * - The proof byte channel is accepted only on probe-guarded deployments
 *   and only with bytes that match the uploaded object's recorded length.
 */

import { Schema } from "effect";
import {
  DurableJobKeySchema,
  errorResult,
  executors,
  newDurableJobKey,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { forbiddenError, unavailableError, validationError, type RequestContext } from "@kiero/runtime";
import { ROUTING_CONFIG_VERSION } from "@kiero/providers";
import { parseWav, base64ToBytes } from "@kiero/media-worker/wav";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { registerDurableJob } from "../../platform/publish";
import {
  DEFAULT_SEGMENTATION_CONFIG,
  canonicalConfig,
  sha256HexOfBytes,
  type SegmentationConfig,
} from "./segmentation";

/** D6 pipeline version of this order shape (bump = new orders, new version). */
export const D6_PIPELINE_VERSION = "d6.stt/1";

/** Bounded retry policy of one transcript order across resumes. */
export const TRANSCRIPT_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

/** The guarded proof stash stays far below the Convex document bound. */
export const MAX_PROOF_STASH_BYTES = 600_000;

/** The input of the order entry (E3 passes it; the probe forwards it). */
export interface OrderTranscriptInput {
  readonly attachmentId: string;
  /** Overrides the segmentation target (ms); dev proofs segment tiny clips. */
  readonly targetSegmentMs?: number | undefined;
  readonly bytesChannel: "media_worker" | "proof_inline";
  /** proof_inline only: the SAME bytes the caller uploaded through D2. */
  readonly proofAudioBase64?: string | undefined;
}

/** The saved order receipt. */
export interface OrderTranscriptReceipt {
  readonly transcriptId: string;
  readonly state: "planning" | "pending" | "partial" | "complete" | "failed";
  readonly segmentCount: number;
  readonly resumed: boolean;
}

/** Whether this deployment allows the guarded proof byte channel. */
export function proofChannelAllowed(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

/** Re-decodes a stored job key through the branded schema (no casts). */
function redecodeJobKey(value: string): ReturnType<typeof newDurableJobKey> {
  return Schema.decodeUnknownSync(DurableJobKeySchema)(value);
}

/** Resolves the segmentation config of one order input. */
export function configOf(input: OrderTranscriptInput): SegmentationConfig {
  const target =
    input.targetSegmentMs !== undefined && input.targetSegmentMs > 0
      ? input.targetSegmentMs
      : DEFAULT_SEGMENTATION_CONFIG.targetSegmentMs;
  return { ...DEFAULT_SEGMENTATION_CONFIG, targetSegmentMs: target };
}

// ---------------------------------------------------------------------------
// Pre-insert registration targets (the atomicity discipline of acceptance).
// ---------------------------------------------------------------------------

/** Decode template id: proves the executor input accepts produced shapes. */
const REGISTRATION_TEMPLATE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";

/**
 * Resolves everything that can throw during registration BEFORE the first
 * insert: the composed executor for `processing.transcribe_segment` and a
 * decode template of its input schema against a transaction-produced shape.
 */
export function registrationTargets():
  | { ok: true }
  | { ok: false; error: ReturnType<typeof unavailableError> } {
  const executor = executors.find(
    (candidate) => candidate.jobKind === "processing.transcribe_segment",
  );
  if (executor === undefined) {
    return { ok: false, error: unavailableError(true, "transcribe_executor_missing") };
  }
  const decoded = Schema.decodeUnknownOption(executor.input)({
    transcriptId: REGISTRATION_TEMPLATE_ID,
  });
  if (decoded._tag === "None") {
    return { ok: false, error: unavailableError(true, "transcribe_executor_input_drift") };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The order transaction.
// ---------------------------------------------------------------------------

/** Runs the whole order inside the caller's mutation transaction. */
export async function orderAudioTranscript(
  tx: MutationCtx,
  context: RequestContext,
  input: OrderTranscriptInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }

  // --- attachment reference checks (tenant + audio + accepted binding) -----
  const attachmentId = tx.db.normalizeId("attachments", input.attachmentId);
  if (attachmentId === null) {
    return errorResult(validationError("attachment_reference_not_found"));
  }
  const attachment = await tx.db.get(attachmentId);
  if (attachment === null) {
    return errorResult(validationError("attachment_reference_not_found"));
  }
  const upload = await tx.db.get(attachment.uploadId);
  if (upload === null || upload.companyId !== companyId) {
    // Tenant isolation rides the ledger row that owns the attachment.
    return errorResult(forbiddenError("tenant_scope_mismatch", "attachments"));
  }
  if (attachment.kind !== "audio") {
    return errorResult(validationError("attachment_not_audio"));
  }
  if (attachment.sourceId === undefined) {
    // Not bound by acceptance: no accepted source, no transcript order.
    return errorResult(validationError("attachment_not_bound_to_source"));
  }
  const source = await tx.db.get(attachment.sourceId);
  if (source === null || source.lifecycle !== "active") {
    return errorResult(validationError("source_not_active"));
  }

  // --- the verified representation whose bytes get segmented ---------------
  const representations = await tx.db
    .query("mediaRepresentations")
    .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachmentId))
    .collect();
  const retained = representations.find(
    (row) => row.role === "retained" && row.verifiedAtMs !== undefined,
  );
  const received = representations.find(
    (row) => row.role === "received" && row.verifiedAtMs !== undefined,
  );
  const representation = retained ?? received;
  if (representation === undefined) {
    return errorResult(validationError("attachment_representation_unverified"));
  }

  // --- the source's initial analysis run (the extraction version anchor) ---
  const runs = await tx.db
    .query("processingRuns")
    .withIndex("by_source_started", (q) => q.eq("sourceId", attachment.sourceId as Id<"sources">))
    .collect();
  const run = runs.slice().sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
  if (run === undefined) {
    return errorResult(validationError("processing_run_missing"));
  }

  // --- replay/resume decision over the attachment's orders -----------------
  const config = configOf(input);
  const existingOrders = await tx.db
    .query("audioTranscripts")
    .withIndex("by_attachment", (q) => q.eq("attachmentId", attachmentId))
    .collect();
  const sameConfig = existingOrders.find(
    (order) =>
      order.segmentationConfigJson === canonicalConfig(config) &&
      order.bytesChannel === input.bytesChannel,
  );
  if (sameConfig !== undefined) {
    // Idempotent replay: the SAME order (its pinned proof stash, if any,
    // already lives on the row — a resume never re-supplies bytes). If its
    // job definitely failed, the registration re-queues it (the sanctioned
    // bounded resume); succeeded/active rows skip.
    await registerDurableJob(tx, {
      kind: "processing.transcribe_segment",
      input: { transcriptId: sameConfig._id },
      companyId: context.actor.companyId,
      sourceId: attachment.sourceId,
      processingRunId: run._id,
      policy: TRANSCRIPT_RETRY_POLICY,
      ...(sameConfig.jobKey === undefined ? {} : { jobKey: redecodeJobKey(sameConfig.jobKey) }),
      dedupKey: `processing.transcribe_segment:${sameConfig._id}`,
    });
    return okResult({
      transcriptId: sameConfig._id,
      state: sameConfig.state,
      segmentCount: sameConfig.segmentCount,
      resumed: true,
    } satisfies OrderTranscriptReceipt);
  }
  // --- the proof byte channel: guarded, pinned to the uploaded object ------
  let proofAudioBase64: string | undefined;
  let proofBytesSha256: string | undefined;
  if (input.bytesChannel === "proof_inline") {
    if (!proofChannelAllowed()) {
      return errorResult(forbiddenError("proof_channel_not_allowed", "audioTranscripts"));
    }
    if (typeof input.proofAudioBase64 !== "string" || input.proofAudioBase64.length === 0) {
      return errorResult(validationError("proof_bytes_missing"));
    }
    const bytes = base64ToBytes(input.proofAudioBase64);
    if (bytes.length > MAX_PROOF_STASH_BYTES) {
      return errorResult(validationError("proof_bytes_too_large"));
    }
    if (parseWav(bytes).ok !== true) {
      return errorResult(validationError("proof_bytes_not_pcm_wav"));
    }
    if (attachment.receivedBytes !== undefined && attachment.receivedBytes !== bytes.length) {
      // The stash must be EXACTLY the object the gateway verified in R2.
      return errorResult(validationError("proof_bytes_length_mismatch"));
    }
    proofAudioBase64 = input.proofAudioBase64;
    proofBytesSha256 = await sha256HexOfBytes(bytes);
  }

  // --- pre-flight: every throwing step resolves BEFORE the first insert ----
  const targets = registrationTargets();
  if (!targets.ok) {
    return errorResult(targets.error);
  }

  // --- the atomic commit: order row + durable registration -----------------
  const jobKey = newDurableJobKey();
  const transcriptId = await tx.db.insert("audioTranscripts", {
    companyId,
    sourceId: attachment.sourceId,
    attachmentId,
    representationId: representation._id,
    processingRunId: run._id,
    pipelineVersion: D6_PIPELINE_VERSION,
    sttRoutingVersion: ROUTING_CONFIG_VERSION,
    segmentationConfigJson: canonicalConfig(config),
    bytesChannel: input.bytesChannel,
    segmentCount: 0,
    state: "planning",
    jobKey,
    ...(proofAudioBase64 === undefined ? {} : { proofAudioBase64 }),
    ...(proofBytesSha256 === undefined ? {} : { proofBytesSha256 }),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  await registerDurableJob(tx, {
    kind: "processing.transcribe_segment",
    input: { transcriptId },
    companyId: context.actor.companyId,
    sourceId: attachment.sourceId,
    processingRunId: run._id,
    policy: TRANSCRIPT_RETRY_POLICY,
    jobKey,
    dedupKey: `processing.transcribe_segment:${transcriptId}`,
  });
  return okResult({
    transcriptId,
    state: "planning",
    segmentCount: 0,
    resumed: false,
  } satisfies OrderTranscriptReceipt);
}
