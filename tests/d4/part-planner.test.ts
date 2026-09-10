/**
 * D4 focused tests: the pure capture planner.
 *
 * Proves the protocol mapping decisions against the ONE shared bounds
 * definition (convex/sources/uploads/protocol.ts, the same module the
 * gateway imports): part counts at the 5 MiB boundary, the declared part
 * bound as a max (never a sum), the canonical mediaKinds declaration, the
 * resume diff against a recorded manifest, and the honest
 * declaration-mismatch rule for drafts whose local material changed.
 */

import { describe, expect, it } from "vitest";
import { MIN_PART_BYTES } from "../../convex/sources/uploads/protocol";
import {
  canonicalMediaKinds,
  declarationMatches,
  declaredPartsOf,
  missingPartNumbers,
  partCountOf,
  partRange,
} from "../../apps/web/src/features/capture/planner";

const MIB = 1024 * 1024;

describe("partCountOf (the 5 MiB slicing rule)", () => {
  it("uses the shared protocol bound", () => {
    expect(MIN_PART_BYTES).toBe(5 * MIB);
  });

  it("slices at the boundary exactly", () => {
    expect(partCountOf(0)).toBe(1); // an empty attachment is one empty part
    expect(partCountOf(64 * 1024)).toBe(1); // a small photo
    expect(partCountOf(5 * MIB)).toBe(1); // exactly one full part
    expect(partCountOf(5 * MIB + 1)).toBe(2);
    expect(partCountOf(12 * MIB)).toBe(3); // a long recording
    expect(partCountOf(96 * MIB)).toBe(20); // the D2 large-fixture scale
  });
});

describe("partRange", () => {
  it("produces non-last parts of exactly the bound and a smaller last part", () => {
    const bytes = 12 * MIB;
    expect(partRange(bytes, 1)).toEqual({ offset: 0, end: 5 * MIB });
    expect(partRange(bytes, 2)).toEqual({ offset: 5 * MIB, end: 10 * MIB });
    expect(partRange(bytes, 3)).toEqual({ offset: 10 * MIB, end: 12 * MIB });
  });

  it("caps an overlong part number to the last part (defensive)", () => {
    expect(partRange(6 * MIB, 99)).toEqual({ offset: 5 * MIB, end: 6 * MIB });
  });
});

describe("declaredPartsOf (the prepare bound is a MAX, never a sum)", () => {
  it("declares the maximum per-attachment count", () => {
    // A 12 MiB recording (3 parts) plus two small photos (1 part each):
    // the bound is 3, not 5 — D2 numbers parts per attachment.
    const bound = declaredPartsOf([
      { kind: "audio", bytes: 12 * MIB },
      { kind: "image", bytes: 64 * 1024 },
      { kind: "image", bytes: 128 * 1024 },
    ]);
    expect(bound).toBe(3);
  });

  it("declares 1 for attachments with no multi-part member", () => {
    expect(declaredPartsOf([{ kind: "image", bytes: 100 }])).toBe(1);
  });
});

describe("canonicalMediaKinds (a pure function of the draft)", () => {
  it("declares [] for a text-only message (the certified text-only prepare)", () => {
    expect(canonicalMediaKinds(false, 0)).toEqual([]);
  });

  it("declares audio first, then one image per photo", () => {
    expect(canonicalMediaKinds(true, 0)).toEqual(["audio"]);
    expect(canonicalMediaKinds(true, 3)).toEqual(["audio", "image", "image", "image"]);
    expect(canonicalMediaKinds(false, 2)).toEqual(["image", "image"]);
  });
});

describe("missingPartNumbers (the resume diff)", () => {
  it("returns only the parts the server has not recorded", () => {
    expect(missingPartNumbers(3, [])).toEqual([1, 2, 3]);
    expect(missingPartNumbers(3, [1])).toEqual([2, 3]);
    expect(missingPartNumbers(3, [1, 2, 3])).toEqual([]);
  });
});

describe("declarationMatches (the honest restart rule)", () => {
  it("matches as a multiset (order is not identity)", () => {
    expect(declarationMatches(["audio", "image"], ["image", "audio"])).toBe(true);
    expect(declarationMatches(["audio"], ["audio"])).toBe(true);
  });

  it("rejects changed local material after prepare", () => {
    expect(declarationMatches(["audio", "image"], ["audio"])).toBe(false);
    expect(declarationMatches(["image"], ["audio"])).toBe(false);
    expect(declarationMatches([], ["audio"])).toBe(false);
  });
});
