/**
 * Upload and retained-media tables (A2 candidate, certified by A3;
 * completed by D2 for resumable uploads and the acceptance gate).
 *
 * Owning implementers: D2 (resumable uploads and atomic acceptance),
 * D5 (photo normalization and retained representations), D3 (range reads).
 *
 * A source is accepted only after all required attachments are durable;
 * finalized objects cannot be overwritten by stale retries (server-owned
 * object identity). The retained representation is the verified archival
 * evidence; the received file may be removed only after the retained one is
 * verified, and is kept on unsupported conversion, failure or unresolved
 * quality.
 *
 * D2 amendments (the owning lane completes the candidate fragment; every
 * added column is OPTIONAL so D1's text-only seed fixtures stay valid):
 *
 * - `uploads.draftId/attachmentCount/declaredKinds/declaredParts`: the
 *   client's stable draft identity and its declaration (media kinds and the
 *   part bound), recorded at prepare so acceptance can later verify the WHOLE
 *   declaration and begin can validate the presented session against it.
 * - `uploads.lastActivityAtMs`: the reconciliation grace anchor. Every
 *   protocol step (begin, part, complete, finalize, acceptance) refreshes
 *   it, so a delayed legitimate retry is never garbage-collected.
 * - `uploads.acceptedSourceId`: set inside the D1 acceptance transaction
 *   (with the attachments' `sourceId`), atomically with the source. An
 *   accepted upload is never collected by orphan reconciliation.
 * - `uploads.orphanedAtMs`: when reconciliation marked the upload orphaned.
 * - `attachments.r2UploadId/partsJson/completedAtMs/r2ObjectEtag`: the
 *   Worker-owned R2 multipart identity, the durable part manifest (R2 parts,
 *   not browser chunks and not media segments), and the durable
 *   completion+readability record. `receivedBytes` is the manifest byte sum
 *   once completed.
 *
 * Vocabulary (architecture protocol step 2): browser chunks are the client's
 * slicing concern; R2 parts are the multipart identities this ledger
 * records; media segments are D6's processing units over accepted audio.
 *
 * Tables: uploads, attachments, mediaRepresentations.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../../schema/shared";
import { MediaKind, MediaRepresentationRole, UploadStage } from "@kiero/contracts";

// Vocabulary pins: drift against the contracts-side schemas fails typecheck.

const uploadStage: ValueValidator<Encoded<typeof UploadStage>> = v.union(
  v.literal("draft"),
  v.literal("uploading"),
  v.literal("finalized"),
  v.literal("orphaned"),
  v.literal("failed"),
);

const mediaKind: ValueValidator<Encoded<typeof MediaKind>> = v.union(
  v.literal("audio"),
  v.literal("image"),
);

const mediaRepresentationRole: ValueValidator<Encoded<typeof MediaRepresentationRole>> =
  v.union(
    v.literal("received"),
    v.literal("retained"),
    v.literal("thumbnail"),
    v.literal("processing"),
  );

export const uploadsTables = {
  /** Resumable upload ledger; reconciles R2 completion with Convex acceptance. */
  uploads: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    stage: uploadStage,
    /** The upload's TOTAL recorded R2 part receipts across ALL attachments. */
    partCount: shared.counter,
    createdAtMs: shared.tsMs,
    finalizedAtMs: v.optional(shared.tsMs),
    orphanReason: v.optional(v.string()),
    /**
     * The client's stable draft identity (protocol step 1). One draft of one
     * company maps to one ledger row: prepare replays return the same row.
     */
    draftId: v.optional(v.string()),
    /** How many attachments the prepare declaration requires (mediaKinds). */
    attachmentCount: v.optional(shared.counter),
    /**
     * The declared media kinds, in declaration order (prepare writes them).
     * Begin validates the presented session against THIS declaration, so an
     * audio attachment can never be swapped for an image mid-upload.
     */
    declaredKinds: v.optional(v.array(mediaKind)),
    /** The declared part bound of the whole upload (>= every recorded part no). */
    declaredParts: v.optional(shared.counter),
    /** Reconciliation grace anchor; refreshed by every protocol step. */
    lastActivityAtMs: v.optional(shared.tsMs),
    /** Set atomically inside acceptance; accepted uploads are never collected. */
    acceptedSourceId: v.optional(shared.sourceId),
    orphanedAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_stage", ["companyId", "stage"])
    .index("by_company_draft", ["companyId", "draftId"]),

  /** One logical attachment (audio or image) of a draft or accepted source. */
  attachments: defineTable({
    uploadId: shared.uploadId,
    sourceId: v.optional(shared.sourceId),
    kind: mediaKind,
    /** Server-owned object identity; stale retries cannot replace finalized bytes. */
    objectKey: v.string(),
    receivedBytes: v.optional(v.float64()),
    contentHash: v.optional(v.string()),
    createdAtMs: shared.tsMs,
    /** The Worker-created R2 multipart upload id (resume handle). */
    r2UploadId: v.optional(v.string()),
    /**
     * Canonical JSON part manifest, ascending by partNumber:
     * [{partNumber, etag, bytes, sha256Hex, receivedAtMs}]. R2 parts, not
     * browser chunks (client slicing) and not media segments (D6).
     */
    partsJson: v.optional(v.string()),
    /** Durable R2 completion + readability verification time (gateway-verified). */
    completedAtMs: v.optional(shared.tsMs),
    /** Etag of the completed R2 object (content-derived receipt identity). */
    r2ObjectEtag: v.optional(v.string()),
  })
    .index("by_upload", ["uploadId"])
    .index("by_source", ["sourceId"])
    .index("by_object_key", ["objectKey"]),

  /** Versioned representation of an attachment (received/retained/thumbnail). */
  mediaRepresentations: defineTable({
    attachmentId: shared.attachmentId,
    role: mediaRepresentationRole,
    objectKey: v.string(),
    contentHash: v.string(),
    transformVersion: v.string(),
    width: v.optional(v.float64()),
    height: v.optional(v.float64()),
    durationMs: v.optional(v.float64()),
    /** Present once the archival representation is verified durable. */
    verifiedAtMs: v.optional(shared.tsMs),
    createdAtMs: shared.tsMs,
    /**
     * D5 amendment (the fragment's "+D5" ownership in the contracts
     * manifest): object size in bytes of this representation's R2 object.
     */
    bytes: v.optional(v.float64()),
    /** D5: the representation's content type (e.g. `image/webp`). */
    mimeType: v.optional(v.string()),
    /**
     * D5: present once the temporary received bytes were removed AFTER the
     * retained representation verified durable (the row stays as the
     * provenance record of what was received).
     */
    removedAtMs: v.optional(shared.tsMs),
    /**
     * D5: the typed honest outcome that kept the RECEIVED original as the
     * retained representation (the CONTEXT.md exception). Closed vocabulary
     * owned by convex/processing/images/protocol.ts (pinned at runtime by
     * tests/d5, the fragments.test.ts pattern for fragment-local unions).
     */
    exceptionKind: v.optional(
      v.union(
        v.literal("oversized_input"),
        v.literal("unsupported_input"),
        v.literal("conversion_failed"),
        v.literal("quality_unresolved"),
      ),
    ),
  }).index("by_attachment_role", ["attachmentId", "role"]),
} as const;
