/**
 * The export lane's HTTP boundaries (I3), registered by convex/http.ts
 * through the composition append pattern (imports only).
 *
 * `/operations/exports/access` (POST): the per-user download channel,
 * exactly the D3 media-access shape — the browser sends its Convex Auth
 * credential, the gateway forwards it verbatim, Convex resolves the acting
 * person through B1's live-session chain, and the CURRENT-administrator
 * check plus the lifecycle gate decide BEFORE any R2 byte. A missing
 * credential fails sanitized 401 before any dispatch.
 *
 * `/operations/exports/bridge` (POST): the service-credentialed build
 * channel the export Worker calls (snapshot, publish, fail, cleanupDone).
 * The bearer is verified against the deployment's KIERO_SERVICE_TOKEN
 * (digest compare; the ONE credential-check home in
 * operations/telemetry/serviceToken.ts), the op name is validated against
 * the closed channel vocabulary, and every op fails with a sanitized
 * closed error — never an internal detail. The service identity can start
 * NO boss operation: it only completes work the admin already requested.
 */

import { Schema } from "effect";
import { httpAction, type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { envelopeHttpStatus, unauthenticatedError, validationError } from "@kiero/runtime";
import { verifyServiceBearerToken } from "../telemetry/serviceToken";
import { BuildChannelOp } from "./channel";
import { ExportAccessInput } from "./channel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respond(result: ResultEnvelope): Response {
  return jsonResponse(envelopeHttpStatus(result), result);
}

/** The forwarded user credential; Convex verifies it, this boundary only requires it. */
function requireAuthorization(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  return authorization === null || authorization === "" ? null : authorization;
}

// ---------------------------------------------------------------------------
// The per-user download channel.
// ---------------------------------------------------------------------------

export const exportAccessHandler = httpAction(async (ctx: ActionCtx, request: Request) => {
  const authorization = requireAuthorization(request);
  if (authorization === null) {
    return jsonResponse(401, errorResult(unauthenticatedError("client_credential_missing")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, errorResult(validationError("export_access_body_not_json")));
  }
  const decoded = Schema.decodeUnknownOption(ExportAccessInput)(isRecord(body) ? body : null);
  if (decoded._tag === "None") {
    return jsonResponse(400, errorResult(validationError("export_reference_malformed")));
  }
  // A mutation (not a query): the resolution may lazily mark a row whose
  // linked source was purged, so the status list says why the download
  // refused; the refusal itself already happened inside the transaction.
  const result: ResultEnvelope = await ctx.runMutation(
    internal.operations["exports"].functions.exportAccessFor,
    { exportId: decoded.value.exportId },
  );
  return respond(result);
});

// ---------------------------------------------------------------------------
// The service-credentialed build channel.
// ---------------------------------------------------------------------------

async function verifyServiceToken(authorizationHeader: string | null): Promise<boolean> {
  return verifyServiceBearerToken(authorizationHeader, process.env.KIERO_SERVICE_TOKEN);
}

export const exportsBridgeHandler = httpAction(async (ctx: ActionCtx, request: Request) => {
  const authorized = await verifyServiceToken(request.headers.get("authorization"));
  if (!authorized) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, errorResult(validationError("bridge_body_not_json")));
  }
  if (!isRecord(body)) {
    return jsonResponse(400, errorResult(validationError("bridge_body_not_record")));
  }
  const op = Schema.decodeUnknownOption(BuildChannelOp)(body.op);
  if (op._tag === "None") {
    return jsonResponse(400, errorResult(validationError("bridge_op_unknown")));
  }
  const { op: _, ...input } = body;
  const functions = internal.operations["exports"].functions;
  switch (op.value) {
    case "snapshot":
      return respond(
        await ctx.runQuery(functions.snapshotForBuild, {
          exportId: String(input.exportId ?? ""),
          buildToken: String(input.buildToken ?? ""),
        }),
      );
    case "publish":
      return respond(
        await ctx.runMutation(functions.publishForBuild, {
          exportId: String(input.exportId ?? ""),
          buildToken: String(input.buildToken ?? ""),
          objectKey: String(input.objectKey ?? ""),
          etag: String(input.etag ?? ""),
          bytes: Number(input.bytes ?? 0),
          snapshotAtMs: Number(input.snapshotAtMs ?? 0),
          schemaVersion: String(input.schemaVersion ?? ""),
          sourceIds: Array.isArray(input.sourceIds) ? input.sourceIds.map(String) : [],
          mediaCount: Number(input.mediaCount ?? 0),
        }),
      );
    case "fail":
      return respond(
        await ctx.runMutation(functions.failForBuild, {
          exportId: String(input.exportId ?? ""),
          buildToken: String(input.buildToken ?? ""),
          failureKind: String(input.failureKind ?? "build_failed"),
        }),
      );
    case "cleanupDone":
      await ctx.runMutation(functions.cleanupDone, { exportId: String(input.exportId ?? "") });
      return jsonResponse(200, { _tag: "ok", value: { cleaned: true } });
  }
});
