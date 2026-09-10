/**
 * R2 media reads for the media lane (D3): the read half of the private EU
 * media bucket this Worker already owns (the write half is the uploads
 * lane's `../uploads/r2.ts`; the binding is the same `MEDIA_BUCKET`).
 *
 * Reads are streaming and bounded-memory by construction: `bucket.get`
 * returns an `R2ObjectBody` whose `body` is a ReadableStream piped straight
 * into the response — no `arrayBuffer()`, no buffering of the whole object,
 * for full reads and range reads alike. Authorization happens in the route
 * BEFORE any call here (the per-user Convex channel), and every served
 * object is cross-checked against the ledger grant (size AND etag), so a
 * stale or inconsistent ledger fails closed instead of serving wrong bytes
 * or wrong lengths.
 */

import type { BridgeEnv } from "../platform/bridge";

/** The R2 binding this lane consumes (wrangler.jsonc `MEDIA_BUCKET`, EU). */
export interface MediaR2Env {
  readonly MEDIA_BUCKET: R2Bucket;
}

/** The env the media routes need overall (bridge + bucket). */
export type MediaEnv = BridgeEnv & MediaR2Env;

/** A ranged R2 read: half-open [offset, offset + length). */
export interface R2RangeSpec {
  readonly offset: number;
  readonly length: number;
}

/**
 * Opens one authorized object for streaming (whole object, or one byte
 * range). Returns the R2ObjectBody, or null when the object the ledger
 * named does not exist (the caller answers the same closed not-found the
 * ledger refusals use — no storage-layout disclosure).
 */
export async function openMediaObject(
  env: MediaR2Env,
  objectKey: string,
  range?: R2RangeSpec,
): Promise<R2ObjectBody | null> {
  return await env.MEDIA_BUCKET.get(objectKey, range === undefined ? undefined : { range });
}

/**
 * The ledger-consistency verdict for one opened object against the grant:
 * the R2 object's true total size and etag must equal the ledger's recorded
 * values, or no byte is served (a sanitized unavailable; the mismatch is an
 * operations signal, never a client-facing detail).
 */
export function verifyAgainstGrant(
  object: R2ObjectBody,
  grant: { readonly bytes: number; readonly etag: string },
): boolean {
  return object.size === grant.bytes && object.etag === grant.etag;
}
