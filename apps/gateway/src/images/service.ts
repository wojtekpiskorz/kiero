/**
 * The images executor service (D5): drives ONE durable normalization job
 * from its current retention state to a terminal state, idempotently and
 * resumably.
 *
 * Every attachment's next step comes from the PURE state machine in
 * convex/processing/images/protocol.ts (the same function the Convex
 * reconcile step runs), so a drive interrupted anywhere — after the R2
 * write but before record, after record but before verify, after verify
 * but before the received-byte cleanup — resumes by doing exactly the
 * missing step, never by discarding a readable copy:
 *
 * 1. `prepare` (Convex txn) hands over the plan and marks in-progress rows;
 * 2. normalize reads the received object, decides (oversized / unsupported
 *    / normalize) with the pure decision, runs the selected normalizer,
 *    checks the conversion quality, writes the retained + thumbnail
 *    objects and proves them durable (head + full re-read hash);
 * 3. `record` writes the unverified rows — or the explicit retained-
 *    original exception row, WITHOUT reading oversized inputs at all;
 * 4. `verify` stamps verifiedAtMs on the cross-checked evidence and
 *    publishes `sources.representationRetained`;
 * 5. ONLY THEN the received bytes are deleted and `cleanup` marks the row.
 *
 * The crash-window proof hook (`crashAfter`) stops the drive at a named
 * boundary by throwing — the Worker answers non-JSON, the Convex action
 * records the UNCERTAIN outcome, and reconciliation owns the resumption.
 */

import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unavailableError } from "@kiero/runtime";
import type { BridgeEnv } from "../platform/bridge";
import { imagesStep } from "./bridge";
import { resolveNormalizer, type NormalizerEnv, type PhotoNormalizer } from "./normalizer";
import { deleteObject, objectAbsent, putObject, readAll, readHead, sha256Hex, verifyObject } from "./r2";
import {
  MAX_INPUT_BYTES,
  RETAINED_MAX_EDGE,
  RETAINED_QUALITY,
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_QUALITY,
  decideConversionQuality,
  decideNormalization,
  sniffImageFormat,
  type RecordOutcome,
  type SniffedFormat,
  type VerifyEvidence,
} from "../../../../convex/processing/images/protocol";

/** The env the images lane consumes overall (bridge + bucket + normalizer). */
export type ImagesEnv = BridgeEnv & NormalizerEnv & { readonly MEDIA_BUCKET: R2Bucket };

/** Where the crash-window proof stops the drive. */
export type CrashAfter = "record" | "verify";

/** One attachment's plan as the prepare step returns it. */
interface AttachmentPlan {
  readonly attachmentId: string;
  readonly state: string;
  readonly step: string;
  readonly receivedObjectKey: string;
  readonly receivedBytes: number;
  readonly receivedContentHash: string;
  readonly retainedObjectKey: string;
  readonly thumbnailObjectKey: string;
}

/** The recorded fields of one derived output. */
interface DerivedOutput {
  readonly objectKey: string;
  readonly bytes: number;
  readonly contentHash: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType: string;
}

/** One attachment's typed outcome in the drive's result. */
type AttachmentOutcome = {
  readonly attachmentId: string;
  readonly state: string;
  readonly outcome:
    | "normalized"
    | "oversized_input"
    | "unsupported_input"
    | "conversion_failed"
    | "quality_unresolved"
    | "already_terminal";
};

function valueOf(envelope: ResultEnvelope): Record<string, unknown> | null {
  return envelope._tag === "ok" ? (envelope.value as Record<string, unknown>) : null;
}

/** Durability evidence of one already-written object (head + full re-read). */
async function evidenceOf(
  env: ImagesEnv,
  objectKey: string,
): Promise<VerifyEvidence | null> {
  const reread = await readAll(env.MEDIA_BUCKET, objectKey);
  if (reread === null) {
    return null;
  }
  return {
    objectKey,
    contentHash: reread.sha256Hex,
    bytes: reread.bytes.length,
  };
}

/** Encodes one derived kind through the selected normalizer. */
async function encode(
  normalizer: PhotoNormalizer,
  kind: "retained" | "thumbnail",
  bytes: Uint8Array,
): Promise<{ bytes: Uint8Array; width: number; height: number; mimeType: string }> {
  return normalizer.normalize({
    kind,
    bytes,
    maxEdge: kind === "retained" ? RETAINED_MAX_EDGE : THUMBNAIL_MAX_EDGE,
    quality: kind === "retained" ? RETAINED_QUALITY : THUMBNAIL_QUALITY,
  });
}

/** Writes one derived object and proves it durable and readable. */
async function writeAndProve(
  env: ImagesEnv,
  objectKey: string,
  output: { bytes: Uint8Array; width: number; height: number; mimeType: string },
): Promise<DerivedOutput | null> {
  const hash = await sha256Hex(output.bytes);
  await putObject(env.MEDIA_BUCKET, objectKey, output.bytes, output.mimeType);
  const verified = await verifyObject(env.MEDIA_BUCKET, objectKey, hash, output.bytes.length);
  if (!verified.ok) {
    return null;
  }
  return {
    objectKey,
    bytes: verified.evidence.bytes,
    contentHash: verified.evidence.contentHash,
    width: output.width,
    height: output.height,
    mimeType: output.mimeType,
  };
}

/**
 * Runs the whole normalization of one attachment: decide (pure), encode,
 * write, prove. Oversized and unsupported inputs are decided WITHOUT a
 * full read (a ranged head sniff decides formats). Conversion failures and
 * unresolved quality are typed exceptions that keep the original.
 */
async function normalizeAttachment(
  env: ImagesEnv,
  normalizer: PhotoNormalizer,
  plan: AttachmentPlan,
): Promise<{ ok: true; outcome: RecordOutcome } | { ok: false; error: ResultEnvelope }> {
  if (plan.receivedBytes > MAX_INPUT_BYTES) {
    return { ok: true, outcome: { _tag: "exception", exceptionKind: "oversized_input" } };
  }
  const head = await readHead(env.MEDIA_BUCKET, plan.receivedObjectKey, 64);
  if (head === null) {
    return { ok: false, error: errorResult(unavailableError(true, "received_object_missing")) };
  }
  const decision = decideNormalization({
    bytes: plan.receivedBytes,
    sniffedFormat: sniffImageFormat(head),
    supportedFormats: normalizer.supportedFormats as readonly SniffedFormat[],
  });
  if (decision.decision === "retain_original") {
    return { ok: true, outcome: { _tag: "exception", exceptionKind: decision.exceptionKind } };
  }
  const input = await readAll(env.MEDIA_BUCKET, plan.receivedObjectKey);
  if (input === null) {
    return { ok: false, error: errorResult(unavailableError(true, "received_object_missing")) };
  }
  let retainedOutput: Awaited<ReturnType<typeof encode>>;
  let thumbnailOutput: Awaited<ReturnType<typeof encode>>;
  try {
    retainedOutput = await encode(normalizer, "retained", input.bytes);
    thumbnailOutput = await encode(normalizer, "thumbnail", input.bytes);
  } catch {
    // The executor failed to decode or encode: a typed conversion failure
    // keeps the received original as the inspectable exception.
    return { ok: true, outcome: { _tag: "exception", exceptionKind: "conversion_failed" } };
  }
  const quality = decideConversionQuality({
    inputBytes: input.bytes.length,
    outputBytes: retainedOutput.bytes.length,
    outputWidth: retainedOutput.width,
    outputHeight: retainedOutput.height,
    plannedMaxEdge: RETAINED_MAX_EDGE,
  });
  if (!quality.resolved) {
    return { ok: true, outcome: { _tag: "exception", exceptionKind: "quality_unresolved" } };
  }
  const retained = await writeAndProve(env, plan.retainedObjectKey, retainedOutput);
  const thumbnail = await writeAndProve(env, plan.thumbnailObjectKey, thumbnailOutput);
  if (retained === null || thumbnail === null) {
    return {
      ok: false,
      error: errorResult(unavailableError(true, "derived_object_not_durable")),
    };
  }
  return { ok: true, outcome: { _tag: "normalized", retained, thumbnail } };
}

/** Records one attachment's typed outcome (idempotent). */
async function recordOutcomeStep(
  env: ImagesEnv,
  jobKey: string,
  attachmentId: string,
  outcome: RecordOutcome,
): Promise<ResultEnvelope> {
  return imagesStep(env, "record", jobKey, { attachmentId, outcome });
}

/** Verifies one attachment from R2 evidence, then cleans the received bytes. */
async function verifyAndCleanup(
  env: ImagesEnv,
  jobKey: string,
  plan: AttachmentPlan,
  crashAfter?: CrashAfter,
): Promise<ResultEnvelope> {
  const retainedEvidence = await evidenceOf(env, plan.retainedObjectKey);
  const thumbnailEvidence = await evidenceOf(env, plan.thumbnailObjectKey);
  if (retainedEvidence === null || thumbnailEvidence === null) {
    return errorResult(unavailableError(true, "derived_object_not_durable"));
  }
  const verified = await imagesStep(env, "verify", jobKey, {
    attachmentId: plan.attachmentId,
    retained: retainedEvidence,
    thumbnail: thumbnailEvidence,
  });
  const value = valueOf(verified);
  if (value === null) {
    return verified;
  }
  if (crashAfter === "verify") {
    // The deliberate crash-window: verified durable, received bytes not yet
    // removed — reconciliation must finish without a second conversion.
    throw new Error("images drive: deliberate stop after verify");
  }
  return finishCleanup(env, jobKey, plan, value);
}

/** Deletes the received bytes (when allowed) and marks the row. */
async function finishCleanup(
  env: ImagesEnv,
  jobKey: string,
  plan: AttachmentPlan,
  verifiedValue: Record<string, unknown>,
): Promise<ResultEnvelope> {
  const cleanupKey = verifiedValue.cleanupObjectKey;
  if (typeof cleanupKey === "string" && cleanupKey !== "") {
    await deleteObject(env.MEDIA_BUCKET, cleanupKey);
    const cleaned = await imagesStep(env, "cleanup", jobKey, {
      attachmentId: plan.attachmentId,
    });
    if (cleaned._tag === "error") {
      return cleaned;
    }
  }
  return okResult({ cleaned: typeof cleanupKey === "string" && cleanupKey !== "" });
}

/**
 * Drives one durable normalization job to a terminal state. Honest
 * exceptions are SUCCESS outcomes of the drive (the original was retained
 * — no fake success, no fake failure of the whole job).
 */
export async function driveNormalization(
  env: ImagesEnv,
  jobKey: string,
  crashAfter?: CrashAfter,
): Promise<ResultEnvelope> {
  const resolved = resolveNormalizer(env);
  if (!resolved.ok) {
    return resolved.error;
  }
  const prepared = await imagesStep(env, "prepare", jobKey);
  const plan = valueOf(prepared);
  if (plan === null) {
    return prepared;
  }
  const attachments = (plan.attachments ?? []) as AttachmentPlan[];
  const outcomes: AttachmentOutcome[] = [];
  for (const attachment of attachments) {
    if (attachment.step === "none" || attachment.step === "cleanup") {
      if (attachment.step === "cleanup") {
        // Crash-after-verify resumption INSIDE a later drive: the retained
        // pair is already verified; only the received bytes remain.
        const done = await finishCleanup(
          env,
          jobKey,
          attachment,
          { cleanupObjectKey: attachment.receivedObjectKey },
        );
        if (done._tag === "error") {
          return done;
        }
      }
      outcomes.push({
        attachmentId: attachment.attachmentId,
        state: attachment.step === "cleanup" ? "cleaned" : attachment.state,
        outcome: "already_terminal",
      });
      continue;
    }
    if (attachment.step === "verify") {
      // Recorded rows exist; only verification (and cleanup) remain.
      const evidence = await evidenceOf(env, attachment.retainedObjectKey);
      const thumbEvidence = await evidenceOf(env, attachment.thumbnailObjectKey);
      if (evidence === null || thumbEvidence === null) {
        // Rows without objects (never producible by this drive's order, but
        // a foreign writer or a lost object lands here): re-normalize into
        // the same deterministic keys rather than verifying ghosts.
        const renormalized = await normalizeAttachment(env, resolved.normalizer, attachment);
        if (!renormalized.ok) {
          return renormalized.error;
        }
        const recorded = await recordOutcomeStep(env, jobKey, attachment.attachmentId, renormalized.outcome);
        if (recorded._tag === "error") {
          return recorded;
        }
        if (renormalized.outcome._tag === "exception") {
          outcomes.push({
            attachmentId: attachment.attachmentId,
            state: "exception",
            outcome: renormalized.outcome.exceptionKind,
          });
          continue;
        }
        const done = await verifyAndCleanup(env, jobKey, attachment, crashAfter);
        if (done._tag === "error") {
          return done;
        }
        outcomes.push({ attachmentId: attachment.attachmentId, state: "cleaned", outcome: "normalized" });
        continue;
      }
      const done = await verifyAndCleanup(env, jobKey, attachment, crashAfter);
      if (done._tag === "error") {
        return done;
      }
      outcomes.push({ attachmentId: attachment.attachmentId, state: "cleaned", outcome: "normalized" });
      continue;
    }
    // step === "normalize": the full conversion path.
    const normalized = await normalizeAttachment(env, resolved.normalizer, attachment);
    if (!normalized.ok) {
      return normalized.error;
    }
    const recorded = await recordOutcomeStep(env, jobKey, attachment.attachmentId, normalized.outcome);
    if (recorded._tag === "error") {
      return recorded;
    }
    if (normalized.outcome._tag === "exception") {
      outcomes.push({
        attachmentId: attachment.attachmentId,
        state: "exception",
        outcome: normalized.outcome.exceptionKind,
      });
      continue;
    }
    if (crashAfter === "record") {
      // The deliberate crash-window: rows recorded, not yet verified.
      throw new Error("images drive: deliberate stop after record");
    }
    const done = await verifyAndCleanup(env, jobKey, attachment, crashAfter);
    if (done._tag === "error") {
      return done;
    }
    outcomes.push({ attachmentId: attachment.attachmentId, state: "cleaned", outcome: "normalized" });
  }
  return okResult({
    jobKey,
    normalizer: resolved.normalizer.id,
    attachments: outcomes,
  });
}

/**
 * The cleanup resumption route body: reconciliation names received objects
 * whose retained pair is verified; delete them, mark the rows, then
 * re-reconcile to confirm completion — including the post-cleanup
 * confirmation that the bytes are truly gone.
 */
export async function resumeCleanup(env: ImagesEnv, jobKey: string): Promise<ResultEnvelope> {
  const reconciled = await imagesStep(env, "reconcile", jobKey);
  const value = valueOf(reconciled);
  if (value === null) {
    return reconciled;
  }
  const pending = (value.pendingCleanup ?? []) as { attachmentId: string; objectKey: string }[];
  const deletedKeys: string[] = [];
  const confirmedAbsent: string[] = [];
  for (const item of pending) {
    await deleteObject(env.MEDIA_BUCKET, item.objectKey);
    const cleaned = await imagesStep(env, "cleanup", jobKey, {
      attachmentId: item.attachmentId,
    });
    if (cleaned._tag === "error") {
      return cleaned;
    }
    if (await objectAbsent(env.MEDIA_BUCKET, item.objectKey)) {
      confirmedAbsent.push(item.objectKey);
    }
    deletedKeys.push(item.objectKey);
  }
  const again = await imagesStep(env, "reconcile", jobKey);
  const againValue = valueOf(again);
  return okResult({
    jobKey,
    firstPass: value.reconciled,
    deletedKeys,
    confirmedAbsent,
    reconciled: againValue === null ? null : againValue.reconciled ?? null,
    attachments: againValue === null ? [] : againValue.attachments ?? [],
  });
}
