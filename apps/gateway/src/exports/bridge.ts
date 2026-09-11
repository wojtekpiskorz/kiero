/**
 * The Convex export-access channel bridge client (I3): how the gateway's
 * download route consults the CURRENT authorization decision AS THE END
 * USER (the D3 media bridge pattern, one transport: `postBridge`).
 *
 * The browser's Convex Auth credential is forwarded verbatim; Convex
 * resolves the acting person (B1 live session -> membership -> company),
 * applies the CURRENT-administrator check (B3) and the lifecycle gate, and
 * answers the LEDGER grant (object key, etag, byte length) or the uniform
 * `not_found` that never discloses existence, expiry reason or storage
 * layout. The Worker's service credential is never substituted on this
 * channel, and the access check happens BEFORE any R2 read.
 */

import type { ResultEnvelope } from "@kiero/contracts";
import type { BridgeEnv } from "../platform/bridge";
import { postBridge } from "../platform/bridge";

/** Resolves one archive download grant as the credentialed user. */
export async function exportAccess(
  env: BridgeEnv,
  exportId: string,
  authorization: string,
): Promise<ResultEnvelope> {
  const result = await postBridge(env, "/operations/exports/access", { exportId }, authorization);
  return result.ok ? result.body : result.error;
}
