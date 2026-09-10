/**
 * The Convex images-channel bridge client (D5): how the Worker's images
 * executor routes reach the normalization ledger.
 *
 * No transport of its own: every call goes through the ONE gateway bridge
 * transport (`postBridge` in `../platform/bridge.ts`) with this channel's
 * own endpoint (`/processing/images/bridge`, registered by convex/http.ts)
 * and the WORKER's service credential — this channel acts as the platform,
 * because its whole authority scope is the durable job the Convex side
 * re-derives from the `jobKey` (there is no user identity on this path).
 * Closed backend errors pass through unchanged and sanitized.
 */

import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { unavailableError } from "@kiero/runtime";
import type { BridgeEnv } from "../platform/bridge";
import { postBridge } from "../platform/bridge";
import type { ImageStepName } from "../../../../convex/processing/images/protocol";

/** Runs one images-channel step against the normalization ledger. */
export async function imagesStep(
  env: BridgeEnv,
  step: ImageStepName,
  jobKey: string,
  input?: Record<string, unknown>,
): Promise<ResultEnvelope> {
  const token = env.KIERO_SERVICE_TOKEN;
  if (token === undefined || token === "") {
    // The same closed error the platform bridge produces when the Worker's
    // credential is missing: sanitized, not silently retried.
    return errorResult(unavailableError(false, "bridge_not_configured"));
  }
  const result = await postBridge(
    env,
    "/processing/images/bridge",
    { step, jobKey, ...(input === undefined ? {} : { input }) },
    `Bearer ${token}`,
  );
  return result.ok ? result.body : result.error;
}
