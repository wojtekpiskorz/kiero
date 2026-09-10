/**
 * The uploads channel HTTP boundary (D2): the browser's verified entry to
 * the upload ledger.
 *
 * `/sources/uploads/bridge` (POST) and `/sources/uploads/state` (POST)
 * carry the END USER's Convex Auth credential: the browser sends
 * `Authorization: Bearer <id token>`, the gateway Worker forwards that
 * header verbatim, and Convex propagates it into the invoked mutation's /
 * query's `ctx.auth` — where B1's live-session resolution and A3's
 * canonical chain resolve the acting user (live session, active
 * membership, company). The service-bridge identity is NOT used here: a
 * user-owned ledger row must never be created or touched as the service
 * account. A missing credential fails sanitized 401 before any dispatch;
 * malformed bodies fail with closed `validation` errors; no internal
 * detail crosses the boundary.
 *
 * Routes register in `convex/http.ts` through the composition append
 * pattern (imports only).
 */

import { httpAction, type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { envelopeHttpStatus, unauthenticatedError, validationError } from "@kiero/runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The forwarded user credential; Convex verifies it, this boundary only requires it. */
function requireAuthorization(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null || authorization === "") {
    return null;
  }
  return authorization;
}

/** The verified uploads channel endpoint for one gateway protocol step. */
export const uploadsBridgeHandler = httpAction(async (ctx: ActionCtx, request) => {
  const authorization = requireAuthorization(request);
  if (authorization === null) {
    return jsonResponse(401, errorResult(unauthenticatedError("client_credential_missing")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, errorResult(validationError("uploads_body_not_json")));
  }
  if (!isRecord(body) || typeof body.step !== "string") {
    return jsonResponse(400, errorResult(validationError("uploads_step_missing")));
  }
  // The caller's Authorization header propagates into the mutation's
  // ctx.auth; the step resolves and acts AS THAT USER.
  const result: ResultEnvelope = await ctx.runMutation(
    internal.sources.uploads.commands.stepTransaction,
    {
      envelope: { step: body.step, input: body.input ?? {} },
    },
  );
  return jsonResponse(envelopeHttpStatus(result), result);
});

/** The verified upload-session state read for the gateway's resume route. */
export const uploadsStateHandler = httpAction(async (ctx: ActionCtx, request) => {
  const authorization = requireAuthorization(request);
  if (authorization === null) {
    return jsonResponse(401, errorResult(unauthenticatedError("client_credential_missing")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, errorResult(validationError("uploads_body_not_json")));
  }
  if (!isRecord(body) || typeof body.uploadId !== "string") {
    return jsonResponse(400, errorResult(validationError("upload_reference_missing")));
  }
  const result: ResultEnvelope = await ctx.runQuery(
    internal.sources.uploads.commands.uploadStateFor,
    { uploadId: body.uploadId },
  );
  return jsonResponse(envelopeHttpStatus(result), result);
});
