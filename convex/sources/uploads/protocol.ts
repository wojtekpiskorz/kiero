/**
 * The gateway upload protocol: step schemas and the PURE decisions of the
 * resumable-upload ledger (D2).
 *
 * The Worker (apps/gateway/src/uploads) mediates R2 and owns object keys and
 * R2 part identities; Convex owns this ledger. The two systems cannot share
 * a transaction, so the protocol is built around a durable part manifest and
 * staged transitions that are safe to retry at every step:
 *
 * - prepare (certified `sources.prepareUpload` semantics) declares the
 *   draft's attachments and part bound, idempotent per (company, draftId);
 * - begin records the Worker-minted object keys and R2 multipart upload ids;
 * - part records one verified R2 part receipt (etag, bytes, sha256);
 * - complete records one attachment's durable R2 completion plus its
 *   verified `received` representation;
 * - finalize requires EVERY declared attachment complete and verified, then
 *   publishes `sources.uploadFinalized` (idempotent);
 * - accept reuses D1's atomic acceptance, which verifies all attachment
 *   references BEFORE any write and binds source+attachments+ledger together;
 * - reconcile decides orphan collection only for expired, unaccepted,
 *   inactive uploads (never accepted, never mid-retry).
 *
 * Everything in this module is pure so tests/d2 can prove the decisions
 * without a deployment; the live proofs run the same functions through the
 * real Worker, R2 and Convex deployment.
 *
 * SHARED-HOME DECISION (D2 review round 1): this file is the ONE definition
 * of the uploads protocol on BOTH sides of the deployment boundary — the
 * Convex functions import it directly, and the gateway Worker imports it
 * exactly like the existing pure Convex-directory module it already ships
 * (`convex/operations/telemetry/sink.ts`, see apps/gateway/src/telemetry/
 * emit.ts). The gateway must not import Convex-RUNTIME code (the functions
 * that execute inside a deployment), and this module is not that: it pulls
 * in effect Schema and @kiero/contracts only. It deliberately does NOT
 * move into @kiero/contracts, because the step schemas are the gateway
 * channel's vocabulary, not the certified client surface — contracts stays
 * certified-client-only, and mirrors of these bounds/keys/schemas anywhere
 * else (gateway routes, R2 helpers) are hazards, not copies.
 */

import { Schema } from "effect";
import { MediaKind } from "@kiero/contracts";

// ---------------------------------------------------------------------------
// Bounds (checked at every layer; R2 caps the part count at 10_000).
// ---------------------------------------------------------------------------

/** R2 caps multipart uploads at 10_000 parts; Kiero declares a tighter bound. */
export const MAX_PARTS = 1_000;
/** One message carries at most this many media attachments (audio + images). */
export const MAX_ATTACHMENTS = 8;
/** R2 minimum size of every part except the last (enforced gateway-side). */
export const MIN_PART_BYTES = 5 * 1024 * 1024;
/**
 * An active (draft/uploading) upload survives reconciliation while its last
 * activity is more recent than this window (the delayed legitimate retry).
 */
export const ACTIVE_GRACE_MS = 24 * 60 * 60 * 1_000;
/**
 * A finalized-but-unaccepted upload stays recoverable through the ledger for
 * this window before orphan collection may claim it.
 */
export const FINALIZED_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;
/** The version label of the D2 received representation (D5 replaces it). */
export const RECEIVED_TRANSFORM_VERSION = "d2.received/1";

/** Lower-case hex SHA-256 (64 chars), the only accepted part digest form. */
export const Sha256Hex = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
);
export type Sha256Hex = Schema.Schema.Type<typeof Sha256Hex>;

/** The canonical object-key namespace: `companies/<companyId>/uploads/...`. */
export function objectKeyPrefix(companyId: string): string {
  return `companies/${companyId}/uploads/`;
}

/** True when the Worker-minted object key belongs to the tenant's namespace. */
export function objectKeyInTenantNamespace(key: string, companyId: string): boolean {
  return key.startsWith(objectKeyPrefix(companyId));
}

// ---------------------------------------------------------------------------
// Step schemas (the gateway -> Convex uploads channel, NOT the certified
// client surface: the client operations stay `sources.prepareUpload` /
// `sources.resumeUpload` with their certified shapes).
// ---------------------------------------------------------------------------

/** Step names of the uploads channel (closed vocabulary). */
export const UPLOAD_STEP_NAMES = [
  "prepare",
  "begin",
  "part",
  "complete",
  "finalize",
  "reconcile",
] as const;
export type UploadStepName = (typeof UPLOAD_STEP_NAMES)[number];

export const PrepareInput = Schema.Struct({
  draftId: Schema.NonEmptyString,
  parts: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
    Schema.check(Schema.isLessThanOrEqualTo(MAX_PARTS)),
  ),
  // J1 prerequisite repair: a TEXT-ONLY source prepares with mediaKinds: []
  // (attachmentCount 0, no attachment references — D1's documented text-only
  // acceptance semantics; the certified contract's array has no minimum).
  // The previous isMinLength(1) made the PUBLIC prepare command unusable
  // for the one capture mode the first text checkpoint proves; media
  // uploads keep the MAX_ATTACHMENTS bound.
  mediaKinds: Schema.Array(MediaKind).pipe(
    Schema.check(Schema.isMaxLength(MAX_ATTACHMENTS)),
  ),
});
export type PrepareInput = Schema.Schema.Type<typeof PrepareInput>;

export const BeginAttachmentInput = Schema.Struct({
  objectKey: Schema.NonEmptyString,
  r2UploadId: Schema.NonEmptyString,
  kind: MediaKind,
});
export type BeginAttachmentInput = Schema.Schema.Type<typeof BeginAttachmentInput>;

export const BeginInput = Schema.Struct({
  uploadId: Schema.String,
  attachments: Schema.Array(BeginAttachmentInput).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(MAX_ATTACHMENTS)),
  ),
});
export type BeginInput = Schema.Schema.Type<typeof BeginInput>;

export const PartInput = Schema.Struct({
  uploadId: Schema.String,
  attachmentId: Schema.String,
  partNumber: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
  etag: Schema.NonEmptyString,
  bytes: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  sha256Hex: Sha256Hex,
});
export type PartInput = Schema.Schema.Type<typeof PartInput>;

export const CompleteInput = Schema.Struct({
  uploadId: Schema.String,
  attachmentId: Schema.String,
  objectEtag: Schema.NonEmptyString,
  totalBytes: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type CompleteInput = Schema.Schema.Type<typeof CompleteInput>;

export const UploadRefInput = Schema.Struct({ uploadId: Schema.String });
export type UploadRefInput = Schema.Schema.Type<typeof UploadRefInput>;

/** One step envelope of the uploads channel. */
export const UploadStepEnvelope = Schema.Struct({
  step: Schema.Literals([...UPLOAD_STEP_NAMES]),
  input: Schema.Unknown,
});
export type UploadStepEnvelope = Schema.Schema.Type<typeof UploadStepEnvelope>;

// ---------------------------------------------------------------------------
// Part manifests (pure).
// ---------------------------------------------------------------------------

/** One durable R2 part receipt. */
export interface PartReceipt {
  readonly partNumber: number;
  readonly etag: string;
  readonly bytes: number;
  readonly sha256Hex: string;
  readonly receivedAtMs: number;
}

/** Parses a stored manifest; malformed JSON fails as an empty manifest never may. */
export function parseManifest(partsJson: string | undefined): PartReceipt[] {
  if (partsJson === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(partsJson);
    if (!Array.isArray(parsed)) {
      throw new Error("not an array");
    }
    return parsed as PartReceipt[];
  } catch {
    // A ledger row with an unparseable manifest is corrupt, not empty: fail
    // loudly to the caller (which surfaces a sanitized unavailable), never
    // silently restart the manifest (that would drop recorded parts).
    throw new Error("part manifest is not valid JSON");
  }
}

/** Serializes a manifest canonically (ascending by partNumber). */
export function serializeManifest(manifest: PartReceipt[]): string {
  return JSON.stringify([...manifest].sort((a, b) => a.partNumber - b.partNumber));
}

export type PartReceiptDecision =
  | { readonly decision: "record" }
  | { readonly decision: "idempotent" }
  | { readonly decision: "refresh" }
  | { readonly decision: "conflict"; readonly code: "part_receipt_conflict" };

/**
 * The decision for one incoming part receipt against the recorded manifest:
 *
 * - no receipt for the part number yet -> `record`;
 * - an identical receipt (same etag, bytes and digest) -> `idempotent`;
 * - the SAME content (same bytes and digest) under a NEW etag -> `refresh`:
 *   R2 mints a fresh etag on every `uploadPart`, so a client that lost the
 *   response and re-sent identical bytes produces a new etag for the part R2
 *   actually stored. The manifest must carry the LATEST etag (completion
 *   validates etags against the stored parts), so this updates the receipt
 *   instead of conflicting or silently keeping a stale etag;
 * - the same part number with DIFFERENT content (bytes or digest) is a typed
 *   conflict — a client bug, not a resume, and never a silent overwrite of
 *   recorded bytes.
 */
export function decidePartReceipt(
  manifest: readonly PartReceipt[],
  receipt: PartReceipt,
): PartReceiptDecision {
  const existing = manifest.find((entry) => entry.partNumber === receipt.partNumber);
  if (existing === undefined) {
    return { decision: "record" };
  }
  const sameContent =
    existing.bytes === receipt.bytes && existing.sha256Hex === receipt.sha256Hex;
  if (!sameContent) {
    return { decision: "conflict", code: "part_receipt_conflict" };
  }
  if (existing.etag === receipt.etag) {
    return { decision: "idempotent" };
  }
  return { decision: "refresh" };
}

/** Sorted upsert of one receipt (pure; the caller persists the result). */
export function upsertReceipt(manifest: readonly PartReceipt[], receipt: PartReceipt): PartReceipt[] {
  return [...manifest.filter((entry) => entry.partNumber !== receipt.partNumber), receipt].sort(
    (a, b) => a.partNumber - b.partNumber,
  );
}

export type PartNumberValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "part_number_out_of_range" | "part_bound_exceeded" };

/** Part numbers are 1-based and bounded by the declared part plan. */
export function validatePartNumber(partNumber: number, declaredParts: number | undefined): PartNumberValidation {
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    return { ok: false, code: "part_number_out_of_range" };
  }
  if (declaredParts !== undefined && partNumber > declaredParts) {
    return { ok: false, code: "part_bound_exceeded" };
  }
  return { ok: true };
}

/** Strictly ascending part numbers (the client's completion list order). */
export function isStrictlyAscending(partNumbers: readonly number[]): boolean {
  return partNumbers.every((value, index) => index === 0 || value > partNumbers[index - 1]!);
}

/** Sum of the manifest byte counts (the completion cross-check). */
export function manifestBytes(manifest: readonly PartReceipt[]): number {
  return manifest.reduce((total, entry) => total + entry.bytes, 0);
}

// ---------------------------------------------------------------------------
// Orphan reconciliation (pure).
// ---------------------------------------------------------------------------

/** The upload fields the reconciliation decision needs. */
export interface ReconcileUploadView {
  readonly stage: "draft" | "uploading" | "finalized" | "orphaned" | "failed";
  readonly acceptedSourceId?: string | undefined;
  readonly lastActivityAtMs?: number | undefined;
  readonly createdAtMs: number;
}

export type ReconcileDecision =
  | { readonly action: "keep"; readonly reason: "accepted" | "active" | "finalized_within_grace" }
  | { readonly action: "collect"; readonly reason: "expired_unaccepted" | "already_orphaned" };

/**
 * Safe orphan reconciliation. Collection requires ALL of:
 * not accepted (an accepted source's media is canonical data), past the
 * activity grace (a delayed legitimate retry may still land), and — for
 * finalized uploads — past the longer recovery window (completed R2 objects
 * stay recoverable through the ledger). Already-orphaned rows stay
 * collectable so a crashed collection pass can finish.
 */
export function decideReconciliation(upload: ReconcileUploadView, nowMs: number): ReconcileDecision {
  if (upload.acceptedSourceId !== undefined) {
    return { action: "keep", reason: "accepted" };
  }
  if (upload.stage === "orphaned") {
    return { action: "collect", reason: "already_orphaned" };
  }
  const lastActivity = upload.lastActivityAtMs ?? upload.createdAtMs;
  if (upload.stage === "finalized") {
    return nowMs - lastActivity > FINALIZED_GRACE_MS
      ? { action: "collect", reason: "expired_unaccepted" }
      : { action: "keep", reason: "finalized_within_grace" };
  }
  if (upload.stage === "draft" || upload.stage === "uploading") {
    return nowMs - lastActivity > ACTIVE_GRACE_MS
      ? { action: "collect", reason: "expired_unaccepted" }
      : { action: "keep", reason: "active" };
  }
  // Explicitly failed uploads are collected like expired ones.
  return { action: "collect", reason: "already_orphaned" };
}

// ---------------------------------------------------------------------------
// The all-attachments-durable acceptance gate (pure view over rows).
// ---------------------------------------------------------------------------

/** The attachment fields the acceptance gate verifies. */
export interface AttachmentForAcceptance {
  readonly _id: string;
  readonly uploadId: string;
  readonly kind: "audio" | "image";
  readonly completedAtMs?: number | undefined;
  readonly sourceId?: string | undefined;
}

/** The verified `received` representation of one attachment, when present. */
export interface ReceivedRepresentationView {
  readonly attachmentId: string;
  readonly verifiedAtMs?: number | undefined;
}

export type AttachmentGateDecision =
  | {
      readonly ok: true;
      readonly attachmentIds: string[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "attachments_not_finalized"
        | "attachment_declaration_mismatch"
        | "attachment_incomplete"
        | "attachment_not_verified"
        | "attachment_already_bound";
    };

/**
 * THE all-attachments-durable rule: a source with attachments is acceptable
 * only when the upload is finalized, the declaration is fully materialized,
 * EVERY attachment is durably completed in R2 and EVERY attachment has a
 * verified received representation. This gate runs BEFORE the first insert
 * of the acceptance transaction (D1's structural pre-flight pattern), so a
 * failing gate leaves nothing written.
 */
export function decideAttachmentGate(
  uploadStage: "draft" | "uploading" | "finalized" | "orphaned" | "failed",
  declaredCount: number | undefined,
  attachments: readonly AttachmentForAcceptance[],
  representations: readonly ReceivedRepresentationView[],
): AttachmentGateDecision {
  if (attachments.length === 0) {
    // Text-only acceptance: no attachment references to verify.
    return { ok: true, attachmentIds: [] };
  }
  if (uploadStage !== "finalized") {
    return { ok: false, code: "attachments_not_finalized" };
  }
  if (declaredCount !== undefined && declaredCount !== attachments.length) {
    return { ok: false, code: "attachment_declaration_mismatch" };
  }
  const verified = new Set(
    representations.filter((row) => row.verifiedAtMs !== undefined).map((row) => row.attachmentId),
  );
  const ids: string[] = [];
  for (const attachment of attachments) {
    if (attachment.completedAtMs === undefined) {
      return { ok: false, code: "attachment_incomplete" };
    }
    if (!verified.has(attachment._id)) {
      return { ok: false, code: "attachment_not_verified" };
    }
    if (attachment.sourceId !== undefined) {
      return { ok: false, code: "attachment_already_bound" };
    }
    ids.push(attachment._id);
  }
  return { ok: true, attachmentIds: ids };
}
