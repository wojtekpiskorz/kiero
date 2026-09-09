/**
 * Upload and retained-media tables (candidate fragment, A2).
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
 * Tables: uploads, attachments, mediaRepresentations.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const uploadsTables = {
  /** Resumable upload ledger; reconciles R2 completion with Convex acceptance. */
  uploads: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    stage: v.union(
      v.literal("draft"),
      v.literal("uploading"),
      v.literal("finalized"),
      v.literal("orphaned"),
      v.literal("failed"),
    ),
    partCount: v.float64(),
    createdAtMs: shared.tsMs,
    finalizedAtMs: v.optional(shared.tsMs),
    orphanReason: v.optional(v.string()),
  }).index("by_company_stage", ["companyId", "stage"]),

  /** One logical attachment (audio or image) of a draft or accepted source. */
  attachments: defineTable({
    uploadId: shared.uploadId,
    sourceId: v.optional(shared.sourceId),
    kind: v.union(v.literal("audio"), v.literal("image")),
    /** Server-owned object identity; stale retries cannot replace finalized bytes. */
    objectKey: v.string(),
    receivedBytes: v.optional(v.float64()),
    contentHash: v.optional(v.string()),
    createdAtMs: shared.tsMs,
  })
    .index("by_upload", ["uploadId"])
    .index("by_source", ["sourceId"]),

  /** Versioned representation of an attachment (received/retained/thumbnail). */
  mediaRepresentations: defineTable({
    attachmentId: shared.attachmentId,
    role: v.union(
      v.literal("received"),
      v.literal("retained"),
      v.literal("thumbnail"),
      v.literal("processing"),
    ),
    objectKey: v.string(),
    contentHash: v.string(),
    transformVersion: v.string(),
    width: v.optional(v.float64()),
    height: v.optional(v.float64()),
    durationMs: v.optional(v.float64()),
    /** Present once the archival representation is verified durable. */
    verifiedAtMs: v.optional(shared.tsMs),
    createdAtMs: shared.tsMs,
  }).index("by_attachment_role", ["attachmentId", "role"]),
} as const;
