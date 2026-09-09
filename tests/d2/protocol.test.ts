/**
 * D2 focused tests: the pure upload-protocol decisions (part manifests,
 * resume identity, orphan reconciliation, the all-attachments-durable gate).
 *
 * The transaction-level behavior over these decisions lives in
 * ledger.test.ts and acceptance.test.ts; the live proofs run the same code
 * against the real deployment, Worker and R2.
 */

import { describe, expect, it } from "vitest";
import {
  ACTIVE_GRACE_MS,
  FINALIZED_GRACE_MS,
  decideAttachmentGate,
  decidePartReceipt,
  decideReconciliation,
  isStrictlyAscending,
  manifestBytes,
  objectKeyInTenantNamespace,
  objectKeyPrefix,
  parseManifest,
  serializeManifest,
  upsertReceipt,
  validatePartNumber,
  type AttachmentForAcceptance,
  type PartReceipt,
  type ReceivedRepresentationView,
} from "../../convex/sources/uploads/protocol";

const COMPANY = "k57company0000000000000a";

const receipt = (partNumber: number, overrides: Partial<PartReceipt> = {}): PartReceipt => ({
  partNumber,
  etag: `etag-${partNumber}`,
  bytes: 5 * 1024 * 1024,
  sha256Hex: "a".repeat(64),
  receivedAtMs: 1_000,
  ...overrides,
});

describe("part manifests", () => {
  it("parses undefined as empty and round-trips canonically", () => {
    expect(parseManifest(undefined)).toEqual([]);
    const manifest = [receipt(2), receipt(1)];
    const stored = serializeManifest(manifest);
    expect(JSON.parse(stored)).toEqual([receipt(1), receipt(2)]);
    expect(parseManifest(stored)).toEqual([receipt(1), receipt(2)]);
  });

  it("fails loudly on a corrupt manifest (never a silent restart)", () => {
    expect(() => parseManifest("{not json")).toThrow();
    expect(() => parseManifest("[{\"partNumber\":")).toThrow();
  });

  it("decides record / idempotent / refresh / conflict", () => {
    const existing = [receipt(1)];
    expect(decidePartReceipt(existing, receipt(2))).toEqual({ decision: "record" });
    expect(decidePartReceipt(existing, receipt(1))).toEqual({ decision: "idempotent" });
    // Same bytes and digest under a NEW R2 etag: a lost-response retry of
    // identical bytes — the manifest must carry the latest etag.
    expect(decidePartReceipt(existing, receipt(1, { etag: "etag-1b" }))).toEqual({
      decision: "refresh",
    });
    // Different content for the same part number: never a silent overwrite.
    expect(
      decidePartReceipt(existing, receipt(1, { sha256Hex: "b".repeat(64) })),
    ).toEqual({ decision: "conflict", code: "part_receipt_conflict" });
    expect(decidePartReceipt(existing, receipt(1, { bytes: 6 }))).toEqual({
      decision: "conflict",
      code: "part_receipt_conflict",
    });
  });

  it("upserts by part number, sorted ascending", () => {
    const manifest = upsertReceipt([receipt(2)], receipt(1));
    expect(manifest.map((entry) => entry.partNumber)).toEqual([1, 2]);
    const replaced = upsertReceipt(manifest, receipt(2, { etag: "etag-2b" }));
    expect(replaced).toHaveLength(2);
    expect(replaced[1]?.etag).toBe("etag-2b");
  });

  it("validates part numbers against the 1-based declared bound", () => {
    expect(validatePartNumber(1, 3)).toEqual({ ok: true });
    expect(validatePartNumber(3, 3)).toEqual({ ok: true });
    expect(validatePartNumber(0, 3)).toEqual({ ok: false, code: "part_number_out_of_range" });
    expect(validatePartNumber(1.5, 3)).toEqual({ ok: false, code: "part_number_out_of_range" });
    expect(validatePartNumber(4, 3)).toEqual({ ok: false, code: "part_bound_exceeded" });
    expect(validatePartNumber(99, undefined)).toEqual({ ok: true });
  });

  it("checks strictly ascending completion order and byte sums", () => {
    expect(isStrictlyAscending([1, 2, 3])).toBe(true);
    expect(isStrictlyAscending([1, 1])).toBe(false);
    expect(isStrictlyAscending([2, 1])).toBe(false);
    expect(manifestBytes([receipt(1, { bytes: 10 }), receipt(2, { bytes: 32 })])).toBe(42);
  });

  it("scopes object keys to the tenant namespace", () => {
    expect(objectKeyInTenantNamespace(`${objectKeyPrefix(COMPANY)}u1/0-x`, COMPANY)).toBe(true);
    expect(objectKeyInTenantNamespace("companies/other/uploads/u1/0-x", COMPANY)).toBe(false);
    expect(objectKeyInTenantNamespace("uploads/u1", COMPANY)).toBe(false);
  });
});

describe("orphan reconciliation decisions", () => {
  const view = (overrides: Partial<Parameters<typeof decideReconciliation>[0]>) => ({
    stage: "uploading" as const,
    createdAtMs: 1_000,
    ...overrides,
  });
  const NOW = 10 * 24 * 60 * 60 * 1_000;

  it("never collects an accepted upload", () => {
    expect(decideReconciliation(view({ acceptedSourceId: "k57source00000000000000s" }), NOW)).toEqual({
      action: "keep",
      reason: "accepted",
    });
    expect(
      decideReconciliation(
        view({ stage: "finalized", acceptedSourceId: "s", lastActivityAtMs: 0 }),
        NOW,
      ),
    ).toEqual({ action: "keep", reason: "accepted" });
  });

  it("keeps active uploads inside the activity grace", () => {
    expect(decideReconciliation(view({ lastActivityAtMs: NOW - ACTIVE_GRACE_MS + 1 }), NOW)).toEqual({
      action: "keep",
      reason: "active",
    });
    expect(decideReconciliation(view({ stage: "draft", lastActivityAtMs: NOW - 1 }), NOW)).toEqual({
      action: "keep",
      reason: "active",
    });
  });

  it("collects expired active uploads only past the grace", () => {
    expect(decideReconciliation(view({ lastActivityAtMs: NOW - ACTIVE_GRACE_MS - 1 }), NOW)).toEqual({
      action: "collect",
      reason: "expired_unaccepted",
    });
  });

  it("keeps finalized-but-unaccepted uploads recoverable through the ledger", () => {
    expect(
      decideReconciliation(view({ stage: "finalized", lastActivityAtMs: NOW - FINALIZED_GRACE_MS + 1 }), NOW),
    ).toEqual({ action: "keep", reason: "finalized_within_grace" });
    expect(
      decideReconciliation(view({ stage: "finalized", lastActivityAtMs: NOW - FINALIZED_GRACE_MS - 1 }), NOW),
    ).toEqual({ action: "collect", reason: "expired_unaccepted" });
  });

  it("returns already-orphaned and failed uploads for collection", () => {
    expect(decideReconciliation(view({ stage: "orphaned" }), NOW)).toEqual({
      action: "collect",
      reason: "already_orphaned",
    });
    expect(decideReconciliation(view({ stage: "failed" }), NOW)).toEqual({
      action: "collect",
      reason: "already_orphaned",
    });
  });
});

describe("the all-attachments-durable acceptance gate", () => {
  const attachment = (id: string, overrides: Partial<AttachmentForAcceptance> = {}): AttachmentForAcceptance => ({
    _id: id,
    uploadId: "u1",
    kind: "image",
    completedAtMs: 1_000,
    ...overrides,
  });
  const representation = (id: string): ReceivedRepresentationView => ({
    attachmentId: id,
    verifiedAtMs: 1_000,
  });

  it("passes text-only acceptance through (D1 semantics)", () => {
    expect(decideAttachmentGate("draft", 0, [], [])).toEqual({ ok: true, attachmentIds: [] });
  });

  it("requires the finalized stage for attachment-bearing sources", () => {
    expect(decideAttachmentGate("uploading", 1, [attachment("a1")], [representation("a1")])).toEqual({
      ok: false,
      code: "attachments_not_finalized",
    });
  });

  it("requires the declaration fully materialized", () => {
    expect(
      decideAttachmentGate("finalized", 2, [attachment("a1")], [representation("a1")]),
    ).toEqual({ ok: false, code: "attachment_declaration_mismatch" });
  });

  it("requires every attachment durably completed and verified", () => {
    expect(
      decideAttachmentGate("finalized", 2, [attachment("a1", { completedAtMs: undefined }), attachment("a2")], [
        representation("a1"),
        representation("a2"),
      ]),
    ).toEqual({ ok: false, code: "attachment_incomplete" });
    expect(decideAttachmentGate("finalized", 1, [attachment("a1")], [])).toEqual({
      ok: false,
      code: "attachment_not_verified",
    });
    expect(
      decideAttachmentGate("finalized", 1, [attachment("a1")], [{ attachmentId: "a1" }]),
    ).toEqual({ ok: false, code: "attachment_not_verified" });
  });

  it("refuses attachments already bound to another source", () => {
    expect(
      decideAttachmentGate("finalized", 1, [attachment("a1", { sourceId: "s1" })], [representation("a1")]),
    ).toEqual({ ok: false, code: "attachment_already_bound" });
  });

  it("accepts a fully durable declaration and returns the verified ids", () => {
    expect(
      decideAttachmentGate(
        "finalized",
        2,
        [attachment("a1", { kind: "audio" }), attachment("a2")],
        [representation("a2"), representation("a1")],
      ),
    ).toEqual({ ok: true, attachmentIds: ["a1", "a2"] });
  });
});
