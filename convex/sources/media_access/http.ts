/**
 * The media-access channel HTTP boundary (D3): the Worker's verified entry
 * to the per-request read authorization.
 *
 * `/sources/media/access` (POST) carries the END USER's Convex Auth
 * credential, exactly like the D2 uploads boundary: the browser sends
 * `Authorization: Bearer <id token>`, the gateway Worker forwards that
 * header verbatim, and Convex propagates it into the invoked query's
 * `ctx.auth` — B1's live-session resolution and the canonical chain decide
 * the acting user, the service identity is never substituted, and the
 * uniform `not_found` refusal never discloses existence, tenancy or
 * storage layout. A missing credential fails sanitized 401 before any
 * dispatch; a malformed body fails with a closed `validation` error.
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

/** The verified media-access resolution for the gateway's read routes. */
export const mediaAccessHandler = httpAction(async (ctx: ActionCtx, request) => {
  const authorization = requireAuthorization(request);
  if (authorization === null) {
    return jsonResponse(401, errorResult(unauthenticatedError("client_credential_missing")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, errorResult(validationError("media_access_body_not_json")));
  }
  if (!isRecord(body)) {
    return jsonResponse(400, errorResult(validationError("media_reference_malformed")));
  }
  const attachmentId = typeof body.attachmentId === "string" ? body.attachmentId : undefined;
  const representationId = typeof body.representationId === "string" ? body.representationId : undefined;
  if (
    (attachmentId === undefined && representationId === undefined) ||
    (attachmentId !== undefined && representationId !== undefined)
  ) {
    return jsonResponse(400, errorResult(validationError("media_reference_malformed")));
  }
  const result: ResultEnvelope = await ctx.runQuery(internal.sources["media_access"].commands.mediaAccessFor, {
    ...(attachmentId === undefined ? {} : { attachmentId }),
    ...(representationId === undefined ? {} : { representationId }),
  });
  return jsonResponse(envelopeHttpStatus(result), result);
});
