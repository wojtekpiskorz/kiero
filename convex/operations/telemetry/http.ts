/**
 * The telemetry HTTP boundary (I2).
 *
 * - `POST /platform/telemetry/ingest`: batch ingest of redacted events from
 *   gateway/worker lanes (service-token verified, like the bridge; every
 *   event still passes the single sanitizer - the boundary is not trusted).
 * - `POST /platform/telemetry/heartbeat`: the external heartbeat entry. The
 *   gateway cron trigger (or any external prober holding the service token)
 *   records liveness HERE; sink-side monitors on absent heartbeat events
 *   detect total backend silence even when Convex itself is down.
 * - `GET /platform/telemetry/health`: the composed state - platform health,
 *   heartbeat/silence, cost thresholds, retention and the honesty block.
 *
 * The bearer check mirrors the bridge's digest comparison (compared as
 * SHA-256 digests; the secret is never handled in the clear or logged).
 */

import { httpAction } from "../../_generated/server";
import { api, internal } from "../../_generated/api";
import { errorResult, okResult } from "@kiero/contracts";
import { forbiddenError, unauthenticatedError, validationError } from "@kiero/runtime";

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
  const [presentedHash, expectedHash] = await Promise.all([sha256Hex(presented), sha256Hex(expected)]);
  let equal = presentedHash.length === expectedHash.length;
  for (let index = 0; index < presentedHash.length; index += 1) {
    equal = presentedHash[index] === expectedHash[index] && equal;
  }
  return equal;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Batch event ingest from verified lanes (each event re-sanitized). */
export const ingestHandler = httpAction(async (ctx, request) => {
  const authorized = await verifyServiceToken(request.headers.get("authorization"));
  if (!authorized) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, errorResult(validationError("ingest_body_not_json")));
  }
  if (!isRecord(body) || !Array.isArray(body.events)) {
    return jsonResponse(400, errorResult(validationError("ingest_events_missing")));
  }
  if (body.events.length > 32) {
    return jsonResponse(400, errorResult(validationError("ingest_batch_too_large")));
  }
  const serviceName = typeof body.serviceName === "string" ? body.serviceName : undefined;
  const environment = typeof body.environment === "string" ? body.environment : undefined;
  const results = [];
  let accepted = 0;
  let rejected = 0;
  let redactions = 0;
  for (const event of body.events) {
    const result = await ctx.runMutation(internal.operations.telemetry.functions.recordEvent, {
      payload: event,
      ...(serviceName === undefined ? {} : { serviceName }),
      ...(environment === undefined ? {} : { environment }),
    });
    if (result.emitted) {
      accepted += 1;
      redactions += result.redactionsApplied ?? 0;
    } else {
      rejected += 1;
    }
    results.push({ emitted: result.emitted, ...(result.reason === undefined ? {} : { reason: result.reason }) });
  }
  return jsonResponse(200, okResult({ accepted, rejected, redactions, results }));
});

/** The external heartbeat entry (records the ledger row + heartbeat event). */
export const heartbeatHandler = httpAction(async (ctx, request) => {
  const authorized = await verifyServiceToken(request.headers.get("authorization"));
  if (!authorized) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, errorResult(validationError("heartbeat_body_not_json")));
  }
  if (!isRecord(body) || typeof body.serviceName !== "string") {
    return jsonResponse(400, errorResult(validationError("heartbeat_service_missing")));
  }
  const status = body.status === "degraded" ? "degraded" : "ok";
  const recorded = await ctx.runMutation(internal.operations.telemetry.functions.recordHeartbeat, {
    serviceName: body.serviceName,
    status,
  });
  if (!recorded.recorded) {
    return jsonResponse(400, errorResult(forbiddenError(recorded.reason ?? "heartbeat_rejected")));
  }
  return jsonResponse(200, okResult(recorded));
});

/** The composed health state (public, like /platform/health). */
export const telemetryHealthHandler = httpAction(async (ctx) => {
  const platform = await ctx.runQuery(api.platform.health.health, {});
  const telemetry = await ctx.runQuery(internal.operations.telemetry.functions.telemetryState, {});
  return jsonResponse(
    200,
    okResult({
      platform,
      telemetry,
      deployment: process.env.KIERO_DEPLOYMENT_LABEL ?? "",
    }),
  );
});
