/**
 * The Convex uploads-channel bridge client (D2): how the Worker's upload
 * routes reach the upload ledger.
 *
 * No transport of its own: every call goes through the ONE gateway bridge
 * transport (`postBridge` in `../platform/bridge.ts`) with this channel's
 * own endpoints (`/sources/uploads/bridge` and `/sources/uploads/state`,
 * registered by `convex/http.ts`). Every call carries the verified service
 * credential (secret binding) and lands on the canonical access check
 * inside `convex/sources/uploads/http.ts`; closed backend errors pass
 * through unchanged and sanitized.
 */

import type { ResultEnvelope } from "@kiero/contracts";
import type { BridgeEnv } from "../platform/bridge";
import { postBridge } from "../platform/bridge";

/** One gateway protocol step to run against the ledger. */
export interface UploadsStepCall {
  readonly step: "prepare" | "begin" | "part" | "complete" | "finalize" | "reconcile";
  readonly input: unknown;
}

/** Runs one uploads protocol step through the verified channel. */
export async function uploadsStep(
  env: BridgeEnv,
  call: UploadsStepCall,
): Promise<ResultEnvelope> {
  const result = await postBridge(env, "/sources/uploads/bridge", {
    step: call.step,
    input: call.input,
  });
  return result.ok ? result.body : result.error;
}

/** Reads one tenant-scoped upload session through the verified channel. */
export async function uploadsState(
  env: BridgeEnv,
  uploadId: string,
): Promise<ResultEnvelope> {
  const result = await postBridge(env, "/sources/uploads/state", { uploadId });
  return result.ok ? result.body : result.error;
}
