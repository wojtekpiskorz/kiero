/**
 * Source acceptance, project links, extractions and fragments
 * (candidate fragment, A2).
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
    /** Processing latency starts here: all required attachments durable. */
    fullyAcceptedAtMs: shared.tsMs,
    lifecycle: v.union(
      v.literal("active"),
      v.literal("withdrawn"),
      v.literal("purged"),
    ),
    withdrawnReason: v.optional(v.string()),
    withdrawnAtMs: v.optional(shared.tsMs),
    purgedAtMs: v.optional(shared.tsMs),
  }).index("by_company_order", ["companyId", "sentAtMs"]),

  /** Which projects one source concerns; reassignment keeps read state. */
  sourceProjectLinks: defineTable({
    sourceId: shared.sourceId,
    projectId: shared.projectId,
    assignedByUserId: shared.userId,
    assignedAtMs: shared.tsMs,
  })
    .index("by_project_source", ["projectId", "sourceId"])
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
