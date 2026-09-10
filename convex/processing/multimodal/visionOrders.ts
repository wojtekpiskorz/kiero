/**
 * The vision-extraction order transaction (E4): one order over one VERIFIED
 * retained representation, the vision counterpart of D6's STT orders.
 *
 * Semantics:
 * - One order = one future immutable vision extraction VERSION over the
 *   EXACT retained representation (the deterministic selection). A
 *   re-normalization is a NEW representation, so it gets a NEW order —
 *   historical anchors never move (the acceptance criterion "a newer
 *   extraction creates linked reanalysis and cannot silently move
 *   coordinates beneath historical findings" holds structurally: fragments
 *   pin extractionId, extractions pin representationId).
 * - Ordering again over the SAME representation replays the SAME order
 *   (idempotent); a definitely-failed order may be resumed by re-running
 *   this entry (the sanctioned bounded resume).
 * - The proof byte channel is accepted only on probe-guarded deployments
 *   and only with bytes whose sha-256 equals the retained representation's
 *   `contentHash` (a STRONGER pin than D6's length pin: the stash can only
 *   replay bytes that are durably the retained object).
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, validationError, type RequestContext } from "@kiero/runtime";
import { ROUTING_CONFIG_VERSION } from "@kiero/providers";
import { base64ToBytes } from "@kiero/media-worker/wav";
import { VISION_EXTRACTION_PIPELINE_VERSION } from "@kiero/agent";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { sha256HexOfBytes } from "../audio/segmentation";
import { decideRetainedSelection, toRepresentationView } from "../images/protocol";
import { initialAnalysisRun } from "./journal";

/** The vision order receipt. */
export interface VisionOrderReceipt {
  readonly orderId: string;
  readonly state: "pending" | "complete" | "failed";
  readonly resumed: boolean;
}

/** Whether this deployment allows the guarded proof byte channel. */
export function proofChannelAllowed(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

/** The input of one vision order. */
export interface OrderVisionInput {
  readonly attachmentId: string;
  readonly bytesChannel: "media_worker" | "proof_inline";
  /** proof_inline only: bytes whose sha-256 equals the retained contentHash. */
  readonly proofImageBase64?: string | undefined;
}

/** Runs one vision order inside the caller's mutation transaction. */
export async function orderVisionExtraction(
  tx: MutationCtx,
  context: RequestContext,
  input: OrderVisionInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
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
    return errorResult(forbiddenError("tenant_scope_mismatch", "attachments"));
  }
  if (attachment.kind !== "image") {
    return errorResult(validationError("attachment_not_image"));
  }
  if (attachment.sourceId === undefined) {
    return errorResult(validationError("attachment_not_bound_to_source"));
  }
  const source = await tx.db.get(attachment.sourceId);
  if (source === null || source.lifecycle !== "active") {
    return errorResult(validationError("source_not_active"));
  }

  // The deterministic retained selection defines the inspectable
  // representation (its width/height are the anchor coordinate space).
  const representations = await tx.db
    .query("mediaRepresentations")
    .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachmentId))
    .collect();
  const selection = decideRetainedSelection(
    representations.map((row) => toRepresentationView(row)),
  );
  if (selection === undefined || selection === null) {
    return errorResult(validationError("retained_representation_not_verified"));
  }
  const representationId = tx.db.normalizeId(
    "mediaRepresentations",
    selection._id,
  ) as Id<"mediaRepresentations"> | null;
  if (representationId === null) {
    return errorResult(validationError("retained_representation_not_verified"));
  }
  const representation = await tx.db.get(representationId);
  if (representation === null) {
    return errorResult(validationError("retained_representation_not_verified"));
  }

  // The run whose journal the join's vision steps anchor to (the source's
  // initial analysis run, D6's anchoring rule).
  const runId = await initialAnalysisRun(tx.db, attachment.sourceId as Id<"sources">);
  if (runId === null) {
    return errorResult(validationError("processing_run_missing"));
  }

  // Replay/resume over the SAME representation + channel.
  const existingOrders = await tx.db
    .query("visionOrders")
    .withIndex("by_representation", (q) => q.eq("representationId", representationId))
    .collect();
  const sameChannel = existingOrders.find((order) => order.bytesChannel === input.bytesChannel);
  if (sameChannel !== undefined) {
    return okResult({
      orderId: sameChannel._id,
      state: sameChannel.state,
      resumed: true,
    } satisfies VisionOrderReceipt);
  }

  // The guarded proof channel: sha-pinned to the retained content hash.
  // (The ledger records the hash in its prefixed form `sha256:<hex>` —
  // convex/processing/images/ledger.ts — so the pin compares against the
  // bare hex after stripping the prefix.)
  let proofImageBase64: string | undefined;
  let proofBytesSha256: string | undefined;
  if (input.bytesChannel === "proof_inline") {
    if (!proofChannelAllowed()) {
      return errorResult(forbiddenError("proof_channel_not_allowed", "visionOrders"));
    }
    if (typeof input.proofImageBase64 !== "string" || input.proofImageBase64.length === 0) {
      return errorResult(validationError("proof_bytes_missing"));
    }
    const bytes = base64ToBytes(input.proofImageBase64);
    const sha = await sha256HexOfBytes(bytes);
    const recordedHash = representation.contentHash.replace(/^sha256:/, "");
    if (recordedHash !== sha) {
      return errorResult(validationError("proof_bytes_hash_mismatch"));
    }
    proofImageBase64 = input.proofImageBase64;
    proofBytesSha256 = sha;
  }

  const decoded = Schema.decodeUnknownOption(
    Schema.Struct({ sourceId: Schema.String }),
  )({ sourceId: attachment.sourceId });
  if (decoded._tag === "None") {
    return errorResult(validationError("vision_order_input_drift"));
  }

  const orderId = await tx.db.insert("visionOrders", {
    companyId,
    sourceId: attachment.sourceId,
    attachmentId,
    representationId,
    processingRunId: runId,
    pipelineVersion: VISION_EXTRACTION_PIPELINE_VERSION,
    visionRoutingVersion: ROUTING_CONFIG_VERSION,
    bytesChannel: input.bytesChannel,
    state: "pending",
    ...(proofImageBase64 === undefined ? {} : { proofImageBase64 }),
    ...(proofBytesSha256 === undefined ? {} : { proofBytesSha256 }),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  });
  return okResult({
    orderId,
    state: "pending",
    resumed: false,
  } satisfies VisionOrderReceipt);
}
