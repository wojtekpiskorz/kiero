/**
 * The deletion lane's HTTP boundary (I4), registered by convex/http.ts
 * through the composition append pattern (imports only).
 *
 * `/operations/deletion/bridge` (POST): the service-credentialed purge
 * channel the gateway Worker's `/purge/media` route calls. The bearer is
 * verified against the deployment's KIERO_SERVICE_TOKEN (digest compare;
 * the ONE credential-check home in operations/telemetry/serviceToken.ts),
 * the op name is validated against this channel's closed vocabulary, and
 * every op fails with a sanitized closed error - never an internal detail.
 *
 * `targets` answers the AUTHORITATIVE R2 object key list of one deletion
 * record's media stage (content-free opaque identities; the Worker never
 * trusts a request body's key list). The service identity can start NO
 * boss operation and can never read source content: this channel hands
 * out object keys of already-tombstoned media only.
 */

import { Schema } from "effect";
import { httpAction, type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { envelopeHttpStatus, unauthenticatedError, validationError } from "@kiero/runtime";
import { verifyServiceBearerToken } from "../telemetry/serviceToken";

/** The closed op vocabulary of this channel. */
const DeletionBridgeOp = Schema.Literals(["targets"]);

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

export const deletionBridgeHandler = httpAction(async (ctx: ActionCtx, request: Request) => {
  const authorized = await verifyServiceBearerToken(
    request.headers.get("authorization"),
    process.env.KIERO_SERVICE_TOKEN,
  );
  if (!authorized) {
    return respond(errorResult(unauthenticatedError("service_credential_invalid")));
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(errorResult(validationError("bridge_body_not_json")));
  }
  if (!isRecord(body)) {
    return respond(errorResult(validationError("bridge_body_not_record")));
  }
  const op = Schema.decodeUnknownOption(DeletionBridgeOp)(body.op);
  if (op._tag === "None") {
    return respond(errorResult(validationError("bridge_op_unknown")));
  }
  const targets = await ctx.runQuery(internal.operations.deletion.functions.purgeBridgeTargets, {
    deletionRecordId: String(body.deletionRecordId ?? ""),
  });
  if (targets === null) {
    // No pending media stage for this record: nothing to delete. The
    // uniform null keeps existence and state out of the answer.
    return respond(errorResult(validationError("purge_targets_absent")));
  }
  return respond({
    _tag: "ok",
    value: { deletionRecordId: targets.deletionRecordId, objectKeys: targets.objectKeys },
  } as ResultEnvelope);
});
