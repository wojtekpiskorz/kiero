/**
 * The Convex HTTP client for the Calendar OAuth boundary (G1).
 *
 * Two verified legs, both ending on the canonical Convex checks:
 *
 * - the START forwards the USER's Convex access token (Authorization
 *   header) to the deployment's `/calendar/oauth/start`; Convex verifies
 *   the token and resolves the company scope through the canonical chain
 *   (the A3 checked path), and the response carries only the constructed
 *   Google authorization URL.
 * - the CALLBACK forwards Google's query parameters to
 *   `/calendar/oauth/callback/complete` with the Worker's service
 *   credential (the A3 verified service-bridge identity): the bridge bearer
 *   check admits the call, and the callback protocol itself correlates by
 *   the single-use state and re-checks membership.
 *
 * Failures are sanitized on THIS side too: a missing backend URL/credential
 * or an unreachable deployment becomes the closed `unavailable` error with
 * no URL, token value or internal message attached.
 */

import { Schema } from "effect";
import { errorResult, ResultEnvelope } from "@kiero/contracts";
import { unavailableError } from "@kiero/runtime";

/** The Convex-side bindings the calendar routes need (names only). */
export interface CalendarBridgeEnv {
  /** HTTPS endpoint of the Convex deployment's HTTP actions. */
  readonly CONVEX_SITE_URL?: string;
  /** Shared service credential (secret binding; never a committed value). */
  readonly KIERO_SERVICE_TOKEN?: string;
}

/** One sanitized calendar bridge failure. */
export type CalendarBridgeFailure =
  | { readonly kind: "not_configured" }
  | { readonly kind: "unreachable" };

function failureEnvelope(failure: CalendarBridgeFailure): ResultEnvelope {
  return errorResult(
    unavailableError(failure.kind === "unreachable", `calendar_backend_${failure.kind}`),
  );
}

/** The start result: only the authorization URL and its expiry. */
export interface CalendarStartResult {
  readonly authorizationUrl: string;
  readonly expiresAtMs: number;
}

function decodeOkObject(payload: ResultEnvelope): Record<string, unknown> | null {
  if (payload._tag !== "ok" || typeof payload.value !== "object" || payload.value === null) {
    return null;
  }
  return payload.value as Record<string, unknown>;
}

/** Forwards the user's verified token to the Convex authorization start. */
export async function calendarStart(
  env: CalendarBridgeEnv,
  userAuthorizationHeader: string | null,
): Promise<{ ok: true; start: CalendarStartResult } | { ok: false; result: ResultEnvelope }> {
  const site = env.CONVEX_SITE_URL;
  if (site === undefined || site === "") {
    return { ok: false, result: failureEnvelope({ kind: "not_configured" }) };
  }
  if (userAuthorizationHeader === null || !userAuthorizationHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      result: errorResult(unavailableError(false, "user_token_missing")),
    };
  }
  let response: Response;
  try {
    response = await fetch(`${site.replace(/\/$/, "")}/calendar/oauth/start`, {
      method: "POST",
      headers: {
        authorization: userAuthorizationHeader,
        "content-type": "application/json",
      },
      body: "{}",
    });
  } catch {
    return { ok: false, result: failureEnvelope({ kind: "unreachable" }) };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, result: failureEnvelope({ kind: "unreachable" }) };
  }
  const decoded = Schema.decodeUnknownOption(ResultEnvelope)(payload);
  if (decoded._tag === "None") {
    return { ok: false, result: failureEnvelope({ kind: "unreachable" }) };
  }
  if (decoded.value._tag === "error") {
    return { ok: false, result: decoded.value };
  }
  const value = decodeOkObject(decoded.value);
  const url = value?.authorizationUrl;
  const expiresAtMs = value?.expiresAtMs;
  if (typeof url !== "string" || typeof expiresAtMs !== "number") {
    return { ok: false, result: failureEnvelope({ kind: "unreachable" }) };
  }
  return { ok: true, start: { authorizationUrl: url, expiresAtMs } };
}

/** Forwards Google's callback query to the verified bridge completion. */
export async function calendarComplete(
  env: CalendarBridgeEnv,
  params: { readonly state: string; readonly code: string | null; readonly error: string | null },
): Promise<{ ok: true; result: ResultEnvelope } | { ok: false; result: ResultEnvelope }> {
  const site = env.CONVEX_SITE_URL;
  const token = env.KIERO_SERVICE_TOKEN;
  if (site === undefined || site === "" || token === undefined || token === "") {
    return { ok: false, result: failureEnvelope({ kind: "not_configured" }) };
  }
  let response: Response;
  try {
    response = await fetch(`${site.replace(/\/$/, "")}/calendar/oauth/callback/complete`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        state: params.state,
        ...(params.code === null ? {} : { code: params.code }),
        ...(params.error === null ? {} : { error: params.error }),
      }),
    });
  } catch {
    return { ok: false, result: failureEnvelope({ kind: "unreachable" }) };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, result: failureEnvelope({ kind: "unreachable" }) };
  }
  const decoded = Schema.decodeUnknownOption(ResultEnvelope)(payload);
  if (decoded._tag === "None") {
    return { ok: false, result: failureEnvelope({ kind: "unreachable" }) };
  }
  return { ok: true, result: decoded.value };
}
