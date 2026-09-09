/**
 * The upload ledger transactions (D2): one place for every state change of
 * a resumable upload, each safe to retry.
 *
 * Ownership and tenancy are re-checked at EVERY step against the resolved
 * actor (the canonical access check): the upload must belong to the actor's
 * company AND the actor's user, the attachment must belong to the upload,
 * and the object key must sit in the company's server-owned namespace. A
 * revoked session or membership fails the dispatch before any of these
 * transactions runs.
 *
 * R2 completion and Convex acceptance are separate systems; this ledger is
 * the reconciliation point:
 *
 * - every step is idempotent (identical replay) or a typed conflict
 *   (diverging replay), so gateway retries after lost responses are safe;
 * - a completed-but-unaccepted upload stays at stage `finalized` with its
 *   event published — recoverable through the ledger until reconciliation
 *   (past its grace, unaccepted, inactive) marks it `orphaned`;
 * - acceptance (D1's transaction, extended by D2) binds source, attachments
 *   and ledger atomically and only then issues the saved receipt.
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  okResult,
  sourcesOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  forbiddenError,
  unavailableError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import {
  BeginInput,
  CompleteInput,
  PartInput,
  PrepareInput,
  RECEIVED_TRANSFORM_VERSION,
  Sha256Hex,
  UploadRefInput,
  decidePartReceipt,
  decideReconciliation,
  manifestBytes,
  objectKeyInTenantNamespace,
  parseManifest,
  serializeManifest,
  upsertReceipt,
  validatePartNumber,
  type PartInput as PartInputType,
  type PartReceipt,
  type PrepareInput as PrepareInputType,
} from "./protocol";

/** The certified entries this ledger implements (decode/typed authority). */
export const prepareUploadEntry = sourcesOperations["sources.prepareUpload"];
export const resumeUploadEntry = sourcesOperations["sources.resumeUpload"];

export type PrepareInputValue = Schema.Schema.Type<typeof PrepareInput>;
export type BeginInputValue = Schema.Schema.Type<typeof BeginInput>;
export type PartInputValue = Schema.Schema.Type<typeof PartInput>;
export type CompleteInputValue = Schema.Schema.Type<typeof CompleteInput>;
export type UploadRefInputValue = Schema.Schema.Type<typeof UploadRefInput>;

/** The slim upload row shape the ledger works with. */
export interface UploadRow {
  readonly _id: Id<"uploads">;
  readonly companyId: Id<"companies">;
  readonly userId: Id<"users">;
  readonly stage: "draft" | "uploading" | "finalized" | "orphaned" | "failed";
  readonly draftId?: string | undefined;
  readonly attachmentCount?: number | undefined;
  readonly declaredKinds?: ("audio" | "image")[] | undefined;
  readonly declaredParts?: number | undefined;
  readonly lastActivityAtMs?: number | undefined;
  readonly finalizedAtMs?: number | undefined;
  readonly acceptedSourceId?: Id<"sources"> | undefined;
}

/** Normalizes a raw upload id (typed rejection on malformed ids). */
function normalizeUploadId(
  tx: MutationCtx,
  uploadId: string,
): Id<"uploads"> | null {
  return tx.db.normalizeId("uploads", uploadId);
}

/** Loads and tenant/owner-checks one upload row (typed closed errors). */
async function loadOwnedUpload(
  tx: MutationCtx,
  context: RequestContext,
  uploadId: string,
  entity: string,
): Promise<
  | { ok: true; upload: UploadRow }
  | { ok: false; error: ReturnType<typeof validationError> | ReturnType<typeof forbiddenError> }
> {
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  const userId = tx.db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return { ok: false, error: validationError("company_scope_unresolved") };
  }
  const id = normalizeUploadId(tx, uploadId);
  if (id === null) {
    return { ok: false, error: validationError("upload_reference_not_found") };
  }
  const upload = await tx.db.get(id);
  if (upload === null) {
    return { ok: false, error: validationError("upload_reference_not_found") };
  }
  if (upload.companyId !== companyId) {
    return { ok: false, error: forbiddenError("tenant_scope_mismatch", entity) };
  }
  if (upload.userId !== userId) {
    return { ok: false, error: forbiddenError("upload_not_owned_by_actor", entity) };
  }
  return { ok: true, upload: upload as UploadRow };
}

// ---------------------------------------------------------------------------
// prepare (the certified `sources.prepareUpload` semantics, idempotent per
// company + stable draft id).
// ---------------------------------------------------------------------------

export interface PrepareResult {
  readonly uploadId: Id<"uploads">;
  readonly stage: "draft" | "uploading" | "finalized" | "orphaned" | "failed";
  readonly companyId: Id<"companies">;
  readonly attachmentCount: number;
}

/**
 * Prepares one resumable upload: declares the attachments and the part
 * bound of the client's stable draft. Re-Preparing the same (company,
 * draftId) returns the SAME ledger row with the SAME declaration — the
 * stable-draft resume identity; a re-declaration with different media kinds
 * or part bound is a typed conflict, never a silent redefinition.
 */
export async function prepareUploadTransaction(
  tx: MutationCtx,
  context: RequestContext,
  input: PrepareInputValue,
): Promise<ResultEnvelope> {
  const decoded = Schema.decodeUnknownSync(PrepareInput)(input);
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  const userId = tx.db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const existing = await tx.db
    .query("uploads")
    .withIndex("by_company_draft", (q) => q.eq("companyId", companyId).eq("draftId", decoded.draftId))
    .first();
  const nowMs = Date.now();
  if (existing !== null) {
    if (existing.userId !== userId) {
      return errorResult(forbiddenError("upload_not_owned_by_actor", "uploads"));
    }
    if (existing.stage === "orphaned") {
      return errorResult(conflictError("draft_expired_restart_required", undefined, existing._id));
    }
    if (existing.declaredKinds !== undefined) {
      const sameDeclaration =
        kindsMatch(existing.declaredKinds, decoded.mediaKinds) &&
        existing.declaredParts === decoded.parts;
      if (!sameDeclaration) {
        return errorResult(conflictError("draft_declaration_mismatch", undefined, existing._id));
      }
    }
    return okResult({
      uploadId: existing._id,
      stage: existing.stage,
      companyId,
      attachmentCount: existing.attachmentCount ?? decoded.mediaKinds.length,
    });
  }
  const uploadId = await tx.db.insert("uploads", {
    companyId,
    userId,
    stage: "draft",
    partCount: 0,
    draftId: decoded.draftId,
    attachmentCount: decoded.mediaKinds.length,
    declaredKinds: [...decoded.mediaKinds],
    declaredParts: decoded.parts,
    createdAtMs: nowMs,
    lastActivityAtMs: nowMs,
  });
  return okResult({
    uploadId,
    stage: "draft",
    companyId,
    attachmentCount: decoded.mediaKinds.length,
  });
}

// ---------------------------------------------------------------------------
// begin (Worker-minted object keys + R2 multipart identities become durable).
// ---------------------------------------------------------------------------

export interface BeginResultAttachment {
  readonly attachmentId: Id<"attachments">;
  readonly objectKey: string;
  readonly kind: "audio" | "image";
  readonly r2UploadId: string;
}

/** Multiset equality of media kinds (declaration order is not identity). */
function kindsMatch(
  declared: readonly ("audio" | "image")[],
  presented: readonly ("audio" | "image")[],
): boolean {
  if (declared.length !== presented.length) {
    return false;
  }
  const sortedDeclared = [...declared].sort();
  const sortedPresented = [...presented].sort();
  return sortedDeclared.every((kind, index) => kind === sortedPresented[index]);
}

/**
 * Records the Worker-side upload session: one attachment row per declared
 * media kind, carrying the server-minted object key (tenant-namespace
 * checked) and the R2 multipart upload id. The presented session must match
 * the prepare declaration (same kinds, same count) — an audio attachment can
 * never be swapped for an image mid-upload. Idempotent: replaying the same
 * session returns the same rows; a diverging replay is a typed conflict.
 */
export async function beginUploadTransaction(
  tx: MutationCtx,
  context: RequestContext,
  input: BeginInputValue,
): Promise<ResultEnvelope> {
  const decoded = Schema.decodeUnknownSync(BeginInput)(input);
  const owned = await loadOwnedUpload(tx, context, decoded.uploadId, "uploads");
  if (!owned.ok) {
    return errorResult(owned.error);
  }
  const upload = owned.upload;
  if (upload.stage !== "draft" && upload.stage !== "uploading") {
    return errorResult(conflictError("upload_stage_not_beginnable", undefined, upload._id));
  }
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  for (const attachment of decoded.attachments) {
    if (!objectKeyInTenantNamespace(attachment.objectKey, companyId)) {
      return errorResult(validationError("object_key_outside_tenant_namespace"));
    }
  }
  if (
    upload.declaredKinds !== undefined &&
    !kindsMatch(upload.declaredKinds, decoded.attachments.map((entry) => entry.kind))
  ) {
    return errorResult(validationError("attachment_declaration_mismatch"));
  }
  if (decoded.attachments.length !== (upload.attachmentCount ?? decoded.attachments.length)) {
    return errorResult(validationError("attachment_declaration_mismatch"));
  }

  const existing = await tx.db
    .query("attachments")
    .withIndex("by_upload", (q) => q.eq("uploadId", upload._id))
    .collect();
  const nowMs = Date.now();
  if (existing.length > 0) {
    const same =
      existing.length === decoded.attachments.length &&
      existing.every((row) =>
        decoded.attachments.some(
          (entry) =>
            entry.objectKey === row.objectKey &&
            entry.r2UploadId === row.r2UploadId &&
            entry.kind === row.kind,
        ),
      );
    if (!same) {
      return errorResult(conflictError("begin_session_mismatch", undefined, upload._id));
    }
    return okResult({
      uploadId: upload._id,
      stage: upload.stage,
      attachments: existing.map((row) => ({
        attachmentId: row._id,
        objectKey: row.objectKey,
        kind: row.kind,
        r2UploadId: row.r2UploadId ?? "",
      })),
    });
  }
  const attachments: BeginResultAttachment[] = [];
  for (const entry of decoded.attachments) {
    const attachmentId = await tx.db.insert("attachments", {
      uploadId: upload._id,
      kind: entry.kind,
      objectKey: entry.objectKey,
      r2UploadId: entry.r2UploadId,
      createdAtMs: nowMs,
    });
    attachments.push({
      attachmentId,
      objectKey: entry.objectKey,
      kind: entry.kind,
      r2UploadId: entry.r2UploadId,
    });
  }
  await tx.db.patch(upload._id, {
    stage: "uploading",
    lastActivityAtMs: nowMs,
  });
  return okResult({ uploadId: upload._id, stage: "uploading", attachments });
}

// ---------------------------------------------------------------------------
// part (one verified R2 part receipt).
// ---------------------------------------------------------------------------

/**
 * Records one part receipt: same part number + identical content is an
 * idempotent replay, diverging content is a typed conflict, parts of a
 * completed attachment are typed stale-retry rejections, and parts outside
 * the declared bound or of a foreign upload are rejected typed.
 */
export async function recordPartTransaction(
  tx: MutationCtx,
  context: RequestContext,
  input: PartInputValue,
): Promise<ResultEnvelope> {
  const decoded: PartInputType = Schema.decodeUnknownSync(PartInput)(input);
  const owned = await loadOwnedUpload(tx, context, decoded.uploadId, "uploads");
  if (!owned.ok) {
    return errorResult(owned.error);
  }
  const upload = owned.upload;
  if (upload.stage !== "uploading") {
    return errorResult(conflictError("upload_stage_not_uploading", undefined, upload._id));
  }
  const bounds = validatePartNumber(decoded.partNumber, upload.declaredParts);
  if (!bounds.ok) {
    return errorResult(validationError(bounds.code));
  }
  const attachmentId = tx.db.normalizeId("attachments", decoded.attachmentId);
  if (attachmentId === null) {
    return errorResult(validationError("attachment_reference_not_found"));
  }
  const attachment = await tx.db.get(attachmentId);
  if (attachment === null || attachment.uploadId !== upload._id) {
    return errorResult(forbiddenError("attachment_not_in_upload", "attachments"));
  }
  if (attachment.completedAtMs !== undefined) {
    // Finalized bytes cannot be overwritten by stale retries.
    return errorResult(conflictError("attachment_finalized", undefined, attachmentId));
  }
  const manifest = parseManifest(attachment.partsJson);
  const receipt: PartReceipt = {
    partNumber: decoded.partNumber,
    etag: decoded.etag,
    bytes: decoded.bytes,
    sha256Hex: Schema.decodeUnknownSync(Sha256Hex)(decoded.sha256Hex),
    receivedAtMs: Date.now(),
  };
  const decision = decidePartReceipt(manifest, receipt);
  if (decision.decision === "conflict") {
    return errorResult(conflictError(decision.code, undefined, attachmentId));
  }
  if (decision.decision === "idempotent") {
    await tx.db.patch(upload._id, { lastActivityAtMs: receipt.receivedAtMs });
    return okResult({
      attachmentId,
      partNumber: receipt.partNumber,
      recorded: manifest.length,
      idempotent: true,
    });
  }
  // "record" (new part number) or "refresh" (same content, latest R2 etag):
  // both persist the sorted upsert; only the recorded-parts count differs.
  const next = upsertReceipt(manifest, receipt);
  await tx.db.patch(attachmentId, {
    partsJson: serializeManifest(next),
    receivedBytes: manifestBytes(next),
  });
  await tx.db.patch(upload._id, {
    partCount: next.length,
    lastActivityAtMs: receipt.receivedAtMs,
  });
  return okResult({
    attachmentId,
    partNumber: receipt.partNumber,
    recorded: next.length,
    idempotent: false,
    refreshed: decision.decision === "refresh",
  });
}

// ---------------------------------------------------------------------------
// complete (one attachment durably finished and verified in R2).
// ---------------------------------------------------------------------------

/**
 * Records one attachment's durable R2 completion: the gateway completed the
 * multipart upload AND verified the object readable (head) before calling.
 * Writes the verified `received` representation (idempotent) and
 * cross-checks the R2 object size against the manifest byte sum.
 */
export async function completeAttachmentTransaction(
  tx: MutationCtx,
  context: RequestContext,
  input: CompleteInputValue,
): Promise<ResultEnvelope> {
  const decoded = Schema.decodeUnknownSync(CompleteInput)(input);
  const owned = await loadOwnedUpload(tx, context, decoded.uploadId, "uploads");
  if (!owned.ok) {
    return errorResult(owned.error);
  }
  const upload = owned.upload;
  if (upload.stage !== "uploading" && upload.stage !== "finalized") {
    return errorResult(conflictError("upload_stage_not_uploading", undefined, upload._id));
  }
  const attachmentId = tx.db.normalizeId("attachments", decoded.attachmentId);
  if (attachmentId === null) {
    return errorResult(validationError("attachment_reference_not_found"));
  }
  const attachment = await tx.db.get(attachmentId);
  if (attachment === null || attachment.uploadId !== upload._id) {
    return errorResult(forbiddenError("attachment_not_in_upload", "attachments"));
  }
  const nowMs = Date.now();
  if (attachment.completedAtMs !== undefined) {
    if (attachment.r2ObjectEtag === decoded.objectEtag) {
      // Idempotent replay still counts as activity (the reconciliation grace
      // anchor follows real protocol traffic, including retries).
      await tx.db.patch(upload._id, { lastActivityAtMs: nowMs });
      return okResult({ attachmentId, completedAtMs: attachment.completedAtMs, idempotent: true });
    }
    return errorResult(conflictError("attachment_finalized", undefined, attachmentId));
  }
  const manifest = parseManifest(attachment.partsJson);
  if (manifest.length === 0) {
    return errorResult(validationError("part_manifest_empty"));
  }
  if (manifestBytes(manifest) !== decoded.totalBytes) {
    return errorResult(validationError("attachment_bytes_mismatch"));
  }
  await tx.db.patch(attachmentId, {
    completedAtMs: nowMs,
    receivedBytes: decoded.totalBytes,
    r2ObjectEtag: decoded.objectEtag,
    contentHash: `r2:etag:${decoded.objectEtag}`,
  });
  const representation = await tx.db
    .query("mediaRepresentations")
    .withIndex("by_attachment_role", (q) =>
      q.eq("attachmentId", attachmentId).eq("role", "received"),
    )
    .first();
  let representationId = representation === null ? undefined : representation._id;
  if (representation === null) {
    representationId = await tx.db.insert("mediaRepresentations", {
      attachmentId,
      role: "received",
      objectKey: attachment.objectKey,
      contentHash: `r2:etag:${decoded.objectEtag}`,
      transformVersion: RECEIVED_TRANSFORM_VERSION,
      verifiedAtMs: nowMs,
      createdAtMs: nowMs,
    });
  } else if (representation.verifiedAtMs === undefined) {
    await tx.db.patch(representation._id, { verifiedAtMs: nowMs });
  }
  await tx.db.patch(upload._id, { lastActivityAtMs: nowMs });
  return okResult({
    attachmentId,
    completedAtMs: nowMs,
    idempotent: false,
    ...(representationId === undefined ? {} : { representationId }),
  });
}

// ---------------------------------------------------------------------------
// finalize (every declared attachment durable; the recoverable state).
// ---------------------------------------------------------------------------

/**
 * Finalizes the upload: every declared attachment must be completed with a
 * verified received representation. Publishes `sources.uploadFinalized`
 * atomically with the stage change (idempotent replays return the original
 * time; no second event).
 */
export async function finalizeUploadTransaction(
  tx: MutationCtx,
  context: RequestContext,
  input: UploadRefInputValue,
): Promise<ResultEnvelope> {
  const decoded = Schema.decodeUnknownSync(UploadRefInput)(input);
  const owned = await loadOwnedUpload(tx, context, decoded.uploadId, "uploads");
  if (!owned.ok) {
    return errorResult(owned.error);
  }
  const upload = owned.upload;
  if (upload.stage === "finalized") {
    return okResult({
      uploadId: upload._id,
      stage: "finalized",
      finalizedAtMs: upload.finalizedAtMs ?? Date.now(),
      idempotent: true,
    });
  }
  if (upload.stage !== "uploading") {
    return errorResult(conflictError("upload_stage_not_finalizable", undefined, upload._id));
  }
  const attachments = await tx.db
    .query("attachments")
    .withIndex("by_upload", (q) => q.eq("uploadId", upload._id))
    .collect();
  if (attachments.length === 0) {
    return errorResult(validationError("attachments_not_declared"));
  }
  if (upload.attachmentCount !== undefined && attachments.length !== upload.attachmentCount) {
    return errorResult(validationError("attachment_declaration_mismatch"));
  }
  for (const attachment of attachments) {
    if (attachment.completedAtMs === undefined) {
      return errorResult(validationError("attachments_not_complete"));
    }
    const received = await tx.db
      .query("mediaRepresentations")
      .withIndex("by_attachment_role", (q) =>
        q.eq("attachmentId", attachment._id).eq("role", "received"),
      )
      .first();
    if (received === null || received.verifiedAtMs === undefined) {
      return errorResult(validationError("attachment_not_verified"));
    }
  }
  // Pre-flight the registry entry (D1's structural pattern: every throwing
  // step resolves before the first write).
  const eventEntry = events["sources.uploadFinalized"];
  if (eventEntry === undefined) {
    return errorResult(unavailableError(true, "upload_finalized_event_missing"));
  }
  const nowMs = Date.now();
  await tx.db.patch(upload._id, {
    stage: "finalized",
    finalizedAtMs: nowMs,
    lastActivityAtMs: nowMs,
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "sources.uploadFinalized",
    payload: { uploadId: upload._id },
    dedupKey: `sources.uploadFinalized:${context.actor.companyId}:${upload._id}`,
  });
  return okResult({
    uploadId: upload._id,
    stage: "finalized",
    finalizedAtMs: nowMs,
    idempotent: false,
  });
}

// ---------------------------------------------------------------------------
// reconcile (safe orphan collection decisions for the actor's company).
// ---------------------------------------------------------------------------

export interface ReconcileCollectItem {
  readonly uploadId: Id<"uploads">;
  readonly draftId?: string | undefined;
  readonly reason: string;
  readonly attachments: {
    readonly attachmentId: Id<"attachments">;
    readonly objectKey: string;
    readonly r2UploadId?: string | undefined;
    readonly completed: boolean;
  }[];
}

export interface ReconcileResult {
  readonly kept: { uploadId: Id<"uploads">; reason: string }[];
  readonly collect: ReconcileCollectItem[];
}

/**
 * One reconciliation pass over the actor's company: expired, unaccepted,
 * inactive uploads are marked `orphaned` in the ledger and returned for R2
 * collection; accepted, active and within-grace uploads survive. Already
 * orphaned rows are returned again so an interrupted R2 collection can
 * finish (R2 abort/delete are idempotent at the gateway).
 */
export async function reconcileUploadsTransaction(
  tx: MutationCtx,
  context: RequestContext,
): Promise<ResultEnvelope> {
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const nowMs = Date.now();
  const result: ReconcileResult = { kept: [], collect: [] };
  // Rows decided in an earlier stage pass of THIS same scan are not
  // re-decided when the "orphaned" sweep reaches them again after the pass
  // itself marked them: one collect entry per upload per pass.
  const decided = new Set<string>();
  for (const stage of ["draft", "uploading", "finalized", "failed", "orphaned"] as const) {
    const rows = await tx.db
      .query("uploads")
      .withIndex("by_company_stage", (q) => q.eq("companyId", companyId).eq("stage", stage))
      .collect();
    for (const row of rows) {
      if (decided.has(row._id)) {
        continue;
      }
      decided.add(row._id);
      const decision = decideReconciliation(
        {
          stage: row.stage,
          ...(row.acceptedSourceId === undefined ? {} : { acceptedSourceId: row.acceptedSourceId }),
          ...(row.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: row.lastActivityAtMs }),
          createdAtMs: row.createdAtMs,
        },
        nowMs,
      );
      if (decision.action === "keep") {
        result.kept.push({ uploadId: row._id, reason: decision.reason });
        continue;
      }
      if (row.stage !== "orphaned") {
        await tx.db.patch(row._id, {
          stage: "orphaned",
          orphanReason: decision.reason,
          orphanedAtMs: nowMs,
        });
      }
      const attachments = await tx.db
        .query("attachments")
        .withIndex("by_upload", (q) => q.eq("uploadId", row._id))
        .collect();
      result.collect.push({
        uploadId: row._id,
        ...(row.draftId === undefined ? {} : { draftId: row.draftId }),
        reason: decision.reason,
        attachments: attachments.map((attachment) => ({
          attachmentId: attachment._id,
          objectKey: attachment.objectKey,
          ...(attachment.r2UploadId === undefined ? {} : { r2UploadId: attachment.r2UploadId }),
          completed: attachment.completedAtMs !== undefined,
        })),
      });
    }
  }
  return okResult(result);
}

// ---------------------------------------------------------------------------
// resume (the certified `sources.resumeUpload` semantics) and state reads.
// ---------------------------------------------------------------------------

/** The certified resume: the upload's current stage (typed not_found/conflict). */
export async function resumeUploadTransaction(
  tx: MutationCtx,
  context: RequestContext,
  uploadId: string,
): Promise<ResultEnvelope> {
  const owned = await loadOwnedUpload(tx, context, uploadId, "uploads");
  if (!owned.ok) {
    return errorResult(owned.error);
  }
  return okResult({ uploadId: owned.upload._id, stage: owned.upload.stage });
}

/**
 * The upload-session read the gateway's resume route serves (tenant-scoped).
 * Takes the READER surface: query contexts and mutation contexts both fit.
 */
export async function uploadSessionState(
  db: QueryCtx["db"],
  context: RequestContext,
  uploadId: string,
): Promise<ResultEnvelope> {
  const companyId = db.normalizeId("companies", context.actor.companyId);
  const userId = db.normalizeId("users", context.actor.userId);
  if (companyId === null || userId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const id = db.normalizeId("uploads", uploadId);
  if (id === null) {
    return errorResult(validationError("upload_reference_not_found"));
  }
  const upload = await db.get(id);
  if (upload === null) {
    return errorResult(validationError("upload_reference_not_found"));
  }
  if (upload.companyId !== companyId) {
    return errorResult(forbiddenError("tenant_scope_mismatch", "uploads"));
  }
  if (upload.userId !== userId) {
    return errorResult(forbiddenError("upload_not_owned_by_actor", "uploads"));
  }
  const attachments = await db
    .query("attachments")
    .withIndex("by_upload", (q) => q.eq("uploadId", id))
    .collect();
  let sessionAttachments: unknown;
  try {
    sessionAttachments = attachments.map((attachment) => ({
      attachmentId: attachment._id,
      kind: attachment.kind,
      objectKey: attachment.objectKey,
      ...(attachment.r2UploadId === undefined ? {} : { r2UploadId: attachment.r2UploadId }),
      ...(attachment.completedAtMs === undefined
        ? {}
        : {
            completedAtMs: attachment.completedAtMs,
            ...(attachment.r2ObjectEtag === undefined ? {} : { r2ObjectEtag: attachment.r2ObjectEtag }),
          }),
      parts: parseManifest(attachment.partsJson),
    }));
  } catch {
    // A corrupt manifest is a sanitized unavailable, never a raw throw
    // across the query boundary (and never a silent empty manifest).
    return errorResult(unavailableError(true, "part_manifest_corrupt"));
  }
  return okResult({
    uploadId: id,
    companyId,
    stage: upload.stage,
    ...(upload.draftId === undefined ? {} : { draftId: upload.draftId }),
    ...(upload.attachmentCount === undefined ? {} : { attachmentCount: upload.attachmentCount }),
    ...(upload.declaredParts === undefined ? {} : { declaredParts: upload.declaredParts }),
    ...(upload.acceptedSourceId === undefined ? {} : { acceptedSourceId: upload.acceptedSourceId }),
    ...(upload.lastActivityAtMs === undefined ? {} : { lastActivityAtMs: upload.lastActivityAtMs }),
    attachments: sessionAttachments,
  });
}

export type { PrepareInputType };
