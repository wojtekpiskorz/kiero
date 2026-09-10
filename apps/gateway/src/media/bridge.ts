/**
 * The Convex media-access-channel bridge client (D3): how the Worker's
 * media routes consult the CURRENT authorization decision AS THE END USER.
 *
 * No transport of its own: every call goes through the ONE gateway bridge
 * transport (`postBridge` in `../platform/bridge.ts`) with this channel's
 * own endpoint (`/sources/media/access`, registered by `convex/http.ts`)
 * and the BROWSER's Authorization header forwarded verbatim — Convex
 * verifies the user's credential, B1's live-session resolution and the
 * canonical chain decide the acting user, and the grant (object key, etag,
 * byte length, media type) is the LEDGER's recorded answer. The Worker's
 * service credential is never substituted on this channel; the access
 * check happens BEFORE any R2 read, so a dead session, a revoked
 * membership or a foreign tenant refuses the request with zero bucket
 * calls.
 */

import type { ResultEnvelope } from "@kiero/contracts";
import type { BridgeEnv } from "../platform/bridge";
import { postBridge } from "../platform/bridge";

/** One media-read access request (exactly one reference; keys never cross in). */
export interface MediaAccessCall {
  readonly attachmentId?: string | undefined;
  readonly representationId?: string | undefined;
}

/** Resolves one media-read grant as the credentialed user. */
export async function mediaAccess(
  env: BridgeEnv,
  call: MediaAccessCall,
  authorization: string,
): Promise<ResultEnvelope> {
  const result = await postBridge(env, "/sources/media/access", { ...call }, authorization);
  return result.ok ? result.body : result.error;
}
