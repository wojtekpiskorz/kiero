/**
 * The Convex uploads-channel bridge client (D2): how the Worker's upload
 * routes reach the upload ledger AS THE END USER.
 *
 * No transport of its own: every call goes through the ONE gateway bridge
 * transport (`postBridge` in `../platform/bridge.ts`) with this channel's
 * own endpoints (`/sources/uploads/bridge` and `/sources/uploads/state`,
 * registered by `convex/http.ts`) and the BROWSER's Authorization header
 * forwarded verbatim — Convex verifies the user's credential, B1's
 * live-session resolution and A3's canonical chain decide the acting user,
 * and the ledger rows stay owned by that user. The Worker's service
 * credential is never substituted on this channel; closed backend errors
 * pass through unchanged and sanitized.
 */

import type { ResultEnvelope } from "@kiero/contracts";
import type { BridgeEnv } from "../platform/bridge";
import { postBridge } from "../platform/bridge";

/** One gateway protocol step to run against the ledger. */
export interface UploadsStepCall {
  readonly step: "prepare" | "begin" | "part" | "complete" | "finalize" | "reconcile";
  readonly input: unknown;
}

/** Runs one uploads protocol step as the credentialed user. */
export async function uploadsStep(
  env: BridgeEnv,
  call: UploadsStepCall,
  authorization: string,
): Promise<ResultEnvelope> {
  const result = await postBridge(
    env,
    "/sources/uploads/bridge",
    {
      step: call.step,
      input: call.input,
    },
    authorization,
  );
  return result.ok ? result.body : result.error;
}

/** Reads one tenant-scoped upload session as the credentialed user. */
export async function uploadsState(
  env: BridgeEnv,
  uploadId: string,
  authorization: string,
): Promise<ResultEnvelope> {
  const result = await postBridge(env, "/sources/uploads/state", { uploadId }, authorization);
  return result.ok ? result.body : result.error;
}
