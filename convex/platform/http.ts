/**
 * The platform HTTP boundary (A3): the Worker bridge, the external echo
 * stand-in and the health endpoint.
 *
 * `/platform/bridge` (POST): Worker service calls. The bearer credential in
 * `Authorization` is verified against the deployment's `KIERO_SERVICE_TOKEN`
 * variable (compared as SHA-256 digests so the secret is never handled in
 * the clear; upgradeable to signed credentials when B/E lanes productionize
 * — the canonical check after verification is unchanged). The verified
 * identity is the service account's session, resolved through the SAME
 * context resolution and authorization seam as user calls, and the command
 * dispatches through the checked path. Malformed bodies and unknown
 * operations fail with sanitized closed errors; no internal detail crosses
 * the boundary.
 *
 * `/platform/echo` (POST): the external-system stand-in. It records one
 * `externalEffects` row per request BEFORE answering (its observable
 * effect), then behaves per `behavior`: `ok` answers immediately, `slow`
 * answers after a delay longer than the caller's deadline (the caller times
 * out after the effect happened — the uncertain-outcome case), `crash`
 * answers with a 5xx (effect happened, clean answer did not arrive). This
 * endpoint is deliberately dumb: it does not dedup and knows nothing about
 * the caller's bookkeeping — exactly like a real external system.
 *
 * `/platform/health` (GET): public health/version info for diagnostics.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { httpAction, internalMutation } from "../_generated/server";
import { api, internal } from "../_generated/api";
import {
  ClosedError,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { dispatchBridgeCommand } from "./dispatch";

// --- credential verification ---------------------------------------------------

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Digest-compared bearer check; never logs or echoes either side. */
async function verifyServiceToken(authorizationHeader: string | null): Promise<boolean> {
  const expected = process.env.KIERO_SERVICE_TOKEN;
  if (expected === undefined || expected === "") {
    return false;
  }
  if (authorizationHeader === null || !authorizationHeader.startsWith("Bearer ")) {
    return false;
  }
  const presented = authorizationHeader.slice("Bearer ".length);
  const [presentedHash, expectedHash] = await Promise.all([
    sha256Hex(presented),
    sha256Hex(expected),
  ]);
  let equal = presentedHash.length === expectedHash.length;
  for (let index = 0; index < presentedHash.length; index += 1) {
    equal = presentedHash[index] === expectedHash[index] && equal;
  }
  return equal;
}

function closedError(tag: ClosedError["_tag"], code: string): ClosedError {
  const messages: Record<string, string> = {
    unauthenticated: "Najpierw się zaloguj.",
    validation: "Kiero nie przyjęło tych danych. Popraw je i spróbuj ponownie.",
    unsupported: "Ta operacja nie jest jeszcze dostępna.",
    forbidden: "Nie masz uprawnień do tej czynności.",
  };
  return Schema.decodeUnknownSync(ClosedError)({
    _tag: tag,
    code,
    message: messages[tag] ?? "",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bridgeStatus(result: ResultEnvelope): number {
  if (result._tag === "ok") {
    return 200;
  }
  switch (result.error._tag) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "unsupported":
      return 501;
    case "unavailable":
      return 503;
    default:
      return 400;
  }
}

// --- the endpoint handlers --------------------------------------------------------

/** The verified Worker bridge endpoint handler. */
export const bridgeHandler = httpAction(async (ctx, request) => {
  const authorized = await verifyServiceToken(request.headers.get("authorization"));
  if (!authorized) {
    return jsonResponse(
      401,
      errorResult(closedError("unauthenticated", "service_credential_invalid")),
    );
  }
  let envelope: unknown;
  try {
    envelope = await request.json();
  } catch {
    return jsonResponse(400, errorResult(closedError("validation", "bridge_body_not_json")));
  }
  const session: unknown = await ctx.runQuery(api.platform.probe.serviceSession, {});
  if (!isRecord(session) || typeof session.sessionId !== "string") {
    return jsonResponse(403, errorResult(closedError("forbidden", "service_identity_unavailable")));
  }
  const result = await dispatchBridgeCommand(
    { action: ctx, serviceSessionId: session.sessionId },
    envelope,
  );
  return jsonResponse(bridgeStatus(result), result);
});

/** The external echo stand-in endpoint handler (see module docs). */
export const echoHandler = httpAction(async (ctx, request) => {
  if (process.env.KIERO_PROBE_ENABLED !== "1") {
    return jsonResponse(404, errorResult(closedError("unsupported", "probe_guard_disabled")));
  }
  let body: { dedupKey?: unknown; serviceName?: unknown; message?: unknown; behavior?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, { status: "rejected", reason: "body_not_json" });
  }
  const dedupKey = typeof body.dedupKey === "string" ? body.dedupKey : "";
  const serviceName = typeof body.serviceName === "string" ? body.serviceName : "unknown";
  const message = typeof body.message === "string" ? body.message.slice(0, 2000) : "";
  if (dedupKey.length === 0) {
    return jsonResponse(400, { status: "rejected", reason: "dedup_key_missing" });
  }
  // The external effect happens HERE, before any response can be lost.
  await ctx.runMutation(internal.platform.http.recordEchoEffect, {
    dedupKey,
    serviceName,
    payload: message,
  });
  // The misbehavior is a property of the TARGET (external system), selected
  // through the configured echo URL's query string (?behavior=slow|crash).
  const urlBehavior = new URL(request.url).searchParams.get("behavior");
  const behavior = urlBehavior ?? (typeof body.behavior === "string" ? body.behavior : "ok");
  if (behavior === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  if (behavior === "crash") {
    return jsonResponse(502, { status: "recorded_but_failed", crash: true });
  }
  return jsonResponse(200, { status: "recorded" });
});

/** The public health endpoint handler. */
export const healthHandler = httpAction(async (ctx) => {
  const snapshot = await ctx.runQuery(internal.platform.health.snapshot, {});
  return jsonResponse(
    200,
    okResult({ ...snapshot, deployment: process.env.KIERO_DEPLOYMENT_LABEL ?? "" }),
  );
});

/** One recorded external effect (the echo endpoint's write path). */
export const recordEchoEffect = internalMutation({
  args: { dedupKey: v.string(), serviceName: v.string(), payload: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("externalEffects", {
      dedupKey: args.dedupKey,
      serviceName: args.serviceName,
      payload: args.payload,
      receivedAtMs: Date.now(),
    });
  },
});