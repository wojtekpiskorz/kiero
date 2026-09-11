/**
 * Gateway purge channel (I4): the service-credentialed R2 deletion route
 * the Convex deletion executor's external action calls.
 *
 *   POST /purge/media   { deletionRecordId }
 *
 * ONE checked path (the D2/D3 channel discipline):
 *
 * 1. the bearer is verified against this Worker's KIERO_SERVICE_TOKEN
 *    (digest compare; the ONE shared credential-check home) - the Convex
 *    action's service identity is the only caller this route accepts;
 * 2. the route asks Convex's deletion bridge for the AUTHORITATIVE object
 *    key list of that ledger record's media stage (./bridge.ts) - a key
 *    list in the request body is never trusted, and an absent/purged
 *    stage answers the typed refusal (nothing to delete);
 * 3. the objects are deleted from the private EU media bucket (the same
 *    MEDIA_BUCKET binding the media/uploads/images lanes own; R2 deletes
 *    are idempotent, so a lost acknowledgement re-deletes nothing that
 *    exists);
 * 4. the answer is the sanitized envelope with the deleted count - never
 *    a key list, never bucket layout.
 *
 * Unknown `/purge/*` paths answer the sanitized `unsupported` closed error
 * like every other lane prefix.
 */

import { errorResult, okResult } from "@kiero/contracts";
import { unauthenticatedError, validationError } from "@kiero/runtime";
import { verifyServiceBearerToken } from "../../../../convex/operations/telemetry/serviceToken";
import type { BridgeEnv } from "../platform/bridge";
import type { GatewayRoute } from "../platform/routes";
import type { RouteProvider } from "../composition/registry";
import type { MediaR2Env } from "../media/r2";
import { resolvePurgeTargets } from "./bridge";

/** The env the purge routes need (bridge + the media bucket binding). */
export type PurgeEnv = BridgeEnv & MediaR2Env;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POST /purge/media: delete the ledger-recorded media objects. */
async function purgeMediaRoute(request: Request, env: PurgeEnv): Promise<Response> {
  const authorized = await verifyServiceBearerToken(
    request.headers.get("authorization"),
    env.KIERO_SERVICE_TOKEN,
  );
  if (!authorized) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, errorResult(validationError("purge_body_not_json")));
  }
  if (!isRecord(body) || typeof body.deletionRecordId !== "string" || body.deletionRecordId.length === 0) {
    return jsonResponse(400, errorResult(validationError("purge_reference_malformed")));
  }
  const resolved = await resolvePurgeTargets(env, body.deletionRecordId);
  if (!resolved.ok) {
    return jsonResponse(400, resolved.result);
  }
  // Idempotent deletes: keys already gone count as deleted (an R2 delete of
  // a missing object is a successful no-op).
  await Promise.all(resolved.targets.objectKeys.map((key) => env.MEDIA_BUCKET.delete(key)));
  return jsonResponse(200, okResult({ deleted: resolved.targets.objectKeys.length }));
}

// --- registration ---------------------------------------------------------------

/** The purge lane's route provider: the media deletion route only. */
export const purgeRouteProvider: RouteProvider = {
  providerId: "purge",
  routes: [
    {
      method: "POST",
      path: "/purge/media",
      handle: (request, env) => purgeMediaRoute(request, env as PurgeEnv),
    },
  ] satisfies readonly GatewayRoute[],
};
