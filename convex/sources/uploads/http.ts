/**
 * The uploads channel HTTP boundary (D2): the Worker's verified entry to the
 * upload ledger, mirroring the A3 platform bridge
 * (`convex/platform/http.ts`).
 *
 * `/sources/uploads/bridge` (POST): one gateway protocol step. The bearer
 * credential in `Authorization` is verified against the deployment's
 * `KIERO_SERVICE_TOKEN` (the shared digest-compare check in
 * operations/telemetry/serviceToken.ts — exactly one definition). The
 * verified identity is the service account's session, resolved through the
 * SAME canonical resolution and policy as user calls; the step then runs in
 * ONE mutation transaction (`commands.ts` `stepTransaction`). Malformed
 * bodies fail with sanitized closed errors; no internal detail crosses the
 * boundary.
 *
 * `/sources/uploads/state` (POST): the tenant-scoped upload-session read
 * (`commands.ts` `uploadStateFor`) the gateway's resume route serves. Same
 * credential check, same canonical resolution, same closed errors.
 *
 * Routes register in `convex/http.ts` through the composition append
 * pattern (imports only).
 */

import { httpAction, type ActionCtx } from "../../_generated/server";
import { api, internal } from "../../_generated/api";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import {
  envelopeHttpStatus,
  forbiddenError,
  unauthenticatedError,
  validationError,
} from "@kiero/runtime";
import { verifyServiceBearerToken } from "../../operations/telemetry/serviceToken";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Resolves the service account's session id, or a sanitized refusal. */
async function serviceSession(
  ctx: ActionCtx,
): Promise<{ ok: true; sessionId: string } | { ok: false; response: Response }> {
  const session: unknown = await ctx.runQuery(api.platform.probe.serviceSession, {});
  if (!isRecord(session) || typeof session.sessionId !== "string") {
    return {
      ok: false,
      response: jsonResponse(403, errorResult(forbiddenError("service_identity_unavailable"))),
    };
  }
  return { ok: true, sessionId: session.sessionId };
}

async function verifyBearer(request: Request): Promise<boolean> {
  return verifyServiceBearerToken(request.headers.get("authorization"), process.env.KIERO_SERVICE_TOKEN);
}

/** The verified Worker bridge endpoint for one uploads protocol step. */
export const uploadsBridgeHandler = httpAction(async (ctx, request) => {
  const authorized = await verifyBearer(request);
  if (!authorized) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
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
  const session = await serviceSession(ctx);
  if (!session.ok) {
    return session.response;
  }
  const result: ResultEnvelope = await ctx.runMutation(
    internal.sources.uploads.commands.stepTransaction,
    {
      envelope: { step: body.step, input: body.input ?? {} },
      serviceSessionId: session.sessionId,
    },
  );
  return jsonResponse(envelopeHttpStatus(result), result);
});

/** The verified upload-session state read for the gateway's resume route. */
export const uploadsStateHandler = httpAction(async (ctx, request) => {
  const authorized = await verifyBearer(request);
  if (!authorized) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
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
  const session = await serviceSession(ctx);
  if (!session.ok) {
    return session.response;
  }
  const result: ResultEnvelope = await ctx.runQuery(
    internal.sources.uploads.commands.uploadStateFor,
    { uploadId: body.uploadId, serviceSessionId: session.sessionId },
  );
  return jsonResponse(envelopeHttpStatus(result), result);
});
