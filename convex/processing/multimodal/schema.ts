/**
 * Vision-extraction order tables (E4 fragment: the multimodal join).
 *
 * Owning implementer: E4 (`convex/processing/multimodal/**`); H4 inspects
 * the rows, J2 composes them into the cross-module join surface.
 *
 * Vocabulary pins (architecture + CONTEXT.md):
 * - One `visionOrders` row is ONE vision-extraction order over one VERIFIED
 *   retained image representation (D5's deterministic selection defines the
 *   inspectable representation; a re-normalization is a NEW representation
 *   and therefore a NEW order — coordinates never move under old anchors).
 * - The order is NOT a durable job of its own: the join workflow drives it
 *   through idempotent steps (resolve bytes -> one bounded provider pass ->
 *   idempotent extraction registration). The row carries the state so a
 *   later join (or a linked reanalysis) resumes instead of re-charging the
 *   provider.
 * - Byte channels follow D6's model: `media_worker` is production (the
 *   configured executor over R2; typed honest refusal leaves the order
 *   blocked-resumable), `proof_inline` is the guarded dev-proof channel
 *   whose stash is sha-256-pinned to the retained representation's
 *   `contentHash` at order time.
 * - "Both image routes failing leaves image extraction pending": provider
 *   exhaustion records a sanitized `lastErrorKind` and keeps the order
 *   `pending` (resumable), never a fake complete and never terminal.
 *
 * E4 registration of the fragment (the sanctioned small coordinated change,
 * docs/implementation/contracts/README.md): the table name is added to
 * `TABLE_ID_NAMES` in @kiero/contracts and the import/spread in
 * convex/schema.ts.
 *
 * Tables: visionOrders.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const multimodalTables = {
  /**
   * One vision-extraction order over one verified retained representation.
   * Immutable fields: attachment/representation/run linkage, pipeline and
   * routing versions, bytes channel. Only state/lastErrorKind/extractionId
   * ever change.
   */
  visionOrders: defineTable({
    companyId: shared.companyId,
    sourceId: shared.sourceId,
    attachmentId: shared.attachmentId,
    /** The EXACT retained representation whose pixels are read (the coordinate space). */
    representationId: shared.mediaRepresentationId,
    /** The run whose journal the join's vision step anchors to. */
    processingRunId: shared.processingRunId,
    /** E4 vision pipeline version of this order (immutable per order). */
    pipelineVersion: v.string(),
    /** E2 routing configuration the vision route ran under (immutable per order). */
    visionRoutingVersion: v.string(),
    /** How the order resolves representation bytes (visible, never implicit). */
    bytesChannel: v.union(
      /** Production: the configured media executor over R2. */
      v.literal("media_worker"),
      /**
       * Guarded dev-proof channel only: the proof script supplies bytes
       * sha-pinned to the retained representation's contentHash (D6's
       * pattern; production flows never use it).
       */
      v.literal("proof_inline"),
    ),
    state: v.union(
      /** Ordered; bytes not yet resolved or the provider pass not yet run. */
      v.literal("pending"),
      /** Extraction version registered (terminal for this order). */
      v.literal("complete"),
      /** Terminal order-level failure (e.g. representation withdrawn). */
      v.literal("failed"),
    ),
    /** Sanitized closed error kind of the last failed pass, if any. */
    lastErrorKind: v.optional(v.string()),
    /** The immutable extraction version registered at completion. */
    extractionId: v.optional(shared.extractionId),
    /**
     * The verbatim recorded observations at completion (bounded JSON of
     * text+region pairs, the vision counterpart of D6's per-segment text):
     * the durable record the joined analysis reads observations from. The
     * extraction's fragments carry the same regions as honest anchors.
     */
    observationsJson: v.optional(v.string()),
    /** Proof channel only: pinned bytes sha256 + the guarded stash itself. */
    proofBytesSha256: v.optional(v.string()),
    proofImageBase64: v.optional(v.string()),
    createdAtMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
    finishedAtMs: v.optional(shared.tsMs),
  })
    .index("by_attachment", ["attachmentId"])
    .index("by_representation", ["representationId"])
    .index("by_source", ["sourceId"]),
} as const;
