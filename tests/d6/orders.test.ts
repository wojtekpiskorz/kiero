/**
 * D6 focused tests: the STT order transaction over the in-memory Convex
 * emulation (tests/d2/harness.ts).
 *
 * These drive the REAL order transaction — tenant and reference checks,
 * the guarded proof byte channel, idempotent replay (one order + one
 * durable registration per attachment+config) and the new-version rule
 * (a different segmentation config creates a NEW order; completed
 * versions are never edited).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { ResultEnvelope } from "@kiero/contracts";
import { orderAudioTranscript, MAX_PROOF_STASH_BYTES } from "../../convex/processing/audio/orders";
import { bytesToBase64, toneWav } from "@kiero/media-worker/wav";
import {
  asTx,
  contextFor,
  errorOf,
  fakeCtx,
  seedActor,
  valueOf,
  type ActorFixture,
  type FakeCtx,
} from "../d2/harness";

const TABLES = [
  "companies",
  "users",
  "sessions",
  "memberships",
  "gmAccessGrants",
  "sources",
  "processingRuns",
  "extractions",
  "uploads",
  "attachments",
  "mediaRepresentations",
  "durableJobs",
  "audioTranscripts",
  "audioSegments",
];

let ctx: FakeCtx;
let actor: ActorFixture;
let other: ActorFixture;

/** Seeds one ACCEPTED audio attachment (D2-gated shape) and returns ids. */
async function seedAcceptedAudio(options?: { receivedBytes?: number; verified?: boolean; kind?: string }) {
  const uploadId = await ctx.db.insert("uploads", {
    companyId: actor.companyId,
    userId: actor.userId,
    stage: "finalized",
    partCount: 1,
    createdAtMs: Date.now(),
    finalizedAtMs: Date.now(),
  });
  const sourceId = await ctx.db.insert("sources", {
    companyId: actor.companyId,
    authorUserId: actor.userId,
    authorText: "nagranie z budowy",
    sentAtMs: Date.now(),
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: Date.now(),
    lifecycle: "active",
  });
  const attachmentId = await ctx.db.insert("attachments", {
    uploadId,
    sourceId,
    kind: (options?.kind ?? "audio") as "audio",
    objectKey: `companies/${actor.companyId}/uploads/${uploadId}/0-proof`,
    receivedBytes: options?.receivedBytes,
    completedAtMs: Date.now(),
  });
  await ctx.db.insert("mediaRepresentations", {
    attachmentId,
    role: "received",
    objectKey: `companies/${actor.companyId}/uploads/${uploadId}/0-proof`,
    contentHash: "deadbeef",
    transformVersion: "d2.receive/1",
    ...(options?.verified === false ? {} : { verifiedAtMs: Date.now() }),
    createdAtMs: Date.now(),
  });
  await ctx.db.insert("processingRuns", {
    companyId: actor.companyId,
    sourceId,
    kind: "initial_analysis",
    pipelineVersion: "d1.accept/1",
    promptVersion: "none",
    schemaVersion: "none",
    modelConfigurationVersion: "none",
    state: "running",
    startedAtMs: Date.now(),
  });
  return { uploadId, sourceId, attachmentId };
}

const order = (attachmentId: string, extra: Record<string, unknown> = {}) =>
  orderAudioTranscript(asTx(ctx), contextFor(actor), {
    attachmentId,
    bytesChannel: "media_worker",
    ...extra,
  } as Parameters<typeof orderAudioTranscript>[2]);

beforeEach(async () => {
  ctx = fakeCtx(TABLES);
  actor = await seedActor(ctx, "d6order-a");
  other = await seedActor(ctx, "d6order-b");
});

describe("the order transaction", () => {
  it("creates ONE order and ONE durable registration for an accepted audio attachment", async () => {
    const seeded = await seedAcceptedAudio();
    const result = await order(seeded.attachmentId);
    const value = valueOf(result);
    expect(value.state).toBe("planning");
    const orders = ctx.db.rows("audioTranscripts");
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      attachmentId: seeded.attachmentId,
      sourceId: seeded.sourceId,
      bytesChannel: "media_worker",
      state: "planning",
    });
    const jobs = ctx.db.rows("durableJobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "processing.transcribe_segment",
      state: "queued",
      sourceId: seeded.sourceId,
    });
    expect(typeof jobs[0]?.jobKey).toBe("string");
  });

  it("denies another tenant's attachment (cross-tenant refusal)", async () => {
    const seeded = await seedAcceptedAudio();
    const result: ResultEnvelope = await orderAudioTranscript(asTx(ctx), contextFor(other), {
      attachmentId: seeded.attachmentId,
      bytesChannel: "media_worker",
    });
    expect(errorOf(result)._tag).toBe("forbidden");
    expect(ctx.db.rows("audioTranscripts")).toHaveLength(0);
    expect(ctx.db.rows("durableJobs")).toHaveLength(0);
  });

  it("refuses non-audio attachments, unbound attachments and unverified representations", async () => {
    const notAudio = await seedAcceptedAudio({ kind: "image" });
    expect(errorOf(await order(notAudio.attachmentId))._tag).toBe("validation");

    const unboundUpload = await ctx.db.insert("uploads", {
      companyId: actor.companyId,
      userId: actor.userId,
      stage: "finalized",
      partCount: 1,
      createdAtMs: Date.now(),
    });
    const unbound = await ctx.db.insert("attachments", {
      uploadId: unboundUpload,
      kind: "audio",
      objectKey: "x",
      completedAtMs: Date.now(),
    });
    expect(errorOf(await order(unbound))._tag).toBe("validation");

    const unverified = await seedAcceptedAudio({ verified: false });
    const refusal = errorOf(await order(unverified.attachmentId));
    expect(refusal._tag).toBe("validation");
  });

  it("replays the SAME order for the same config (no second row, no second job)", async () => {
    const seeded = await seedAcceptedAudio();
    const first = valueOf(await order(seeded.attachmentId, { targetSegmentMs: 1_500 }));
    const second = valueOf(await order(seeded.attachmentId, { targetSegmentMs: 1_500 }));
    expect(second.transcriptId).toBe(first.transcriptId);
    expect(second.resumed).toBe(true);
    expect(ctx.db.rows("audioTranscripts")).toHaveLength(1);
    expect(ctx.db.rows("durableJobs")).toHaveLength(1);
  });

  it("a DIFFERENT config creates a NEW order (a future new extraction version)", async () => {
    const seeded = await seedAcceptedAudio();
    await order(seeded.attachmentId, { targetSegmentMs: 1_500 });
    const second = valueOf(await order(seeded.attachmentId, { targetSegmentMs: 2_500 }));
    expect(second.transcriptId).not.toBe(ctx.db.rows("audioTranscripts")[0]?._id);
    expect(ctx.db.rows("audioTranscripts")).toHaveLength(2);
    expect(ctx.db.rows("durableJobs")).toHaveLength(2);
  });
});

describe("the guarded proof byte channel", () => {
  const stash = bytesToBase64(toneWav({ seconds: 3 }));

  it("is refused when the deployment is not probe-enabled", async () => {
    const previous = process.env.KIERO_PROBE_ENABLED;
    delete process.env.KIERO_PROBE_ENABLED;
    try {
      const seeded = await seedAcceptedAudio({ receivedBytes: stash.length * 0 });
      const result = await orderAudioTranscript(asTx(ctx), contextFor(actor), {
        attachmentId: seeded.attachmentId,
        bytesChannel: "proof_inline",
        proofAudioBase64: stash,
      });
      expect(errorOf(result)._tag).toBe("forbidden");
    } finally {
      if (previous !== undefined) {
        process.env.KIERO_PROBE_ENABLED = previous;
      }
    }
  });

  it("accepts ONLY bytes matching the uploaded object's recorded length, and pins their sha", async () => {
    process.env.KIERO_PROBE_ENABLED = "1";
    try {
      const bytes = toneWav({ seconds: 3 });
      const base64 = bytesToBase64(bytes);
      const seeded = await seedAcceptedAudio({ receivedBytes: bytes.length });
      valueOf(
        await orderAudioTranscript(asTx(ctx), contextFor(actor), {
          attachmentId: seeded.attachmentId,
          bytesChannel: "proof_inline",
          proofAudioBase64: base64,
        }),
      );
      const row = ctx.db.rows("audioTranscripts")[0];
      expect(row?.bytesChannel).toBe("proof_inline");
      expect(typeof row?.proofBytesSha256).toBe("string");
      expect(row?.proofBytesSha256).toHaveLength(64);

      // Same stash but the ledger says the object was a different size:
      // the channel must refuse (it can only replay REAL uploaded bytes).
      const mismatched = await seedAcceptedAudio({ receivedBytes: bytes.length + 1 });
      const refused = await orderAudioTranscript(asTx(ctx), contextFor(actor), {
        attachmentId: mismatched.attachmentId,
        bytesChannel: "proof_inline",
        proofAudioBase64: base64,
      });
      expect(errorOf(refused)._tag).toBe("validation");
    } finally {
      delete process.env.KIERO_PROBE_ENABLED;
    }
  });

  it("refuses stashes above the bounded size and non-PCM-WAV stashes", async () => {
    process.env.KIERO_PROBE_ENABLED = "1";
    try {
      const oversized = bytesToBase64(new Uint8Array(MAX_PROOF_STASH_BYTES + 1));
      const seeded = await seedAcceptedAudio({ receivedBytes: MAX_PROOF_STASH_BYTES + 1 });
      const refusal = await orderAudioTranscript(asTx(ctx), contextFor(actor), {
        attachmentId: seeded.attachmentId,
        bytesChannel: "proof_inline",
        proofAudioBase64: oversized,
      });
      expect(errorOf(refusal)._tag).toBe("validation");

      const notWav = await seedAcceptedAudio({ receivedBytes: 64 });
      const refusal2 = await orderAudioTranscript(asTx(ctx), contextFor(actor), {
        attachmentId: notWav.attachmentId,
        bytesChannel: "proof_inline",
        proofAudioBase64: bytesToBase64(new Uint8Array(64)),
      });
      expect(errorOf(refusal2)._tag).toBe("validation");
    } finally {
      delete process.env.KIERO_PROBE_ENABLED;
    }
  });
});
