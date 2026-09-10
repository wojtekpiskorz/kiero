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
 *    objects and proves them durable (head + full re-read hash) — the
 *    evidence computed THERE is what record and verify consume (no
 *    write-then-immediately-reread);
 * 3. `record` writes the unverified rows — or the explicit retained-
 *    original exception row, WITHOUT reading oversized inputs at all;
 * 4. `verify` stamps verifiedAtMs on the cross-checked evidence and
 *    publishes `sources.representationRetained`;
 * 5. ONLY THEN the received bytes are deleted and `cleanup` marks the row.
 *
 * Every path that reaches verification runs the SAME shared tail
 * (`verifyTail`): the verify bridge step, the crash hook, then the
 * received-byte cleanup driven by the verify step's OWN decision — never a
 * fabricated one. A drive resuming at the `cleanup` step re-derives the
 * decision through the idempotent verify replay (a deduplicated verify
 * returns the original cleanup decision).
 *
 * The crash-window proof hook (`crashAfter`, gated on KIERO_PROBE_ENABLED
 * at the route) stops the drive at a named boundary by throwing — the
 * Worker answers non-JSON, the Convex action records the UNCERTAIN
 * outcome, and reconciliation owns the resumption.
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
  type RetentionExceptionKind,
  type SniffedFormat,
  type VerifyEvidence,
} from "../../../../convex/processing/images/protocol";

/** The env the images lane consumes overall (bridge + bucket + normalizer). */
export type ImagesEnv = BridgeEnv &
  NormalizerEnv & {
    readonly MEDIA_BUCKET: R2Bucket;
    /** Proof-only dev variable; never set by the committed production config. */
    readonly KIERO_PROBE_ENABLED?: string;
  };

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

/** One attachment's typed outcome in the drive's result. */
type AttachmentOutcome = {
  readonly attachmentId: string;
  readonly state: string;
  readonly outcome:
    | "normalized"
    | RetentionExceptionKind
    | "already_terminal";
};

/** The durability evidence pair of one attachment's derived objects. */
interface EvidencePair {
  readonly retained: VerifyEvidence;
  readonly thumbnail: VerifyEvidence;
}

function valueOf(envelope: ResultEnvelope): Record<string, unknown> | null {
  return envelope._tag === "ok" ? (envelope.value as Record<string, unknown>) : null;
}

/** Durability evidence of one already-written object (full re-read + hash). */
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

/** Collects the evidence pair for already-written derived objects. */
async function collectEvidence(env: ImagesEnv, plan: AttachmentPlan): Promise<EvidencePair | null> {
  const retained = await evidenceOf(env, plan.retainedObjectKey);
  const thumbnail = await evidenceOf(env, plan.thumbnailObjectKey);
  if (retained === null || thumbnail === null) {
    return null;
  }
  return { retained, thumbnail };
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
): Promise<VerifyEvidence> {
  const hash = await sha256Hex(output.bytes);
  await putObject(env.MEDIA_BUCKET, objectKey, output.bytes, output.mimeType);
  const verified = await verifyObject(env.MEDIA_BUCKET, objectKey, hash, output.bytes.length);
  if (!verified.ok) {
    throw new Error(`derived object not durable: ${verified.reason}`);
  }
  return verified.evidence;
}

/** What one completed normalization produced. */
type NormalizationResult =
  | { readonly kind: "exception"; readonly exceptionKind: RetentionExceptionKind }
  | {
      readonly kind: "normalized";
      readonly outcome: RecordOutcome;
      readonly evidence: EvidencePair;
    };

/**
 * Runs the whole normalization of one attachment: decide (pure), encode,
 * write, prove. Oversized and unsupported inputs are decided WITHOUT a
 * full read (a ranged head sniff decides formats). Conversion failures and
 * unresolved quality are typed exceptions that keep the original. The
 * durability evidence computed at write time is returned WITH the outcome
 * so record and verify consume it directly.
 */
async function normalizeAttachment(
  env: ImagesEnv,
  normalizer: PhotoNormalizer,
  plan: AttachmentPlan,
): Promise<{ ok: true; result: NormalizationResult } | { ok: false; error: ResultEnvelope }> {
  if (plan.receivedBytes > MAX_INPUT_BYTES) {
    return { ok: true, result: { kind: "exception", exceptionKind: "oversized_input" } };
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
    return { ok: true, result: { kind: "exception", exceptionKind: decision.exceptionKind } };
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
    return { ok: true, result: { kind: "exception", exceptionKind: "conversion_failed" } };
  }
  const quality = decideConversionQuality({
    inputBytes: input.bytes.length,
    outputBytes: retainedOutput.bytes.length,
    outputWidth: retainedOutput.width,
    outputHeight: retainedOutput.height,
    plannedMaxEdge: RETAINED_MAX_EDGE,
  });
  if (!quality.resolved) {
    return { ok: true, result: { kind: "exception", exceptionKind: "quality_unresolved" } };
  }
  try {
    const retainedEvidence = await writeAndProve(env, plan.retainedObjectKey, retainedOutput);
    const thumbnailEvidence = await writeAndProve(env, plan.thumbnailObjectKey, thumbnailOutput);
    return {
      ok: true,
      result: {
        kind: "normalized",
        outcome: {
          _tag: "normalized",
          retained: {
            objectKey: plan.retainedObjectKey,
            contentHash: retainedEvidence.contentHash,
            bytes: retainedEvidence.bytes,
            width: retainedOutput.width,
            height: retainedOutput.height,
            mimeType: retainedOutput.mimeType,
          },
          thumbnail: {
            objectKey: plan.thumbnailObjectKey,
            contentHash: thumbnailEvidence.contentHash,
            bytes: thumbnailEvidence.bytes,
            width: thumbnailOutput.width,
            height: thumbnailOutput.height,
            mimeType: thumbnailOutput.mimeType,
          },
        },
        evidence: { retained: retainedEvidence, thumbnail: thumbnailEvidence },
      },
    };
  } catch {
    return {
      ok: false,
      error: errorResult(unavailableError(true, "derived_object_not_durable")),
    };
  }
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

/**
 * THE shared tail every verification-reaching path runs: the verify bridge
 * step on real evidence, the crash hook, then the received-byte cleanup
 * driven by the verify step's OWN decision (a deduplicated replay returns
 * the original decision, so a `cleanup`-state resumption re-derives it
 * here instead of fabricating one).
 */
async function verifyTail(
  env: ImagesEnv,
  jobKey: string,
  plan: AttachmentPlan,
  evidence: EvidencePair,
  crashAfter?: CrashAfter,
): Promise<ResultEnvelope> {
  const verified = await imagesStep(env, "verify", jobKey, {
    attachmentId: plan.attachmentId,
    retained: evidence.retained,
    thumbnail: evidence.thumbnail,
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
  const cleanupKey = value.cleanupObjectKey;
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
 * Runs one attachment's full conversion path: normalize (with evidence),
 * record, then the shared verify tail. Exception outcomes record their
 * typed row and finish without verification (the received bytes ARE the
 * archive).
 */
async function normalizeRecordAndVerify(
  env: ImagesEnv,
  normalizer: PhotoNormalizer,
  jobKey: string,
  plan: AttachmentPlan,
  crashAfter?: CrashAfter,
): Promise<{ ok: true; outcome: AttachmentOutcome } | { ok: false; error: ResultEnvelope }> {
  const normalized = await normalizeAttachment(env, normalizer, plan);
  if (!normalized.ok) {
    return normalized;
  }
  const recorded = await recordOutcomeStep(env, jobKey, plan.attachmentId, outcomeOf(normalized.result));
  if (recorded._tag === "error") {
    return { ok: false, error: recorded };
  }
  if (normalized.result.kind === "exception") {
    return {
      ok: true,
      outcome: { attachmentId: plan.attachmentId, state: "exception", outcome: normalized.result.exceptionKind },
    };
  }
  if (crashAfter === "record") {
    // The deliberate crash-window: rows recorded, not yet verified.
    throw new Error("images drive: deliberate stop after record");
  }
  const done = await verifyTail(env, jobKey, plan, normalized.result.evidence, crashAfter);
  if (done._tag === "error") {
    return { ok: false, error: done };
  }
  return {
    ok: true,
    outcome: { attachmentId: plan.attachmentId, state: "cleaned", outcome: "normalized" },
  };
}

/** The record-step payload of one normalization result. */
function outcomeOf(result: NormalizationResult): RecordOutcome {
  return result.kind === "exception"
    ? { _tag: "exception", exceptionKind: result.exceptionKind }
    : result.outcome;
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
    if (attachment.step === "none") {
      outcomes.push({
        attachmentId: attachment.attachmentId,
        state: attachment.state,
        outcome: "already_terminal",
      });
      continue;
    }
    if (attachment.step === "cleanup") {
      // Crash-after-verify resumption: the retained pair is verified; the
      // idempotent verify replay re-derives the cleanup decision from real
      // evidence (no fabricated decision).
      const evidence = await collectEvidence(env, attachment);
      if (evidence === null) {
        // Verified rows without objects (a foreign writer or a lost
        // object): re-normalize into the same deterministic keys rather
        // than verifying ghosts.
        const redone = await normalizeRecordAndVerify(env, resolved.normalizer, jobKey, attachment, crashAfter);
        if (!redone.ok) {
          return redone.error;
        }
        outcomes.push(redone.outcome);
        continue;
      }
      const done = await verifyTail(env, jobKey, attachment, evidence);
      if (done._tag === "error") {
        return done;
      }
      outcomes.push({ attachmentId: attachment.attachmentId, state: "cleaned", outcome: "normalized" });
      continue;
    }
    if (attachment.step === "verify") {
      // Recorded rows exist; only verification (and cleanup) remain — from
      // the objects actually in R2.
      const evidence = await collectEvidence(env, attachment);
      if (evidence === null) {
        const redone = await normalizeRecordAndVerify(env, resolved.normalizer, jobKey, attachment, crashAfter);
        if (!redone.ok) {
          return redone.error;
        }
        outcomes.push(redone.outcome);
        continue;
      }
      const done = await verifyTail(env, jobKey, attachment, evidence, crashAfter);
      if (done._tag === "error") {
        return done;
      }
      outcomes.push({ attachmentId: attachment.attachmentId, state: "cleaned", outcome: "normalized" });
      continue;
    }
    // step === "normalize": the full conversion path.
    const done = await normalizeRecordAndVerify(env, resolved.normalizer, jobKey, attachment, crashAfter);
    if (!done.ok) {
      return done.error;
    }
    outcomes.push(done.outcome);
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
