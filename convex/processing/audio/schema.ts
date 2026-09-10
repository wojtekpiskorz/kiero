/**
 * Audio transcript tables (D6 fragment: resumable long-audio STT).
 *
 * Owning implementer: D6 (segmentation + per-segment durable STT), E3/E4
 * consume the extraction versions and fragments; H4 inspects the rows.
 *
 * Vocabulary pins (architecture + CONTEXT.md):
 * - One "Wiadomość źródłowa" keeps ONE original audio attachment; segment
 *   processing NEVER creates new source messages. `audioTranscripts` rows
 *   are processing orders over an accepted attachment, not messages.
 * - Browser chunks (client slicing), R2 upload parts (D2's multipart
 *   manifest) and STT segments (these rows) are DISTINCT vocabularies.
 * - The segment manifest (index, startMs, endMs over the ORIGINAL audio
 *   timeline) is immutable once planned: rows are inserted once and only
 *   attempt/outcome columns ever change. A new segmentation or STT
 *   configuration is a NEW transcript order and, on completion, a NEW
 *   immutable `extractions` version — coordinates never silently move.
 * - A complete transcript requires EVERY required segment; anything less
 *   leaves the order `pending`/`partial` (never a fake `complete`), which
 *   is the visible state E3's coverage model and E4's joins consume.
 *
 * D6 registration of the fragment (the sanctioned small coordinated change
 * named in docs/implementation/contracts/README.md): the two table names
 * are added to `TABLE_ID_NAMES` in @kiero/contracts and the composition
 * import/spread in convex/schema.ts.
 *
 * Tables: audioTranscripts, audioSegments.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

/** How one order resolves retained object bytes (visible, never implicit). */
const bytesChannel = v.union(
  /** Production: the EU media executor's segment protocol over R2. */
  v.literal("media_worker"),
  /**
   * Guarded dev-proof channel only: the proof script supplies the SAME
   * bytes it uploaded through D2 (length- and sha-pinned at order time),
   * because the container runtime + R2 S3 token are BLOCKED owner actions.
   * Rows record this channel honestly; production flows never use it.
   */
  v.literal("proof_inline"),
);

export const audioTables = {
  /**
   * One STT order (transcript version head) over one accepted audio
   * attachment. Immutable fields: attachment/representation/run linkage,
   * segmentation config, duration and manifest counters once planned.
   */
  audioTranscripts: defineTable({
    companyId: shared.companyId,
    sourceId: shared.sourceId,
    attachmentId: shared.attachmentId,
    /** The representation whose bytes are segmented (received or retained). */
    representationId: shared.mediaRepresentationId,
    /** The source's initial analysis run; the extraction version lands on it. */
    processingRunId: shared.processingRunId,
    /** D6 pipeline version of this order (immutable per order). */
    pipelineVersion: v.string(),
    /** E2 routing configuration the STT route ran under (immutable per order). */
    sttRoutingVersion: v.string(),
    /** Canonical segmentation config JSON (immutable per order). */
    segmentationConfigJson: v.string(),
    bytesChannel,
    /** Planned total duration in ms; present once the manifest is planned. */
    audioDurationMs: v.optional(v.float64()),
    /**
     * Planning-time sha-256 of the canonical interval manifest; assembly
     * re-derives it from the stored rows and refuses publication if the
     * coordinates moved (immutable-manifest enforcement).
     */
    manifestSha256: v.optional(v.string()),
    /** Required segment count; 0 until planned, immutable once set. */
    segmentCount: shared.counter,
    state: v.union(
      /** Ordered, manifest not yet planned (or planning blocked: bytes source). */
      v.literal("planning"),
      /** Planned; no segment has succeeded yet. */
      v.literal("pending"),
      /** Running or between resumes: some segments succeeded, some not. */
      v.literal("partial"),
      /** EVERY required segment succeeded; extraction version registered. */
      v.literal("complete"),
      /** Terminal order-level failure (e.g. attachment withdrawn mid-run). */
      v.literal("failed"),
    ),
    /** Sanitized closed error kind of the last order-level failure, if any. */
    lastErrorKind: v.optional(v.string()),
    /** The durable job key of this order (stable across resumes). */
    jobKey: v.optional(v.string()),
    /** The immutable extraction version registered at completion. */
    extractionId: v.optional(shared.extractionId),
    /** Proof channel only: pinned object sha256 + the guarded stash itself. */
    proofBytesSha256: v.optional(v.string()),
    proofAudioBase64: v.optional(v.string()),
    createdAtMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
    finishedAtMs: v.optional(shared.tsMs),
  })
    .index("by_attachment", ["attachmentId"])
    .index("by_source", ["sourceId"])
    .index("by_company_state", ["companyId", "state"]),

  /**
   * One decodable STT segment: the immutable manifest entry (index,
   * original-time interval) doubles as the resumable per-segment checkpoint
   * and result row. Time anchors are ORIGINAL audio time; attempt outcome
   * columns are the only mutable part.
   */
  audioSegments: defineTable({
    transcriptId: v.id("audioTranscripts"),
    /** Order within the transcript; 0-based, contiguous, gap-free. */
    segmentIndex: shared.counter,
    /** Original-time interval [startMs, endMs) this segment anchors. */
    startMs: v.float64(),
    endMs: v.float64(),
    durationMs: v.float64(),
    state: v.union(
      // No "running" state (review finding 3): D6 never wrote it — an
      // interrupted pass leaves the segment `pending`, which resume retries.
      v.literal("pending"),
      v.literal("succeeded"),
      v.literal("failed"),
    ),
    /** Bounded attempt count for this segment across resumes. */
    attempts: shared.counter,
    /** Sanitized closed error kind of the last failed attempt, if any. */
    lastErrorKind: v.optional(v.string()),
    /** Verbatim provider transcript of this segment (present iff succeeded). */
    text: v.optional(v.string()),
    /** Serving metadata (present iff succeeded): the models that served. */
    servedModels: v.optional(v.array(v.string())),
    provider: v.optional(v.string()),
    routingConfigVersion: v.optional(v.string()),
    /** Latency of the serving attempt in ms. */
    latencyMs: v.optional(v.float64()),
    usageTokens: v.optional(v.float64()),
    /** Provider-reported audio seconds for this segment, when reported. */
    audioSeconds: v.optional(v.float64()),
    costUsd: v.optional(v.float64()),
    lastAttemptAtMs: v.optional(shared.tsMs),
    succeededAtMs: v.optional(shared.tsMs),
  }).index("by_transcript_index", ["transcriptId", "segmentIndex"]),
} as const;
