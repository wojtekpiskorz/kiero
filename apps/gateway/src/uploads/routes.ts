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
 * IDENTITY (round-2 review): every route carries the END USER's credential.
 * The browser sends its Convex Auth `Authorization` header; the Worker
 * forwards it verbatim and Convex resolves the acting user (B1 live session
 * -> active membership -> company). No route on this lane acts as the
 * service account — a user-owned ledger must never be touched as the
 * platform — and because every R2-touching route resolves the user through
 * Convex FIRST, a dead session or membership refuses the request before any
 * byte reaches R2 (what D4's revocation-mid-upload tests exercise).
 *
 * Registration rides the composition contract: this lane supplies a
 * `RouteProvider` whose optional `match` owns the parameterized paths (the
 * captured groups close over structurally-GatewayRoute handlers), so the
 * registry composes providers by imports only. Parts travel over POST
 * because the shared route vocabulary (platform/routes.ts, A3-owned)
 * admits GET|POST only; widening it is a named cross-lane prerequisite,
 * not an independent edit.
 *
 * The protocol (bounds, key namespace, the prepare input schema) and the
 * envelope-to-HTTP-status mapping are consumed from their ONE definitions:
 * convex/sources/uploads/protocol.ts (the shared pure module — see its
 * shared-home note) and @kiero/runtime's `envelopeHttpStatus`. Envelope
 * values arriving from the verified Convex channel were already decoded
 * against schemas on the backend; the narrow `as` views below re-shape
 * them for route logic after explicit field checks.
 */

import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  conflictError,
  decodeInput,
  envelopeHttpStatus,
  unauthenticatedError,
  unavailableError,
  validationError,
} from "@kiero/runtime";
import type { GatewayRoute } from "../platform/routes";
import type { RouteProvider } from "../composition/registry";
import { uploadsState, uploadsStep } from "./bridge";
import {
  collectObjects,
  completeAndVerify,
  createMultipartSessions,
  streamPartToR2,
  type AttachmentSession,
  type UploadsEnv,
} from "./r2";
import { PrepareInput } from "../../../../convex/sources/uploads/protocol";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respond(result: ResultEnvelope): Response {
  return jsonResponse(envelopeHttpStatus(result), result);
}

/** The client's credential (forwarded verbatim; Convex verifies it). */
function clientCredential(
  request: Request,
): { ok: true; authorization: string } | { ok: false; response: Response } {
  const authorization = request.headers.get("authorization");
  if (authorization === null || authorization === "") {
    return { ok: false, response: respond(errorResult(unauthenticatedError("client_credential_missing"))) };
  }
  return { ok: true, authorization };
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
  authorization: string,
): Promise<{ ok: true; state: SessionState } | { ok: false; response: Response }> {
  const result = await uploadsState(env, uploadId, authorization);
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
  const credential = clientCredential(request);
  if (!credential.ok) {
    return credential.response;
  }
  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }
  // The ONE prepare declaration (bounds, kinds) is the shared PrepareInput
  // schema; the Convex boundary decodes the same schema again.
  const decoded = decodeInput(PrepareInput, body.body);
  if (!decoded.ok) {
    return respond(decoded.error);
  }
  const { mediaKinds } = decoded.value;
  const prepared = await uploadsStep(env, { step: "prepare", input: decoded.value }, credential.authorization);
  if (prepared._tag === "error") {
    return respond(prepared);
  }
  const preparedView = prepared.value as { uploadId: string };
  const uploadId = preparedView.uploadId;
  const session = await readSession(env, uploadId, credential.authorization);
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
  const begun = await uploadsStep(env, { step: "begin", input: { uploadId, attachments: sessions } }, credential.authorization);
  if (begun._tag === "error") {
    return respond(begun);
  }
  const begunView = begun.value as { stage: string; attachments: unknown };
  return jsonResponse(200, okResult({ uploadId, stage: begunView.stage, attachments: begunView.attachments }));
}

/** GET /uploads/<uploadId>/session */
async function sessionRoute(request: Request, env: UploadsEnv, uploadId: string): Promise<Response> {
  const credential = clientCredential(request);
  if (!credential.ok) {
    return credential.response;
  }
  return respond(await uploadsState(env, uploadId, credential.authorization));
}

/** POST /uploads/<uploadId>/attachments/<attachmentId>/parts/<partNumber> */
async function partRoute(
  request: Request,
  env: UploadsEnv,
  uploadId: string,
  attachmentId: string,
  partNumber: number,
): Promise<Response> {
  const credential = clientCredential(request);
  if (!credential.ok) {
    return credential.response;
  }
  // The acting user resolves BEFORE any R2 byte is written: a dead session
  // or membership answers here, closed, without touching the bucket.
  const session = await readSession(env, uploadId, credential.authorization);
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
    await uploadsStep(
      env,
      {
        step: "part",
        input: {
          uploadId,
          attachmentId,
          partNumber,
          etag: receipt.etag,
          bytes: receipt.bytes,
          sha256Hex: receipt.sha256Hex,
        },
      },
      credential.authorization,
    ),
  );
}

/** POST /uploads/<uploadId>/attachments/<attachmentId>/complete */
async function completeRoute(
  request: Request,
  env: UploadsEnv,
  uploadId: string,
  attachmentId: string,
): Promise<Response> {
  const credential = clientCredential(request);
  if (!credential.ok) {
    return credential.response;
  }
  const session = await readSession(env, uploadId, credential.authorization);
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
      await uploadsStep(
        env,
        {
          step: "complete",
          input: {
            uploadId,
            attachmentId,
            objectEtag: attachment.r2ObjectEtag,
            totalBytes: attachment.receivedBytes ?? 0,
          },
        },
        credential.authorization,
      ),
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
  const recorded = await uploadsStep(
    env,
    {
      step: "complete",
      input: {
        uploadId,
        attachmentId,
        objectEtag: completion.objectEtag,
        totalBytes: completion.totalBytes,
      },
    },
    credential.authorization,
  );
  if (recorded._tag === "error") {
    return respond(recorded);
  }
  const recordedView = recorded.value as Record<string, unknown>;
  return jsonResponse(200, okResult({ ...recordedView, verifiedReadable: true }));
}

/** POST /uploads/<uploadId>/finalize */
async function finalizeRoute(request: Request, env: UploadsEnv, uploadId: string): Promise<Response> {
  const credential = clientCredential(request);
  if (!credential.ok) {
    return credential.response;
  }
  return respond(await uploadsStep(env, { step: "finalize", input: { uploadId } }, credential.authorization));
}

/** POST /uploads/reconcile */
async function reconcileRoute(request: Request, env: UploadsEnv): Promise<Response> {
  const credential = clientCredential(request);
  if (!credential.ok) {
    return credential.response;
  }
  const decision = await uploadsStep(env, { step: "reconcile", input: {} }, credential.authorization);
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

/** One parameterized uploads route: method, path pattern, and its handler. */
interface ParamRouteSpec {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly handle: (
    request: Request,
    env: UploadsEnv,
    groups: RegExpExecArray,
  ) => Promise<Response>;
}

/**
 * The four parameterized routes. Every pattern's captures are non-empty by
 * construction (`[^/]+` cannot match a slash-less empty segment and `\d+`
 * only digits), which is what makes the non-null assertions below safe.
 */
const paramRoutes: readonly ParamRouteSpec[] = [
  {
    method: "POST",
    pattern: /^\/uploads\/([^/]+)\/attachments\/([^/]+)\/parts\/(\d+)$/,
    handle: (request, env, groups) =>
      partRoute(request, env, groups[1]!, groups[2]!, Number(groups[3])),
  },
  {
    method: "POST",
    pattern: /^\/uploads\/([^/]+)\/attachments\/([^/]+)\/complete$/,
    handle: (request, env, groups) => completeRoute(request, env, groups[1]!, groups[2]!),
  },
  {
    method: "GET",
    pattern: /^\/uploads\/([^/]+)\/session$/,
    handle: (request, env, groups) => sessionRoute(request, env, groups[1]!),
  },
  {
    method: "POST",
    pattern: /^\/uploads\/([^/]+)\/finalize$/,
    handle: (request, env, groups) => finalizeRoute(request, env, groups[1]!),
  },
];

/**
 * Matches one parameterized uploads route: the first table entry whose
 * method and pattern fit, with the captured groups closed over the handler
 * (structurally a `GatewayRoute`, so the shared route type stays untouched).
 */
function matchUploadsRoute(method: string, path: string): GatewayRoute | undefined {
  for (const spec of paramRoutes) {
    if (spec.method !== method) {
      continue;
    }
    const groups = spec.pattern.exec(path);
    if (groups === null) {
      continue;
    }
    return {
      method: spec.method,
      path,
      handle: (request, env) => spec.handle(request, env as UploadsEnv, groups),
    };
  }
  return undefined;
}

/** The uploads lane's route provider: static routes plus param matching. */
export const uploadsRouteProvider: RouteProvider = {
  providerId: "uploads",
  routes: [
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
  ],
  match: matchUploadsRoute,
};
