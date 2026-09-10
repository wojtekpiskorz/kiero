/**
 * D4 focused tests: the send engine (uploader.ts).
 *
 * Drives the REAL state machine (runSend) against a scripted fake of the
 * two I/O ports (UploadGateway, AcceptPort) — the same seam where
 * production attaches the real gateway Worker and the Convex mutation.
 * The live proof (tests/d4/live-proof.mjs) runs the identical engine
 * against the real deployment, Worker and R2.
 *
 * Proves the issue's recoverability contract:
 * - the stable draft id is BOTH the prepare draftId and the acceptance
 *   idempotency key;
 * - an interrupted upload resumes from the SERVER manifest: only missing
 *   parts travel again;
 * - automatic retry (bounded, per step) survives transient network errors;
 * - typed envelope errors abort honestly without retry spam;
 * - a crash between finalize and accept goes straight to acceptance on the
 *   same durable objects (no re-upload, no duplicate);
 * - the accept port observes ONE idempotency key per logical message
 *   across retries.
 */

import { describe, expect, it } from "vitest";
import { StepEnvelopeError, runSend, type AcceptPort, type SendMaterial, type UploadGateway } from "../../apps/web/src/features/capture/uploader";
import { MIN_PART_BYTES } from "../../convex/sources/uploads/protocol";

const MIB = 1024 * 1024;
const noSleep = { sleep: async () => undefined };
const retry3 = { attempts: 3, delayMs: 0, ...noSleep };

// ---------------------------------------------------------------------------
// The scripted fake gateway (the real ledger is live-proved; D2 owns it)
// ---------------------------------------------------------------------------

interface PartCall {
  readonly attachmentId: string;
  readonly partNumber: number;
  readonly bytes: number;
}

function fakeGateway() {
  const calls: {
    prepare: { draftId: string; parts: number; mediaKinds: string[] }[];
    parts: PartCall[];
    completes: string[];
    finalizes: string[];
  } = { prepare: [], parts: [], completes: [], finalizes: [] };

  /** The server's authoritative view: manifests per attachment id. */
  const manifests = new Map<string, number[]>();
  const kinds = new Map<string, "audio" | "image">();
  let uploadCounter = 0;
  let attachmentCounter = 0;

  let failPartsTimes = 0;

  const gateway: UploadGateway = {
    async prepare(input) {
      calls.prepare.push({ ...input, mediaKinds: [...input.mediaKinds] });
      uploadCounter += 1;
      const uploadId = `up${uploadCounter}`;
      void uploadId;
      const attachments = input.mediaKinds.map((kind) => {
        attachmentCounter += 1;
        const attachmentId = `at${attachmentCounter}`;
        kinds.set(attachmentId, kind);
        manifests.set(attachmentId, []);
        return {
          attachmentId,
          kind,
          objectKey: `companies/k/uploads/${uploadId}/${attachmentId}`,
          r2UploadId: `r2-${attachmentId}`,
        };
      });
      return { uploadId, stage: "draft", attachments };
    },
    async putPart(_uploadId, attachmentId, partNumber, bytes) {
      if (failPartsTimes > 0) {
        failPartsTimes -= 1;
        throw new Error("connection reset");
      }
      calls.parts.push({ attachmentId, partNumber, bytes: bytes.size });
      const manifest = manifests.get(attachmentId) ?? [];
      manifest.push(partNumber);
      manifests.set(attachmentId, manifest);
    },
    async complete(_uploadId, attachmentId) {
      calls.completes.push(attachmentId);
    },
    async finalize(uploadId) {
      calls.finalizes.push(uploadId);
    },
  };
  return {
    gateway,
    calls,
    manifests,
    failNextPartUploads: (count: number) => {
      failPartsTimes = count;
    },
  };
}

function fakeAccept() {
  const accepted: { input: unknown; idempotencyKey: string }[] = [];
  let errorOnce: StepEnvelopeError | null = null;
  const port: AcceptPort = {
    async accept(input, idempotencyKey) {
      if (errorOnce !== null) {
        const failure = errorOnce;
        errorOnce = null;
        throw failure;
      }
      accepted.push({ input, idempotencyKey });
      return { sourceId: "k57source00000000000000000a" };
    },
  };
  return {
    port,
    accepted,
    failOnceWith: (error: StepEnvelopeError) => {
      errorOnce = error;
    },
  };
}

function material(overrides: Partial<SendMaterial> = {}): SendMaterial {
  return {
    draftId: "idem_stable_draft",
    authorText: "Banan: dowóz płytek w środę rano",
    intendedSentAtIso: "2026-09-10T07:30:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
    audio: null,
    photos: [],
    ...overrides,
  };
}

const hooksOf = () => {
  const progress: string[] = [];
  const sessions: { uploadId: string; attachmentIds: string[] }[] = [];
  return {
    progress,
    sessions,
    hooks: {
      onProgress: (update: { phase: string }) => {
        progress.push(update.phase);
      },
      onSession: (session: { readonly uploadId: string; readonly attachments: readonly { readonly attachmentId: string }[] }) => {
        sessions.push({
          uploadId: session.uploadId,
          attachmentIds: session.attachments.map((attachment) => attachment.attachmentId),
        });
      },
    },
  };
};

// ---------------------------------------------------------------------------

describe("runSend: the happy path (text + recording + photo)", () => {
  it("prepares, uploads every planned part, finalizes and accepts under the stable key", async () => {
    const fake = fakeGateway();
    const accept = fakeAccept();
    const hooks = hooksOf();
    const audio = new Blob([new Uint8Array(6 * MIB)]); // 2 parts: 5 MiB + 1 MiB
    const photo = new Blob([new Uint8Array(64 * 1024)]); // 1 part
    const outcome = await runSend(
      material({ audio, photos: [{ blob: photo }] }),
      fake.gateway,
      accept.port,
      hooks.hooks,
      retry3,
    );
    expect(outcome).toEqual({ ok: true, sourceId: "k57source00000000000000000a" });
    // The declaration: audio first, part bound = max(2, 1) = 2.
    expect(fake.calls.prepare).toEqual([
      { draftId: "idem_stable_draft", parts: 2, mediaKinds: ["audio", "image"] },
    ]);
    // Parts per attachment: audio 1..2, image 1.
    const audioAttachment = fake.calls.parts.filter(
      (part) => part.attachmentId === hooks.sessions[0]!.attachmentIds[0],
    );
    const imageAttachment = fake.calls.parts.filter(
      (part) => part.attachmentId === hooks.sessions[0]!.attachmentIds[1],
    );
    expect(audioAttachment.map((part) => [part.partNumber, part.bytes])).toEqual([
      [1, MIN_PART_BYTES],
      [2, 1 * MIB],
    ]);
    expect(imageAttachment.map((part) => part.partNumber)).toEqual([1]);
    expect(fake.calls.completes).toHaveLength(2);
    expect(fake.calls.finalizes).toEqual(["up1"]);
    expect(accept.accepted).toEqual([
      {
        input: expect.objectContaining({
          authorText: "Banan: dowóz płytek w środę rano",
          uploadId: "up1",
        }),
        idempotencyKey: "idem_stable_draft",
      },
    ]);
    expect(hooks.progress).toEqual([
      "preparing",
      "uploading",
      "uploading",
      "uploading",
      "finalizing",
      "accepting",
    ]);
  });

  it("sends a text-only message (prepare with the empty declaration)", async () => {
    const fake = fakeGateway();
    const accept = fakeAccept();
    const outcome = await runSend(material(), fake.gateway, accept.port, hooksOf().hooks, retry3);
    expect(outcome.ok).toBe(true);
    expect(fake.calls.prepare).toEqual([{ draftId: "idem_stable_draft", parts: 1, mediaKinds: [] }]);
    expect(fake.calls.parts).toEqual([]);
    expect(fake.calls.finalizes).toEqual(["up1"]);
  });
});

describe("runSend: resume semantics (the recoverable draft)", () => {
  it("uploads only the parts the server manifest is missing", async () => {
    const accept = fakeAccept();
    const hooks = hooksOf();
    const putCalls: { attachmentId: string; partNumber: number }[] = [];
    // The interrupted state: prepare already happened once, the server
    // recorded part 1 of a 3-part recording, the tab died. A re-prepare
    // (same draftId) answers with the live session state, parts included.
    const gateway: UploadGateway = {
      prepare: async () => ({
        uploadId: "up-resume",
        stage: "uploading",
        attachments: [
          {
            attachmentId: "at-audio",
            kind: "audio",
            objectKey: "companies/k/uploads/up-resume/at-audio",
            parts: [{ partNumber: 1 }],
          },
        ],
      }),
      putPart: async (_uploadId, attachmentId, partNumber) => {
        putCalls.push({ attachmentId, partNumber });
      },
      complete: async () => undefined,
      finalize: async () => undefined,
    };
    const audio = new Blob([new Uint8Array(12 * MIB)]); // 3 planned parts
    const outcome = await runSend(material({ audio }), gateway, accept.port, hooks.hooks, retry3);
    expect(outcome.ok).toBe(true);
    // ONLY parts 2 and 3 traveled: part 1 was already durable server-side.
    expect(putCalls.map((part) => part.partNumber)).toEqual([2, 3]);
    expect(accept.accepted).toHaveLength(1);
    expect(accept.accepted[0]!.idempotencyKey).toBe("idem_stable_draft");
  });

  it("goes straight to acceptance when the upload already finalized (crash between finalize and accept)", async () => {
    const accept = fakeAccept();
    const putCalls: { attachmentId: string; partNumber: number }[] = [];
    const gateway: UploadGateway = {
      prepare: async () => ({
        uploadId: "up-finalized",
        stage: "finalized",
        attachments: [{ attachmentId: "at-audio", kind: "audio", objectKey: "k" }],
      }),
      putPart: async (_u, attachmentId, partNumber) => {
        putCalls.push({ attachmentId, partNumber });
      },
      complete: async () => {
        throw new Error("complete must not run again");
      },
      finalize: async () => {
        throw new Error("finalize must not run again");
      },
    };
    const outcome = await runSend(
      material({ audio: new Blob([new Uint8Array(MIB)]) }),
      gateway,
      accept.port,
      hooksOf().hooks,
      retry3,
    );
    expect(outcome.ok).toBe(true);
    expect(putCalls).toEqual([]);
    expect(accept.accepted).toHaveLength(1);
  });
});

describe("runSend: retry policy", () => {
  it("automatically retries a transient network failure on a part (same ids)", async () => {
    const fake = fakeGateway();
    const accept = fakeAccept();
    fake.failNextPartUploads(2); // two resets, then success
    const outcome = await runSend(
      material({ audio: new Blob([new Uint8Array(MIB)]) }),
      fake.gateway,
      accept.port,
      hooksOf().hooks,
      retry3,
    );
    expect(outcome.ok).toBe(true);
    expect(fake.calls.parts).toHaveLength(1);
    expect(accept.accepted).toHaveLength(1);
  });

  it("stops honestly after exhausting the bounded attempts (resumable)", async () => {
    const fake = fakeGateway();
    const accept = fakeAccept();
    fake.failNextPartUploads(99);
    const outcome = await runSend(
      material({ audio: new Blob([new Uint8Array(MIB)]) }),
      fake.gateway,
      accept.port,
      hooksOf().hooks,
      retry3,
    );
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "network", detail: "connection reset" },
    });
    expect(fake.calls.parts).toEqual([]);
    // No acceptance without durable material: no false saved state.
    expect(accept.accepted).toHaveLength(0);
  });

  it("does NOT retry a typed envelope error (client/server bug, not noise)", async () => {
    const fake = fakeGateway();
    const accept = fakeAccept();
    let putCalls = 0;
    const gateway: UploadGateway = {
      ...fake.gateway,
      putPart: async () => {
        putCalls += 1;
        throw new StepEnvelopeError("part_receipt_conflict", "diverging content");
      },
    };
    const outcome = await runSend(
      material({ audio: new Blob([new Uint8Array(MIB)]) }),
      gateway,
      accept.port,
      hooksOf().hooks,
      retry3,
    );
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "gateway", code: "part_receipt_conflict", message: "diverging content" },
    });
    expect(putCalls).toBe(1);
  });

  it("surfaces a typed acceptance failure (author_text_empty) without inventing a save", async () => {
    const fake = fakeGateway();
    const accept = fakeAccept();
    accept.failOnceWith(new StepEnvelopeError("author_text_empty", "empty"));
    const outcome = await runSend(material(), fake.gateway, accept.port, hooksOf().hooks, retry3);
    expect(outcome).toEqual({
      ok: false,
      failure: { kind: "accept", code: "author_text_empty", message: "empty" },
    });
  });

  it("retries an acceptance network failure automatically (lost response)", async () => {
    const fake = fakeGateway();
    const accept = fakeAccept();
    let failures = 0;
    const port: AcceptPort = {
      accept: async (input, idempotencyKey) => {
        if (failures < 1) {
          failures += 1;
          throw new Error("socket closed after commit");
        }
        return accept.port.accept(input, idempotencyKey);
      },
    };
    const outcome = await runSend(material(), fake.gateway, port, hooksOf().hooks, retry3);
    expect(outcome.ok).toBe(true);
    // The retry carries the SAME idempotency key: one logical message.
    expect(accept.accepted.map((entry) => entry.idempotencyKey)).toEqual(["idem_stable_draft"]);
  });

  it("rejects a session whose attachments disagree with the local material", async () => {
    const accept = fakeAccept();
    const gateway: UploadGateway = {
      prepare: async () => ({
        uploadId: "up-mismatch",
        stage: "uploading",
        attachments: [{ attachmentId: "at-x", kind: "image", objectKey: "k" }],
      }),
      putPart: async () => undefined,
      complete: async () => undefined,
      finalize: async () => undefined,
    };
    const outcome = await runSend(
      material({ audio: new Blob([new Uint8Array(MIB)]) }),
      gateway,
      accept.port,
      hooksOf().hooks,
      retry3,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure).toMatchObject({ code: "attachment_declaration_mismatch" });
    }
    expect(accept.accepted).toHaveLength(0);
  });
});
