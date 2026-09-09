/**
 * Staged media and publication states.
 *
 * Upload staging is an explicit lifecycle: a draft becomes a resumable
 * upload, the worker finalizes durable objects, and a source is accepted
 * only after all required attachments are durable (R2 completion and Convex
 * acceptance are separate systems; see architecture protocol steps 1–4).
 * Publication of checked memory changes is likewise staged and atomic per
 * dependent group.
 *
 * Certified by A3 on 2026-09-09 (docs/implementation/contracts/README.md).
 */

import { Schema } from "effect";

/** Lifecycle of one uploaded object before source acceptance. */
export const UploadStage = Schema.Literals([
  "draft",
  "uploading",
  "finalized",
  "orphaned",
  "failed",
]);
export type UploadStage = Schema.Schema.Type<typeof UploadStage>;

/**
 * Role of one media representation of an attachment. `received` is the input
 * file; `retained` is the verified durable archival representation kept as
 * honest evidence; `thumbnail` is derived; `processing` marks an in-progress
 * normalization whose failure retains the original.
 */
export const MediaRepresentationRole = Schema.Literals([
  "received",
  "retained",
  "thumbnail",
  "processing",
]);
export type MediaRepresentationRole =
  Schema.Schema.Type<typeof MediaRepresentationRole>;

/** Lifecycle of a checked memory change before it becomes current state. */
export const PublicationState = Schema.Literals([
  "prepared",
  "publishing",
  "published",
  "failed",
  "superseded",
]);
export type PublicationState = Schema.Schema.Type<typeof PublicationState>;

/** Lifecycle of a firm export archive. */
export const ExportState = Schema.Literals([
  "requested",
  "building",
  "available",
  "expired",
  "invalidated",
]);
export type ExportState = Schema.Schema.Type<typeof ExportState>;
