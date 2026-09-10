/**
 * Source acceptance, project links, extractions and fragments
 * (A2 candidate, certified by A3; completed by D1 for text acceptance).
 *
 * Owning implementers: D1 (accept and publish views), E3/E4 (extraction
 * joins), C5 (withdrawal reads), I3/I4 (export/deletion reads).
 *
 * One immutable logical source with one original: the user-authored text,
 * authorship and send-time snapshot never change; lifecycle transitions
 * (withdraw, purge) are explicit operations with reason, actor and history.
 * One source may concern several projects; project conversations project the
 * same original rather than copying it. Each new STT/vision version is
 * another immutable extraction; historical evidence never silently moves.
 *
 * D1 amendments (the owning lane completes the candidate fragment):
 * - `sources.acceptanceKey`/`acceptanceFingerprint`: the client-generated
 *   logical-source key (the command idempotency key) and a fingerprint of
 *   the first accepted logical payload. A replay of the key returns the same
 *   receipt; the same key with a DIFFERENT payload is a typed idempotency
 *   conflict — never a second source and never an edit of the original.
 * - `sourceProjectLinks.sentAtMs`: the linked source's immutable send time,
 *   denormalized at link time so the project conversation paginates in
 *   conversation order through a real index (the projection never copies
 *   editable content, and `sentAtMs` never changes after acceptance).
 *
 * Tables: sources, sourceProjectLinks, extractions, sourceFragments.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../../schema/shared";
import { ExtractionConfidence } from "@kiero/contracts";

// Pinned to the contracts-side ExtractionConfidence (a number in [0, 1], not
// a literals union): the column's type equals the schema's encoded type, and
// the range itself is enforced by the Effect decoder at the boundary.
const extractionConfidence: ValueValidator<Encoded<typeof ExtractionConfidence>> =
  v.float64();

export const acceptTables = {
  /** One immutable logical message ("Wiadomość źródłowa", CONTEXT.md). */
  sources: defineTable({
    companyId: shared.companyId,
    authorUserId: shared.userId,
    /** The user's own words; immutable after acceptance, corrections are new sources. */
    authorText: v.string(),
    /** Original send time and zone snapshot anchor relative language. */
    sentAtMs: shared.tsMs,
    sentAtTimezone: v.string(),
    /** Processing latency starts here: all required attachments are durable. */
    fullyAcceptedAtMs: shared.tsMs,
    lifecycle: v.union(
      v.literal("active"),
      v.literal("withdrawn"),
      v.literal("purged"),
    ),
    withdrawnReason: v.optional(v.string()),
    withdrawnAtMs: v.optional(shared.tsMs),
    /**
     * C5 amendment (additive, flagged): the user who executed the explicit
     * withdrawal — "withdrawal records actor, time and reason on the same
     * immutable D1 source" (issue #28). The recomputation's marking
     * revisions record the same actor.
     */
    withdrawnByUserId: v.optional(shared.userId),
    purgedAtMs: v.optional(shared.tsMs),
    /**
     * The client-generated logical-source key (the accepting command's
     * idempotency key), when one was supplied. Unique per company: one
     * logical source per key, retries return the same source.
     */
    acceptanceKey: v.optional(v.string()),
    /**
     * SHA-256 of the first accepted logical payload. A replay of the same
     * acceptance key with a different payload is refused as an idempotency
     * conflict instead of editing the immutable original.
     */
    acceptanceFingerprint: v.optional(v.string()),
  })
    .index("by_company_order", ["companyId", "sentAtMs"])
    .index("by_company_acceptance_key", ["companyId", "acceptanceKey"]),

  /** Which projects one source concerns; reassignment keeps read state. */
  sourceProjectLinks: defineTable({
    sourceId: shared.sourceId,
    projectId: shared.projectId,
    assignedByUserId: shared.userId,
    assignedAtMs: shared.tsMs,
    /** The source's immutable send time, copied for conversation-ordered reads. */
    sentAtMs: shared.tsMs,
  })
    .index("by_project_source", ["projectId", "sourceId"])
    .index("by_project_order", ["projectId", "sentAtMs"])
    .index("by_source", ["sourceId"]),

  /** Immutable extraction version over a source or representation. */
  extractions: defineTable({
    sourceId: shared.sourceId,
    representationId: v.optional(shared.mediaRepresentationId),
    kind: v.union(v.literal("stt"), v.literal("vision"), v.literal("text")),
    pipelineVersion: v.string(),
    model: v.string(),
    provider: v.string(),
    /** How sure the reader was about the bytes; separate from knowledge state. */
    confidence: v.optional(extractionConfidence),
    processingRunId: shared.processingRunId,
    createdAtMs: shared.tsMs,
  })
    .index("by_source_kind", ["sourceId", "kind"])
    .index("by_run", ["processingRunId"]),

  /** The part of a source a finding is grounded in, with stable coordinates. */
  sourceFragments: defineTable({
    extractionId: shared.extractionId,
    sourceId: shared.sourceId,
    anchor: v.union(
      v.object({ _tag: v.literal("text_range"), startOffset: v.float64(), endOffset: v.float64() }),
      v.object({ _tag: v.literal("audio_interval"), startMs: v.float64(), endMs: v.float64() }),
      v.object({
        _tag: v.literal("image_region"),
        x: v.float64(),
        y: v.float64(),
        width: v.float64(),
        height: v.float64(),
      }),
      v.object({ _tag: v.literal("whole_source") }),
    ),
    createdAtMs: shared.tsMs,
  })
    .index("by_source", ["sourceId"])
    .index("by_extraction", ["extractionId"]),
} as const;
