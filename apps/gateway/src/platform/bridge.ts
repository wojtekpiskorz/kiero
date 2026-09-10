/**
 * The Convex bridge client (A3; transport exported for lane bridges by D2):
 * how Worker calls reach the backend.
 *
 * Every gateway call to the backend carries the verified service identity
 * (bearer credential from the Worker secret binding) and lands on the
 * canonical access check inside the Convex HTTP boundary. Failures are
 * sanitized on THIS side too: a missing backend URL or network failure
 * becomes the closed `unavailable` error with no URL, hostname or internal
 * message attached; an unauthenticated/forbidden backend answer passes
 * through as the closed error it already is.
 *
 * `postBridge` is the ONE HTTP transport for Convex-bound calls from this
 * Worker (the mirror-is-a-hazard ruling): lane bridges (uploads, later
 * media/export routes) pass their own path, body and Authorization header
 * value through it instead of copying the fetch/error-mapping plumbing.
 * The header decides WHO the call acts as: the platform routes pass the
 * Worker's service credential, user-owned lanes pass the browser's
 * credential verbatim.
 */

import { Schema } from "effect";
import { errorResult, ResultEnvelope } from "@kiero/contracts";
import { unavailableError } from "@kiero/runtime";

/** The Convex-side bindings the gateway needs (names only; secrets injected). */
export interface BridgeEnv {
  /** HTTPS endpoint of the Convex deployment's HTTP actions. */
  readonly CONVEX_SITE_URL?: string;
  /** Shared service credential (secret binding; never a committed value). */
  readonly KIERO_SERVICE_TOKEN?: string;
}

/** One bridge command request. */
export interface BridgeCommand {
  readonly operation: string;
  readonly input?: unknown;
  readonly idempotencyKey?: string;
}

export async function postBridge(
  env: BridgeEnv,
  path: string,
  body: unknown,
  authorization: string,
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
        authorization,
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

/** Forwards one command envelope through the verified service bridge. */
export async function callPlatform(
  env: BridgeEnv,
  command: BridgeCommand,
): Promise<ResultEnvelope> {
  const result = await postBridge(
    env,
    "/platform/bridge",
    {
      operation: command.operation,
      input: command.input ?? {},
      expectedRevisions: [],
      ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
    },
    // The platform routes act as the platform: the Worker's own credential.
    `Bearer ${env.KIERO_SERVICE_TOKEN}`,
  );
  if (!result.ok) {
    return result.error;
  }
  return result.body;
}

/** Reads backend health through the same verified bridge. */
export async function platformHealth(env: BridgeEnv): Promise<ResultEnvelope> {
  const site = env.CONVEX_SITE_URL;
  const token = env.KIERO_SERVICE_TOKEN;
  if (site === undefined || site === "" || token === undefined || token === "") {
    return errorResult(unavailableError(false, "bridge_not_configured"));
  }
  try {
    const response = await fetch(`${site.replace(/\/$/, "")}/platform/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const payload: unknown = await response.json();
    const decoded = Schema.decodeUnknownOption(ResultEnvelope)(payload);
    if (decoded._tag === "None") {
      return errorResult(unavailableError(false, "backend_response_invalid"));
    }
    return decoded.value;
  } catch {
    return errorResult(unavailableError(true, "backend_unreachable"));
  }
}
