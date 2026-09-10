/**
 * D2 focused tests: attachment-bearing acceptance over the D1 transaction
 * (`performAcceptance`, minimally extended by D2 — see the flagged file).
 *
 * The all-attachments-durable gate runs inside the transaction's
 * reference-check phase, so every failing gate below must leave NOTHING
 * written; the happy path must commit source, attachment bindings, the
 * ledger's accepted marker, the canonical event (with the verified
 * attachment ids) and the durable processing registration together.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { performAcceptance, type AcceptSourceInput } from "../../convex/sources/accept/acceptance";
import { objectKeyPrefix } from "../../convex/sources/uploads/protocol";
import { asTx, contextFor, errorOf, fakeCtx, seedActor, valueOf, type ActorFixture, type FakeCtx } from "./harness";

let ctx: FakeCtx;
let actor: ActorFixture;

const value = (envelope: { _tag: string; value?: unknown }) => envelope.value as Record<string, unknown>;
/** The fixture's upload id as the branded input type (harness ids are plain). */
const input = (uploadId: string): AcceptSourceInput =>
  ({
    uploadId,
    authorText: "Dowóz płytek na Buniewice; zdjęcie faktury w załączniku",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  }) as unknown as AcceptSourceInput;


/** Prepares + begins + completes a two-attachment upload through the ledger. */
async function durableUpload(
  draftId: string,
  options: { stage?: "uploading" | "finalized"; verifySecond?: boolean; completeSecond?: boolean } = {},
): Promise<{ uploadId: string; attachmentIds: string[] }> {
  const { prepareUploadTransaction, beginUploadTransaction, recordPartTransaction, completeAttachmentTransaction, finalizeUploadTransaction } =
    await import("../../convex/sources/uploads/ledger");
  const prepared = await prepareUploadTransaction(asTx(ctx), contextFor(actor), {
    draftId,
    parts: 2,
    mediaKinds: ["audio", "image"],
  });
  const uploadId = value(prepared).uploadId as string;
  const begun = await beginUploadTransaction(asTx(ctx), contextFor(actor), {
    uploadId,
    attachments: [
      { objectKey: `${objectKeyPrefix(actor.companyId)}${uploadId}/0-t`, r2UploadId: "r2-0", kind: "audio" },
      { objectKey: `${objectKeyPrefix(actor.companyId)}${uploadId}/1-t`, r2UploadId: "r2-1", kind: "image" },
    ],
  });
  const attachmentIds = (value(begun).attachments as { attachmentId: string }[]).map((a) => a.attachmentId);
  let index = 0;
  for (const attachmentId of attachmentIds) {
    index += 1;
    const complete = index === 1 || (options.completeSecond ?? true);
    await recordPartTransaction(asTx(ctx), contextFor(actor), {
      uploadId,
      attachmentId,
      partNumber: 1,
      etag: `etag-${index}`,
      bytes: 64,
      sha256Hex: `${index}`.padEnd(64, "0"),
    });
    if (complete) {
      await completeAttachmentTransaction(asTx(ctx), contextFor(actor), {
        uploadId,
        attachmentId,
        objectEtag: `object-${index}`,
        totalBytes: 64,
      });
    }
  }
  if (options.verifySecond === false) {
    const representation = ctx.db
      .rows("mediaRepresentations")
      .find((row) => row.attachmentId === attachmentIds[1]);
    if (representation !== undefined) {
      await ctx.db.patch("mediaRepresentations", representation._id, { verifiedAtMs: undefined });
    }
  }
  if ((options.stage ?? "finalized") === "finalized") {
    await finalizeUploadTransaction(asTx(ctx), contextFor(actor), { uploadId });
  }
  return { uploadId, attachmentIds };
}

beforeEach(async () => {
  ctx = fakeCtx([
    "companies",
    "users",
    "sessions",
    "memberships",
    "gmAccessGrants",
    "projects",
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
  actor = await seedActor(ctx, "d2accept");
});

describe("attachment-bearing acceptance commits ONE atomic source", () => {
  it("binds source, attachments and ledger together with the verified ids in the event", async () => {
    const { uploadId, attachmentIds } = await durableUpload("draft-accept-1");
    const result = await performAcceptance(asTx(ctx), contextFor(actor), input(uploadId), "key-accept-1");
    expect(result._tag).toBe("ok");
    const sourceId = valueOf(result).sourceId as string;

    expect(ctx.db.rows("sources")).toHaveLength(1);
    expect(await ctx.db.get("sources", sourceId)).toMatchObject({
      companyId: actor.companyId,
      lifecycle: "active",
      acceptanceKey: "key-accept-1",
    });
    // Attachments bound inside the SAME transaction:
    for (const attachmentId of attachmentIds) {
      expect(await ctx.db.get("attachments", attachmentId)).toMatchObject({ sourceId });
    }
    // The ledger row is marked accepted (never collectable):
    expect(await ctx.db.get("uploads", uploadId)).toMatchObject({ acceptedSourceId: sourceId });

    // The canonical event carries the verified attachment ids:
    const event = ctx.db.rows("outboxEvents").find((row) => row.eventName === "sources.sourceAccepted");
    expect(event).toBeDefined();
    expect(JSON.parse((event ?? { envelopeJson: "{}" }).envelopeJson as string).payload).toEqual({
      sourceId,
      attachmentIds,
    });

    // Durable processing registered atomically:
    const job = ctx.db.rows("durableJobs").find((row) => row.kind === "processing.extract_fragments");
    expect(job).toMatchObject({ state: "queued", companyId: actor.companyId });
    expect(ctx.scheduled.length).toBeGreaterThan(0);
  });

  it("replays one logical key onto the SAME source without rebinding work", async () => {
    const { uploadId } = await durableUpload("draft-accept-2");
    const first = await performAcceptance(asTx(ctx), contextFor(actor), input(uploadId), "key-accept-2");
    const second = await performAcceptance(asTx(ctx), contextFor(actor), input(uploadId), "key-accept-2");
    expect(valueOf(second).sourceId).toBe(valueOf(first).sourceId);
    expect(ctx.db.rows("sources")).toHaveLength(1);
    expect(
      ctx.db.rows("outboxEvents").filter((row) => row.eventName === "sources.sourceAccepted"),
    ).toHaveLength(1);
  });
});

describe("a failing gate writes NOTHING (no accepted orphan)", () => {
  const rowsOf = () => ({
    sources: ctx.db.rows("sources").length,
    outbox: ctx.db.rows("outboxEvents").length,
    jobs: ctx.db.rows("durableJobs").length,
  });

  it("rejects an upload that is not finalized (typed at either layer)", async () => {
    // Still uploading: the D1 stage check refuses it first.
    const uploading = await durableUpload("draft-gate-1", { stage: "uploading" });
    const beforeUploading = rowsOf();
    const stageResult = await performAcceptance(asTx(ctx), contextFor(actor), input(uploading.uploadId), "key-g1a");
    expect(stageResult._tag).toBe("error");
    expect(errorOf(stageResult).code).toBe("upload_stage_not_acceptable");
    expect(rowsOf()).toEqual(beforeUploading);

    // Draft stage with materialized attachments: the D2 gate refuses it.
    const draft = await durableUpload("draft-gate-1b", { stage: "uploading" });
    await ctx.db.patch("uploads", draft.uploadId, { stage: "draft" });
    const beforeDraft = rowsOf();
    const gateResult = await performAcceptance(asTx(ctx), contextFor(actor), input(draft.uploadId), "key-g1b");
    expect(gateResult._tag).toBe("error");
    expect(errorOf(gateResult).code).toBe("attachments_not_finalized");
    expect(rowsOf()).toEqual(beforeDraft);
  });

  it("rejects an incomplete declaration", async () => {
    const { uploadId, attachmentIds } = await durableUpload("draft-gate-2");
    // Drift after finalize: one attachment loses its durable completion.
    await ctx.db.patch("attachments", attachmentIds[1]!, { completedAtMs: undefined });
    const before = rowsOf();
    const result = await performAcceptance(asTx(ctx), contextFor(actor), input(uploadId), "key-g2");
    expect(errorOf(result).code).toBe("attachment_incomplete");
    expect(rowsOf()).toEqual(before);
  });

  it("rejects an unverified received representation", async () => {
    const { uploadId, attachmentIds } = await durableUpload("draft-gate-3");
    const representation = ctx.db
      .rows("mediaRepresentations")
      .find((row) => row.attachmentId === attachmentIds[1]);
    await ctx.db.patch("mediaRepresentations", representation!._id, { verifiedAtMs: undefined });
    const before = rowsOf();
    const result = await performAcceptance(asTx(ctx), contextFor(actor), input(uploadId), "key-g3");
    expect(errorOf(result).code).toBe("attachment_not_verified");
    expect(rowsOf()).toEqual(before);
    expect(ctx.db.rows("uploads").find((row) => row._id === uploadId)?.acceptedSourceId).toBeUndefined();
  });

  it("rejects attachments already bound to a source (typed conflict)", async () => {
    const { uploadId } = await durableUpload("draft-gate-4");
    const first = await performAcceptance(asTx(ctx), contextFor(actor), input(uploadId), "key-g4");
    expect(first._tag).toBe("ok");
    const second = await performAcceptance(asTx(ctx), contextFor(actor), input(uploadId), "key-g4b");
    expect(second._tag).toBe("error");
    expect(errorOf(second)._tag).toBe("conflict");
    expect(errorOf(second).code).toBe("attachment_already_bound");
    expect(ctx.db.rows("sources")).toHaveLength(1);
  });
});

describe("text-only acceptance keeps the exact D1 semantics", () => {
  it("accepts a plain draft upload with no attachments and no ledger binding", async () => {
    const uploadId = await ctx.db.insert("uploads", {
      companyId: actor.companyId,
      userId: actor.userId,
      stage: "draft",
      partCount: 0,
      createdAtMs: Date.now(),
    });
    const result = await performAcceptance(asTx(ctx), contextFor(actor), input(uploadId), "key-text-1");
    expect(result._tag).toBe("ok");
    const sourceId = valueOf(result).sourceId as string;
    const event = ctx.db.rows("outboxEvents").find((row) => row.eventName === "sources.sourceAccepted");
    expect(JSON.parse((event ?? { envelopeJson: "{}" }).envelopeJson as string).payload).toEqual({
      sourceId,
      attachmentIds: [],
    });
    expect(ctx.db.rows("uploads").find((row) => row._id === uploadId)?.acceptedSourceId).toBeUndefined();
  });
});
