/**
 * R24 focused tests: the bounded dimension decoder, the binding adapter's
 * decoded OUTPUT contract, and the exception rows carrying the original's
 * pixel space (the coordinate space vision region validation needs over
 * the retained-original fallback).
 *
 * Synthetic byte fixtures follow the decisions suite's inline-bytes idiom:
 * minimal headers that exercise exactly one branch each.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  decodeImageDimensions,
  DIMENSION_HEAD_WINDOW_BYTES,
} from "../../apps/gateway/src/images/dimensions";
import { imagesBindingNormalizer } from "../../apps/gateway/src/images/normalizer";
import { recordNormalizationTransaction } from "../../convex/processing/images/ledger";
import { asTx, fakeCtx, seedActor, valueOf, type FakeCtx } from "../d2/harness";
import { seedImageOn, seedJobOn } from "./ledger-seeding";

let ctx: FakeCtx;

const tx = () => asTx(ctx);

/** A minimal PNG whose IHDR carries exactly (width, height). */
function pngBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const be32 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 0xff;
    bytes[offset + 1] = (value >>> 16) & 0xff;
    bytes[offset + 2] = (value >>> 8) & 0xff;
    bytes[offset + 3] = value & 0xff;
  };
  be32(16, width);
  be32(20, height);
  return bytes;
}

/** A minimal JPEG: APP0 then a SOF0 frame header carrying (width, height). */
function jpegBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4 + 18 + 19);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0); // SOI + APP0 len 16
  const offset = 2 + 2 + 16; // past the APP0 segment (marker + length bytes)
  bytes[offset] = 0xff;
  bytes[offset + 1] = 0xc0; // SOF0
  bytes[offset + 2] = 0x00;
  bytes[offset + 3] = 17; // length
  bytes[offset + 4] = 8; // precision
  bytes[offset + 5] = (height >> 8) & 0xff;
  bytes[offset + 6] = height & 0xff;
  bytes[offset + 7] = (width >> 8) & 0xff;
  bytes[offset + 8] = width & 0xff;
  return bytes;
}

/** A minimal lossless WebP whose VP8L header carries (width, height). */
function webpLosslessBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(21);
  bytes.set([0x52, 0x49, 0x46, 0x46, 6, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
  bytes.set([5, 0, 0, 0], 16); // chunk size
  bytes[20] = 0x2f; // signature
  const bits = (width - 1) | ((height - 1) << 14);
  return new Uint8Array([...bytes, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff]);
}

/** A minimal extended WebP whose VP8X canvas carries (width, height). */
function webpExtendedBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46, 18, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 0);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  bytes.set([10, 0, 0, 0], 16); // chunk size
  bytes[20] = 0x10; // flags
  // canvas minus one, 3 bytes LE each
  const w = width - 1;
  const h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return bytes;
}

describe("the bounded dimension decoder (R24)", () => {
  it("decodes png, jpeg and both webp header families", () => {
    expect(decodeImageDimensions(pngBytes(291, 200))).toEqual({ width: 291, height: 200 });
    expect(decodeImageDimensions(jpegBytes(500, 300))).toEqual({ width: 500, height: 300 });
    expect(decodeImageDimensions(webpLosslessBytes(300, 200))).toEqual({ width: 300, height: 200 });
    expect(decodeImageDimensions(webpExtendedBytes(4096, 1024))).toEqual({ width: 4096, height: 1024 });
  });

  it("refuses truncated, markerless and absurd headers — null, never a guess", () => {
    expect(decodeImageDimensions(pngBytes(291, 200).subarray(0, 20))).toBeNull();
    // A JPEG that reaches scan data before any SOF carries nothing.
    const noSof = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02]);
    expect(decodeImageDimensions(noSof)).toBeNull();
    // An IHDR that claims an absurd canvas is not what it says it is.
    expect(decodeImageDimensions(pngBytes(0x7fff_ffff, 4))).toBeNull();
    expect(decodeImageDimensions(new Uint8Array(32))).toBeNull();
    expect(decodeImageDimensions(new Uint8Array(0))).toBeNull();
  });

  it("the window bound is the documented 64 KiB head read", () => {
    expect(DIMENSION_HEAD_WINDOW_BYTES).toBe(65_536);
  });
});

describe("the binding adapter's decoded OUTPUT contract (R24)", () => {
  const bindingOf = (response: () => Promise<Response>) => {
    const binding = {
      input(): { transform(): { output(): { response(): Promise<Response> } } } {
        return {
          transform: () => ({ output: () => ({ response }) }),
        };
      },
    };
    return imagesBindingNormalizer(binding as never);
  };

  it("returns the real dimensions of its own webp output", async () => {
    const output = webpLosslessBytes(4096, 2160);
    const normalizer = bindingOf(async () => new Response(output.slice()));
    const normalized = await normalizer.normalize({
      kind: "retained",
      bytes: jpegBytes(8192, 4320),
      maxEdge: 4096,
      quality: 85,
    });
    expect(normalized.width).toBe(4096);
    expect(normalized.height).toBe(2160);
    expect(normalized.mimeType).toBe("image/webp");
    expect(normalized.bytes).toEqual(output);
  });

  it("throws with the executor status on a refused transform (the drive records it)", async () => {
    const normalizer = bindingOf(async () => new Response("forbidden", { status: 403 }));
    await expect(
      normalizer.normalize({ kind: "retained", bytes: jpegBytes(10, 10), maxEdge: 4096, quality: 85 }),
    ).rejects.toThrow(/403$/);
  });

  it("throws on an undecodable own output instead of returning a 0x0 stand-in", async () => {
    const normalizer = bindingOf(async () => new Response(new Uint8Array([1, 2, 3])));
    await expect(
      normalizer.normalize({ kind: "retained", bytes: jpegBytes(10, 10), maxEdge: 4096, quality: 85 }),
    ).rejects.toThrow("undecodable");
  });
});

describe("exception rows carry the original's pixel space (R24)", () => {
  beforeEach(() => {
    ctx = fakeCtx([
      "companies",
      "users",
      "sessions",
      "memberships",
      "sources",
      "sourceProjectLinks",
      "processingRuns",
      "extractions",
      "uploads",
      "attachments",
      "mediaRepresentations",
      "outboxEvents",
      "durableJobs",
    ]);
  });

  it("records width/height on the retained-original exception row", async () => {
    const actor = await seedActor(ctx, "dims");
    const seeded = await seedImageOn(ctx, "one", { company: actor.companyId });
    const job = await seedJobOn(ctx, actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    const result = valueOf(
      await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, {
        _tag: "exception",
        exceptionKind: "conversion_failed",
        originalSpace: { width: 4032, height: 3024 },
        failureStatus: 403,
      }),
    );
    expect(result.exception).toBe("conversion_failed");
    const retained = ctx.db.rows("mediaRepresentations").find((row) => row.role === "retained");
    expect(retained?.width).toBe(4032);
    expect(retained?.height).toBe(3024);
    // The executor's HTTP status persists on the durable row (entitlement
    // vs decode becomes distinguishable in the record).
    expect(retained?.exceptionFailureStatus).toBe(403);
  });

  it("omits the dimensions when the header did not resolve (never a stand-in)", async () => {
    const actor = await seedActor(ctx, "nodims");
    const seeded = await seedImageOn(ctx, "one", { company: actor.companyId });
    const job = await seedJobOn(ctx, actor.companyId, seeded.sourceId, [seeded.attachmentId]);
    await recordNormalizationTransaction(tx(), job.jobKey, seeded.attachmentId, {
      _tag: "exception",
      exceptionKind: "unsupported_input",
    });
    const retained = ctx.db.rows("mediaRepresentations").find((row) => row.role === "retained");
    expect(retained?.width).toBeUndefined();
    expect(retained?.height).toBeUndefined();
  });
});
