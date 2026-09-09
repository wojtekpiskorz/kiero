/**
 * Gateway uploads routes (D2): the Worker-mediated resumable upload surface.
 *
 * Protocol (architecture steps 2-3; the Convex ledger in
 * convex/sources/uploads is the state authority, this Worker owns R2):
 *
 * - `POST /uploads/prepare` — declares the stable draft (prepare step),
 *   mints server-owned object keys, opens the R2 multipart sessions and
 *   records them (begin step). Idempotent per (company, draftId).
 * - `GET  /uploads/<uploadId>/session` — the resume view: stage, declared
 *   bound and every attachment's recorded part manifest. A client that lost
 *   its place re-uploads ONLY the parts missing from this manifest.
 * - `POST /uploads/<uploadId>/attachments/<attachmentId>/parts/<partNumber>`
 *   — streams one R2 part (bounded memory; SHA-256 hashed in flight) and
 *   records the receipt. Access is re-checked through Convex BEFORE the R2
 *   write in the same request.
 * - `POST /uploads/<uploadId>/attachments/<attachmentId>/complete` — R2
 *   completion from the ledger's manifest plus a readability head, then the
 *   durable completion record with the verified `received` representation.
 * - `POST /uploads/<uploadId>/finalize` — all-attachments-durable gate;
 *   publishes `sources.uploadFinalized`. The upload stays recoverable here.
 * - `POST /uploads/reconcile` — one orphan-collection pass: Convex decides
 *   (never for accepted or active uploads), the Worker aborts/deletes the
 *   decided objects only.
 *
 * Acceptance itself (`sources.acceptSource`) stays a Convex operation (D1's
 * atomic transaction extended by D2's attachment gate); the saved receipt is
 * issued there, never here.
 *
 * Parameterized paths register through `../composition/registry.ts`'s
 * append pattern: `matchUploadsRoute` returns a structurally-GatewayRoute
 * object with the captured params closed over, so shared matching code is
 * unchanged. Parts travel over POST because the shared route vocabulary
 * (platform/routes.ts, A3-owned) admits GET|POST only; widening it is a
 * named cross-lane prerequisite, not an independent edit.
 *
 * Envelope values arriving from the verified Convex channel were already
 * decoded against contract schemas on the backend; the narrow `as` views
 * below re-shape them for route logic after explicit field checks.
 */

import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { conflictError, unavailableError, validationError } from "@kiero/runtime";
import type { GatewayRoute } from "../platform/routes";
import { uploadsState, uploadsStep } from "./bridge";
import {
  collectObjects,
  completeAndVerify,
  createMultipartSessions,
  streamPartToR2,
  type AttachmentSession,
  type UploadsEnv,
} from "./r2";

/** Mirrors convex/sources/uploads/protocol.ts bounds (Convex re-validates). */
const MAX_PARTS = 1_000;
const MAX_ATTACHMENTS = 8;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function statusOf(result: ResultEnvelope): number {
  if (result._tag === "ok") {
    return 200;
  }
  switch (result.error._tag) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "unsupported":
      return 501;
    case "unavailable":
      return 503;
    default:
      return 400;
  }
}

function respond(result: ResultEnvelope): Response {
  return jsonResponse(statusOf(result), result);
}

async function readJsonBody(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, response: respond(errorResult(validationError("uploads_body_not_json"))) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: respond(errorResult(validationError("uploads_body_not_object"))) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** The session state envelope narrowed to its value (typed view for routes). */
interface SessionState {
  readonly uploadId: string;
  readonly companyId: string;
  readonly stage: "draft" | "uploading" | "finalized" | "orphaned" | "failed";
  readonly declaredParts?: number | undefined;
  readonly attachments: AttachmentSession[];
}

/** Runtime field check before the narrow view cast (backend decoded already). */
function asSessionState(value: unknown): SessionState | null {
  const record = value as Record<string, unknown>;
  if (
    typeof record.uploadId !== "string" ||
    typeof record.companyId !== "string" ||
    typeof record.stage !== "string" ||
    !Array.isArray(record.attachments)
  ) {
    return null;
  }
  return value as SessionState;
}

async function readSession(
  env: UploadsEnv,
  uploadId: string,
): Promise<{ ok: true; state: SessionState } | { ok: false; response: Response }> {
  const result = await uploadsState(env, uploadId);
  if (result._tag === "error") {
    return { ok: false, response: respond(result) };
  }
  const state = asSessionState(result.value);
  if (state === null) {
    return { ok: false, response: respond(errorResult(unavailableError(false, "session_state_invalid"))) };
  }
  return { ok: true, state };
}

function findAttachment(state: SessionState, attachmentId: string): AttachmentSession | undefined {
  return state.attachments.find((candidate) => candidate.attachmentId === attachmentId);
}

// --- route handlers ---------------------------------------------------------------

/** POST /uploads/prepare */
async function prepareRoute(request: Request, env: UploadsEnv): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  const { draftId, parts, mediaKinds } = body.body;
  if (typeof draftId !== "string" || draftId.length === 0) {
    return respond(errorResult(validationError("draft_id_missing")));
  }
  if (!Number.isInteger(parts) || (parts as number) < 1 || (parts as number) > MAX_PARTS) {
    return respond(errorResult(validationError("part_bound_invalid")));
  }
  if (
    !Array.isArray(mediaKinds) ||
    mediaKinds.length < 1 ||
    mediaKinds.length > MAX_ATTACHMENTS ||
    !mediaKinds.every((kind) => kind === "audio" || kind === "image")
  ) {
    return respond(errorResult(validationError("media_kinds_invalid")));
  }
  const prepared = await uploadsStep(env, { step: "prepare", input: body.body });
  if (prepared._tag === "error") {
    return respond(prepared);
  }
  const preparedView = prepared.value as { uploadId: string };
  const uploadId = preparedView.uploadId;
  const session = await readSession(env, uploadId);
  if (!session.ok) {
    return session.response;
  }
  // A resumed draft that already has its R2 sessions recorded returns them
  // unchanged; only a fresh (or crashed-before-begin) declaration mints.
  if (session.state.attachments.length > 0) {
    return jsonResponse(
      200,
      okResult({ uploadId, stage: session.state.stage, attachments: session.state.attachments }),
    );
  }
  if (session.state.stage !== "draft" && session.state.stage !== "uploading") {
    return jsonResponse(200, okResult({ uploadId, stage: session.state.stage, attachments: [] }));
  }
  let sessions;
  try {
    sessions = await createMultipartSessions(
      env.MEDIA_BUCKET,
      session.state.companyId,
      uploadId,
      mediaKinds as ("audio" | "image")[],
    );
  } catch {
    return respond(errorResult(unavailableError(true, "media_store_unavailable")));
  }
  const begun = await uploadsStep(env, {
    step: "begin",
    input: { uploadId, attachments: sessions },
  });
  if (begun._tag === "error") {
    return respond(begun);
  }
  const begunView = begun.value as { stage: string; attachments: unknown };
  return jsonResponse(200, okResult({ uploadId, stage: begunView.stage, attachments: begunView.attachments }));
}

/** GET /uploads/<uploadId>/session */
async function sessionRoute(_request: Request, env: UploadsEnv, uploadId: string): Promise<Response> {
  return respond(await uploadsState(env, uploadId));
}

/** POST /uploads/<uploadId>/attachments/<attachmentId>/parts/<partNumber> */
async function partRoute(
  request: Request,
  env: UploadsEnv,
  uploadId: string,
  attachmentId: string,
  partNumber: number,
): Promise<Response> {
  const session = await readSession(env, uploadId);
  if (!session.ok) {
    return session.response;
  }
  const attachment = findAttachment(session.state, attachmentId);
  if (attachment === undefined) {
    return respond(errorResult(validationError("attachment_not_in_upload")));
  }
  if (attachment.completedAtMs !== undefined) {
    // Finalized bytes cannot be overwritten by stale retries.
    return respond(errorResult(conflictError("attachment_finalized", undefined, attachmentId)));
  }
  const r2UploadId = attachment.r2UploadId;
  if (r2UploadId === undefined) {
    return respond(errorResult(validationError("multipart_session_missing")));
  }
  const declared = session.state.declaredParts;
  if (partNumber < 1 || (declared !== undefined && partNumber > declared)) {
    return respond(errorResult(validationError("part_number_out_of_range")));
  }
  if (request.body === null) {
    return respond(errorResult(validationError("part_body_missing")));
  }
  let receipt;
  try {
    receipt = await streamPartToR2(
      env.MEDIA_BUCKET,
      attachment.objectKey,
      r2UploadId,
      partNumber,
      request.body,
    );
  } catch {
    return respond(errorResult(unavailableError(true, "media_store_unavailable")));
  }
  return respond(
    await uploadsStep(env, {
      step: "part",
      input: {
        uploadId,
        attachmentId,
        partNumber,
        etag: receipt.etag,
        bytes: receipt.bytes,
        sha256Hex: receipt.sha256Hex,
      },
    }),
  );
}

/** POST /uploads/<uploadId>/attachments/<attachmentId>/complete */
async function completeRoute(
  _request: Request,
  env: UploadsEnv,
  uploadId: string,
  attachmentId: string,
): Promise<Response> {
  const session = await readSession(env, uploadId);
  if (!session.ok) {
    return session.response;
  }
  const attachment = findAttachment(session.state, attachmentId);
  if (attachment === undefined) {
    return respond(errorResult(validationError("attachment_not_in_upload")));
  }
  if (attachment.completedAtMs !== undefined && attachment.r2ObjectEtag !== undefined) {
    // Idempotent replay: re-run the ledger step with the recorded receipt.
    return respond(
      await uploadsStep(env, {
        step: "complete",
        input: {
          uploadId,
          attachmentId,
          objectEtag: attachment.r2ObjectEtag,
          totalBytes: attachment.receivedBytes ?? 0,
        },
      }),
    );
  }
  const r2UploadId = attachment.r2UploadId;
  if (r2UploadId === undefined) {
    return respond(errorResult(validationError("multipart_session_missing")));
  }
  let completion;
  try {
    completion = await completeAndVerify(
      env.MEDIA_BUCKET,
      attachment.objectKey,
      r2UploadId,
      attachment.parts,
    );
  } catch {
    return respond(errorResult(unavailableError(true, "media_store_unavailable")));
  }
  if (!completion.ok) {
    return respond(errorResult(unavailableError(true, `attachment_completion_${completion.reason}`)));
  }
  const recorded = await uploadsStep(env, {
    step: "complete",
    input: {
      uploadId,
      attachmentId,
      objectEtag: completion.objectEtag,
      totalBytes: completion.totalBytes,
    },
  });
  if (recorded._tag === "error") {
    return respond(recorded);
  }
  const recordedView = recorded.value as Record<string, unknown>;
  return jsonResponse(200, okResult({ ...recordedView, verifiedReadable: true }));
}

/** POST /uploads/<uploadId>/finalize */
async function finalizeRoute(_request: Request, env: UploadsEnv, uploadId: string): Promise<Response> {
  return respond(await uploadsStep(env, { step: "finalize", input: { uploadId } }));
}

/** POST /uploads/reconcile */
async function reconcileRoute(_request: Request, env: UploadsEnv): Promise<Response> {
  const decision = await uploadsStep(env, { step: "reconcile", input: {} });
  if (decision._tag === "error") {
    return respond(decision);
  }
  const value = decision.value as {
    kept: { uploadId: string; reason: string }[];
    collect: {
      uploadId: string;
      reason: string;
      attachments: { attachmentId: string; objectKey: string; r2UploadId?: string | undefined }[];
    }[];
  };
  let aborted: string[] = [];
  let deleted: string[] = [];
  try {
    for (const item of value.collect) {
      const collected = await collectObjects(env.MEDIA_BUCKET, item.attachments);
      aborted = [...aborted, ...collected.aborted];
      deleted = [...deleted, ...collected.deleted];
    }
  } catch {
    return respond(errorResult(unavailableError(true, "media_store_unavailable")));
  }
  return jsonResponse(
    200,
    okResult({
      kept: value.kept,
      collectedUploads: value.collect.map((item) => ({ uploadId: item.uploadId, reason: item.reason })),
      r2AbortedKeys: aborted,
      r2DeletedKeys: deleted,
    }),
  );
}

// --- registration ------------------------------------------------------------------

/** Captured path parameters, accumulated during one match. */
interface RouteParams {
  uploadId: string;
  attachmentId?: string | undefined;
  partNumber?: number | undefined;
}

function partParams(
  method: string,
  path: string,
  pattern: RegExp,
  expectedMethod: "GET" | "POST",
  withPartNumber: boolean,
): RouteParams | undefined {
  if (method !== expectedMethod) {
    return undefined;
  }
  const match = pattern.exec(path);
  if (match === null) {
    return undefined;
  }
  const uploadId = match[1];
  if (uploadId === undefined) {
    return undefined;
  }
  const params: RouteParams = { uploadId };
  if (pattern.source.includes("attachments")) {
    const attachmentId = match[2];
    if (attachmentId === undefined) {
      return undefined;
    }
    params.attachmentId = attachmentId;
  }
  if (withPartNumber) {
    const raw = match[3];
    if (raw === undefined || !/^\d+$/.test(raw)) {
      return undefined;
    }
    params.partNumber = Number(raw);
  }
  return params;
}

/**
 * Matches one parameterized uploads route. Returns a structurally
 * `GatewayRoute` object with the captured path parameters closed over the
 * handler, so the composition registry's exact-match-first flow and the
 * shared `GatewayRoute` type stay untouched.
 */
export function matchUploadsRoute(method: string, path: string): GatewayRoute | undefined {
  const part = partParams(method, path, /^\/uploads\/([^/]+)\/attachments\/([^/]+)\/parts\/([^/]+)$/, "POST", true);
  if (part !== undefined && part.attachmentId !== undefined && part.partNumber !== undefined) {
    const { uploadId, attachmentId, partNumber } = part;
    return {
      method: "POST",
      path,
      handle: (request, env) => partRoute(request, env as UploadsEnv, uploadId, attachmentId, partNumber),
    };
  }
  const complete = partParams(method, path, /^\/uploads\/([^/]+)\/attachments\/([^/]+)\/complete$/, "POST", false);
  if (complete !== undefined && complete.attachmentId !== undefined) {
    const { uploadId, attachmentId } = complete;
    return {
      method: "POST",
      path,
      handle: (request, env) => completeRoute(request, env as UploadsEnv, uploadId, attachmentId),
    };
  }
  const session = partParams(method, path, /^\/uploads\/([^/]+)\/session$/, "GET", false);
  if (session !== undefined) {
    const { uploadId } = session;
    return {
      method: "GET",
      path,
      handle: (request, env) => sessionRoute(request, env as UploadsEnv, uploadId),
    };
  }
  const finalize = partParams(method, path, /^\/uploads\/([^/]+)\/finalize$/, "POST", false);
  if (finalize !== undefined) {
    const { uploadId } = finalize;
    return {
      method: "POST",
      path,
      handle: (request, env) => finalizeRoute(request, env as UploadsEnv, uploadId),
    };
  }
  return undefined;
}

/** The static (parameterless) uploads routes for the composition registry. */
export const uploadsStaticRoutes: readonly GatewayRoute[] = [
  {
    method: "POST",
    path: "/uploads/prepare",
    handle: (request, env) => prepareRoute(request, env as UploadsEnv),
  },
  {
    method: "POST",
    path: "/uploads/reconcile",
    handle: (request, env) => reconcileRoute(request, env as UploadsEnv),
  },
];
