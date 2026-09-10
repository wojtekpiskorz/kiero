/**
 * Gateway media routes (D3): the authorized retained-media read surface.
 *
 * Two parameterized GET routes, both carrying the END USER's credential
 * (the D2 per-user channel pattern):
 *
 * - `GET /media/attachments/<attachmentId>` — the canonical read: the
 *   SERVER resolves which representation serves the bytes (retained when
 *   verified, else the verified received record) through Convex.
 * - `GET /media/representations/<representationId>` — the exact-version
 *   read E4's media anchors and I3/I5's export/backup readers address.
 *
 * Every request — full, ranged, conditional — follows ONE checked path:
 *
 *   browser credential -> `/sources/media/access` on Convex (live session,
 *   active membership, tenant scope, source lifecycle, attachment
 *   relationship, representation verification; the uniform not-found never
 *   discloses existence, tenancy or storage layout) -> the ledger grant
 *   (object key, etag, byte length, media type) -> the pure RFC 9110 read
 *   decision (protocol.ts) -> the R2 read (streamed, un-buffered,
 *   ledger-verified size and etag) -> the byte response.
 *
 * A session or membership revoked between two range requests refuses the
 * fresh request before any R2 byte; the already-delivered bytes of an
 * in-flight response are the explicit physical limit. Every response
 * carries `Cache-Control: no-store` so no shared or private cache can
 * serve these bytes without re-running this check.
 *
 * Registration rides the composition contract: this lane supplies a
 * `RouteProvider` whose `match` owns the parameterized paths (the seam D2
 * built; `GatewayRoute.method` GET|POST already covers reads — HEAD would
 * be a named cross-lane prerequisite, and browsers seek audio with ranged
 * GETs).
 */

import { Schema } from "effect";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import {
  envelopeHttpStatus,
  notFoundError,
  unauthenticatedError,
  unavailableError,
} from "@kiero/runtime";
import type { GatewayRoute } from "../platform/routes";
import type { RouteProvider } from "../composition/registry";
import { mediaAccess } from "./bridge";
import { openMediaObject, verifyAgainstGrant, type MediaEnv } from "./r2";
import {
  MEDIA_CACHE_CONTROL,
  MediaAccessGrant,
  decideMediaRead,
  quotedEtag,
  type MediaReadPlan,
} from "../../../../convex/sources/media_access/protocol";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respond(result: ResultEnvelope): Response {
  return jsonResponse(envelopeHttpStatus(result), result);
}

/**
 * The grant envelope narrowed to its value through the ONE schema that
 * defines it (the same `MediaAccessGrant` the Convex resolution decoded
 * its answer against — no hand-written field ladder beside the definition
 * to drift in either direction).
 */
function asGrant(value: unknown): MediaAccessGrant | null {
  const decoded = Schema.decodeUnknownOption(MediaAccessGrant)(value);
  return decoded._tag === "Some" ? decoded.value : null;
}

/** The headers every media answer carries (authorization cannot be cached away). */
function baseMediaHeaders(grant: MediaAccessGrant): Record<string, string> {
  return {
    etag: quotedEtag(grant.etag),
    "cache-control": MEDIA_CACHE_CONTROL,
    "accept-ranges": "bytes",
    "content-disposition": "inline",
  };
}

/** Answers a decided plan that needs no bytes (304 needs no R2 read at all). */
function metadataResponse(plan: Extract<MediaReadPlan, { status: 304 | 416 }>, grant: MediaAccessGrant): Response {
  if (plan.status === 304) {
    return new Response(null, { status: 304, headers: baseMediaHeaders(grant) });
  }
  return new Response(null, {
    status: 416,
    headers: { ...baseMediaHeaders(grant), "content-range": `bytes */${plan.totalBytes}` },
  });
}

/** Streams the opened object's bytes with the plan's headers. */
function streamResponse(
  plan: Extract<MediaReadPlan, { status: 200 | 206 }>,
  grant: MediaAccessGrant,
  object: R2ObjectBody,
): Response {
  const headers: Record<string, string> = {
    ...baseMediaHeaders(grant),
    "content-type": grant.contentType,
    "content-length": String(plan.status === 206 ? plan.last - plan.first + 1 : object.size),
  };
  if (plan.status === 206) {
    headers["content-range"] = `bytes ${plan.first}-${plan.last}/${grant.bytes}`;
  }
  return new Response(object.body, { status: plan.status, headers });
}

/** GET /media/attachments/<id> and /media/representations/<id>. */
async function mediaReadRoute(
  request: Request,
  env: MediaEnv,
  call: { attachmentId: string } | { representationId: string },
): Promise<Response> {
  const authorization = request.headers.get("authorization");
  if (authorization === null || authorization === "") {
    return respond(errorResult(unauthenticatedError("client_credential_missing")));
  }
  // The authorization decision happens BEFORE any R2 read: a dead session,
  // a revoked membership, a foreign tenant or a purged source answers here
  // with zero bucket calls.
  const access = await mediaAccess(env, call, authorization);
  if (access._tag === "error") {
    return respond(access);
  }
  const grant = asGrant(access.value);
  if (grant === null) {
    return respond(errorResult(unavailableError(false, "media_grant_invalid")));
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
    return respond(errorResult(notFoundError("media", "media_reference_not_found")));
  }
  if (!verifyAgainstGrant(object, grant)) {
    // Ledger inconsistency (size or etag drift): no byte is served.
    return respond(errorResult(unavailableError(true, "media_ledger_inconsistent")));
  }
  return streamResponse(plan, grant, object);
}

// --- registration ------------------------------------------------------------------

/** Matches one parameterized media route (captures are non-empty by construction). */
function matchMediaRoute(method: string, path: string): GatewayRoute | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const attachment = /^\/media\/attachments\/([^/]+)$/.exec(path);
  if (attachment !== null) {
    const attachmentId = attachment[1]!;
    return {
      method: "GET",
      path,
      handle: (request, env) => mediaReadRoute(request, env as MediaEnv, { attachmentId }),
    };
  }
  const representation = /^\/media\/representations\/([^/]+)$/.exec(path);
  if (representation !== null) {
    const representationId = representation[1]!;
    return {
      method: "GET",
      path,
      handle: (request, env) => mediaReadRoute(request, env as MediaEnv, { representationId }),
    };
  }
  return undefined;
}

/** The media lane's route provider: parameterized GET reads only. */
export const mediaRouteProvider: RouteProvider = {
  providerId: "media",
  routes: [],
  match: matchMediaRoute,
};
