/**
 * The Convex uploads-channel bridge client (D2): how the Worker's upload
 * routes reach the upload ledger.
 *
 * Mirrors the platform bridge (`../platform/bridge.ts`) with the uploads
 * channel's own endpoints (`/sources/uploads/bridge` and
 * `/sources/uploads/state`, registered by `convex/http.ts`): every call
 * carries the verified service credential (secret binding) and lands on the
 * canonical access check inside `convex/sources/uploads/http.ts`. Failures
 * are sanitized on THIS side too: a missing backend URL or network failure
 * becomes the closed `unavailable` error with no URL, hostname or internal
 * message attached; closed backend errors pass through unchanged.
 */

import { Schema } from "effect";
import { errorResult, ResultEnvelope } from "@kiero/contracts";
import { unavailableError } from "@kiero/runtime";
import type { BridgeEnv } from "../platform/bridge";

/** One gateway protocol step to run against the ledger. */
export interface UploadsStepCall {
  readonly step: "prepare" | "begin" | "part" | "complete" | "finalize" | "reconcile";
  readonly input: unknown;
}

async function postUploads(
  env: BridgeEnv,
  path: "/sources/uploads/bridge" | "/sources/uploads/state",
  body: unknown,
): Promise<{ ok: true; body: ResultEnvelope } | { ok: false; error: ResultEnvelope }> {
  const site = env.CONVEX_SITE_URL;
  const token = env.KIERO_SERVICE_TOKEN;
  if (site === undefined || site === "" || token === undefined || token === "") {
    return {
      ok: false,
      error: errorResult(unavailableError(false, "bridge_not_configured")),
    };
  }
  let response: Response;
  try {
    response = await fetch(`${site.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Unreachable backend: sanitized, retryable, no internal detail.
    return {
      ok: false,
      error: errorResult(unavailableError(true, "backend_unreachable")),
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      error: errorResult(unavailableError(false, "backend_route_missing")),
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      error: errorResult(unavailableError(true, "backend_response_not_json")),
    };
  }
  const decoded = Schema.decodeUnknownOption(ResultEnvelope)(payload);
  if (decoded._tag === "None") {
    return {
      ok: false,
      error: errorResult(unavailableError(false, "backend_response_invalid")),
    };
  }
  return { ok: true, body: decoded.value };
}

/** Runs one uploads protocol step through the verified channel. */
export async function uploadsStep(
  env: BridgeEnv,
  call: UploadsStepCall,
): Promise<ResultEnvelope> {
  const result = await postUploads(env, "/sources/uploads/bridge", {
    step: call.step,
    input: call.input,
  });
  return result.ok ? result.body : result.error;
}

/** Reads one tenant-scoped upload session through the verified channel. */
export async function uploadsState(
  env: BridgeEnv,
  uploadId: string,
): Promise<ResultEnvelope> {
  const result = await postUploads(env, "/sources/uploads/state", { uploadId });
  return result.ok ? result.body : result.error;
}
