/**
 * D2 focused tests: the upload-ledger transactions over an in-memory
 * emulation of the Convex db surface (tests/d2/harness.ts).
 *
 * These drive the REAL transaction functions — prepare/begin/part/
 * complete/finalize/reconcile/resume — including the tenant and owner
 * checks at every step, the idempotent/typed-conflict replay semantics and
 * the safe orphan reconciliation. The atomicity proofs (crash rollback,
 * concurrency) run live against the real deployment.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ResultEnvelope } from "@kiero/contracts";
import {
  beginUploadTransaction,
  completeAttachmentTransaction,
  finalizeUploadTransaction,
  prepareUploadTransaction,
  reconcileUploadsTransaction,
  recordPartTransaction,
  uploadSessionState,
} from "../../convex/sources/uploads/ledger";
import { ACTIVE_GRACE_MS, FINALIZED_GRACE_MS, objectKeyPrefix } from "../../convex/sources/uploads/protocol";
import {
  asReaderDb,
  asTx,
  contextFor,
  errorOf,
  fakeCtx,
  seedActor,
  valueOf,
  type ActorFixture,
  type FakeCtx,
} from "./harness";

let ctx: FakeCtx;
let actor: ActorFixture;
let other: ActorFixture;

const tx = () => asTx(ctx);

beforeEach(async () => {
  ctx = fakeCtx([
    "companies",
    "users",
    "sessions",
    "memberships",
    "gmAccessGrants",
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
  actor = await seedActor(ctx, "d2ledger-a");
  other = await seedActor(ctx, "d2ledger-b");
});

async function preparedUpload(
  draftId: string,
  mediaKinds: ("audio" | "image")[],
  parts: number,
  asActor: ActorFixture = actor,
): Promise<string> {
  const result = await prepareUploadTransaction(tx(), contextFor(asActor), {
    draftId,
    parts,
    mediaKinds,
  });
  expect(result._tag).toBe("ok");
  return valueOf(result).uploadId as string;
}

async function begunUpload(
  uploadId: string,
  kinds: ("audio" | "image")[],
  asActor: ActorFixture = actor,
): Promise<{ attachmentId: string; objectKey: string; r2UploadId: string }[]> {
  const attachments = kinds.map((kind, index) => ({
    objectKey: `${objectKeyPrefix(asActor.companyId)}${uploadId}/${index}-test`,
    r2UploadId: `r2-${uploadId}-${index}`,
    kind,
  }));
  const result = await beginUploadTransaction(tx(), contextFor(asActor), { uploadId, attachments });
  expect(result._tag).toBe("ok");
  return valueOf(result).attachments as { attachmentId: string; objectKey: string; r2UploadId: string }[];
}

async function recordPart(
  uploadId: string,
  attachmentId: string,
  partNumber: number,
  overrides: Record<string, unknown> = {},
): Promise<ResultEnvelope> {
  return recordPartTransaction(tx(), contextFor(actor), {
    uploadId,
    attachmentId,
    partNumber,
    etag: `etag-${partNumber}`,
    bytes: 5 * 1024 * 1024,
    sha256Hex: `${String(partNumber).padStart(64, "0")}`.slice(0, 64),
    ...overrides,
  });
}

async function completeAttachment(
  uploadId: string,
  attachmentId: string,
  totalBytes: number,
  objectEtag = "object-etag-1",
): Promise<ResultEnvelope> {
  return completeAttachmentTransaction(tx(), contextFor(actor), {
    uploadId,
    attachmentId,
    objectEtag,
    totalBytes,
  });
}

describe("prepare: the stable-draft resume identity", () => {
  it("records the declaration on a fresh draft", async () => {
    const uploadId = await preparedUpload("draft-1", ["audio", "image"], 4);
    const row = await ctx.db.get("uploads", uploadId);
    expect(row).toMatchObject({
      stage: "draft",
      draftId: "draft-1",
      attachmentCount: 2,
      declaredParts: 4,
      declaredKinds: ["audio", "image"],
    });
    expect(valueOf(await prepareUploadTransaction(tx(), contextFor(actor), { draftId: "draft-1", parts: 4, mediaKinds: ["image", "audio"] })).uploadId).toBe(uploadId);
  });

  it("returns the SAME row on replay but refuses a diverging re-declaration", async () => {
    const uploadId = await preparedUpload("draft-2", ["audio"], 3);
    const replay = valueOf(
      await prepareUploadTransaction(tx(), contextFor(actor), { draftId: "draft-2", parts: 3, mediaKinds: ["audio"] }),
    );
    expect(replay.uploadId).toBe(uploadId);

    const kindsChanged = await prepareUploadTransaction(tx(), contextFor(actor), {
      draftId: "draft-2",
      parts: 3,
      mediaKinds: ["image"],
    });
    expect(kindsChanged._tag).toBe("error");
    expect(errorOf(kindsChanged).code).toBe("draft_declaration_mismatch");

    const partsChanged = await prepareUploadTransaction(tx(), contextFor(actor), {
      draftId: "draft-2",
      parts: 9,
      mediaKinds: ["audio"],
    });
    expect(errorOf(partsChanged).code).toBe("draft_declaration_mismatch");
  });

  it("never resumes an orphaned draft and keeps tenants apart", async () => {
    const uploadId = await preparedUpload("draft-3", ["audio"], 2);
    await ctx.db.patch("uploads", uploadId, { stage: "orphaned" });
    const refused = await prepareUploadTransaction(tx(), contextFor(actor), {
      draftId: "draft-3",
      parts: 2,
      mediaKinds: ["audio"],
    });
    expect(refused._tag).toBe("error");
    expect(errorOf(refused).code).toBe("draft_expired_restart_required");

    // Same draftId under another company is a DIFFERENT ledger row.
    const otherUploadId = await preparedUpload("draft-3", ["audio"], 2, other);
    expect(otherUploadId).not.toBe(uploadId);
    expect(await ctx.db.get("uploads", otherUploadId)).toMatchObject({ companyId: other.companyId });
  });
});

describe("begin: server-issued keys and R2 identities become durable", () => {
  it("creates one attachment row per declared kind and moves to uploading", async () => {
    const uploadId = await preparedUpload("draft-b1", ["audio", "image"], 2);
    const attachments = await begunUpload(uploadId, ["image", "audio"]);
    expect(attachments).toHaveLength(2);
    expect(await ctx.db.get("uploads", uploadId)).toMatchObject({ stage: "uploading" });
  });

  it("rejects keys outside the tenant namespace and sessions off-declaration", async () => {
    const uploadId = await preparedUpload("draft-b2", ["audio"], 2);
    const foreign = await beginUploadTransaction(tx(), contextFor(actor), {
      uploadId,
      attachments: [
        { objectKey: `${objectKeyPrefix(other.companyId)}${uploadId}/0-x`, r2UploadId: "r2", kind: "audio" },
      ],
    });
    expect(foreign._tag).toBe("error");
    expect(errorOf(foreign).code).toBe("object_key_outside_tenant_namespace");

    const swapped = await beginUploadTransaction(tx(), contextFor(actor), {
      uploadId,
      attachments: [
        { objectKey: `${objectKeyPrefix(actor.companyId)}${uploadId}/0-x`, r2UploadId: "r2", kind: "image" },
      ],
    });
    expect(errorOf(swapped).code).toBe("attachment_declaration_mismatch");
  });

  it("replays identically and refuses a diverging session", async () => {
    const uploadId = await preparedUpload("draft-b3", ["audio"], 2);
    const first = await begunUpload(uploadId, ["audio"]);
    const replay = await begunUpload(uploadId, ["audio"]);
    expect(replay.map((row) => row.attachmentId)).toEqual(first.map((row) => row.attachmentId));

    const diverging = await beginUploadTransaction(tx(), contextFor(actor), {
      uploadId,
      attachments: [
        { objectKey: `${objectKeyPrefix(actor.companyId)}${uploadId}/9-other`, r2UploadId: "r2-9", kind: "audio" },
      ],
    });
    expect(diverging._tag).toBe("error");
    expect(errorOf(diverging).code).toBe("begin_session_mismatch");
  });

  it("denies a foreign tenant's actor on the upload", async () => {
    const uploadId = await preparedUpload("draft-b4", ["audio"], 2);
    const denied = await beginUploadTransaction(tx(), contextFor(other), {
      uploadId,
      attachments: [
        { objectKey: `${objectKeyPrefix(other.companyId)}${uploadId}/0-x`, r2UploadId: "r2", kind: "audio" },
      ],
    });
    expect(denied._tag).toBe("error");
    expect(errorOf(denied)._tag).toBe("forbidden");
    expect(errorOf(denied).code).toBe("tenant_scope_mismatch");
  });
});

describe("part: recorded receipts are the resume truth", () => {
  let uploadId: string;
  let attachmentId: string;

  beforeEach(async () => {
    uploadId = await preparedUpload("draft-p", ["audio"], 3);
    const rows = await begunUpload(uploadId, ["audio"]);
    attachmentId = rows[0]!.attachmentId;
  });

  it("records parts and accumulates the manifest", async () => {
    await recordPart(uploadId, attachmentId, 2);
    const second = await recordPart(uploadId, attachmentId, 1);
    expect(valueOf(second)).toMatchObject({ partNumber: 1, recorded: 2, idempotent: false });
    const row = await ctx.db.get("attachments", attachmentId);
    expect(JSON.parse(String(row?.partsJson)).map((p: { partNumber: number }) => p.partNumber)).toEqual([1, 2]);
    expect(await ctx.db.get("uploads", uploadId)).toMatchObject({ partCount: 2 });
  });

  it("treats identical receipts as idempotent and refreshed etags as updates", async () => {
    await recordPart(uploadId, attachmentId, 1);
    const replay = await recordPart(uploadId, attachmentId, 1);
    expect(valueOf(replay)).toMatchObject({ idempotent: true, recorded: 1 });

    const refreshed = await recordPart(uploadId, attachmentId, 1, { etag: "etag-1b" });
    expect(valueOf(refreshed)).toMatchObject({ idempotent: false, refreshed: true, recorded: 1 });
    const row = await ctx.db.get("attachments", attachmentId);
    expect(JSON.parse(String(row?.partsJson))[0]).toMatchObject({ etag: "etag-1b" });
  });

  it("rejects diverging content, out-of-bound numbers and foreign attachments typed", async () => {
    const conflict = await recordPart(uploadId, attachmentId, 1, { sha256Hex: "f".repeat(64) });
    // (nothing recorded yet for part 1: record first, then diverge)
    expect(conflict._tag).toBe("ok");
    const diverging = await recordPart(uploadId, attachmentId, 1, { bytes: 6 });
    expect(diverging._tag).toBe("error");
    expect(errorOf(diverging).code).toBe("part_receipt_conflict");

    const outOfBound = await recordPart(uploadId, attachmentId, 4);
    expect(errorOf(outOfBound).code).toBe("part_bound_exceeded");
    // 0 / non-integers are rejected by the input schema itself (typed throw
    // at the decode boundary, sanitized to validation through the dispatch).
    await expect(recordPart(uploadId, attachmentId, 0)).rejects.toThrow();

    const foreignUpload = await preparedUpload("draft-p2", ["audio"], 2);
    const foreignRows = await begunUpload(foreignUpload, ["audio"]);
    const foreign = await recordPartTransaction(tx(), contextFor(actor), {
      uploadId,
      attachmentId: foreignRows[0]!.attachmentId,
      partNumber: 1,
      etag: "e",
      bytes: 1,
      sha256Hex: "a".repeat(64),
    });
    expect(foreign._tag).toBe("error");
    expect(errorOf(foreign).code).toBe("attachment_not_in_upload");
  });

  it("refuses parts of a completed attachment (stale retry)", async () => {
    await recordPart(uploadId, attachmentId, 1, { bytes: 128 });
    await completeAttachment(uploadId, attachmentId, 128);
    const stale = await recordPart(uploadId, attachmentId, 2);
    expect(stale._tag).toBe("error");
    expect(errorOf(stale).code).toBe("attachment_finalized");
  });
});

describe("complete: durable R2 completion and the verified representation", () => {
  let uploadId: string;
  let attachmentId: string;

  beforeEach(async () => {
    uploadId = await preparedUpload("draft-c", ["image"], 1);
    const rows = await begunUpload(uploadId, ["image"]);
    attachmentId = rows[0]!.attachmentId;
  });

  it("refuses an empty manifest and a byte-count mismatch", async () => {
    expect(errorOf(await completeAttachment(uploadId, attachmentId, 10)).code).toBe("part_manifest_empty");
    await recordPart(uploadId, attachmentId, 1, { bytes: 100 });
    expect(errorOf(await completeAttachment(uploadId, attachmentId, 99)).code).toBe("attachment_bytes_mismatch");
  });

  it("records completion with the verified received representation, idempotently", async () => {
    await recordPart(uploadId, attachmentId, 1, { bytes: 100 });
    const done = await completeAttachment(uploadId, attachmentId, 100, "etag-x");
    expect(valueOf(done)).toMatchObject({ attachmentId, idempotent: false });

    const attachmentRow = await ctx.db.get("attachments", attachmentId);
    expect(attachmentRow).toMatchObject({ completedAtMs: expect.any(Number), r2ObjectEtag: "etag-x", receivedBytes: 100 });
    const representation = await ctx.db
      .query("mediaRepresentations")
      .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachmentId).eq("role", "received"))
      .first();
    expect(representation).toMatchObject({ objectKey: attachmentRow?.objectKey, verifiedAtMs: expect.any(Number) });

    const replay = await completeAttachment(uploadId, attachmentId, 100, "etag-x");
    expect(valueOf(replay)).toMatchObject({ idempotent: true });
    const diverging = await completeAttachment(uploadId, attachmentId, 100, "etag-y");
    expect(errorOf(diverging).code).toBe("attachment_finalized");
  });
});

describe("finalize: every declared attachment durable, then the recoverable state", () => {
  it("refuses incomplete or unverified declarations", async () => {
    const uploadId = await preparedUpload("draft-f", ["image", "image"], 1);
    const rows = await begunUpload(uploadId, ["image", "image"]);
    const a1 = rows[0]!.attachmentId;
    const a2 = rows[1]!.attachmentId;
    await recordPart(uploadId, a1, 1, { bytes: 10 });
    await completeAttachment(uploadId, a1, 10);
    // a2 incomplete:
    expect(errorOf(await finalizeUploadTransaction(tx(), contextFor(actor), { uploadId })).code).toBe(
      "attachments_not_complete",
    );
    // a2 complete but its representation unverified:
    await recordPart(uploadId, a2, 1, { bytes: 5 });
    await completeAttachment(uploadId, a2, 5);
    await ctx.db.patch("mediaRepresentations", representationIdOf(a2), { verifiedAtMs: undefined });
    expect(errorOf(await finalizeUploadTransaction(tx(), contextFor(actor), { uploadId })).code).toBe(
      "attachment_not_verified",
    );
  });

  it("finalizes atomically with the sources.uploadFinalized event, idempotently", async () => {
    const uploadId = await preparedUpload("draft-f2", ["image"], 1);
    const a1 = (await begunUpload(uploadId, ["image"]))[0]!.attachmentId;
    await recordPart(uploadId, a1, 1, { bytes: 7 });
    await completeAttachment(uploadId, a1, 7);

    const done = await finalizeUploadTransaction(tx(), contextFor(actor), { uploadId });
    expect(valueOf(done)).toMatchObject({ stage: "finalized", idempotent: false });
    expect(await ctx.db.get("uploads", uploadId)).toMatchObject({ stage: "finalized", finalizedAtMs: expect.any(Number) });

    const events = await ctx.db
      .query("outboxEvents")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", `sources.uploadFinalized:${actor.companyId}:${uploadId}`))
      .collect();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventName: "sources.uploadFinalized" });
    expect(ctx.scheduled.length).toBeGreaterThan(0);

    const replay = await finalizeUploadTransaction(tx(), contextFor(actor), { uploadId });
    expect(valueOf(replay)).toMatchObject({ stage: "finalized", idempotent: true });
    const eventsAfter = await ctx.db
      .query("outboxEvents")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", `sources.uploadFinalized:${actor.companyId}:${uploadId}`))
      .collect();
    expect(eventsAfter).toHaveLength(1);
  });
});

function representationIdOf(attachmentId: string): string {
  const rows = ctx.db.rows("mediaRepresentations").filter((row) => row.attachmentId === attachmentId);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no representation");
  }
  return row._id;
}

describe("reconcile: safe orphan collection", () => {
  async function uploadAt(
    draftId: string,
    stage: "draft" | "uploading" | "finalized" | "orphaned" | "failed",
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const uploadId = await preparedUpload(draftId, ["image"], 1);
    await begunUpload(uploadId, ["image"]);
    await ctx.db.patch("uploads", uploadId, { stage, ...overrides });
    return uploadId;
  }

  it("keeps accepted and active uploads; collects only expired unaccepted ones", async () => {
    const now = Date.now();
    const accepted = await uploadAt("r-accepted", "finalized", { acceptedSourceId: "k57accepted0000000000000s", lastActivityAtMs: 0 });
    const active = await uploadAt("r-active", "uploading", { lastActivityAtMs: now - 1 });
    const agedActive = await uploadAt("r-aged", "uploading", { lastActivityAtMs: now - ACTIVE_GRACE_MS - 1_000 });
    const recoverable = await uploadAt("r-finalized", "finalized", { lastActivityAtMs: now - FINALIZED_GRACE_MS + 1_000 });
    const expiredFinalized = await uploadAt("r-expired", "finalized", { lastActivityAtMs: now - FINALIZED_GRACE_MS - 1_000 });
    const failed = await uploadAt("r-failed", "failed", { lastActivityAtMs: now });

    const result = await reconcileUploadsTransaction(tx(), contextFor(actor));
    expect(result._tag).toBe("ok");
    const kept = new Map((valueOf(result).kept as { uploadId: string; reason: string }[]).map((k) => [k.uploadId, k.reason]));
    const collected = new Map(
      (valueOf(result).collect as { uploadId: string; reason: string }[]).map((c) => [c.uploadId, c.reason]),
    );

    expect(kept.get(accepted)).toBe("accepted");
    expect(kept.get(active)).toBe("active");
    expect(kept.get(recoverable)).toBe("finalized_within_grace");
    expect(collected.get(agedActive)).toBe("expired_unaccepted");
    expect(collected.get(expiredFinalized)).toBe("expired_unaccepted");
    expect(collected.get(failed)).toBe("already_orphaned");

    // Collected rows are marked orphaned with their reason and their R2
    // identities are returned for the Worker's collection pass.
    expect(await ctx.db.get("uploads", agedActive)).toMatchObject({ stage: "orphaned", orphanReason: "expired_unaccepted" });
    const collectList = valueOf(result).collect as { attachments: { objectKey: string; r2UploadId?: string }[] }[];
    expect(collectList[0]?.attachments[0]).toMatchObject({ r2UploadId: expect.any(String) });
  });

  it("returns already-orphaned uploads again so a crashed pass finishes", async () => {
    const uploadId = await uploadAt("r-orphan", "orphaned", { orphanReason: "expired_unaccepted" });
    const result = await reconcileUploadsTransaction(tx(), contextFor(actor));
    const collected = (valueOf(result).collect as { uploadId: string }[]).map((c) => c.uploadId);
    expect(collected).toContain(uploadId);
  });
});

describe("resume read: the gateway's session view", () => {
  it("returns the manifest and stays tenant-scoped", async () => {
    const uploadId = await preparedUpload("draft-s", ["audio"], 3);
    const attachment = (await begunUpload(uploadId, ["audio"]))[0]!;
    await recordPart(uploadId, attachment.attachmentId, 1, { bytes: 11 });

    const state = await uploadSessionState(asReaderDb(ctx), contextFor(actor), uploadId);
    expect(state._tag).toBe("ok");
    const stateValue = valueOf(state);
    expect(stateValue).toMatchObject({ uploadId, companyId: actor.companyId, stage: "uploading", declaredParts: 3 });
    expect((stateValue.attachments as { parts: { partNumber: number }[] }[])[0]?.parts).toEqual([
      expect.objectContaining({ partNumber: 1, bytes: 11 }),
    ]);

    const denied = await uploadSessionState(asReaderDb(ctx), contextFor(other), uploadId);
    expect(denied._tag).toBe("error");
    expect(errorOf(denied).code).toBe("tenant_scope_mismatch");
  });
});
