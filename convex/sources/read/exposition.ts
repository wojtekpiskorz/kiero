/**
 * Source-history exposition reads (H3, additive and flagged on the H1
 * memory-exposition precedent): the full dossier of ONE immutable source
 * and the paginated evidence chain that rests on it.
 *
 * Issue #51: "Source detail shows immutable authored content, all retained
 * representations, transcript/OCR segments and time/coordinate anchors,
 * project fragments, findings/provenance, corrections, withdrawals, and
 * dependent recomputation status", and "Paginate history rather than
 * loading one growing object". Two read-only cores serve that through the
 * SAME tenant rules as D1's conversation views: the company resolves from
 * the verified context, the source row is tenant-checked, and every
 * joined row (links, representations, transcripts, segments, vision
 * orders, findings, revisions) is read through its own index — never
 * through a client-supplied scope.
 *
 * What each core answers:
 *
 * - `readSourceExpositionRows`: the dossier. The immutable original
 *   (text, author, send snapshot), lifecycle INCLUDING the withdrawal
 *   record (reason, actor, time — history, never deletion), processing
 *   state, project links, every attachment with ALL retained/received
 *   representations (verification and D5 removal state included; which
 *   representation serves bytes stays D3's server-side selection, this
 *   read never predicts it), every transcript order with its verbatim
 *   segments (original-time anchors), every vision order with its
 *   observations (pixel anchors against the pinned representation's own
 *   coordinate space) and every fragment anchor of the source.
 *
 * - `readSourceEvidenceRows`: the evidence chain, PAGINATED over
 *   `evidenceLinks.by_source`. Each row is one witness link joined to the
 *   revision it supported AND to the finding's CURRENT projection: the
 *   boss sees which finding rested on which fragment of this source, and
 *   what that finding says NOW (a later correction, or a withdrawal
 *   marking that leaves it `updating` — C5's recomputation status).
 */

import { Schema } from "effect";
import { type ClosedError } from "@kiero/contracts";
import { forbiddenError, notFoundError, type RequestContext } from "@kiero/runtime";
import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { deriveProcessingState } from "./rows";

// ---------------------------------------------------------------------------
// Wire schemas (decoded at the untrusted boundary like D1's own rows)
// ---------------------------------------------------------------------------

/** The four anchor families of a "Fragment źródła" (CONTEXT.md / E4). */
export const FragmentAnchor = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("text_range"),
    startOffset: Schema.Number,
    endOffset: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal("audio_interval"),
    startMs: Schema.Number,
    endMs: Schema.Number,
  }),
  Schema.Struct({
    _tag: Schema.Literal("image_region"),
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({ _tag: Schema.Literal("whole_source") }),
]);
export type FragmentAnchor = Schema.Schema.Type<typeof FragmentAnchor>;

/** One retained/received representation as the dossier lists it. */
const RepresentationWireRow = Schema.Struct({
  representationId: Schema.String,
  role: Schema.Literals(["received", "retained", "thumbnail", "processing"]),
  /** Present once verified durable (absent rows never serve reads). */
  verifiedAtMs: Schema.NullOr(Schema.Number),
  /** D5's received-byte cleanup marker: the object is deliberately gone. */
  removedAtMs: Schema.NullOr(Schema.Number),
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
  mimeType: Schema.NullOr(Schema.String),
  bytes: Schema.NullOr(Schema.Number),
  /** D5's typed honest outcome that kept the RECEIVED original retained. */
  exceptionKind: Schema.NullOr(Schema.String),
});

/** One attachment with every representation ever recorded for it. */
const AttachmentWireRow = Schema.Struct({
  attachmentId: Schema.String,
  kind: Schema.Literals(["audio", "image"]),
  representations: Schema.Array(RepresentationWireRow),
});

/** One STT segment: verbatim text plus its original-time interval. */
const SegmentWireRow = Schema.Struct({
  segmentIndex: Schema.Number,
  startMs: Schema.Number,
  endMs: Schema.Number,
  state: Schema.Literals(["pending", "succeeded", "failed"]),
  /** Verbatim provider transcript (present iff succeeded). */
  text: Schema.NullOr(Schema.String),
});

/** One transcript order (D6) with its complete segment manifest. */
const TranscriptWireRow = Schema.Struct({
  transcriptId: Schema.String,
  state: Schema.Literals(["planning", "pending", "partial", "complete", "failed"]),
  audioDurationMs: Schema.NullOr(Schema.Number),
  pipelineVersion: Schema.String,
  segmentCount: Schema.Number,
  segments: Schema.Array(SegmentWireRow),
});

/** One OCR observation: read text plus its pixel region (E4). */
const ObservationWireRow = Schema.Struct({
  text: Schema.String,
  region: Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }),
});

/** One vision order (E4) with its observations and coordinate space. */
const VisionOrderWireRow = Schema.Struct({
  orderId: Schema.String,
  state: Schema.Literals(["pending", "complete", "failed"]),
  pipelineVersion: Schema.String,
  /** The image attachment this order read (per-attachment correlation). */
  attachmentId: Schema.String,
  /** The EXACT representation whose pixels were read (coordinate space). */
  representationId: Schema.String,
  spaceWidth: Schema.NullOr(Schema.Number),
  spaceHeight: Schema.NullOr(Schema.Number),
  /** Verbatim recorded observations (present iff complete). */
  observations: Schema.Array(ObservationWireRow),
});

/** One fragment of this source, with its stable anchor. */
const FragmentWireRow = Schema.Struct({
  fragmentId: Schema.String,
  extractionId: Schema.String,
  anchor: FragmentAnchor,
});

/** The full source dossier (one immutable original, everything retained). */
export const SourceExpositionRow = Schema.Struct({
  sourceId: Schema.String,
  authorUserId: Schema.String,
  /** The immutable original text; corrections are new sources. */
  authorText: Schema.String,
  sentAtMs: Schema.Number,
  sentAtTimezone: Schema.String,
  fullyAcceptedAtMs: Schema.Number,
  lifecycle: Schema.Literals(["active", "withdrawn", "purged"]),
  processingState: Schema.Literals(["accepted", "processing", "partial", "processed", "failed"]),
  projectIds: Schema.Array(Schema.String),
  /** The withdrawal record: present iff lifecycle is "withdrawn". */
  withdrawnReason: Schema.NullOr(Schema.String),
  withdrawnByUserId: Schema.NullOr(Schema.String),
  withdrawnAtMs: Schema.NullOr(Schema.Number),
  attachments: Schema.Array(AttachmentWireRow),
  transcripts: Schema.Array(TranscriptWireRow),
  visionOrders: Schema.Array(VisionOrderWireRow),
  fragments: Schema.Array(FragmentWireRow),
});
export type SourceExpositionRow = Schema.Schema.Type<typeof SourceExpositionRow>;

/** One witness link joined to the finding's current state (paginated). */
export const SourceEvidenceRow = Schema.Struct({
  /** The finding this witness supports (identity for /pamiec links). */
  findingId: Schema.String,
  semanticKey: Schema.String,
  scope: Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("company") }),
    Schema.Struct({ _tag: Schema.Literal("project"), projectId: Schema.String }),
  ]),
  /** The witness link itself: which revision, which fragment, what kind. */
  supportKind: Schema.Literals([
    "support",
    "independent_corroboration",
    "derivation",
    "supersession",
  ]),
  citedRevisionId: Schema.String,
  citedRevision: Schema.Number,
  // E7 amendment (additive, flagged): the reassignment scope marking joins
  // the origin vocabulary on both the cited and the current revision.
  citedOrigin: Schema.Literals([
    "publication",
    "correction",
    "withdrawal_marking",
    "reassignment_marking",
  ]),
  citedRecordedAtMs: Schema.Number,
  fragmentId: Schema.NullOr(Schema.String),
  fragmentAnchor: Schema.NullOr(FragmentAnchor),
  /** The finding's CURRENT projection (wire forms, like H1's history read). */
  currentRevisionId: Schema.NullOr(Schema.String),
  currentRevision: Schema.NullOr(Schema.Number),
  currentKnowledgeState: Schema.NullOr(Schema.Unknown),
  currentValue: Schema.NullOr(Schema.Unknown),
  currentOrigin: Schema.NullOr(
    Schema.Literals([
      "publication",
      "correction",
      "withdrawal_marking",
      "reassignment_marking",
    ]),
  ),
  currentReason: Schema.NullOr(Schema.String),
  currentRecordedAtMs: Schema.NullOr(Schema.Number),
  /** True when a newer revision replaced the one this source supported. */
  supersededByNewerRevision: Schema.Boolean,
});
export type SourceEvidenceRow = Schema.Schema.Type<typeof SourceEvidenceRow>;

/** One page of the evidence chain (Convex pagination shape). */
export const SourceEvidencePage = Schema.Struct({
  page: Schema.Array(SourceEvidenceRow),
  isDone: Schema.Boolean,
  continueCursor: Schema.String,
});
export type SourceEvidencePage = Schema.Schema.Type<typeof SourceEvidencePage>;

type ReadResult<T> =
  | { readonly ok: true; readonly row: T }
  | { readonly ok: false; readonly error: ClosedError };

type PageResult =
  | { readonly ok: true; readonly page: SourceEvidencePage }
  | { readonly ok: false; readonly error: ClosedError };

/** How many segments one transcript read keeps (bounded, long audio included). */
const MAX_SEGMENTS_PER_TRANSCRIPT = 500;

/** How many observations one vision order read keeps (E4's own bound is 32). */
const MAX_OBSERVATIONS_PER_ORDER = 64;

// ---------------------------------------------------------------------------
// The dossier core
// ---------------------------------------------------------------------------

/** The tenant-checked source row or the uniform refusal. */
async function requireSourceRow(
  db: QueryCtx["db"],
  companyId: Id<"companies">,
  sourceId: Id<"sources">,
): Promise<Doc<"sources"> | null> {
  const source = await db.get(sourceId);
  if (source === null || source.companyId !== companyId) {
    return null;
  }
  return source;
}

async function attachmentsOf(
  db: QueryCtx["db"],
  sourceId: Id<"sources">,
): Promise<SourceExpositionRow["attachments"]> {
  const attachments = await db
    .query("attachments")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  return Promise.all(
    attachments.map(async (attachment) => ({
      attachmentId: attachment._id as string,
      kind: attachment.kind as "audio" | "image",
      representations: (
        await db
          .query("mediaRepresentations")
          .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachment._id))
          .collect()
      ).map((representation) => ({
        representationId: representation._id as string,
        role: representation.role,
        verifiedAtMs: representation.verifiedAtMs ?? null,
        removedAtMs: representation.removedAtMs ?? null,
        width: representation.width ?? null,
        height: representation.height ?? null,
        durationMs: representation.durationMs ?? null,
        mimeType: representation.mimeType ?? null,
        bytes: representation.bytes ?? null,
        exceptionKind: representation.exceptionKind ?? null,
      })),
    })),
  );
}

async function transcriptsOf(
  db: QueryCtx["db"],
  sourceId: Id<"sources">,
): Promise<SourceExpositionRow["transcripts"]> {
  const transcripts = await db
    .query("audioTranscripts")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  return Promise.all(
    transcripts.map(async (transcript) => {
      const segments = (
        await db
          .query("audioSegments")
          .withIndex("by_transcript_index", (q) => q.eq("transcriptId", transcript._id))
          .collect()
      )
        .sort((a, b) => a.segmentIndex - b.segmentIndex)
        .slice(0, MAX_SEGMENTS_PER_TRANSCRIPT);
      return {
        transcriptId: transcript._id as string,
        state: transcript.state,
        audioDurationMs: transcript.audioDurationMs ?? null,
        pipelineVersion: transcript.pipelineVersion,
        segmentCount: transcript.segmentCount,
        segments: segments.map((segment) => ({
          segmentIndex: segment.segmentIndex,
          startMs: segment.startMs,
          endMs: segment.endMs,
          state: segment.state,
          text: segment.text ?? null,
        })),
      };
    }),
  );
}

/**
 * Parses one vision order's durable observations (bounded, fail-soft): a
 * malformed record lists empty, never blocks the dossier behind a provider
 * artifact.
 */
function parseObservations(order: Doc<"visionOrders">): SourceExpositionRow["visionOrders"][number]["observations"] {
  if (order.observationsJson === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(order.observationsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const decoded = Schema.decodeUnknownOption(
    Schema.Array(ObservationWireRow).pipe(Schema.check(Schema.isMaxLength(MAX_OBSERVATIONS_PER_ORDER))),
  )(parsed);
  return decoded._tag === "Some" ? decoded.value : [];
}

async function visionOrdersOf(
  db: QueryCtx["db"],
  sourceId: Id<"sources">,
): Promise<SourceExpositionRow["visionOrders"]> {
  const orders = await db
    .query("visionOrders")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  return Promise.all(
    orders.map(async (order) => {
      // The coordinate space is the pinned representation's OWN dimensions
      // (E4: a re-normalization is a new representation and a new order, so
      // old anchors never move under the highlight that cites them).
      const representation = await db.get(order.representationId);
      return {
        orderId: order._id as string,
        state: order.state,
        pipelineVersion: order.pipelineVersion,
        attachmentId: order.attachmentId as string,
        representationId: order.representationId as string,
        spaceWidth: representation?.width ?? null,
        spaceHeight: representation?.height ?? null,
        observations: parseObservations(order),
      };
    }),
  );
}

async function fragmentsOf(
  db: QueryCtx["db"],
  sourceId: Id<"sources">,
): Promise<SourceExpositionRow["fragments"]> {
  const fragments = await db
    .query("sourceFragments")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  return fragments.map((fragment) => ({
    fragmentId: fragment._id,
    extractionId: fragment.extractionId,
    anchor: fragment.anchor,
  }));
}

/**
 * The full dossier of one immutable source, tenant-checked like D1's
 * source detail: a foreign or missing source answers the same closed
 * `not_found` (existence and tenancy are not disclosed).
 */
export async function readSourceExpositionRows(
  db: QueryCtx["db"],
  context: RequestContext,
  sourceId: Id<"sources">,
): Promise<ReadResult<SourceExpositionRow>> {
  const normalized = db.normalizeId("companies", context.actor.companyId);
  if (normalized === null) {
    return { ok: false, error: forbiddenError("company_scope_unresolved", "companies") };
  }
  const source = await requireSourceRow(db, normalized, sourceId);
  if (source === null) {
    return { ok: false, error: notFoundError("sources", "source_not_in_company") };
  }
  // I4 append (flagged, the D3 media-access rule): a permanently deleted
  // source's dossier is the same closed not-found - after the committed
  // tombstone no application read serves the source, and the refusal never
  // distinguishes deletion from nonexistence.
  if (source.lifecycle === "purged") {
    return { ok: false, error: notFoundError("sources", "source_not_in_company") };
  }
  const links = await db
    .query("sourceProjectLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const latestRun = await db
    .query("processingRuns")
    .withIndex("by_source_started", (q) => q.eq("sourceId", sourceId))
    .order("desc")
    .first();
  const row: SourceExpositionRow = {
    sourceId: source._id,
    authorUserId: source.authorUserId,
    authorText: source.authorText,
    sentAtMs: source.sentAtMs,
    sentAtTimezone: source.sentAtTimezone,
    fullyAcceptedAtMs: source.fullyAcceptedAtMs,
    lifecycle: source.lifecycle,
    processingState: deriveProcessingState(
      latestRun === null ? null : { state: latestRun.state },
    ),
    projectIds: links.map((link) => link.projectId),
    withdrawnReason: source.withdrawnReason ?? null,
    withdrawnByUserId: source.withdrawnByUserId ?? null,
    withdrawnAtMs: source.withdrawnAtMs ?? null,
    attachments: await attachmentsOf(db, sourceId),
    transcripts: await transcriptsOf(db, sourceId),
    visionOrders: await visionOrdersOf(db, sourceId),
    fragments: await fragmentsOf(db, sourceId),
  };
  return { ok: true, row: Schema.decodeUnknownSync(SourceExpositionRow)(row) };
}

// ---------------------------------------------------------------------------
// The paginated evidence core
// ---------------------------------------------------------------------------

/**
 * The evidence chain resting on one source, one witness link per row,
 * paginated through `evidenceLinks.by_source` (oldest link first — a
 * stable index order, so paging never reshuffles the chain). Each row is
 * joined to the finding's CURRENT projection so corrections and C5's
 * recomputation markings are visible without a second growing read.
 */
export async function readSourceEvidenceRows(
  db: QueryCtx["db"],
  context: RequestContext,
  sourceId: Id<"sources">,
  pagination: { cursor: string | null; numItems: number },
): Promise<PageResult> {
  const normalized = db.normalizeId("companies", context.actor.companyId);
  if (normalized === null) {
    return { ok: false, error: forbiddenError("company_scope_unresolved", "companies") };
  }
  const source = await requireSourceRow(db, normalized, sourceId);
  if (source === null) {
    return { ok: false, error: notFoundError("sources", "source_not_in_company") };
  }
  const raw = await db
    .query("evidenceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .paginate(pagination);
  const fragmentCache = new Map<Id<"sourceFragments">, Doc<"sourceFragments"> | null>();
  const rows: SourceEvidenceRow[] = [];
  for (const link of raw.page) {
    const revision = await db.get(link.findingRevisionId);
    if (revision === null) {
      continue;
    }
    // Tenant check on the joined finding: a foreign revision row can never
    // surface through this source's chain (defense in depth beside the
    // source's own tenant check).
    const finding = await db.get(revision.findingId);
    if (finding === null || finding.companyId !== normalized) {
      continue;
    }
    let fragmentAnchor: FragmentAnchor | null = null;
    if (link.sourceFragmentId !== undefined) {
      const cached = fragmentCache.get(link.sourceFragmentId);
      const fragment =
        cached !== undefined ? cached : await db.get(link.sourceFragmentId);
      fragmentCache.set(link.sourceFragmentId, fragment ?? null);
      if (fragment !== null && fragment.sourceId === sourceId) {
        fragmentAnchor = fragment.anchor;
      }
    }
    const currentRevision =
      finding.currentRevisionId === undefined ? null : await db.get(finding.currentRevisionId);
    const citedFragmentId =
      link.sourceFragmentId !== undefined && fragmentAnchor !== null ? link.sourceFragmentId : null;
    rows.push(
      Schema.decodeUnknownSync(SourceEvidenceRow)({
        findingId: finding._id,
        semanticKey: finding.semanticKey,
        scope:
          finding.scopeKind === "company"
            ? { _tag: "company" }
            : { _tag: "project", projectId: finding.scopeProjectId ?? "" },
        supportKind: link.supportKind,
        citedRevisionId: revision._id,
        citedRevision: revision.revision,
        citedOrigin: revision.origin,
        citedRecordedAtMs: revision.recordedAtMs,
        fragmentId: citedFragmentId,
        fragmentAnchor,
        currentRevisionId: currentRevision?._id ?? null,
        currentRevision: currentRevision?.revision ?? null,
        currentKnowledgeState: currentRevision?.knowledgeState ?? null,
        currentValue: currentRevision?.value ?? null,
        currentOrigin: currentRevision?.origin ?? null,
        currentReason: currentRevision?.reason ?? null,
        currentRecordedAtMs: currentRevision?.recordedAtMs ?? null,
        supersededByNewerRevision:
          currentRevision !== null && currentRevision._id !== revision._id,
      }),
    );
  }
  return {
    ok: true,
    page: Schema.decodeUnknownSync(SourceEvidencePage)({
      page: rows,
      isDone: raw.isDone,
      continueCursor: raw.continueCursor,
    }),
  };
}
