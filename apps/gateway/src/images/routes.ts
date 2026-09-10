/**
 * Gateway images routes (D5): the executor surface the Convex durable job
 * calls.
 *
 * - `POST /images/normalize` — drives ONE `processing.normalize_photo` job
 *   from its current retention state to a terminal state (see ./service.ts
 *   for the resumable step machine). The optional `crashAfter` field is the
 *   guarded crash-window proof hook: it stops the drive at a named boundary
 *   so the live evidence can prove the uncertain-outcome semantics and the
 *   reconciliation resumption.
 * - `POST /images/reconcile` — the cleanup resumption pass: reconciliation
 *   names the received objects whose retained pair is verified; this route
 *   deletes them, marks the rows and confirms completion.
 *
 * IDENTITY: both routes act as the PLATFORM (the Worker's service
 * credential, the same shared secret the Convex images action presents).
 * There is no user identity on this surface — the Convex side re-derives
 * every row from the durable job the `jobKey` names. The bearer check is a
 * SHA-256 digest compare (never a plaintext equality on the wire secret).
 */

import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError, validationError } from "@kiero/runtime";
import type { RouteProvider } from "../composition/registry";
import type { CrashAfter, ImagesEnv } from "./service";
import { driveNormalization, resumeCleanup } from "./service";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respond(result: ResultEnvelope): Response {
  return jsonResponse(result._tag === "ok" ? 200 : 400, result);
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The service-credential check: the bearer value must digest-match the
 * Worker's `KIERO_SERVICE_TOKEN` secret binding. (The Convex side compares
 * the same way in operations/telemetry/serviceToken.ts; this is the
 * gateway-side mirror of that one definition.)
 */
async function requireServiceCredential(
  request: Request,
  env: ImagesEnv,
): Promise<boolean> {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return false;
  }
  const secret = env.KIERO_SERVICE_TOKEN;
  if (secret === undefined || secret === "") {
    return false;
  }
  const presented = authorization.slice("Bearer ".length);
  if (presented.length !== secret.length) {
    return false;
  }
  return (await digestHex(presented)) === (await digestHex(secret));
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
  const stop: CrashAfter | undefined =
    crashAfter === "record" || crashAfter === "verify" ? crashAfter : undefined;
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
