/**
 * The joined coverage loader (E4): DB rows -> the pure views
 * packages/agent/extraction consumes.
 *
 * Everything is scoped through the source (tenant isolation rides the
 * source row the caller already validated):
 *
 * - attachments of the source, by kind (audio/image);
 * - D6 transcript orders per audio attachment (state + lastErrorKind +
 *   extraction) and the ASSEMBLED segment text of the newest completed
 *   order (original-time intervals, verbatim provider text);
 * - D5 representation rows per image attachment -> the deterministic
 *   retained selection (`decideRetainedSelection` imported from the images
 *   protocol, never mirrored) -> the vision orders over THAT
 *   representation, whose NEWEST completed one supplies the extraction
 *   version (the audio lane's rule), versus extractions over older
 *   representations (superseded);
 * - the vision observations of that newest completed order, rebuilt from
 *   its durable `observationsJson` record with stable handles and pinned
 *   to its OWN extraction id.
 */

import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { decideRetainedSelection, toRepresentationView } from "../images/protocol";
import {
  completedByNewest,
  completedVisionOrdersByNewest,
  observationIdOf,
  type CoverageSourceView,
  type ImageInputView,
  type JoinVisionObservation,
  type TranscriptOrderView,
  type TranscriptSegmentView,
  type VisionOrderView,
} from "@kiero/agent";

/** The DB reader surface the loader needs (mutation or query context). */
export type LoaderDb = QueryCtx["db"];

/** Loads the pure coverage view of one source. */
export async function loadCoverageSourceView(
  db: LoaderDb,
  sourceId: Id<"sources">,
): Promise<CoverageSourceView> {
  const attachments = await db
    .query("attachments")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const textExtraction = await db
    .query("extractions")
    .withIndex("by_source_kind", (q) => q.eq("sourceId", sourceId).eq("kind", "text"))
    .first();

  const transcriptOrders: TranscriptOrderView[] = [];
  const imageInputs: ImageInputView[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === "audio") {
      const orders = await db
        .query("audioTranscripts")
        .withIndex("by_attachment", (q) => q.eq("attachmentId", attachment._id))
        .collect();
      for (const order of orders) {
        transcriptOrders.push({
          transcriptId: order._id,
          attachmentId: order.attachmentId,
          state: order.state,
          lastErrorKind: order.lastErrorKind ?? null,
          extractionId: order.extractionId ?? null,
          finishedAtMs: order.finishedAtMs ?? null,
        });
      }
    } else {
      imageInputs.push(await loadImageInputView(db, sourceId, attachment._id));
    }
  }
  return {
    textExtractionId: textExtraction?._id ?? null,
    attachments: attachments.map((attachment) => ({
      attachmentId: attachment._id,
      kind: attachment.kind,
    })),
    transcriptOrders,
    imageInputs,
  };
}

/** One image attachment's inspectability view (pure-input assembly). */
async function loadImageInputView(
  db: LoaderDb,
  sourceId: Id<"sources">,
  attachmentId: Id<"attachments">,
): Promise<ImageInputView> {
  const representations = await db
    .query("mediaRepresentations")
    .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachmentId))
    .collect();
  const selection = decideRetainedSelection(
    representations.map((row) => toRepresentationView(row)),
  );
  const visionExtractions = await db
    .query("extractions")
    .withIndex("by_source_kind", (q) => q.eq("sourceId", sourceId).eq("kind", "vision"))
    .collect();
  const supersededIds = visionExtractions
    .filter(
      (row) =>
        row.representationId !== undefined &&
        (selection === null || row.representationId !== selection._id),
    )
    .map((row) => row._id);
  const normalizing = representations.some(
    (row) => (row.role === "processing" || row.role === "received") && row.removedAtMs === undefined,
  );
  let visionOrders: VisionOrderView[] = [];
  let visionFailureKind: string | null = null;
  if (selection !== null) {
    const selectionId = db.normalizeId("mediaRepresentations", selection._id);
    const orders =
      selectionId === null
        ? []
        : await db
            .query("visionOrders")
            .withIndex("by_representation", (q) => q.eq("representationId", selectionId))
            .collect();
    visionOrders = orders.map((order) => ({
      orderId: order._id,
      state: order.state,
      lastErrorKind: order.lastErrorKind ?? null,
      extractionId: order.extractionId ?? null,
      finishedAtMs: order.finishedAtMs ?? null,
    }));
    const failed = orders.find(
      (order) => order.state === "pending" && order.lastErrorKind !== undefined,
    );
    visionFailureKind = failed?.lastErrorKind ?? null;
  }
  return {
    attachmentId,
    representationId: selection?._id ?? null,
    visionOrders,
    supersededVisionExtractionIds: supersededIds,
    pendingReason:
      selection === null && normalizing ? "photo_normalization_in_progress" : null,
    visionFailureKind,
  };
}

/**
 * The assembled segments of the transcript orders the coverage reports
 * COMPLETE (the newest completed order per attachment wins — a newer
 * extraction version is a re-join trigger, never silent coordinate moves).
 */
export async function loadCompletedTranscriptSegments(
  db: LoaderDb,
  view: CoverageSourceView,
): Promise<TranscriptSegmentView[]> {
  // The shared rule, newest first: the first order seen per attachment is
  // its newest completed version, the same function the coverage decision
  // uses (round-3: the third hand-rolled copy of this selection).
  const newest = new Map<string, TranscriptOrderView>();
  for (const order of completedByNewest(view.transcriptOrders)) {
    if (!newest.has(order.attachmentId)) {
      newest.set(order.attachmentId, order);
    }
  }
  const segments: TranscriptSegmentView[] = [];
  for (const order of newest.values()) {
    const rows = await db
      .query("audioSegments")
      .withIndex("by_transcript_index", (q) =>
        q.eq("transcriptId", order.transcriptId as Id<"audioTranscripts">),
      )
      .collect();
    for (const row of rows
      .filter((segment) => segment.state === "succeeded" && segment.text !== undefined)
      .sort((a, b) => a.segmentIndex - b.segmentIndex)) {
      segments.push({
        transcriptId: order.transcriptId,
        extractionId: order.extractionId as string,
        segmentIndex: row.segmentIndex,
        startMs: row.startMs,
        endMs: row.endMs,
        text: row.text as string,
      });
    }
  }
  return segments;
}

/** One recorded observation as the order's durable JSON stores it. */
export interface RecordedVisionObservation {
  readonly text: string;
  readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** Parses an order's recorded observations (malformed rows yield none). */
export function parseRecordedObservations(
  observationsJson: string | undefined,
): RecordedVisionObservation[] {
  if (observationsJson === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(observationsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const recorded: RecordedVisionObservation[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const text = (entry as { text?: unknown }).text;
    const region = (entry as { region?: unknown }).region;
    if (typeof text !== "string" || typeof region !== "object" || region === null) {
      continue;
    }
    const { x, y, width, height } = region as Record<string, unknown>;
    if (
      typeof x !== "number" || typeof y !== "number" ||
      typeof width !== "number" || typeof height !== "number"
    ) {
      continue;
    }
    recorded.push({ text, region: { x, y, width, height } });
  }
  return recorded;
}

/**
 * The observations of the completed vision order the coverage SELECTS:
 * the NEWEST completed order by finishedAtMs over the representation (the
 * audio lane's rule, the same `completedVisionOrdersByNewest` the coverage
 * decision applies), rebuilt from that order's durable record with stable
 * per-representation handles. The extraction id is the completed order's
 * OWN, so observations and their version pin can never come from two
 * different provider passes. The representation id pins the coordinate
 * space. This is the ONE place the record's nested `region` object
 * flattens into the fragment-anchor shape everything downstream (prompt,
 * evidence, anchors) speaks.
 */
export async function loadCompletedVisionObservations(
  db: LoaderDb,
  view: CoverageSourceView,
): Promise<JoinVisionObservation[]> {
  const observations: JoinVisionObservation[] = [];
  for (const input of view.imageInputs) {
    if (input.representationId === null) {
      continue;
    }
    const newest = completedVisionOrdersByNewest(input.visionOrders)[0];
    if (newest === undefined || newest.extractionId === null) {
      continue;
    }
    const order = await db.get(newest.orderId as Id<"visionOrders">);
    if (order === null || order.observationsJson === undefined) {
      continue;
    }
    for (const [index, recorded] of parseRecordedObservations(order.observationsJson).entries()) {
      observations.push({
        observationId: observationIdOf(input.representationId, index),
        attachmentId: input.attachmentId,
        representationId: input.representationId,
        extractionId: newest.extractionId,
        text: recorded.text,
        x: recorded.region.x,
        y: recorded.region.y,
        width: recorded.region.width,
        height: recorded.region.height,
      });
    }
  }
  return observations;
}
