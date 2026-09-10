/**
 * The send engine (D4): one logical message's attachments through the REAL
 * D2 resumable-upload protocol (gateway Worker routes over R2, Convex
 * ledger behind them), then D1's atomic acceptance.
 *
 * RECOVERABILITY CONTRACT (issue #32): the draft id is ONE stable identity
 * used as (a) the prepare draftId, so a re-prepare of the same material
 * returns the SAME ledger row and upload id, and (b) the acceptance
 * idempotency key, so a lost-response retry can never create a second
 * source. Interrupted uploads resume from the SERVER's recorded part
 * manifest (a re-prepare answers with the live session state, parts
 * included): only missing parts travel again; already recorded parts are
 * skipped, re-sent identical parts are idempotent.
 *
 * Failure honesty:
 *
 * - transport failures (fetch throws, unreachable) are `network` and retry
 *   per step a bounded number of times, then leave the draft resumable;
 * - typed envelope errors (`part_receipt_conflict`,
 *   `draft_expired_restart_required`, `author_text_empty`, ...) are
 *   `gateway`/`accept` failures the UI maps to Polish copy verbatim: the
 *   engine never masks them as retryable network noise, and never claims a
 *   saved state.
 *
 * All I/O is injected through the two ports (UploadGateway, AcceptPort),
 * so tests drive the full state machine deterministically while the
 * production wiring (createGatewayUploadGateway) talks to the real Worker.
 */

import {
  canonicalMediaKinds,
  declarationMatches,
  declaredPartsOf,
  missingPartNumbers,
  partCountOf,
  partRange,
} from "./planner";

// ---------------------------------------------------------------------------
// Wire views (the gateway's JSON envelopes, narrowed at runtime)
// ---------------------------------------------------------------------------

/** One begun attachment of the prepare response / session state. */
export interface SessionAttachment {
  readonly attachmentId: string;
  readonly kind: "audio" | "image";
  readonly objectKey: string;
  readonly r2UploadId?: string | undefined;
  readonly completedAtMs?: number | undefined;
  readonly r2ObjectEtag?: string | undefined;
  readonly parts?: readonly { readonly partNumber: number }[] | undefined;
}

/** The resume view of the upload session (GET /uploads/<id>/session). */
export interface SessionState {
  readonly uploadId: string;
  readonly stage: "draft" | "uploading" | "finalized" | "orphaned" | "failed";
  readonly attachments: readonly SessionAttachment[];
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The typed gateway step failures (closed vocabulary). */
export type StepError =
  | { readonly kind: "network"; readonly detail: string }
  | { readonly kind: "envelope"; readonly code: string; readonly message: string };

/** The D2 gateway routes the engine drives (prepare/begin fused route). */
export interface UploadGateway {
  prepare(input: {
    readonly draftId: string;
    readonly parts: number;
    readonly mediaKinds: readonly ("audio" | "image")[];
  }): Promise<{ readonly uploadId: string; readonly stage: SessionState["stage"]; readonly attachments: readonly SessionAttachment[] }>;
  putPart(
    uploadId: string,
    attachmentId: string,
    partNumber: number,
    bytes: Blob,
  ): Promise<void>;
  complete(uploadId: string, attachmentId: string): Promise<void>;
  finalize(uploadId: string): Promise<void>;
}

/** The acceptance command (the certified Convex mutation in production). */
export interface AcceptPort {
  accept(input: {
    readonly uploadId: string;
    readonly authorText: string;
    readonly intendedSentAtIso: string | null;
    readonly timezoneSnapshot: string;
    readonly projectHints: readonly string[];
  }, idempotencyKey: string): Promise<{ readonly sourceId: string }>;
}

/** How the engine reports honest progress (the draft store persists it). */
export type SendProgress =
  | { readonly phase: "preparing" }
  | { readonly phase: "uploading"; readonly attachmentIndex: number; readonly attachmentTotal: number; readonly doneParts: number; readonly totalParts: number }
  | { readonly phase: "finalizing" }
  | { readonly phase: "accepting" };

export interface SendHooks {
  onProgress(progress: SendProgress): void;
  /**
   * Reports the begun session once prepare returns (an observer hook for
   * progress UIs and the deterministic tests). Recoverability does NOT
   * depend on it: the stable draftId re-prepares into the same session,
   * and the draft record deliberately mirrors nothing (round 2).
   */
  onSession?(session: { readonly uploadId: string; readonly attachments: readonly SessionAttachment[] }): void;
}

/** The local material of one logical message (blobs from the draft store). */
export interface SendMaterial {
  readonly draftId: string;
  readonly authorText: string;
  readonly intendedSentAtIso: string | null;
  readonly timezoneSnapshot: string;
  readonly projectHints: readonly string[];
  readonly audio: Blob | null;
  readonly photos: readonly { readonly blob: Blob }[];
}

/** Step-level retry policy for transport failures. */
export interface RetryPolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

export const defaultRetryPolicy: RetryPolicy = {
  attempts: 3,
  delayMs: 800,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type SendFailure =
  | { readonly kind: "network"; readonly detail: string }
  | { readonly kind: "gateway"; readonly code: string; readonly message: string }
  | { readonly kind: "accept"; readonly code: string; readonly message: string };

export type SendOutcome =
  | { readonly ok: true; readonly sourceId: string }
  | { readonly ok: false; readonly failure: SendFailure };

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function asStepError(cause: unknown): StepError {
  if (cause instanceof Error && cause.name === "StepEnvelopeError") {
    return { kind: "envelope", code: (cause as Error & { code: string }).code, message: cause.message };
  }
  return { kind: "network", detail: cause instanceof Error ? cause.message : String(cause) };
}

/** The thrown form of a typed envelope error (caught and unwrapped above). */
export class StepEnvelopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StepEnvelopeError";
  }
}

/**
 * Sends one logical message: prepare (idempotent per draftId), upload every
 * attachment's MISSING parts, complete, finalize, accept (idempotent per
 * draftId). Safe to re-run at any point after any failure: the stable ids
 * make every step a resume, never a duplicate.
 */
export async function runSend(
  material: SendMaterial,
  gateway: UploadGateway,
  accept: AcceptPort,
  hooks: SendHooks,
  retry: RetryPolicy = defaultRetryPolicy,
): Promise<SendOutcome> {
  const attachments: readonly { kind: "audio" | "image"; blob: Blob }[] = [
    ...(material.audio === null ? [] : [{ kind: "audio" as const, blob: material.audio }]),
    ...material.photos.map((photo) => ({ kind: "image" as const, blob: photo.blob })),
  ];
  const mediaKinds = canonicalMediaKinds(material.audio !== null, material.photos.length);

  hooks.onProgress({ phase: "preparing" });
  let prepared: Awaited<ReturnType<UploadGateway["prepare"]>>;
  try {
    prepared = await withRetry(retry, () => gateway.prepare({
      draftId: material.draftId,
      parts: declaredPartsOf(attachments.map(({ kind, blob }) => ({ kind, bytes: blob.size }))),
      mediaKinds,
    }));
  } catch (cause) {
    return failed(asStepError(cause), "gateway");
  }
  hooks.onSession?.({ uploadId: prepared.uploadId, attachments: prepared.attachments });

  // A previously finalized upload (crash between finalize and accept) goes
  // straight to acceptance on the SAME durable objects.
  if (prepared.stage !== "finalized") {
    // ONE declaration rule (the planner's declarationMatches, mirroring
    // the server's multiset kindsMatch): the session must carry exactly
    // the declared kinds, in any order.
    if (!declarationMatches(mediaKinds, prepared.attachments.map((attachment) => attachment.kind))) {
      return failed(
        { kind: "envelope", code: "attachment_declaration_mismatch", message: "sesja wysyłki nie zgadza się z lokalnym szkicem" },
        "gateway",
      );
    }
    // The loop below is NOT the verdict: it hands each local blob a session
    // attachment id of the same kind, so bytes land on the right id even if
    // the server ever reorders its answer (same-kind images pair in order).
    const unpaired = [...prepared.attachments];
    for (let index = 0; index < attachments.length; index += 1) {
      const local = attachments[index]!;
      const pairIndex = unpaired.findIndex((candidate) => candidate.kind === local.kind);
      const session = unpaired.splice(pairIndex, 1)[0]!;
      try {
        await uploadOneAttachment(gateway, hooks, retry, prepared.uploadId, session, local.blob, index, attachments.length);
      } catch (cause) {
        return failed(asStepError(cause), "gateway");
      }
    }
    hooks.onProgress({ phase: "finalizing" });
    try {
      await withRetry(retry, () => gateway.finalize(prepared.uploadId));
    } catch (cause) {
      return failed(asStepError(cause), "gateway");
    }
  }

  hooks.onProgress({ phase: "accepting" });
  try {
    const receipt = await withRetry(retry, () =>
      accept.accept(
        {
          uploadId: prepared.uploadId,
          authorText: material.authorText,
          intendedSentAtIso: material.intendedSentAtIso,
          timezoneSnapshot: material.timezoneSnapshot,
          projectHints: material.projectHints,
        },
        material.draftId,
      ),
    );
    return { ok: true, sourceId: receipt.sourceId };
  } catch (cause) {
    return failed(asStepError(cause), "accept");
  }
}

async function uploadOneAttachment(
  gateway: UploadGateway,
  hooks: SendHooks,
  retry: RetryPolicy,
  uploadId: string,
  session: SessionAttachment,
  blob: Blob,
  attachmentIndex: number,
  attachmentTotal: number,
): Promise<void> {
  if (session.completedAtMs !== undefined) {
    return; // Already durably complete (resumed upload).
  }
  const plannedCount = partCountOf(blob.size);
  const recorded = (session.parts ?? []).map((part) => part.partNumber);
  const totalParts = plannedCount;
  let done = plannedCount - missingPartNumbers(plannedCount, recorded).length;
  for (const partNumber of missingPartNumbers(plannedCount, recorded)) {
    const { offset, end } = partRange(blob.size, partNumber);
    const bytes = blob.slice(offset, end, blob.type);
    await withRetry(retry, () => gateway.putPart(uploadId, session.attachmentId, partNumber, bytes));
    done += 1;
    hooks.onProgress({ phase: "uploading", attachmentIndex, attachmentTotal, doneParts: done, totalParts });
  }
  await withRetry(retry, () => gateway.complete(uploadId, session.attachmentId));
}

/** Runs one step with the bounded transport retry (typed errors abort). */
async function withRetry<T>(retry: RetryPolicy, step: () => Promise<T>): Promise<T> {
  let lastCause: unknown;
  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    try {
      return await step();
    } catch (cause) {
      if (cause instanceof StepEnvelopeError) {
        throw cause;
      }
      lastCause = cause;
      if (attempt < retry.attempts) {
        await retry.sleep(retry.delayMs * attempt);
      }
    }
  }
  throw lastCause;
}

function failed(error: StepError, area: "gateway" | "accept"): SendOutcome {
  if (error.kind === "network") {
    return { ok: false, failure: { kind: "network", detail: error.detail } };
  }
  return { ok: false, failure: { kind: area, code: error.code, message: error.message } };
}

// ---------------------------------------------------------------------------
// The production wiring: the real gateway routes over fetch
// ---------------------------------------------------------------------------

/** Reads the ResultEnvelope JSON every route answers with. */
async function envelopeOf(response: Response): Promise<{ _tag: "ok"; value: unknown } | { _tag: "error"; error: { code: string; message: string } }> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`gateway answer is not JSON (HTTP ${response.status})`);
  }
  if (typeof body === "object" && body !== null && "_tag" in body) {
    const envelope = body as { _tag: unknown; value?: unknown; error?: { code?: unknown; message?: unknown } };
    if (envelope._tag === "ok") {
      return { _tag: "ok", value: envelope.value };
    }
    if (envelope._tag === "error" && envelope.error !== undefined) {
      return {
        _tag: "error",
        error: {
          code: typeof envelope.error.code === "string" ? envelope.error.code : "unknown",
          message: typeof envelope.error.message === "string" ? envelope.error.message : "nieznany błąd bramy",
        },
      };
    }
  }
  throw new Error(`gateway answer is not an envelope (HTTP ${response.status})`);
}

function unwrap<T>(envelope: Awaited<ReturnType<typeof envelopeOf>>): T {
  if (envelope._tag === "error") {
    throw new StepEnvelopeError(envelope.error.code, envelope.error.message);
  }
  return envelope.value as T;
}

function asAttachments(value: unknown): SessionAttachment[] {
  if (!Array.isArray(value)) {
    throw new Error("gateway attachments are not an array");
  }
  return value.map((entry) => {
    const record = entry as Record<string, unknown>;
    if (
      typeof record.attachmentId !== "string" ||
      (record.kind !== "audio" && record.kind !== "image") ||
      typeof record.objectKey !== "string"
    ) {
      throw new Error("gateway attachment shape invalid");
    }
    return {
      attachmentId: record.attachmentId,
      kind: record.kind,
      objectKey: record.objectKey,
      ...(typeof record.r2UploadId === "string" ? { r2UploadId: record.r2UploadId } : {}),
      ...(typeof record.completedAtMs === "number" ? { completedAtMs: record.completedAtMs } : {}),
      ...(typeof record.r2ObjectEtag === "string" ? { r2ObjectEtag: record.r2ObjectEtag } : {}),
      ...(Array.isArray(record.parts)
        ? {
            parts: record.parts
              .map((part) => (part as { partNumber?: unknown }).partNumber)
              .filter((partNumber): partNumber is number => typeof partNumber === "number")
              .map((partNumber) => ({ partNumber })),
          }
        : {}),
    };
  });
}

/**
 * One gateway request's hard ceiling. A request that neither completes nor
 * errors (a dead mobile connection) aborts into the typed network path so
 * the bounded retry — and the honest resumable failure — can take over;
 * without it a hung fetch would stall the send forever.
 */
export const GATEWAY_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The real UploadGateway over the deployed Worker: every call carries the
 * signed-in person's Convex Auth token (the D2 per-user channel; the Worker
 * forwards it and Convex re-resolves access before any R2 byte).
 */
export function createGatewayUploadGateway(
  gatewayUrl: string,
  token: () => string | null | Promise<string | null>,
): UploadGateway {
  const base = gatewayUrl.replace(/\/+$/, "");
  const call = async (path: string, init: RequestInit, tokenNow: string | null): Promise<Response> => {
    if (tokenNow === null || tokenNow.length === 0) {
      throw new StepEnvelopeError("client_credential_missing", "brak tokenu sesji");
    }
    return fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${tokenNow}`,
      },
      signal: AbortSignal.timeout(GATEWAY_REQUEST_TIMEOUT_MS),
    });
  };
  const jsonCall = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    const tokenNow = await token();
    const response = await call(
      path,
      {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
      },
      tokenNow,
    );
    return unwrap(await envelopeOf(response));
  };
  return {
    async prepare(input) {
      const value = await jsonCall("POST", "/uploads/prepare", {
        draftId: input.draftId,
        parts: input.parts,
        mediaKinds: input.mediaKinds,
      });
      const record = value as Record<string, unknown>;
      return {
        uploadId: String(record.uploadId),
        stage: (typeof record.stage === "string" ? record.stage : "draft") as SessionState["stage"],
        attachments: asAttachments(record.attachments),
      };
    },
    async putPart(uploadId, attachmentId, partNumber, bytes) {
      const tokenNow = await token();
      const response = await call(
        `/uploads/${encodeURIComponent(uploadId)}/attachments/${encodeURIComponent(attachmentId)}/parts/${partNumber}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes },
        tokenNow,
      );
      await envelopeOf(response);
    },
    async complete(uploadId, attachmentId) {
      await jsonCall("POST", `/uploads/${encodeURIComponent(uploadId)}/attachments/${encodeURIComponent(attachmentId)}/complete`, {});
    },
    async finalize(uploadId) {
      await jsonCall("POST", `/uploads/${encodeURIComponent(uploadId)}/finalize`, {});
    },
  };
}
