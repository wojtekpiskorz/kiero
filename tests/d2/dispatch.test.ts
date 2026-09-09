/**
 * D2 focused tests: the uploads dispatch wiring — the certified client
 * operations and the gateway protocol steps over the SAME checked order
 * (decode -> known step -> canonical identity -> policy -> handler).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { dispatchUploadsCommand, dispatchUploadsStep, uploadsHandlers } from "../../convex/sources/uploads/dispatch";
import { asTx, errorOf, fakeCtx, seedActor, valueOf, type ActorFixture, type FakeCtx } from "./harness";

let ctx: FakeCtx;
let actor: ActorFixture;

const command = (operation: string, input_: unknown, idempotencyKey?: string) => ({
  operation,
  input: input_,
  expectedRevisions: [],
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

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
  actor = await seedActor(ctx, "d2dispatch");
});

describe("the certified client operations", () => {
  it("implements both operations with the certified result shape", () => {
    const handlers = uploadsHandlers();
    expect(Object.keys(handlers).sort()).toEqual(["sources.prepareUpload", "sources.resumeUpload"]);
  });

  it("dispatches prepareUpload through the bridge identity path", async () => {
    const result = await dispatchUploadsCommand(
      asTx(ctx),
      command("sources.prepareUpload", { draftId: "dispatch-1", parts: 2, mediaKinds: ["audio"] }),
      actor.sessionId,
    );
    expect(result._tag).toBe("ok");
    expect(valueOf(result)).toEqual({ uploadId: expect.any(String), stage: "draft" });

    // Unknown operations fail closed:
    const unknown = await dispatchUploadsCommand(
      asTx(ctx),
      command("sources.unknownOp", {}),
      actor.sessionId,
    );
    expect(unknown._tag).toBe("error");
    expect(errorOf(unknown)._tag).toBe("unsupported");
  });

  it("fails unauthenticated without a verified identity (there is no shortcut)", async () => {
    const result = await dispatchUploadsCommand(
      asTx(ctx),
      command("sources.prepareUpload", { draftId: "dispatch-2", parts: 2, mediaKinds: ["audio"] }),
      undefined,
    );
    expect(result._tag).toBe("error");
    expect(errorOf(result)._tag).toBe("unauthenticated");
  });

  it("denies a revoked session through the canonical resolution", async () => {
    await ctx.db.patch("sessions", actor.sessionId, { revokedAtMs: Date.now() });
    const result = await dispatchUploadsCommand(
      asTx(ctx),
      command("sources.prepareUpload", { draftId: "dispatch-3", parts: 2, mediaKinds: ["audio"] }),
      actor.sessionId,
    );
    expect(result._tag).toBe("error");
    expect(errorOf(result)._tag).toBe("unauthenticated");
  });
});

describe("the gateway protocol steps", () => {
  it("routes prepare through the certified operation (one implementation)", async () => {
    const result = await dispatchUploadsStep(
      asTx(ctx),
      { step: "prepare", input: { draftId: "step-1", parts: 2, mediaKinds: ["image"] } },
      actor.sessionId,
    );
    expect(result._tag).toBe("ok");
    expect(valueOf(result)).toEqual({ uploadId: expect.any(String), stage: "draft" });
  });

  it("fails unknown steps and malformed envelopes typed", async () => {
    // The step vocabulary is closed: an off-vocabulary step name is rejected
    // by the envelope decode (validation), never dispatched.
    const unknown = await dispatchUploadsStep(asTx(ctx), { step: "rollback", input: {} }, actor.sessionId);
    expect(unknown._tag).toBe("error");
    expect(errorOf(unknown)._tag).toBe("validation");

    const malformed = await dispatchUploadsStep(asTx(ctx), { step: "begin" }, actor.sessionId);
    expect(malformed._tag).toBe("error");
    expect(errorOf(malformed)._tag).toBe("validation");
  });

  it("checks tenant scope on every step (cross-tenant upload denied)", async () => {
    const prepared = await dispatchUploadsStep(
      asTx(ctx),
      { step: "prepare", input: { draftId: "step-2", parts: 2, mediaKinds: ["image"] } },
      actor.sessionId,
    );
    const uploadId = valueOf(prepared).uploadId as string;
    const other = await seedActor(ctx, "d2dispatch-b");
    const denied = await dispatchUploadsStep(
      asTx(ctx),
      { step: "finalize", input: { uploadId } },
      other.sessionId,
    );
    expect(denied._tag).toBe("error");
    expect(errorOf(denied)._tag).toBe("forbidden");
    expect(errorOf(denied).code).toBe("tenant_scope_mismatch");
  });

  it("checks identity BEFORE input decode (the certified order, no drift)", async () => {
    // A revoked session with malformed input refuses on identity, not shape:
    // the step rides dispatchCommand, whose order is envelope -> operation ->
    // identity -> policy -> input decode.
    await ctx.db.patch("sessions", actor.sessionId, { revokedAtMs: Date.now() });
    const revoked = await dispatchUploadsStep(
      asTx(ctx),
      { step: "begin", input: { uploadId: 42 } },
      actor.sessionId,
    );
    expect(revoked._tag).toBe("error");
    expect(errorOf(revoked)._tag).toBe("unauthenticated");

    // A live session with the same malformed input reaches the input decode.
    const fresh = await seedActor(ctx, "d2dispatch-order");
    const malformed = await dispatchUploadsStep(
      asTx(ctx),
      { step: "begin", input: { uploadId: 42 } },
      fresh.sessionId,
    );
    expect(malformed._tag).toBe("error");
    expect(errorOf(malformed)._tag).toBe("validation");
  });

  it("sanitizes handler throws to unavailable (never a raw internal error)", async () => {
    // A corrupt manifest inside the part step throws inside the handler.
    const prepared = await dispatchUploadsStep(
      asTx(ctx),
      { step: "prepare", input: { draftId: "step-3", parts: 2, mediaKinds: ["image"] } },
      actor.sessionId,
    );
    const uploadId = valueOf(prepared).uploadId as string;
    const attachmentId = await ctx.db.insert("attachments", {
      uploadId,
      kind: "image",
      objectKey: `companies/${actor.companyId}/uploads/${uploadId}/0-x`,
      r2UploadId: "r2",
      partsJson: "{corrupt",
      createdAtMs: Date.now(),
    });
    await ctx.db.patch("uploads", uploadId, { stage: "uploading" });
    const result = await dispatchUploadsStep(
      asTx(ctx),
      {
        step: "part",
        input: { uploadId, attachmentId, partNumber: 1, etag: "e", bytes: 1, sha256Hex: "a".repeat(64) },
      },
      actor.sessionId,
    );
    expect(result._tag).toBe("error");
    expect(errorOf(result)._tag).toBe("unavailable");
  });
});