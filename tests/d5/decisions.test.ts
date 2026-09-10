/**
 * D5 focused tests, part 1: the PURE normalization and retention decisions
 * (convex/processing/images/protocol.ts) — no deployment, no fakes beyond
 * literals. These prove the decision table the live evidence exercises:
 * rotation-and-bounded-dimensions plans, typed honest outcomes for
 * oversized/unsupported/corrupt inputs, the resolved-quality floor, the
 * crash-window-resumable retention state machine, deterministic retained
 * selection under version races, and the received-bytes retention rule.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  MAX_INPUT_BYTES,
  NORMALIZE_TRANSFORM_VERSION,
  compareTransformVersions,
  RETAINED_MAX_EDGE,
  RETENTION_EXCEPTION_KINDS,
  RetentionExceptionKind,
  RETAINED_ORIGINAL_TRANSFORM_VERSION,
  Sha256Hex,
  THUMBNAIL_TRANSFORM_VERSION,
  decideConversionQuality,
  decideNormalization,
  decideReceivedCleanup,
  decideRetentionStep,
  decideRetainedSelection,
  objectKeyInRetainedNamespace,
  representationObjectKey,
  sniffImageFormat,
  type RepresentationView,
} from "../../convex/processing/images/protocol";
import { uploadsTables } from "../../convex/sources/uploads/schema";

// ---------------------------------------------------------------------------
// Sniffing.
// ---------------------------------------------------------------------------

describe("input sniffing", () => {
  it("names the magic-prefixed formats this protocol must distinguish", () => {
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("png");
    expect(
      sniffImageFormat(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe("webp");
    expect(
      sniffImageFormat(
        new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
      ),
    ).toBe("avif");
    expect(
      sniffImageFormat(
        new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
      ),
    ).toBe("heic");
    expect(sniffImageFormat(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe("tiff");
    expect(sniffImageFormat(new Uint8Array([0x42, 0x4d, 0x00, 0x00]))).toBe("bmp");
    expect(sniffImageFormat(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]))).toBe("ico");
  });

  it("reports unnameable bytes as unknown (the corrupt-input path)", () => {
    expect(sniffImageFormat(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array([]))).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// The normalization decision (oversized / unsupported / plan).
// ---------------------------------------------------------------------------

describe("decideNormalization", () => {
  const supported = ["jpeg", "png", "webp", "gif", "avif", "tiff"] as const;

  it("plans rotation, bounded archival dimensions and the conservative WebP re-encode", () => {
    const decision = decideNormalization({
      bytes: 4 * 1024 * 1024,
      sniffedFormat: "jpeg",
      supportedFormats: supported,
    });
    expect(decision.decision).toBe("normalize");
    if (decision.decision === "normalize") {
      expect(decision.plan.rotate).toBe(true);
      expect(decision.plan.maxEdge).toBe(RETAINED_MAX_EDGE);
      expect(decision.plan.format).toBe("webp");
      expect(decision.plan.quality).toBeGreaterThanOrEqual(80);
    }
  });

  it("retains the original for inputs beyond the proved executor limit (typed)", () => {
    const decision = decideNormalization({
      bytes: MAX_INPUT_BYTES + 1,
      sniffedFormat: "jpeg",
      supportedFormats: supported,
    });
    expect(decision).toEqual({ decision: "retain_original", exceptionKind: "oversized_input" });
  });

  it("retains the original for formats the selected executor cannot decode (typed)", () => {
    // An ICO-shaped header is nameable but outside the executor's proved list.
    expect(
      decideNormalization({
        bytes: 1024,
        sniffedFormat: "ico",
        supportedFormats: supported,
      }),
    ).toEqual({ decision: "retain_original", exceptionKind: "unsupported_input" });
    // Corrupt bytes (unnameable) are unsupported too, never a guessed decode.
    expect(
      decideNormalization({
        bytes: 1024,
        sniffedFormat: "unknown",
        supportedFormats: supported,
      }),
    ).toEqual({ decision: "retain_original", exceptionKind: "unsupported_input" });
  });

  it("the supported list belongs to the executor (the binding and the local adapter differ)", () => {
    // The Images binding's conservative production set excludes AVIF input;
    // an AVIF phone file must retain the original under THAT executor.
    expect(
      decideNormalization({
        bytes: 1024,
        sniffedFormat: "avif",
        supportedFormats: ["jpeg", "png", "webp", "gif", "heic"],
      }),
    ).toEqual({ decision: "retain_original", exceptionKind: "unsupported_input" });
  });
});

// ---------------------------------------------------------------------------
// The resolved-quality floor.
// ---------------------------------------------------------------------------

describe("decideConversionQuality", () => {
  it("resolves plausible bounded output", () => {
    expect(
      decideConversionQuality({
        inputBytes: 4 * 1024 * 1024,
        outputBytes: 900 * 1024,
        outputWidth: 3024,
        outputHeight: 4032,
        plannedMaxEdge: RETAINED_MAX_EDGE,
      }),
    ).toEqual({ resolved: true });
  });

  it("rejects impossible output dimensions", () => {
    expect(
      decideConversionQuality({
        inputBytes: 1024,
        outputBytes: 512,
        outputWidth: 0,
        outputHeight: 0,
        plannedMaxEdge: RETAINED_MAX_EDGE,
      }),
    ).toEqual({ resolved: false, reason: "output_dimensions_invalid" });
    expect(
      decideConversionQuality({
        inputBytes: 1024,
        outputBytes: 512,
        outputWidth: RETAINED_MAX_EDGE + 1,
        outputHeight: 8,
        plannedMaxEdge: RETAINED_MAX_EDGE,
      }),
    ).toEqual({ resolved: false, reason: "output_dimensions_invalid" });
  });

  it("leaves quality unresolved when the encoder failed to compress a real photo", () => {
    // A noise image the WebP encoder cannot compress below the input keeps
    // the original as the honest exception (the forced-quality fixture).
    expect(
      decideConversionQuality({
        inputBytes: 2 * 1024 * 1024,
        outputBytes: 2 * 1024 * 1024 + 1024,
        outputWidth: 2000,
        outputHeight: 3000,
        plannedMaxEdge: RETAINED_MAX_EDGE,
      }),
    ).toEqual({ resolved: false, reason: "output_not_smaller" });
  });

  it("does not demand compression of already-small images", () => {
    expect(
      decideConversionQuality({
        inputBytes: 24 * 1024,
        outputBytes: 30 * 1024,
        outputWidth: 320,
        outputHeight: 240,
        plannedMaxEdge: RETAINED_MAX_EDGE,
      }),
    ).toEqual({ resolved: true });
  });
});

// ---------------------------------------------------------------------------
// Keys and the retained namespace.
// ---------------------------------------------------------------------------

describe("object keys", () => {
  it("derived keys are deterministic per (tenant, attachment, version, role)", () => {
    expect(representationObjectKey("c1", "a1", NORMALIZE_TRANSFORM_VERSION, "retained")).toBe(
      "companies/c1/retained/a1/d5.normalize/1/retained.webp",
    );
    expect(representationObjectKey("c1", "a1", THUMBNAIL_TRANSFORM_VERSION, "thumbnail")).toBe(
      "companies/c1/retained/a1/d5.thumbnail/1/thumbnail.webp",
    );
    expect(representationObjectKey("c1", "a1", NORMALIZE_TRANSFORM_VERSION, "retained")).toBe(
      representationObjectKey("c1", "a1", NORMALIZE_TRANSFORM_VERSION, "retained"),
    );
  });

  it("a new transform version is a NEW immutable key, not an overwrite", () => {
    expect(
      representationObjectKey("c1", "a1", "d5.normalize/2", "retained"),
    ).not.toBe(representationObjectKey("c1", "a1", NORMALIZE_TRANSFORM_VERSION, "retained"));
  });

  it("tenant namespace checks", () => {
    const key = representationObjectKey("c1", "a1", NORMALIZE_TRANSFORM_VERSION, "retained");
    expect(objectKeyInRetainedNamespace(key, "c1")).toBe(true);
    expect(objectKeyInRetainedNamespace(key, "c2")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The retention state machine (crash-window resumability).
// ---------------------------------------------------------------------------

let idCounter = 0;
function rep(fields: Partial<RepresentationView> & Pick<RepresentationView, "role">): RepresentationView {
  idCounter += 1;
  return {
    _id: `r${idCounter}`,
    attachmentId: "a1",
    objectKey: `key-${idCounter}`,
    contentHash: `hash-${idCounter}`,
    transformVersion: NORMALIZE_TRANSFORM_VERSION,
    ...fields,
  };
}

function receivedRow(fields: Partial<RepresentationView> = {}): RepresentationView {
  return rep({ role: "received", objectKey: "companies/c1/uploads/u1/0-uuid", ...fields });
}

describe("decideRetentionStep (the crash-window state machine)", () => {
  it("a fresh accepted image awaits normalization", () => {
    expect(decideRetentionStep([receivedRow()])).toEqual({ step: "normalize", state: "awaiting" });
  });

  it("a crashed attempt's processing row re-enters normalize (same deterministic keys)", () => {
    const step = decideRetentionStep([
      receivedRow(),
      rep({ role: "processing", objectKey: "companies/c1/retained/a1/d5.normalize/1/retained.webp" }),
    ]);
    expect(step).toEqual({ step: "normalize", state: "processing" });
  });

  it("crash after record, before verify: exactly the verify step remains", () => {
    const step = decideRetentionStep([
      receivedRow(),
      rep({ role: "retained" }),
      rep({ role: "thumbnail", transformVersion: THUMBNAIL_TRANSFORM_VERSION }),
    ]);
    expect(step).toEqual({ step: "verify", state: "recorded" });
  });

  it("crash after verify (retained verified, thumbnail not): verify still repairs", () => {
    const step = decideRetentionStep([
      receivedRow(),
      rep({ role: "retained", verifiedAtMs: 1 }),
      rep({ role: "thumbnail", transformVersion: THUMBNAIL_TRANSFORM_VERSION }),
    ]);
    expect(step).toEqual({ step: "verify", state: "recorded" });
  });

  it("crash after verify, before cleanup: exactly the cleanup step remains", () => {
    const step = decideRetentionStep([
      receivedRow(),
      rep({ role: "retained", verifiedAtMs: 1 }),
      rep({ role: "thumbnail", transformVersion: THUMBNAIL_TRANSFORM_VERSION, verifiedAtMs: 1 }),
    ]);
    expect(step).toEqual({ step: "cleanup", state: "verified" });
  });

  it("a completed attachment is terminal (cleaned)", () => {
    const step = decideRetentionStep([
      receivedRow({ removedAtMs: 2 }),
      rep({ role: "retained", verifiedAtMs: 1 }),
      rep({ role: "thumbnail", transformVersion: THUMBNAIL_TRANSFORM_VERSION, verifiedAtMs: 1 }),
    ]);
    expect(step).toEqual({ step: "none", state: "cleaned" });
  });

  it("the retained-original exception is terminal (bytes kept, by design)", () => {
    const step = decideRetentionStep([
      receivedRow(),
      rep({ role: "retained", transformVersion: RETAINED_ORIGINAL_TRANSFORM_VERSION, verifiedAtMs: 1, exceptionKind: "oversized_input" }),
    ]);
    expect(step).toEqual({ step: "none", state: "exception" });
  });
});

// ---------------------------------------------------------------------------
// Deterministic retained selection (the version race).
// ---------------------------------------------------------------------------

describe("decideRetainedSelection", () => {
  it("selects nothing before a verified representation exists", () => {
    expect(decideRetainedSelection([receivedRow(), rep({ role: "retained" })])).toBeNull();
    expect(decideRetainedSelection([])).toBeNull();
  });

  it("racing two verified transform versions always selects the greater version", () => {
    const older = rep({ role: "retained", verifiedAtMs: 1, transformVersion: "d5.normalize/1" });
    const newer = rep({ role: "retained", verifiedAtMs: 1, transformVersion: "d5.normalize/2" });
    expect(decideRetainedSelection([older, newer])).toBe(newer);
    expect(decideRetainedSelection([newer, older])).toBe(newer);
  });

  it("version precedence is numeric-aware, not string-ordered (/10 beats /2)", () => {
    const two = rep({ role: "retained", verifiedAtMs: 1, transformVersion: "d5.normalize/2" });
    const ten = rep({ role: "retained", verifiedAtMs: 1, transformVersion: "d5.normalize/10" });
    expect(decideRetainedSelection([two, ten])).toBe(ten);
    expect(decideRetainedSelection([ten, two])).toBe(ten);
    expect(compareTransformVersions("d5.normalize/2", "d5.normalize/10")).toBeLessThan(0);
    expect(compareTransformVersions("d5.normalize/10", "d5.normalize/2")).toBeGreaterThan(0);
    expect(compareTransformVersions("d5.normalize/1", "d5.normalize/1")).toBe(0);
    // Non-numeric segments stay lexicographic; equal versions fall through
    // to the id tiebreak (tested below).
    expect(compareTransformVersions("d5.normalize/1", "d5.normalize/1b")).toBeLessThan(0);
  });

  it("ties break deterministically by representation id (stable across observations)", () => {
    const a = rep({ role: "retained", verifiedAtMs: 1, transformVersion: "d5.normalize/1" });
    const b = rep({ role: "retained", verifiedAtMs: 1, transformVersion: "d5.normalize/1" });
    const first = [a, b].sort((x, y) => (x._id < y._id ? -1 : 1))[0]!;
    expect(decideRetainedSelection([a, b])).toBe(first);
    expect(decideRetainedSelection([b, a])).toBe(first);
  });

  it("a verified normalized row beats the retained-original exception", () => {
    const exception = rep({
      role: "retained",
      verifiedAtMs: 1,
      transformVersion: RETAINED_ORIGINAL_TRANSFORM_VERSION,
      exceptionKind: "quality_unresolved",
    });
    const normalized = rep({ role: "retained", verifiedAtMs: 1 });
    expect(decideRetainedSelection([exception, normalized])).toBe(normalized);
    expect(decideRetainedSelection([exception])).toBe(exception);
  });
});

// ---------------------------------------------------------------------------
// THE received-bytes retention rule.
// ---------------------------------------------------------------------------

describe("decideReceivedCleanup", () => {
  const verifiedPair = (): RepresentationView[] => [
    receivedRow(),
    rep({ role: "retained", verifiedAtMs: 1 }),
    rep({ role: "thumbnail", transformVersion: THUMBNAIL_TRANSFORM_VERSION, verifiedAtMs: 1 }),
  ];

  it("removes the received bytes only when the full reference/recovery/quality chain holds", () => {
    const decision = decideReceivedCleanup({ representations: verifiedPair(), extractionReferences: 0 });
    expect(decision).toEqual({ remove: true, objectKey: "companies/c1/uploads/u1/0-uuid" });
  });

  it("refuses without a verified retained representation", () => {
    expect(
      decideReceivedCleanup({
        representations: [receivedRow(), rep({ role: "retained" })],
        extractionReferences: 0,
      }),
    ).toEqual({ remove: false, reason: "retained_not_verified" });
  });

  it("refuses while the recovery copy (thumbnail) is unverified", () => {
    expect(
      decideReceivedCleanup({
        representations: [
          receivedRow(),
          rep({ role: "retained", verifiedAtMs: 1 }),
          rep({ role: "thumbnail", transformVersion: THUMBNAIL_TRANSFORM_VERSION }),
        ],
        extractionReferences: 0,
      }),
    ).toEqual({ remove: false, reason: "thumbnail_not_verified" });
  });

  it("refuses when the retained selection IS the original exception (its bytes are the archive)", () => {
    expect(
      decideReceivedCleanup({
        representations: [
          receivedRow(),
          rep({
            role: "retained",
            verifiedAtMs: 1,
            transformVersion: RETAINED_ORIGINAL_TRANSFORM_VERSION,
            exceptionKind: "unsupported_input",
          }),
        ],
        extractionReferences: 0,
      }),
    ).toEqual({ remove: false, reason: "retained_is_original_exception" });
  });

  it("refuses while a historical extraction still references the received representation", () => {
    expect(
      decideReceivedCleanup({ representations: verifiedPair(), extractionReferences: 1 }),
    ).toEqual({ remove: false, reason: "received_referenced_by_extraction" });
  });

  it("an already-removed row is an idempotent refusal, never a second deletion", () => {
    expect(
      decideReceivedCleanup({
        representations: [receivedRow({ removedAtMs: 9 }), ...verifiedPair().slice(1)],
        extractionReferences: 0,
      }),
    ).toEqual({ remove: false, reason: "received_already_removed" });
  });
});

// ---------------------------------------------------------------------------
// Schema pins (the fragments.test.ts pattern for the D5 fragment-local
// vocabulary: the exception union must equal the mediaRepresentations
// column's literals at runtime, in both directions).
// ---------------------------------------------------------------------------

interface GenericValidator {
  readonly kind: string;
  readonly isConvexValidator: boolean;
  readonly fields?: Record<string, GenericValidator>;
  readonly members?: readonly GenericValidator[];
  readonly value?: unknown;
}

describe("protocol/schema pins", () => {
  it("the exception vocabulary equals the mediaRepresentations column union", () => {
    const validator = uploadsTables.mediaRepresentations.validator as GenericValidator;
    expect(validator.isConvexValidator).toBe(true);
    expect(validator.kind).toBe("object");
    const exceptionKind = validator.fields?.exceptionKind;
    expect(exceptionKind?.kind).toBe("union");
    const literals = (exceptionKind?.members ?? []).map((member) => {
      expect(member.kind).toBe("literal");
      return member.value as string;
    });
    expect([...literals].sort()).toEqual([...RETENTION_EXCEPTION_KINDS].sort());
    // And the protocol side decodes exactly that closed set.
    for (const kind of RETENTION_EXCEPTION_KINDS) {
      expect(() => Schema.decodeUnknownSync(RetentionExceptionKind)(kind)).not.toThrow();
    }
    expect(() => Schema.decodeUnknownSync(RetentionExceptionKind)("no_such_kind")).toThrow();
  });

  it("the digest form is exactly lower-case hex sha-256", () => {
    expect(() => Schema.decodeUnknownSync(Sha256Hex)("a".repeat(64))).not.toThrow();
    expect(() => Schema.decodeUnknownSync(Sha256Hex)("A".repeat(64))).toThrow();
    expect(() => Schema.decodeUnknownSync(Sha256Hex)("a".repeat(63))).toThrow();
  });
});
