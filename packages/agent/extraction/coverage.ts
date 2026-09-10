/**
 * Joined segment coverage honesty (E4): the aggregate that names EVERY
 * required input of one mixed source and never marks it fully processed
 * while a required segment or image remains unresolved.
 *
 * This extends E3's text-side snapshot (packages/agent/planning/coverage.ts,
 * `CoverageSnapshot`) with the D5/D6 producer states:
 *
 * - D6 `audioTranscripts` orders: `complete` (extraction version
 *   registered), `pending`/`partial` (actively progressing or awaiting a
 *   bounded resume), `planning` with a sanitized `lastErrorKind`
 *   (EXTERNALLY BLOCKED, resumable — e.g. the media executor is not
 *   configured; honest production degradation, never a fake failure), and
 *   terminal `failed`;
 * - D5 image representations: the deterministic retained selection
 *   (`decideRetainedSelection`, convex/processing/images/protocol.ts)
 *   defines the inspectable representation; a vision extraction over THAT
 *   exact representationId completes the input, both vision routes failing
 *   leaves it pending (architecture "Provider configuration").
 *
 * The status vocabulary is the issue's own: complete, pending, failed, or
 * replaced by a newer extraction version. `replaced_by_newer_version` is
 * informational honesty for evidence readers (historical findings keep
 * their exact coordinates because extraction versions are immutable), it
 * never blocks publication by itself.
 */

/** The per-required-input status vocabulary (issue #38). */
export type RequiredInputStatus =
  /** A completed extraction version exists and is usable by the analysis. */
  | "complete"
  /** In progress or retryable: normalization running, STT pending/partial, vision routes failed. */
  | "pending"
  /**
   * Externally blocked with a sanitized reason (D6 planning +
   * lastErrorKind): resumable when the external condition clears; never
   * waited on, never fabricated over.
   */
  | "externally_blocked"
  /** Terminal failure: no completed version and no resumable path on this input. */
  | "failed"
  /**
   * A completed version exists, but a NEWER extraction version also exists:
   * recorded for aggregate honesty; evidence anchored to the older version
   * keeps its coordinates (immutable versions).
   */
  | "replaced_by_newer_version";

/** One named required input of a source. */
export interface RequiredInput {
  /** The attachment the input refers to (null for the author's own text). */
  readonly attachmentId: string | null;
  readonly kind: "text" | "audio" | "image";
  readonly status: RequiredInputStatus;
  /** The extraction version the analysis consumes (complete inputs only). */
  readonly extractionId: string | null;
  /** The retained representation whose pixels/bytes define the space (images). */
  readonly representationId: string | null;
  /** Sanitized blocked/failed reason (pending/externally_blocked/failed). */
  readonly lastErrorKind: string | null;
}

/** The joined coverage snapshot: every required input, named. */
export interface JoinedCoverageSnapshot {
  readonly inputs: readonly RequiredInput[];
}

/** The honest aggregate completeness state of one joined run. */
export type JoinedCompleteness =
  /** Every required input complete: the whole source was inspectable. */
  | "complete"
  /** Some inputs pending/failed/superseded: conclusions over them stay pending. */
  | "partial_unresolved_inputs"
  /** Every unresolved input is externally blocked (resumable). */
  | "blocked_external";

/** Whether every required input is complete: the whole source was inspectable. */
export function allInputsComplete(coverage: JoinedCoverageSnapshot): boolean {
  return coverage.inputs.every((input) => input.status === "complete");
}

/**
 * Derives the honest aggregate label. Planning-blocked media is externally
 * blocked (resumable) — a distinct honest state, never "complete" and never
 * silently folded into a plain partial.
 */
export function decideJoinedCompleteness(
  coverage: JoinedCoverageSnapshot,
): JoinedCompleteness {
  const unresolved = coverage.inputs.filter((input) => input.status !== "complete");
  if (unresolved.length === 0) {
    return "complete";
  }
  const allBlocked = unresolved.every(
    (input) => input.status === "externally_blocked",
  );
  return allBlocked ? "blocked_external" : "partial_unresolved_inputs";
}

/**
 * Whether one unresolved input is worth the bounded wait: actively
 * progressing media may still complete within the budget; blocked and
 * terminal inputs never wait (the join proceeds partial-safe over them).
 * A transcript with NO order is not progressing either — the join's own
 * evaluate stage is the production orderer, so by the time the wait polls,
 * an unordered transcript means THIS run could not order it (no author
 * context); waiting cannot change that.
 */
export function inputWorthWaiting(input: RequiredInput): boolean {
  if (input.lastErrorKind === "transcript_not_ordered") {
    return false;
  }
  return input.status === "pending";
}

// ---------------------------------------------------------------------------
// The DB-shaped view the pure join consumes (built by the Convex loader).
// ---------------------------------------------------------------------------

/** One audio transcript order as the join sees it (D6 rows). */
export interface TranscriptOrderView {
  readonly transcriptId: string;
  readonly attachmentId: string;
  readonly state: "planning" | "pending" | "partial" | "complete" | "failed";
  readonly lastErrorKind: string | null;
  readonly extractionId: string | null;
  /** Completion time, when complete (the newest complete order wins). */
  readonly finishedAtMs: number | null;
}

/** One image attachment's inspectable representation + vision extractions. */
export interface ImageInputView {
  readonly attachmentId: string;
  /** The deterministic current retained selection (null while normalizing). */
  readonly representationId: string | null;
  /** Vision extraction ids that exist over the CURRENT representationId. */
  readonly visionExtractionIds: readonly string[];
  /** Vision extraction ids over OLDER representations (superseded versions). */
  readonly supersededVisionExtractionIds: readonly string[];
  /** Sanitized reason the representation is not inspectable yet, if any. */
  readonly pendingReason: string | null;
  /** Whether a vision attempt failed over the current representation. */
  readonly visionFailureKind: string | null;
}

/** One attachment row as the join sees it. */
export interface AttachmentView {
  readonly attachmentId: string;
  readonly kind: "audio" | "image";
}

/** The full DB-shaped coverage view of one source. */
export interface CoverageSourceView {
  /** The D1 text extraction id (the author's words are their own extraction). */
  readonly textExtractionId: string | null;
  readonly attachments: readonly AttachmentView[];
  readonly transcriptOrders: readonly TranscriptOrderView[];
  readonly imageInputs: readonly ImageInputView[];
}

/** The best status of one audio attachment over its orders (pure). */
export function audioAttachmentStatus(
  orders: readonly TranscriptOrderView[],
): RequiredInput {
  const attachmentId = orders[0]?.attachmentId ?? null;
  if (orders.length === 0) {
    return {
      attachmentId,
      kind: "audio",
      status: "pending",
      extractionId: null,
      representationId: null,
      lastErrorKind: "transcript_not_ordered",
    };
  }
  const complete = orders
    .filter((order) => order.state === "complete" && order.extractionId !== null)
    .sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0));
  if (complete.length > 0) {
    // Newer COMPLETED orders than the selected one: the older extraction is
    // superseded — informational, the selected stays usable evidence.
    const newest = complete[0];
    if (newest !== undefined) {
      const superseded = complete.length > 1;
      return {
        attachmentId,
        kind: "audio",
        status: superseded ? "replaced_by_newer_version" : "complete",
        extractionId: newest.extractionId,
        representationId: null,
        lastErrorKind: null,
      };
    }
  }
  const progressing = orders.filter(
    (order) =>
      order.state === "pending" ||
      order.state === "partial" ||
      (order.state === "planning" && order.lastErrorKind === null),
  );
  if (progressing.length > 0) {
    const failing = orders.find(
      (order) => (order.state === "pending" || order.state === "partial") &&
        order.lastErrorKind !== null,
    );
    return {
      attachmentId,
      kind: "audio",
      status: "pending",
      extractionId: null,
      representationId: null,
      lastErrorKind: failing?.lastErrorKind ?? null,
    };
  }
  const blocked = orders.find(
    (order) => order.state === "planning" && order.lastErrorKind !== null,
  );
  if (blocked !== undefined) {
    return {
      attachmentId,
      kind: "audio",
      status: "externally_blocked",
      extractionId: null,
      representationId: null,
      lastErrorKind: blocked.lastErrorKind,
    };
  }
  return {
    attachmentId,
    kind: "audio",
    status: "failed",
    extractionId: null,
    representationId: null,
    lastErrorKind: orders.find((order) => order.state === "failed")?.lastErrorKind ?? "transcript_failed",
  };
}

/** The status of one image attachment (pure). */
export function imageAttachmentStatus(view: ImageInputView): RequiredInput {
  if (view.representationId === null) {
    return {
      attachmentId: view.attachmentId,
      kind: "image",
      status: "pending",
      extractionId: null,
      representationId: null,
      lastErrorKind: view.pendingReason ?? "retained_representation_not_ready",
    };
  }
  if (view.visionExtractionIds.length > 0) {
    return {
      attachmentId: view.attachmentId,
      kind: "image",
      status: "complete",
      extractionId: view.visionExtractionIds[0] ?? null,
      representationId: view.representationId,
      lastErrorKind: null,
    };
  }
  if (view.supersededVisionExtractionIds.length > 0) {
    // A vision version exists over an OLDER representation: the input is
    // superseded (honest for evidence readers) AND unresolved for the
    // current pixels — a re-run over the current representation is due.
    return {
      attachmentId: view.attachmentId,
      kind: "image",
      status: "pending",
      extractionId: null,
      representationId: view.representationId,
      lastErrorKind: "vision_superseded_representation",
    };
  }
  return {
    attachmentId: view.attachmentId,
    kind: "image",
    status: "pending",
    extractionId: null,
    representationId: view.representationId,
    lastErrorKind: view.visionFailureKind ?? "vision_extraction_not_run",
  };
}

/**
 * THE joined coverage decision (pure): names every required input of the
 * source — the author's text plus every accepted audio and image
 * attachment — with its honest status. An empty `textExtractionId` keeps
 * the text input honestly pending (D1 always seeds one; defensive only).
 */
export function joinCoverage(view: CoverageSourceView): JoinedCoverageSnapshot {
  const inputs: RequiredInput[] = [
    {
      attachmentId: null,
      kind: "text",
      status: view.textExtractionId === null ? "pending" : "complete",
      extractionId: view.textExtractionId,
      representationId: null,
      lastErrorKind: view.textExtractionId === null ? "text_extraction_missing" : null,
    },
  ];
  for (const attachment of view.attachments) {
    if (attachment.kind === "audio") {
      const orders = view.transcriptOrders.filter(
        (order) => order.attachmentId === attachment.attachmentId,
      );
      inputs.push(audioAttachmentStatus(orders));
    } else {
      const imageView = view.imageInputs.find(
        (input) => input.attachmentId === attachment.attachmentId,
      );
      inputs.push(
        imageView === undefined
          ? {
              attachmentId: attachment.attachmentId,
              kind: "image",
              status: "pending",
              extractionId: null,
              representationId: null,
              lastErrorKind: "image_input_view_missing",
            }
          : imageAttachmentStatus(imageView),
      );
    }
  }
  return { inputs };
}
