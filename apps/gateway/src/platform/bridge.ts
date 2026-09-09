/**
 * The Convex bridge client (A3): how Worker calls reach the platform.
 *
 * Every gateway call to the backend carries the verified service identity
 * (bearer credential from the Worker secret binding) and lands on the
 * canonical access check inside `convex/platform/http.ts`. Failures are
 * sanitized on THIS side too: a missing backend URL or network failure
 * becomes the closed `unavailable` error with no URL, hostname or internal
 * message attached; an unauthenticated/forbidden backend answer passes
 * through as the closed error it already is.
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

async function postBridge(
  env: BridgeEnv,
  path: string,
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

/** Forwards one command envelope through the verified bridge. */
export async function callPlatform(
  env: BridgeEnv,
  command: BridgeCommand,
): Promise<ResultEnvelope> {
  const result = await postBridge(env, "/platform/bridge", {
    operation: command.operation,
    input: command.input ?? {},
    expectedRevisions: [],
    ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
  });
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
