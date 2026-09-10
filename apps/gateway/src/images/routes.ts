/**
 * Gateway images routes (D5): the executor surface the Convex durable job
 * calls.
 *
 * - `POST /images/normalize` — drives ONE `processing.normalize_photo` job
 *   from its current retention state to a terminal state (see ./service.ts
 *   for the resumable step machine). The optional `crashAfter` field is the
 *   guarded crash-window proof hook: it stops the drive at a named boundary
 *   so the live evidence can prove the uncertain-outcome semantics and the
 *   reconciliation resumption. The hook is dead unless the Worker runs with
 *   `KIERO_PROBE_ENABLED=1` (a dev/proof variable; production deploys of the
 *   committed config never set it) — production cannot be told to crash on
 *   demand.
 * - `POST /images/reconcile` — the cleanup resumption pass: reconciliation
 *   names the received objects whose retained pair is verified; this route
 *   deletes them, marks the rows and confirms completion.
 *
 * IDENTITY: both routes act as the PLATFORM (the Worker's service
 * credential, the same shared secret the Convex images action presents).
 * There is no user identity on this surface — the Convex side re-derives
 * every row from the durable job the `jobKey` names. The bearer check is
 * the ONE digest-compare definition (convex/operations/telemetry/
 * serviceToken.ts — deliberately runtime-importable, imported here exactly
 * like the gateway's other pure Convex-directory modules).
 */

import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError, validationError } from "@kiero/runtime";
import type { RouteProvider } from "../composition/registry";
import type { CrashAfter, ImagesEnv } from "./service";
import { driveNormalization, resumeCleanup } from "./service";
import { verifyServiceBearerToken } from "../../../../convex/operations/telemetry/serviceToken";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respond(result: ResultEnvelope): Response {
  return jsonResponse(result._tag === "ok" ? 200 : 400, result);
}

/** The service-credential check: the ONE shared digest-compare definition. */
function requireServiceCredential(request: Request, env: ImagesEnv): Promise<boolean> {
  return verifyServiceBearerToken(request.headers.get("authorization"), env.KIERO_SERVICE_TOKEN);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBody(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, response: respond(errorResult(validationError("images_body_not_json"))) };
  }
  if (!isRecord(parsed)) {
    return { ok: false, response: respond(errorResult(validationError("images_body_not_object"))) };
  }
  return { ok: true, body: parsed };
}

/** POST /images/normalize */
async function normalizeRoute(request: Request, env: ImagesEnv): Promise<Response> {
  if (!(await requireServiceCredential(request, env))) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
  }
  const body = await readBody(request);
  if (!body.ok) {
    return body.response;
  }
  const { jobKey, crashAfter } = body.body;
  if (typeof jobKey !== "string" || jobKey.length === 0) {
    return respond(errorResult(validationError("job_key_missing")));
  }
  // The crash hook is proof-only: dead unless the Worker runs with the
  // probe variable set (never set by the committed production config).
  const stop: CrashAfter | undefined =
    env.KIERO_PROBE_ENABLED === "1" && (crashAfter === "record" || crashAfter === "verify")
      ? crashAfter
      : undefined;
  return respond(await driveNormalization(env, jobKey, stop));
}

/** POST /images/reconcile */
async function reconcileRoute(request: Request, env: ImagesEnv): Promise<Response> {
  if (!(await requireServiceCredential(request, env))) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
  }
  const body = await readBody(request);
  if (!body.ok) {
    return body.response;
  }
  const { jobKey } = body.body;
  if (typeof jobKey !== "string" || jobKey.length === 0) {
    return respond(errorResult(validationError("job_key_missing")));
  }
  return respond(await resumeCleanup(env, jobKey));
}

/** The images lane's route provider. */
export const imagesRouteProvider: RouteProvider = {
  providerId: "images",
  routes: [
    {
      method: "POST",
      path: "/images/normalize",
      handle: (request, env) => normalizeRoute(request, env as ImagesEnv),
    },
    {
      method: "POST",
      path: "/images/reconcile",
      handle: (request, env) => reconcileRoute(request, env as ImagesEnv),
    },
  ],
};
