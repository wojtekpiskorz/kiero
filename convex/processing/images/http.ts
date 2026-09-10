/**
 * The images channel HTTP boundary (D5): the gateway executor's verified
 * recording entry.
 *
 * `/processing/images/bridge` (POST) carries the WORKER's service credential:
 * the bearer value is verified against the deployment's
 * `KIERO_SERVICE_TOKEN` variable through the ONE digest-compare definition
 * (operations/telemetry/serviceToken.ts, the platform bridge's check). The
 * body is one images step envelope `{step, jobKey, input}`; the step
 * resolves to its internal mutation, and EVERY transaction re-derives its
 * whole authority from the durable job row (never from the request). A
 * missing credential fails sanitized 401 before any dispatch; malformed
 * bodies fail with closed `validation` errors; no internal detail crosses
 * the boundary.
 *
 * Routes register in `convex/http.ts` through the composition append
 * pattern (imports only).
 */

import { httpAction, type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { Schema } from "effect";
import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { envelopeHttpStatus, unauthenticatedError, validationError } from "@kiero/runtime";
import { verifyServiceBearerToken } from "../../operations/telemetry/serviceToken";
import { ImagesStepEnvelope } from "./protocol";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function decodeEnvelope(
  request: Request,
): Promise<
  | { ok: true; envelope: Schema.Schema.Type<typeof ImagesStepEnvelope> }
  | { ok: false; response: Response }
> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: jsonResponse(400, errorResult(validationError("images_body_not_json"))) };
  }
  try {
    return { ok: true, envelope: Schema.decodeUnknownSync(ImagesStepEnvelope)(body) };
  } catch {
    return { ok: false, response: jsonResponse(400, errorResult(validationError("images_envelope_invalid"))) };
  }
}

/** The verified images channel endpoint for one protocol step. */
export const imagesBridgeHandler = httpAction(async (ctx: ActionCtx, request) => {
  const authorized = await verifyServiceBearerToken(
    request.headers.get("authorization"),
    process.env.KIERO_SERVICE_TOKEN,
  );
  if (!authorized) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
  }
  const decoded = await decodeEnvelope(request);
  if (!decoded.ok) {
    return decoded.response;
  }
  const { step, jobKey, input } = decoded.envelope;
  const inputRecord = isRecord(input) ? input : {};
  let result: ResultEnvelope = errorResult(validationError("images_step_unknown"));
  switch (step) {
    case "prepare":
      result = await ctx.runMutation(internal.processing.images.commands.prepareStep, { jobKey });
      break;
    case "record":
      result = await ctx.runMutation(internal.processing.images.commands.recordStep, {
        jobKey,
        attachmentId: String(inputRecord.attachmentId ?? ""),
        outcome: inputRecord.outcome,
      });
      break;
    case "verify":
      result = await ctx.runMutation(internal.processing.images.commands.verifyStep, {
        jobKey,
        attachmentId: String(inputRecord.attachmentId ?? ""),
        retained: inputRecord.retained,
        thumbnail: inputRecord.thumbnail,
      });
      break;
    case "cleanup":
      result = await ctx.runMutation(internal.processing.images.commands.cleanupStep, {
        jobKey,
        attachmentId: String(inputRecord.attachmentId ?? ""),
      });
      break;
    case "reconcile":
      result = await ctx.runMutation(internal.processing.images.commands.reconcileStep, { jobKey });
      break;
  }
  return jsonResponse(envelopeHttpStatus(result), result);
});
