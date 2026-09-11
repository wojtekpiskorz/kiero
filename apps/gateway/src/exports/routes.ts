/**
 * Gateway export download route (I3): the authorized, bounded-streaming
 * archive read surface, ONE parameterized GET route:
 *
 *   GET /exports/<exportId>/download
 *
 * Every request — full, ranged, conditional — follows ONE checked path (the
 * D3 media-route discipline): browser credential -> `/operations/exports/
 * access` on Convex (live session, active membership, CURRENT
 * administrator, tenant scope, lifecycle window, linked-source purge check;
 * the uniform not-found discloses nothing) -> the ledger grant (object key,
 * etag, byte length) -> the PURE RFC 9110 read decision (the shared
 * media_access protocol — the ONE range/conditional definition) -> the R2
 * read (streamed, ledger-verified size and etag) -> the byte answer with
 * `content-disposition: attachment` and `cache-control: no-store`.
 *
 * A session revoked, an admin demoted, the 24-hour window passed or a
 * linked source purged between two range requests refuses the FRESH
 * request before any R2 byte; the already-delivered bytes of an in-flight
 * response are the explicit physical limit.
 */

import { Schema } from "effect";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { envelopeHttpStatus, notFoundError, unauthenticatedError, unavailableError } from "@kiero/runtime";
import type { GatewayRoute } from "../platform/routes";
import type { RouteProvider } from "../composition/registry";
import { exportAccess } from "./bridge";
import { openMediaObject, verifyAgainstGrant, type MediaEnv } from "../media/r2";
import {
  MEDIA_CACHE_CONTROL,
  decideMediaRead,
  quotedEtag,
  type MediaReadPlan,
} from "../../../../convex/sources/media_access/protocol";
import { ExportAccessGrant } from "../../../../convex/operations/exports/channel";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respond(result: ResultEnvelope): Response {
  return jsonResponse(envelopeHttpStatus(result), result);
}

/** The grant envelope narrowed through the ONE schema that defines it. */
function asGrant(value: unknown): ExportAccessGrant | null {
  const decoded = Schema.decodeUnknownOption(ExportAccessGrant)(value);
  return decoded._tag === "Some" ? decoded.value : null;
}

function baseHeaders(grant: ExportAccessGrant): Record<string, string> {
  return {
    etag: quotedEtag(grant.etag),
    "cache-control": MEDIA_CACHE_CONTROL,
    "accept-ranges": "bytes",
    "content-disposition": `attachment; filename="${grant.fileName}"`,
  };
}

function metadataResponse(
  plan: Extract<MediaReadPlan, { status: 304 | 416 }>,
  grant: ExportAccessGrant,
): Response {
  if (plan.status === 304) {
    return new Response(null, { status: 304, headers: baseHeaders(grant) });
  }
  return new Response(null, {
    status: 416,
    headers: { ...baseHeaders(grant), "content-range": `bytes */${plan.totalBytes}` },
  });
}

function streamResponse(
  plan: Extract<MediaReadPlan, { status: 200 | 206 }>,
  grant: ExportAccessGrant,
  object: R2ObjectBody,
): Response {
  const headers: Record<string, string> = {
    ...baseHeaders(grant),
    "content-type": grant.contentType,
    "content-length": String(plan.status === 206 ? plan.last - plan.first + 1 : object.size),
  };
  if (plan.status === 206) {
    headers["content-range"] = `bytes ${plan.first}-${plan.last}/${grant.bytes}`;
  }
  return new Response(object.body, { status: plan.status, headers });
}

/** GET /exports/<exportId>/download (the end user's credential). */
async function exportDownloadRoute(
  request: Request,
  env: MediaEnv,
  exportId: string,
): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (authorization === null || authorization === "") {
    return respond(errorResult(unauthenticatedError("client_credential_missing")));
  }
  // The authorization decision happens BEFORE any R2 read: a dead session,
  // a demoted administrator, a foreign tenant, an expired or invalidated
  // archive, or a purged linked source answers here with zero bucket calls.
  const access = await exportAccess(env, exportId, authorization);
  if (access._tag === "error") {
    return respond(access);
  }
  const grant = asGrant(access.value);
  if (grant === null) {
    return respond(errorResult(unavailableError(false, "export_grant_invalid")));
  }
  const plan = decideMediaRead(
    {
      range: request.headers.get("range") ?? undefined,
      ifNoneMatch: request.headers.get("if-none-match") ?? undefined,
      ifRange: request.headers.get("if-range") ?? undefined,
    },
    grant.etag,
    grant.bytes,
  );
  if (plan.status === 304 || plan.status === 416) {
    return metadataResponse(plan, grant);
  }
  let object: R2ObjectBody | null;
  try {
    object = await openMediaObject(
      env,
      grant.objectKey,
      plan.status === 206 ? { offset: plan.first, length: plan.last - plan.first + 1 } : undefined,
    );
  } catch {
    return respond(errorResult(unavailableError(true, "media_store_unavailable")));
  }
  if (object === null) {
    // The ledger named an object R2 does not have: the same closed
    // not-found the ledger refusals use (no storage-layout disclosure).
    return respond(errorResult(notFoundError("exports", "export_not_found")));
  }
  if (!verifyAgainstGrant(object, grant)) {
    // Ledger inconsistency (size or etag drift): no byte is served.
    return respond(errorResult(unavailableError(true, "media_ledger_inconsistent")));
  }
  return streamResponse(plan, grant, object);
}

// --- registration ---------------------------------------------------------------

/** Matches the parameterized download route (captures are non-empty). */
function matchExportRoute(method: string, path: string): GatewayRoute | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/exports\/([^/]+)\/download$/.exec(path);
  if (match === null) {
    return undefined;
  }
  const exportId = match[1]!;
  return {
    method: "GET",
    path,
    handle: (request, env) => exportDownloadRoute(request, env as MediaEnv, exportId),
  };
}

/** The exports lane's route provider: the parameterized download read only. */
export const exportsRouteProvider: RouteProvider = {
  providerId: "exports",
  routes: [],
  match: matchExportRoute,
};
