/**
 * The images normalization ledger transactions (D5): one place for every
 * state change of the photo-normalization durable job
 * `processing.normalize_photo`, each safe to retry.
 *
 * AUTHORITY MODEL: these transactions run behind the SERVICE-credential
 * images-channel boundary (convex/processing/images/http.ts) and behind the
 * executor's own action. They never resolve a user identity: their whole
 * authority scope is ONE durable job row, loaded by `jobKey`. Tenancy is
 * structural — the job carries the company it was registered for (the
 * acceptance event's company), every attachment is loaded through the job's
 * input, and each attachment's upload is checked against the job's company
 * before anything is written. A job of company A therefore cannot touch
 * company B's attachment rows, keys or bytes.
 *
 * The retention rule (architecture protocol step 4) is enforced here as
 * data, not convention:
 *
 * - `record` writes UNVERIFIED retained/thumbnail rows (or the explicit
 *   retained-original exception row with its typed reason);
 * - `verify` stamps `verifiedAtMs` only on cross-checked durability
 *   evidence and publishes `sources.representationRetained`;
 * - `cleanup` removes the received BYTES marker only when the pure
 *   received-cleanup rule allows it (verified retained + verified
 *   thumbnail + no extraction references + not the original exception);
 * - `reconcile` observes the rows and completes, directs pending cleanup,
 *   or retries — never a blind second conversion (echo-template
 *   uncertainty semantics).
 *
 * Pure decisions (formats, bounds, the state machine) live in ./protocol.ts
 * so tests/d5 can prove them without a deployment.
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  executors,
  normalizePhotoInput,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { backoffDelayMs, conflictError, nextDeliveryState, unavailableError, validationError } from "@kiero/runtime";
import { internal } from "../../_generated/api";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import {
  NORMALIZE_TRANSFORM_VERSION,
  RETAINED_ORIGINAL_TRANSFORM_VERSION,
  THUMBNAIL_TRANSFORM_VERSION,
  representationObjectKey,
  decideReceivedCleanup,
  decideRetentionStep,
  decideRetainedSelection,
  RecordOutcome,
  VerifyEvidence,
  type RepresentationView,
} from "./protocol";

const RETRY_BACKOFF_BASE_MS = 2_000;

/** The registry executor entry that owns this job kind (decode authority). */
export const normalizeExecutorEntry = executors.find(
  (candidate) => candidate.jobKind === "processing.normalize_photo",
);

/** The durable job rows this ledger works with. */
interface JobRow {
  readonly _id: Id<"durableJobs">;
  readonly jobKey: string;
  readonly kind: "processing.normalize_photo";
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly inputJson: string;
  readonly companyId?: Id<"companies"> | undefined;
  readonly sourceId?: Id<"sources"> | undefined;
  readonly dedupKey?: string | undefined;
  readonly externalOutcome?: string | undefined;
}

/** One image attachment with its upload scoping (the tenancy chain). */
interface AttachmentRow {
  readonly _id: Id<"attachments">;
  readonly uploadId: Id<"uploads">;
  readonly sourceId?: Id<"sources"> | undefined;
  readonly kind: "audio" | "image";
  readonly objectKey: string;
  readonly receivedBytes?: number | undefined;
  readonly contentHash?: string | undefined;
}

/** Loads one durable job row by key (typed errors; never a raw throw). */
async function loadJob(
  tx: MutationCtx,
  jobKey: string,
): Promise<{ ok: true; job: JobRow } | { ok: false; error: ReturnType<typeof validationError> }> {
  const job = await tx.db
    .query("durableJobs")
    .withIndex("by_jobKey", (q) => q.eq("jobKey", jobKey))
    .first();
  if (job === null || job.kind !== "processing.normalize_photo") {
    return { ok: false, error: validationError("normalization_job_not_found") };
  }
  return { ok: true, job: job as JobRow };
}

/** The job's decoded input (throws on contract drift; decode before writes). */
function jobInput(job: JobRow): { sourceId: string; attachmentIds: readonly string[] } {
  const input: { sourceId: string; attachmentIds: readonly string[] } = Schema.decodeUnknownSync(
    normalizePhotoInput,
  )(JSON.parse(job.inputJson));
  return { sourceId: input.sourceId, attachmentIds: [...input.attachmentIds] };
}

/**
 * Loads and scopes the job's IMAGE attachments: the attachment must exist,
 * belong to the job's source, and its upload must belong to the job's
 * company. Audio ids in the payload are reported as skipped, never touched.
 */
async function loadImageAttachments(
  tx: MutationCtx,
  job: JobRow,
): Promise<{
  ok: true;
  images: AttachmentRow[];
  skippedAudio: string[];
} | { ok: false; error: ReturnType<typeof validationError> | ReturnType<typeof conflictError> }> {
  const input = jobInput(job);
  const images: AttachmentRow[] = [];
  const skippedAudio: string[] = [];
  for (const attachmentIdValue of input.attachmentIds) {
    const attachmentId = tx.db.normalizeId("attachments", attachmentIdValue);
    if (attachmentId === null) {
      return { ok: false, error: validationError("attachment_reference_not_found") };
    }
    const attachment = await tx.db.get(attachmentId);
    if (attachment === null) {
      return { ok: false, error: validationError("attachment_reference_not_found") };
    }
    if (attachment.kind !== "image") {
      skippedAudio.push(attachmentId);
      continue;
    }
    if (job.sourceId !== undefined && attachment.sourceId !== job.sourceId) {
      return { ok: false, error: conflictError("attachment_not_bound_to_job_source") };
    }
    if (job.companyId === undefined) {
      return { ok: false, error: validationError("job_company_scope_unresolved") };
    }
    const upload = await tx.db.get(attachment.uploadId);
    if (upload === null || upload.companyId !== job.companyId) {
      return { ok: false, error: conflictError("attachment_outside_job_company") };
    }
    images.push(attachment as AttachmentRow);
  }
  return { ok: true, images, skippedAudio };
}

/** All representation rows of one attachment, as the pure views read. */
async function representationsOf(
  db: QueryCtx["db"],
  attachmentId: Id<"attachments">,
): Promise<RepresentationView[]> {
  const rows = await db
    .query("mediaRepresentations")
    .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachmentId))
    .collect();
  return rows.map((row) => ({
    _id: row._id,
    attachmentId: row.attachmentId,
    role: row.role,
    objectKey: row.objectKey,
    contentHash: row.contentHash,
    transformVersion: row.transformVersion,
    ...(row.verifiedAtMs === undefined ? {} : { verifiedAtMs: row.verifiedAtMs }),
    ...(row.removedAtMs === undefined ? {} : { removedAtMs: row.removedAtMs }),
    ...(row.exceptionKind === undefined ? {} : { exceptionKind: row.exceptionKind }),
    ...(row.bytes === undefined ? {} : { bytes: row.bytes }),
  }));
}

/** How many extraction rows still reference one representation. */
async function extractionReferences(
  db: QueryCtx["db"],
  sourceId: Id<"sources"> | undefined,
  representationId: Id<"mediaRepresentations"> | undefined,
): Promise<number> {
  if (sourceId === undefined || representationId === undefined) {
    return 0;
  }
  const rows = await db
    .query("extractions")
    .withIndex("by_source_kind", (q) => q.eq("sourceId", sourceId))
    .collect();
  return rows.filter((row) => row.representationId === representationId).length;
}

/** One shared completion: job terminal state plus the outbox row's state. */
async function completeJob(
  tx: MutationCtx,
  job: JobRow,
  params: {
    jobState: "succeeded" | "failed";
    externalOutcome: "succeeded" | "failed" | "timeout" | "unknown";
    deliveryState: "delivered" | "failed";
    errorKind?: string;
    finished: boolean;
  },
): Promise<void> {
  const nowMs = Date.now();
  await tx.db.patch(job._id, {
    state: params.jobState,
    externalOutcome: params.externalOutcome,
    ...(params.errorKind === undefined || params.errorKind === ""
      ? {}
      : { lastErrorKind: params.errorKind }),
    updatedAtMs: nowMs,
    ...(params.finished ? { finishedAtMs: nowMs } : {}),
  });
  if (job.dedupKey === undefined) {
    return;
  }
  const outboxRow = await tx.db
    .query("outboxEvents")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", job.dedupKey))
    .first();
  if (outboxRow !== null) {
    await tx.db.patch(outboxRow._id, {
      deliveryState: params.deliveryState,
      ...(params.errorKind === undefined || params.errorKind === ""
        ? {}
        : { lastErrorKind: params.errorKind }),
    });
  }
}

/** Re-queues one job attempt with backoff (bounded by the row's maxAttempts). */
async function requeueJob(tx: MutationCtx, job: JobRow, errorKind: string): Promise<void> {
  const nowMs = Date.now();
  await tx.db.patch(job._id, {
    state: "queued",
    lastErrorKind: errorKind,
    updatedAtMs: nowMs,
  });
  await tx.scheduler.runAfter(
    backoffDelayMs(job.attempts, RETRY_BACKOFF_BASE_MS),
    internal.platform.jobs.runDurableJob,
    { jobKey: job.jobKey },
  );
}

// ---------------------------------------------------------------------------
// prepare (mark the in-progress rows; hand the executor its plan).
// ---------------------------------------------------------------------------

/** One attachment's normalization plan handed to the executor service. */
export interface NormalizationPlanItem {
  readonly attachmentId: Id<"attachments">;
  readonly state: ReturnType<typeof decideRetentionStep>["state"];
  readonly step: string;
  readonly receivedObjectKey: string;
  readonly receivedBytes: number;
  readonly receivedContentHash: string;
  readonly retainedObjectKey: string;
  readonly thumbnailObjectKey: string;
}

/**
 * Marks the in-progress `processing` representation rows for the job's
 * image attachments (idempotent: an existing processing row from a crashed
 * attempt is reused, since the planned keys are deterministic) and returns
 * each attachment's current retention state plus its object-key plan.
 */
export async function prepareNormalizationTransaction(
  tx: MutationCtx,
  jobKey: string,
): Promise<ResultEnvelope> {
  const loaded = await loadJob(tx, jobKey);
  if (!loaded.ok) {
    return errorResult(loaded.error);
  }
  const job = loaded.job;
  if (job.state !== "running" && job.state !== "succeeded") {
    return errorResult(conflictError("normalization_job_not_running", undefined, job._id));
  }
  // For a SUCCEEDED job prepare is a read-back: every attachment's step is
  // terminal (`none`), so the plan returns without writing anything — the
  // idempotent answer to a duplicate registration or a direct re-drive.
  const scoped = await loadImageAttachments(tx, job);
  if (!scoped.ok) {
    return errorResult(scoped.error);
  }
  if (job.companyId === undefined) {
    return errorResult(validationError("job_company_scope_unresolved"));
  }
  const companyId = job.companyId;
  const attachments: NormalizationPlanItem[] = [];
  const nowMs = Date.now();
  for (const attachment of scoped.images) {
    const representations = await representationsOf(tx.db, attachment._id);
    const decision = decideRetentionStep(representations);
    const retainedObjectKey = representationObjectKey(
      companyId,
      attachment._id,
      NORMALIZE_TRANSFORM_VERSION,
      "retained",
    );
    if (decision.step === "normalize") {
      const processing = representations.find((row) => row.role === "processing");
      if (processing === undefined) {
        await tx.db.insert("mediaRepresentations", {
          attachmentId: attachment._id,
          role: "processing",
          objectKey: retainedObjectKey,
          contentHash: attachment.contentHash ?? "",
          transformVersion: NORMALIZE_TRANSFORM_VERSION,
          createdAtMs: nowMs,
        });
      }
    }
    const received = representations.find((row) => row.role === "received");
    attachments.push({
      attachmentId: attachment._id,
      state: decision.state,
      step: decision.step,
      receivedObjectKey: attachment.objectKey,
      receivedBytes: attachment.receivedBytes ?? 0,
      receivedContentHash: received?.contentHash ?? attachment.contentHash ?? "",
      retainedObjectKey,
      thumbnailObjectKey: representationObjectKey(
        companyId,
        attachment._id,
        THUMBNAIL_TRANSFORM_VERSION,
        "thumbnail",
      ),
    });
  }
  return okResult({
    jobKey: job.jobKey,
    sourceId: job.sourceId ?? null,
    companyId,
    attachments,
    skippedAudio: scoped.skippedAudio,
  });
}

// ---------------------------------------------------------------------------
// record (unverified retained/thumbnail rows, or the original exception).
// ---------------------------------------------------------------------------

/**
 * Records one attachment's typed normalization outcome:
 *
 * - `normalized`: the unverified `retained` and `thumbnail` representation
 *   rows (hashes, dimensions, bytes, content type) — verification is a
 *   separate step with its own evidence;
 * - `exception`: the explicit retained-original row pointing AT the
 *   received bytes with the typed `exceptionKind` (durable since D2
 *   verified the received object at completion), published as retained.
 *
 * Idempotent: an existing retained row of the same transform version is
 * returned, never duplicated.
 */
export async function recordNormalizationTransaction(
  tx: MutationCtx,
  jobKey: string,
  attachmentIdValue: string,
  outcomeValue: unknown,
): Promise<ResultEnvelope> {
  const loaded = await loadJob(tx, jobKey);
  if (!loaded.ok) {
    return errorResult(loaded.error);
  }
  const job = loaded.job;
  // Decode BEFORE any write (the D1 structural pattern).
  const outcome = Schema.decodeUnknownSync(RecordOutcome)(outcomeValue);
  const attachmentId = tx.db.normalizeId("attachments", attachmentIdValue);
  if (attachmentId === null) {
    return errorResult(validationError("attachment_reference_not_found"));
  }
  const scoped = await loadImageAttachments(tx, job);
  if (!scoped.ok) {
    return errorResult(scoped.error);
  }
  const attachment = scoped.images.find((candidate) => candidate._id === attachmentId);
  if (attachment === undefined) {
    return errorResult(validationError("attachment_not_in_job"));
  }
  const representations = await representationsOf(tx.db, attachmentId);
  const existingRetained = representations.find(
    (row) => row.role === "retained" && row.transformVersion === NORMALIZE_TRANSFORM_VERSION,
  );
  if (existingRetained !== undefined) {
    return okResult({ attachmentId, deduplicated: true, representationId: existingRetained._id });
  }
  const processing = representations.find((row) => row.role === "processing");
  const nowMs = Date.now();
  if (outcome._tag === "exception") {
    if (processing !== undefined) {
      await tx.db.delete(processing._id as Id<"mediaRepresentations">);
    }
    const received = representations.find((row) => row.role === "received");
    const representationId = await tx.db.insert("mediaRepresentations", {
      attachmentId,
      role: "retained",
      objectKey: attachment.objectKey,
      contentHash: received?.contentHash ?? attachment.contentHash ?? "",
      transformVersion: RETAINED_ORIGINAL_TRANSFORM_VERSION,
      ...(attachment.receivedBytes === undefined
        ? {}
        : { bytes: attachment.receivedBytes }),
      exceptionKind: outcome.exceptionKind,
      // The received object was already verified durable by D2's completion
      // step; the exception's archive IS those bytes.
      verifiedAtMs: nowMs,
      createdAtMs: nowMs,
    });
    await publishRetained(tx, job, attachmentId, representationId, "retained");
    return okResult({ attachmentId, deduplicated: false, representationId, exception: outcome.exceptionKind });
  }
  if (processing !== undefined) {
    await tx.db.delete(processing._id as Id<"mediaRepresentations">);
  }
  const retainedId = await tx.db.insert("mediaRepresentations", {
    attachmentId,
    role: "retained",
    objectKey: outcome.retained.objectKey,
    contentHash: `sha256:${outcome.retained.contentHash}`,
    transformVersion: NORMALIZE_TRANSFORM_VERSION,
    width: outcome.retained.width,
    height: outcome.retained.height,
    bytes: outcome.retained.bytes,
    mimeType: outcome.retained.mimeType,
    createdAtMs: nowMs,
  });
  const thumbnailId = await tx.db.insert("mediaRepresentations", {
    attachmentId,
    role: "thumbnail",
    objectKey: outcome.thumbnail.objectKey,
    contentHash: `sha256:${outcome.thumbnail.contentHash}`,
    transformVersion: THUMBNAIL_TRANSFORM_VERSION,
    width: outcome.thumbnail.width,
    height: outcome.thumbnail.height,
    bytes: outcome.thumbnail.bytes,
    mimeType: outcome.thumbnail.mimeType,
    createdAtMs: nowMs,
  });
  return okResult({
    attachmentId,
    deduplicated: false,
    representationId: retainedId,
    thumbnailRepresentationId: thumbnailId,
  });
}

/** Publishes one retained representation event (deduped by representation). */
async function publishRetained(
  tx: MutationCtx,
  job: JobRow,
  attachmentId: Id<"attachments">,
  representationId: Id<"mediaRepresentations">,
  role: "retained" | "thumbnail",
): Promise<void> {
  const entry = events["sources.representationRetained"];
  if (entry === undefined) {
    throw new Error("representationRetained event missing from the registry");
  }
  if (job.companyId === undefined) {
    throw new Error("job company scope unresolved");
  }
  await publishEvent(tx, {
    companyId: job.companyId,
    eventName: "sources.representationRetained",
    payload: { attachmentId, representationId, role },
    dedupKey: `sources.representationRetained:${representationId}`,
  });
}

// ---------------------------------------------------------------------------
// verify (durability evidence -> verifiedAtMs + events + cleanup decision).
// ---------------------------------------------------------------------------

/**
 * Verifies one attachment's recorded representations against the executor's
 * durability evidence (object key, content hash and byte size of what R2
 * actually holds), stamps `verifiedAtMs`, publishes
 * `sources.representationRetained` for both rows and returns the
 * received-bytes cleanup decision. Idempotent replays return the original
 * decision without a second event.
 */
export async function verifyNormalizationTransaction(
  tx: MutationCtx,
  jobKey: string,
  attachmentIdValue: string,
  retainedEvidenceValue: unknown,
  thumbnailEvidenceValue: unknown,
): Promise<ResultEnvelope> {
  const loaded = await loadJob(tx, jobKey);
  if (!loaded.ok) {
    return errorResult(loaded.error);
  }
  const job = loaded.job;
  const retainedEvidence = Schema.decodeUnknownSync(VerifyEvidence)(retainedEvidenceValue);
  const thumbnailEvidence = Schema.decodeUnknownSync(VerifyEvidence)(thumbnailEvidenceValue);
  const attachmentId = tx.db.normalizeId("attachments", attachmentIdValue);
  if (attachmentId === null) {
    return errorResult(validationError("attachment_reference_not_found"));
  }
  const scoped = await loadImageAttachments(tx, job);
  if (!scoped.ok) {
    return errorResult(scoped.error);
  }
  if (!scoped.images.some((candidate) => candidate._id === attachmentId)) {
    return errorResult(validationError("attachment_not_in_job"));
  }
  // Pre-flight the registry entry before the first write (D1's pattern).
  const eventEntry = events["sources.representationRetained"];
  if (eventEntry === undefined) {
    return errorResult(unavailableError(true, "representation_retained_event_missing"));
  }
  const representations = await representationsOf(tx.db, attachmentId);
  const retained = representations.find(
    (row) => row.role === "retained" && row.transformVersion === NORMALIZE_TRANSFORM_VERSION,
  );
  const thumbnail = representations.find(
    (row) => row.role === "thumbnail" && row.transformVersion === THUMBNAIL_TRANSFORM_VERSION,
  );
  if (retained === undefined || thumbnail === undefined) {
    return errorResult(validationError("normalization_not_recorded"));
  }
  const received = representations.find((row) => row.role === "received");
  const references = await extractionReferences(
    tx.db,
    job.sourceId,
    received?._id as Id<"mediaRepresentations"> | undefined,
  );
  if (retained.verifiedAtMs !== undefined) {
    // Idempotent replay: the rows were verified in an earlier attempt; the
    // decision reads them as they now stand.
    const decision = decideReceivedCleanup({ representations, extractionReferences: references });
    return okResult({
      attachmentId,
      deduplicated: true,
      representationId: retained._id,
      ...(decision.remove
        ? { cleanupObjectKey: decision.objectKey }
        : { cleanupRefusalReason: decision.reason }),
    });
  }
  // Evidence cross-check: what R2 reportedly holds must equal what record
  // wrote, or the verification refuses (typed, nothing stamped).
  const matches = (row: RepresentationView, evidence: VerifyEvidence): boolean =>
    row.objectKey === evidence.objectKey &&
    row.contentHash === `sha256:${evidence.contentHash}` &&
    row.bytes === evidence.bytes;
  if (!matches(retained, retainedEvidence) || !matches(thumbnail, thumbnailEvidence)) {
    return errorResult(validationError("verification_evidence_mismatch"));
  }
  const nowMs = Date.now();
  await tx.db.patch(retained._id as Id<"mediaRepresentations">, { verifiedAtMs: nowMs });
  await tx.db.patch(thumbnail._id as Id<"mediaRepresentations">, { verifiedAtMs: nowMs });
  await publishRetained(tx, job, attachmentId, retained._id as Id<"mediaRepresentations">, "retained");
  await publishRetained(tx, job, attachmentId, thumbnail._id as Id<"mediaRepresentations">, "thumbnail");
  // The cleanup decision reads the rows AS NOW VERIFIED (the stamp above is
  // what makes the reference check pass; deciding before it would refuse
  // every first verification).
  const verified = await representationsOf(tx.db, attachmentId);
  const decision = decideReceivedCleanup({ representations: verified, extractionReferences: references });
  return okResult({
    attachmentId,
    deduplicated: false,
    representationId: retained._id,
    ...(decision.remove
      ? { cleanupObjectKey: decision.objectKey }
      : { cleanupRefusalReason: decision.reason }),
  });
}

// ---------------------------------------------------------------------------
// cleanup (received BYTES removed; the row stays as provenance).
// ---------------------------------------------------------------------------

/**
 * Marks the received representation's bytes removed — called only after the
 * executor deleted the received R2 object. Re-checks the pure rule: the
 * retained representation must be verified and must not be the original
 * exception. Idempotent: an already-removed row returns the original time.
 */
export async function cleanupReceivedTransaction(
  tx: MutationCtx,
  jobKey: string,
  attachmentIdValue: string,
): Promise<ResultEnvelope> {
  const loaded = await loadJob(tx, jobKey);
  if (!loaded.ok) {
    return errorResult(loaded.error);
  }
  const job = loaded.job;
  const attachmentId = tx.db.normalizeId("attachments", attachmentIdValue);
  if (attachmentId === null) {
    return errorResult(validationError("attachment_reference_not_found"));
  }
  const scoped = await loadImageAttachments(tx, job);
  if (!scoped.ok) {
    return errorResult(scoped.error);
  }
  if (!scoped.images.some((candidate) => candidate._id === attachmentId)) {
    return errorResult(validationError("attachment_not_in_job"));
  }
  const representations = await representationsOf(tx.db, attachmentId);
  const received = representations.find((row) => row.role === "received");
  if (received === undefined) {
    return errorResult(validationError("received_representation_missing"));
  }
  if (received.removedAtMs !== undefined) {
    return okResult({ attachmentId, removedAtMs: received.removedAtMs, idempotent: true });
  }
  const references = await extractionReferences(tx.db, job.sourceId, received._id as Id<"mediaRepresentations">);
  const decision = decideReceivedCleanup({ representations, extractionReferences: references });
  if (decision.remove || decision.reason === "received_already_removed") {
    const nowMs = Date.now();
    await tx.db.patch(received._id as Id<"mediaRepresentations">, { removedAtMs: nowMs });
    return okResult({ attachmentId, removedAtMs: nowMs, idempotent: false });
  }
  return errorResult(conflictError(`received_cleanup_refused_${decision.reason}`));
}

// ---------------------------------------------------------------------------
// reconcile (observe rows; complete, direct cleanup, or retry once more).
// ---------------------------------------------------------------------------

/** One attachment's observed reconciliation view. */
export interface ReconcileAttachmentView {
  readonly attachmentId: Id<"attachments">;
  readonly state: ReturnType<typeof decideRetentionStep>["state"];
  readonly step: string;
  readonly retainedRepresentationId?: string | undefined;
  readonly selection: RepresentationView | null;
  readonly receivedRemovedAtMs?: number | undefined;
  readonly exceptionKind?: string | undefined;
}

export interface ReconcileResult {
  readonly reconciled: "completed" | "pending_cleanup" | "retrying" | "max_attempts" | "not_applicable";
  readonly attachments: ReconcileAttachmentView[];
  readonly pendingCleanup: { attachmentId: Id<"attachments">; objectKey: string }[];
}

/**
 * The observation-based reconciliation (echo template): reads ONLY the
 * representation rows the executor may have written and decides without a
 * blind second conversion:
 *
 * - every image terminal (cleaned or exception) -> the job completes
 *   succeeded, no external call;
 * - a verified retained pair with the received bytes still present ->
 *   `pending_cleanup` names exactly those objects (the caller deletes them
 *   and runs the cleanup step);
 * - work provably absent and attempts left -> one more bounded attempt;
 * - attempts exhausted -> terminal failure.
 */
export async function reconcileNormalizationTransaction(
  tx: MutationCtx,
  jobKey: string,
): Promise<ResultEnvelope> {
  const loaded = await loadJob(tx, jobKey);
  if (!loaded.ok) {
    return errorResult(loaded.error);
  }
  const job = loaded.job;
  if (job.state === "succeeded" || job.state === "cancelled") {
    return okResult({ reconciled: "not_applicable", attachments: [], pendingCleanup: [] } satisfies ReconcileResult);
  }
  const scoped = await loadImageAttachments(tx, job);
  if (!scoped.ok) {
    return errorResult(scoped.error);
  }
  const attachments: ReconcileAttachmentView[] = [];
  const pendingCleanup: { attachmentId: Id<"attachments">; objectKey: string }[] = [];
  // Terminal means every image attachment reached a terminal retention state
  // (cleaned, or the retained-original exception). A job with NO image
  // attachments (text/audio-only source) is terminal immediately.
  let terminal = true;
  for (const attachment of scoped.images) {
    const representations = await representationsOf(tx.db, attachment._id);
    const decision = decideRetentionStep(representations);
    const selection = decideRetainedSelection(representations);
    const received = representations.find((row) => row.role === "received");
    attachments.push({
      attachmentId: attachment._id,
      state: decision.state,
      step: decision.step,
      ...(selection === null ? {} : { retainedRepresentationId: selection._id }),
      selection,
      ...(received?.removedAtMs === undefined ? {} : { receivedRemovedAtMs: received.removedAtMs }),
      ...(selection?.exceptionKind === undefined ? {} : { exceptionKind: selection.exceptionKind }),
    });
    if (decision.step === "cleanup") {
      pendingCleanup.push({ attachmentId: attachment._id, objectKey: attachment.objectKey });
    }
    if (decision.step !== "none") {
      terminal = false;
    }
  }
  if (terminal) {
    await completeJob(tx, job, {
      jobState: "succeeded",
      externalOutcome: "succeeded",
      deliveryState: "delivered",
      finished: true,
    });
    return okResult({ reconciled: "completed", attachments, pendingCleanup } satisfies ReconcileResult);
  }
  if (pendingCleanup.length > 0) {
    return okResult({ reconciled: "pending_cleanup", attachments, pendingCleanup } satisfies ReconcileResult);
  }
  if (job.attempts >= job.maxAttempts) {
    await completeJob(tx, job, {
      jobState: "failed",
      externalOutcome: job.externalOutcome === "timeout" || job.externalOutcome === "unknown"
        ? job.externalOutcome
        : "failed",
      deliveryState: "failed",
      errorKind: "max_attempts_exceeded",
      finished: true,
    });
    return okResult({ reconciled: "max_attempts", attachments, pendingCleanup } satisfies ReconcileResult);
  }
  await requeueJob(tx, job, "reconcile_requeued");
  return okResult({ reconciled: "retrying", attachments, pendingCleanup } satisfies ReconcileResult);
}

// ---------------------------------------------------------------------------
// The executor's outcome recording (the action's completion half).
// ---------------------------------------------------------------------------

/**
 * Records one external normalization attempt's outcome (echo template):
 * `succeeded` completes; definite failures re-queue with backoff while
 * attempts remain; `timeout`/`unknown` are UNCERTAIN — terminal on the row
 * until reconciliation observes the representations.
 */
export async function recordAttemptOutcomeTransaction(
  tx: MutationCtx,
  jobKey: string,
  outcome: "succeeded" | "failed" | "timeout" | "unknown",
  retryable: boolean,
  errorKind: string,
): Promise<ResultEnvelope> {
  const loaded = await loadJob(tx, jobKey);
  if (!loaded.ok) {
    return errorResult(loaded.error);
  }
  const job = loaded.job;
  if (job.state === "succeeded" || job.state === "cancelled") {
    return okResult({ recorded: false, state: job.state });
  }
  if (outcome === "succeeded") {
    await completeJob(tx, job, {
      jobState: "succeeded",
      externalOutcome: "succeeded",
      deliveryState: "delivered",
      finished: true,
    });
    return okResult({ recorded: true, state: "succeeded" });
  }
  if (outcome === "failed" && !retryable) {
    await completeJob(tx, job, {
      jobState: "failed",
      externalOutcome: "failed",
      deliveryState: "failed",
      ...(errorKind === "" ? {} : { errorKind }),
      finished: true,
    });
    return okResult({ recorded: true, state: "failed" });
  }
  const transition = nextDeliveryState(
    { outcome, attempts: job.attempts, maxAttempts: job.maxAttempts },
    Date.now(),
    RETRY_BACKOFF_BASE_MS,
  );
  if (transition.to === "in_flight") {
    // Definite failure with attempts left: re-queue with backoff.
    await requeueJob(tx, job, errorKind);
    if (job.dedupKey !== undefined) {
      const outboxRow = await tx.db
        .query("outboxEvents")
        .withIndex("by_dedup", (q) => q.eq("dedupKey", job.dedupKey))
        .first();
      if (outboxRow !== null) {
        await tx.db.patch(outboxRow._id, {
          deliveryState: "pending",
          nextAttemptAtMs: transition.nextAttemptAtMs,
        });
      }
    }
    return okResult({ recorded: true, state: "queued" });
  }
  // Uncertain (timeout/unknown) or attempts exhausted: record and stop;
  // reconciliation owns the next move (uncertain) or none (terminal).
  await completeJob(tx, job, {
    jobState: "failed",
    externalOutcome: outcome,
    deliveryState: "failed",
    ...(errorKind === "" ? {} : { errorKind }),
    finished: transition.to === "failed" ? transition.terminal : true,
  });
  return okResult({ recorded: true, state: "failed" });
}

// ---------------------------------------------------------------------------
// The executor transaction half (jobs.ts calls this inside the executor).
// ---------------------------------------------------------------------------

/**
 * The in-transaction executor decision: a job whose payload carries no
 * image attachment (text/audio-only sources) succeeds without an external
 * call; a job whose images are all terminal (a replay after reconcile or a
 * duplicate registration) succeeds idempotently; everything else leaves the
 * transaction for the external normalizer action.
 */
export async function executeNormalizationHalf(
  tx: MutationCtx,
  job: { jobKey: string },
): Promise<{ outcome: "succeeded" } | { outcome: "needs_external" } | { outcome: "failed"; errorKind: string }> {
  const loaded = await loadJob(tx, job.jobKey);
  if (!loaded.ok) {
    return { outcome: "failed", errorKind: "normalization_job_not_found" };
  }
  const scoped = await loadImageAttachments(tx, loaded.job);
  if (!scoped.ok) {
    return { outcome: "failed", errorKind: "normalization_job_scoping_failed" };
  }
  if (scoped.images.length === 0) {
    return { outcome: "succeeded" };
  }
  for (const attachment of scoped.images) {
    const representations = await representationsOf(tx.db, attachment._id);
    const decision = decideRetentionStep(representations);
    if (decision.step !== "none") {
      return { outcome: "needs_external" };
    }
  }
  return { outcome: "succeeded" };
}
