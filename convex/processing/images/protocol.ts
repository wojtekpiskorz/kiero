/**
 * The photo-normalization protocol: step schemas and the PURE decisions of
 * the D5 images lane.
 *
 * Convex owns the durable job (`processing.normalize_photo`, the A2/A3 job
 * vocabulary) and the representation ledger rows; the gateway Worker owns
 * R2 and the normalizer execution (the Cloudflare Images binding selected
 * by Q210, or the configured remote normalizer stand-in while the binding
 * requires the paid plan). The two systems cannot share a transaction, so
 * the protocol is built around typed, idempotent, resumable steps
 * (architecture protocol step 4):
 *
 * - prepare (Convex txn) loads the accepted image attachments and marks the
 *   in-progress `processing` representation rows;
 * - the executor service reads the received bytes from R2, applies the
 *   normalization plan (EXIF rotation baked in, downscale to bounded
 *   dimensions, conservative re-encode) and writes the retained and
 *   thumbnail objects;
 * - record (Convex txn) writes the unverified `retained`/`thumbnail`
 *   representation rows, or the explicit retained-original exception row;
 * - verify (Convex txn) stamps `verifiedAtMs` ONLY on evidence the archival
 *   object is durable and readable, and publishes
 *   `sources.representationRetained`;
 * - cleanup removes the temporary received bytes ONLY after that
 *   verification (reference, recovery and quality checks included);
 * - reconcile observes the rows and completes or retries WITHOUT a blind
 *   second conversion (the echo-template uncertainty semantics).
 *
 * Unsupported input, failed conversion, oversized input and unresolved
 * conversion quality retain the RECEIVED original as the inspectable
 * exception (CONTEXT.md, "Zdjęcie źródłowe") — never a fake success.
 *
 * Everything in this module is pure so tests/d5 can prove the decisions
 * without a deployment; the live proofs run the same functions through the
 * real Convex deployment, Worker and R2 bucket.
 *
 * SHARED-HOME DECISION (D2's pattern): this file is the ONE definition of
 * the images protocol on BOTH sides of the deployment boundary — the Convex
 * functions import it directly, and the gateway Worker imports it exactly
 * like the existing pure Convex-directory modules it already ships
 * (convex/sources/uploads/protocol.ts, convex/operations/telemetry/sink.ts).
 * It pulls in effect Schema and @kiero/contracts only; mirrors of these
 * bounds/keys/schemas anywhere else are hazards, not copies.
 */

import { Schema } from "effect";

// ---------------------------------------------------------------------------
// Bounds and versions.
// ---------------------------------------------------------------------------

/**
 * The proved input limit of the selected executor. The Images binding's
 * `.input()` accepts at most 20 MB (media-normalization research facts,
 * 2026-09-08); inputs beyond it retain the received original as the typed
 * `oversized_input` exception until the scoped media Container's exact
 * conversion profile passes P05.
 */
export const MAX_INPUT_BYTES = 20 * 1024 * 1024;
/**
 * Bounded archival dimensions: the longest edge of the retained
 * representation never exceeds this (downscale only, never upscale). Chosen
 * to keep handwritten amounts, measurements and orientation legible for
 * vision while bounding decoder memory (P05 owns the measurement).
 */
export const RETAINED_MAX_EDGE = 4096;
/** Bounded thumbnail edge for presentation views. */
export const THUMBNAIL_MAX_EDGE = 512;
/**
 * WebP encode quality of the archival representation (the first candidate
 * per Q193; AVIF earns a place only through real sample evidence).
 */
export const RETAINED_QUALITY = 85;
/** WebP encode quality of the thumbnail. */
export const THUMBNAIL_QUALITY = 75;
/**
 * A conversion whose output is not meaningfully smaller than a
 * sufficiently-large photo input leaves the archival quality unresolved:
 * the encoder failed to compress what it read, so semantic preservation
 * cannot be asserted. The received original is retained instead.
 */
export const QUALITY_MIN_INPUT_BYTES = 256 * 1024;
export const QUALITY_MAX_OUTPUT_RATIO = 1.0;

/** Transform version of the D5 normalized archival representation. */
export const NORMALIZE_TRANSFORM_VERSION = "d5.normalize/1";
/** Transform version of the D5 derived thumbnail. */
export const THUMBNAIL_TRANSFORM_VERSION = "d5.thumbnail/1";
/**
 * Transform version of the explicit retained-original exception: the
 * received bytes ARE the retained representation (CONTEXT.md's input-file
 * fallback), with the typed `exceptionKind` on the same row.
 */
export const RETAINED_ORIGINAL_TRANSFORM_VERSION = "d5.retained-original/1";

/**
 * The closed vocabulary of honest outcomes that keep the received original.
 * Pinned against the `exceptionKind` column of `mediaRepresentations` by a
 * runtime literal-equality test in tests/d5 (the fragments.test.ts pattern
 * for fragment-local unions).
 */
export const RETENTION_EXCEPTION_KINDS = [
  "oversized_input",
  "unsupported_input",
  "conversion_failed",
  "quality_unresolved",
] as const;
export type RetentionExceptionKind = (typeof RETENTION_EXCEPTION_KINDS)[number];

export const RetentionExceptionKind = Schema.Literals([...RETENTION_EXCEPTION_KINDS]);

// ---------------------------------------------------------------------------
// Sniffing and the normalization plan (pure).
// ---------------------------------------------------------------------------

/** Input formats this protocol can name by magic bytes. */
export const SNIFFED_FORMATS = [
  "jpeg",
  "png",
  "webp",
  "gif",
  "avif",
  "heic",
  "heif",
  "tiff",
  "bmp",
  "ico",
] as const;
export type SniffedFormat = (typeof SNIFFED_FORMATS)[number] | "unknown";

/**
 * Names the input format from its leading bytes (magic-prefix matching
 * only; decodability is the normalizer's to prove).
 */
export function sniffImageFormat(head: Uint8Array): SniffedFormat {
  const startsWith = (bytes: readonly number[]): boolean =>
    bytes.every((byte, index) => head[index] === byte);
  if (startsWith([0xff, 0xd8, 0xff])) {
    return "jpeg";
  }
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) {
    return "png";
  }
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && head[8] === 0x57 && head[9] === 0x45) {
    return "webp";
  }
  if (startsWith([0x47, 0x49, 0x46, 0x38])) {
    return "gif";
  }
  if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
    // ISO-BMFF brand: distinguish the image brands this protocol names.
    const brand = String.fromCharCode(head[8] ?? 0, head[9] ?? 0, head[10] ?? 0, head[11] ?? 0);
    if (brand.startsWith("avif")) {
      return "avif";
    }
    if (brand.startsWith("heic")) {
      return "heic";
    }
    if (brand.startsWith("mif1") || brand.startsWith("msf1")) {
      return "heif";
    }
    return "unknown";
  }
  if ((startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a]))) {
    return "tiff";
  }
  if (startsWith([0x42, 0x4d])) {
    return "bmp";
  }
  if (startsWith([0x00, 0x00, 0x01, 0x00])) {
    return "ico";
  }
  return "unknown";
}

/** The fields the normalization decision needs about one received input. */
export interface NormalizationInputView {
  readonly bytes: number;
  /** The sniffed format of the received bytes ("unknown" when unnameable). */
  readonly sniffedFormat: SniffedFormat;
  /** Input formats the SELECTED normalizer adapter proved it can decode. */
  readonly supportedFormats: readonly SniffedFormat[];
}

/** One bounded transform recipe (what the normalizer must produce). */
export interface NormalizationPlan {
  readonly rotate: true;
  /** Downscale so the longest edge is at most this; never upscale. */
  readonly maxEdge: number;
  readonly format: "webp";
  readonly quality: number;
}

export type NormalizationDecision =
  | { readonly decision: "normalize"; readonly plan: NormalizationPlan }
  | { readonly decision: "retain_original"; readonly exceptionKind: RetentionExceptionKind };

/**
 * THE normalization decision for one received image: inputs the selected
 * executor proved too large, or in a format it cannot decode, retain the
 * received original as the typed exception; everything else normalizes
 * (EXIF rotation baked into the pixels, bounded archival dimensions,
 * conservative WebP re-encode). No branch ever claims success it did not
 * verify.
 */
export function decideNormalization(input: NormalizationInputView): NormalizationDecision {
  if (input.bytes > MAX_INPUT_BYTES) {
    return { decision: "retain_original", exceptionKind: "oversized_input" };
  }
  if (input.sniffedFormat === "unknown" || !input.supportedFormats.includes(input.sniffedFormat)) {
    return { decision: "retain_original", exceptionKind: "unsupported_input" };
  }
  return {
    decision: "normalize",
    plan: {
      rotate: true,
      maxEdge: RETAINED_MAX_EDGE,
      format: "webp",
      quality: RETAINED_QUALITY,
    },
  };
}

/** The quality metrics the resolved-quality check compares (pure). */
export interface ConversionQualityView {
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  /** The output's longest edge bound from the plan. */
  readonly plannedMaxEdge: number;
}

export type QualityDecision =
  | { readonly resolved: true }
  | { readonly resolved: false; readonly reason: "output_not_smaller" | "output_dimensions_invalid" };

/**
 * The resolved-quality check of one completed conversion: a photo the
 * encoder could not compress (or produced with impossible dimensions)
 * leaves semantic preservation unresolved, so the original must be
 * retained. Measurements of handwriting legibility itself stay with P05's
 * real fixtures; this is the honest typed floor.
 */
export function decideConversionQuality(view: ConversionQualityView): QualityDecision {
  if (
    !Number.isFinite(view.outputWidth) ||
    !Number.isFinite(view.outputHeight) ||
    view.outputWidth < 1 ||
    view.outputHeight < 1 ||
    Math.max(view.outputWidth, view.outputHeight) > view.plannedMaxEdge
  ) {
    return { resolved: false, reason: "output_dimensions_invalid" };
  }
  if (
    view.inputBytes >= QUALITY_MIN_INPUT_BYTES &&
    view.outputBytes > Math.floor(view.inputBytes * QUALITY_MAX_OUTPUT_RATIO)
  ) {
    return { resolved: false, reason: "output_not_smaller" };
  }
  return { resolved: true };
}

// ---------------------------------------------------------------------------
// The retained-object key namespace (server-owned, tenant-scoped).
// ---------------------------------------------------------------------------

/** The canonical retained-media key namespace: `companies/<id>/retained/`. */
export function retainedKeyPrefix(companyId: string): string {
  return `companies/${companyId}/retained/`;
}

/** True when an object key belongs to the tenant's retained namespace. */
export function objectKeyInRetainedNamespace(key: string, companyId: string): boolean {
  return key.startsWith(retainedKeyPrefix(companyId));
}

/**
 * The deterministic retained/thumbnail object key of one attachment
 * version: `companies/<companyId>/retained/<attachmentId>/<transformVersion>/<role>.webp`.
 * Same attachment + same transform version always maps to the same key, so
 * replays are idempotent writes of identical bytes while a NEW transform
 * version materializes as a NEW immutable object.
 */
export function representationObjectKey(
  companyId: string,
  attachmentId: string,
  transformVersion: string,
  role: "retained" | "thumbnail",
): string {
  return `${retainedKeyPrefix(companyId)}${attachmentId}/${transformVersion}/${role}.webp`;
}

// ---------------------------------------------------------------------------
// The retention state machine (pure view over representation rows).
// ---------------------------------------------------------------------------

/** The representation fields the retention decisions read. */
export interface RepresentationView {
  readonly _id: string;
  readonly attachmentId: string;
  readonly role: "received" | "retained" | "thumbnail" | "processing";
  readonly objectKey: string;
  readonly contentHash: string;
  readonly transformVersion: string;
  readonly verifiedAtMs?: number | undefined;
  readonly removedAtMs?: number | undefined;
  readonly exceptionKind?: string | undefined;
  readonly bytes?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly mimeType?: string | undefined;
}

/** The derived retention state of one image attachment. */
export type RetentionState =
  | "awaiting"
  | "processing"
  | "recorded"
  | "verified"
  | "cleaned"
  | "exception";

/** The next protocol step for one image attachment, with its state. */
export type RetentionStep =
  | { readonly step: "normalize"; readonly state: "awaiting" | "processing" }
  | { readonly step: "verify"; readonly state: "recorded" }
  | { readonly step: "cleanup"; readonly state: "verified" }
  | { readonly step: "none"; readonly state: "cleaned" | "exception" };

/**
 * Derives the attachment's retention state from its representation rows
 * and decides the NEXT step. Resumable by construction: every crash window
 * (after the R2 write but before record, after record but before verify,
 * after verify but before cleanup) lands on a state whose step repairs
 * exactly what is missing — never a restart that loses a readable copy.
 */
export function decideRetentionStep(
  representations: readonly RepresentationView[],
): RetentionStep {
  const received = representations.find((row) => row.role === "received");
  const processing = representations.find((row) => row.role === "processing");
  const retained = representations.filter((row) => row.role === "retained");
  const thumbnails = representations.filter((row) => row.role === "thumbnail");
  if (retained.length > 0) {
    const normalized = retained.filter(
      (row) => row.transformVersion !== RETAINED_ORIGINAL_TRANSFORM_VERSION,
    );
    if (normalized.length > 0) {
      const verified = normalized.filter((row) => row.verifiedAtMs !== undefined);
      if (verified.length > 0) {
        const thumbVerified = thumbnails.some((row) => row.verifiedAtMs !== undefined);
        const receivedRemoved = received === undefined || received.removedAtMs !== undefined;
        if (!thumbVerified) {
          return { step: "verify", state: "recorded" };
        }
        if (!receivedRemoved) {
          return { step: "cleanup", state: "verified" };
        }
        return { step: "none", state: "cleaned" };
      }
      return { step: "verify", state: "recorded" };
    }
    // Only retained-original exception rows exist: terminal.
    return { step: "none", state: "exception" };
  }
  if (processing !== undefined) {
    return { step: "normalize", state: "processing" };
  }
  return { step: "normalize", state: "awaiting" };
}

/**
 * The deterministic CURRENT retained representation of one attachment (what
 * E4's vision anchors and D3's reads must resolve to): verified normalized
 * rows win over the retained-original exception; among verified normalized
 * rows the greatest transform version wins (explicit version precedence,
 * then creation time, then id — a stable total order), so racing two
 * transform versions never flips the selection between observations.
 */
export function decideRetainedSelection(
  representations: readonly RepresentationView[],
): RepresentationView | null {
  const retained = representations.filter(
    (row) => row.role === "retained" && row.verifiedAtMs !== undefined,
  );
  if (retained.length === 0) {
    return null;
  }
  const ranked = [...retained].sort((a, b) => {
    const aException = a.transformVersion === RETAINED_ORIGINAL_TRANSFORM_VERSION ? 1 : 0;
    const bException = b.transformVersion === RETAINED_ORIGINAL_TRANSFORM_VERSION ? 1 : 0;
    if (aException !== bException) {
      return aException - bException;
    }
    if (a.transformVersion !== b.transformVersion) {
      return a.transformVersion < b.transformVersion ? 1 : -1;
    }
    return a._id < b._id ? -1 : 1;
  });
  return ranked[0] ?? null;
}

/** The reference facts the received-bytes cleanup rule checks. */
export interface ReceivedCleanupView {
  readonly representations: readonly RepresentationView[];
  /** How many extraction rows still reference the RECEIVED representation. */
  readonly extractionReferences: number;
}

export type ReceivedCleanupDecision =
  | { readonly remove: true; readonly objectKey: string }
  | {
      readonly remove: false;
      readonly reason:
        | "retained_not_verified"
        | "retained_is_original_exception"
        | "thumbnail_not_verified"
        | "received_referenced_by_extraction"
        | "received_already_removed"
        | "no_received_representation";
    };

/**
 * THE received-bytes retention rule (architecture protocol step 4): the
 * temporary input may be removed ONLY when the normalized archival
 * representation is VERIFIED durable (reference check), a verified
 * thumbnail provides the second readable copy (recovery check), the
 * retained row is not the original exception (whose bytes ARE the archive),
 * and no extraction still anchors to the received representation. Every
 * refusal carries its typed reason.
 */
export function decideReceivedCleanup(view: ReceivedCleanupView): ReceivedCleanupDecision {
  const received = view.representations.find((row) => row.role === "received");
  if (received === undefined) {
    return { remove: false, reason: "no_received_representation" };
  }
  if (received.removedAtMs !== undefined) {
    return { remove: false, reason: "received_already_removed" };
  }
  const selection = decideRetainedSelection(view.representations);
  if (selection === null) {
    return { remove: false, reason: "retained_not_verified" };
  }
  if (selection.transformVersion === RETAINED_ORIGINAL_TRANSFORM_VERSION) {
    return { remove: false, reason: "retained_is_original_exception" };
  }
  if (selection.objectKey === received.objectKey) {
    return { remove: false, reason: "retained_is_original_exception" };
  }
  const thumbnailVerified = view.representations.some(
    (row) => row.role === "thumbnail" && row.verifiedAtMs !== undefined,
  );
  if (!thumbnailVerified) {
    return { remove: false, reason: "thumbnail_not_verified" };
  }
  if (view.extractionReferences > 0) {
    return { remove: false, reason: "received_referenced_by_extraction" };
  }
  return { remove: true, objectKey: received.objectKey };
}

// ---------------------------------------------------------------------------
// Step schemas (the gateway -> Convex images channel; service-credential
// boundary, NOT the certified client surface).
// ---------------------------------------------------------------------------

/** Step names of the images channel (closed vocabulary). */
export const IMAGE_STEP_NAMES = [
  "prepare",
  "record",
  "verify",
  "cleanup",
  "reconcile",
] as const;
export type ImageStepName = (typeof IMAGE_STEP_NAMES)[number];

/** Lower-case hex SHA-256 (64 chars). */
export const Sha256Hex = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
);
export type Sha256Hex = Schema.Schema.Type<typeof Sha256Hex>;

/** One recorded representation's identity evidence. */
export const RecordedRepresentation = Schema.Struct({
  objectKey: Schema.NonEmptyString,
  contentHash: Sha256Hex,
  bytes: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  width: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  height: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
  mimeType: Schema.NonEmptyString,
});
export type RecordedRepresentation = Schema.Schema.Type<typeof RecordedRepresentation>;

/** One attachment's typed outcome for the record step. */
export const RecordOutcome = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literals(["normalized"]),
    retained: RecordedRepresentation,
    thumbnail: RecordedRepresentation,
  }),
  Schema.Struct({
    _tag: Schema.Literals(["exception"]),
    exceptionKind: RetentionExceptionKind,
  }),
]);
export type RecordOutcome = Schema.Schema.Type<typeof RecordOutcome>;

/** Durability evidence of one written object for the verify step. */
export const VerifyEvidence = Schema.Struct({
  objectKey: Schema.NonEmptyString,
  contentHash: Sha256Hex,
  bytes: Schema.Number.pipe(
    Schema.check(Schema.isInt()),
    Schema.check(Schema.isGreaterThan(0)),
  ),
});
export type VerifyEvidence = Schema.Schema.Type<typeof VerifyEvidence>;

/** One images-channel step envelope (jobKey-scoped, service boundary). */
export const ImagesStepEnvelope = Schema.Struct({
  step: Schema.Literals([...IMAGE_STEP_NAMES]),
  jobKey: Schema.NonEmptyString,
  input: Schema.optional(Schema.Unknown),
});
export type ImagesStepEnvelope = Schema.Schema.Type<typeof ImagesStepEnvelope>;
