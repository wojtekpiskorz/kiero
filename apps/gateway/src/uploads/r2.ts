/**
 * R2 multipart media for the uploads lane (D2): the ONLY place the gateway
 * touches the private EU media bucket.
 *
 * The Worker owns object keys and R2 part identities (architecture protocol
 * step 2): keys are minted inside the company's server-owned namespace and
 * every route re-checks access through Convex BEFORE any R2 call in the
 * same request. Parts stream straight from the request body into R2 while a
 * `DigestStream` computes the SHA-256 — there is no whole-file buffering
 * anywhere on this path (no `arrayBuffer()`/`bytes()` on upload bodies).
 *
 * Browser chunks are the client's slicing concern and media segments are
 * D6's processing units; what crosses THIS seam are R2 multipart parts.
 */

import type { BridgeEnv } from "../platform/bridge";

/** The R2 binding this lane consumes (wrangler.jsonc `MEDIA_BUCKET`, EU). */
export interface R2Env {
  readonly MEDIA_BUCKET: R2Bucket;
}

/** The env the uploads routes need overall (bridge + bucket). */
export type UploadsEnv = BridgeEnv & R2Env;

/** One recorded R2 part receipt as the session read returns it. */
export interface RecordedPart {
  readonly partNumber: number;
  readonly etag: string;
  readonly bytes: number;
  readonly sha256Hex: string;
  readonly receivedAtMs: number;
}

/** One attachment's session view (the resume handle). */
export interface AttachmentSession {
  readonly attachmentId: string;
  readonly kind: "audio" | "image";
  readonly objectKey: string;
  readonly r2UploadId?: string | undefined;
  readonly completedAtMs?: number | undefined;
  readonly r2ObjectEtag?: string | undefined;
  readonly receivedBytes?: number | undefined;
  readonly parts: RecordedPart[];
}

/**
 * The canonical object-key namespace. Mirrors
 * `objectKeyPrefix` in convex/sources/uploads/protocol.ts (the Convex side
 * is the authority and re-validates the namespace at `begin`); duplicated
 * here because the gateway bundle must not import Convex runtime code.
 */
export function objectKeyPrefix(companyId: string): string {
  return `companies/${companyId}/uploads/`;
}

/** Mints one server-owned object key inside the tenant's namespace. */
export function mintObjectKey(companyId: string, uploadId: string, index: number): string {
  return `${objectKeyPrefix(companyId)}${uploadId}/${index}-${crypto.randomUUID()}`;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Creates the R2 multipart sessions for one upload declaration: one session
 * per declared media kind, each under a freshly minted server-owned key.
 */
export async function createMultipartSessions(
  bucket: R2Bucket,
  companyId: string,
  uploadId: string,
  kinds: readonly ("audio" | "image")[],
): Promise<{ objectKey: string; r2UploadId: string; kind: "audio" | "image" }[]> {
  const sessions: { objectKey: string; r2UploadId: string; kind: "audio" | "image" }[] = [];
  for (const [index, kind] of kinds.entries()) {
    const objectKey = mintObjectKey(companyId, uploadId, index);
    const mpu = await bucket.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: kind === "audio" ? "audio/webm" : "image/jpeg" },
    });
    sessions.push({ objectKey, r2UploadId: mpu.uploadId, kind });
  }
  return sessions;
}

/**
 * Streams ONE part into the resumed R2 multipart upload while hashing the
 * same bytes: the request body is `tee()`d — one branch flows into R2, the
 * other into a SHA-256 `DigestStream` — so memory stays bounded regardless
 * of part size. Returns the R2 part etag, the exact byte count and the
 * lower-case hex digest the ledger records.
 */
export async function streamPartToR2(
  bucket: R2Bucket,
  objectKey: string,
  r2UploadId: string,
  partNumber: number,
  body: ReadableStream,
): Promise<{ etag: string; bytes: number; sha256Hex: string }> {
  const multipart = bucket.resumeMultipartUpload(objectKey, r2UploadId);
  const [toR2, toHash] = body.tee();
  const digestStream = new crypto.DigestStream("SHA-256");
  const digest = digestStream.digest;
  const [uploaded] = await Promise.all([
    multipart.uploadPart(partNumber, toR2),
    toHash.pipeTo(digestStream),
  ]);
  return {
    etag: uploaded.etag,
    bytes: Number(digestStream.bytesWritten),
    sha256Hex: hex(await digest),
  };
}

/**
 * Completes one attachment's multipart upload from the LEDGER's recorded
 * parts (ascending part numbers, the etags R2 actually issued) and verifies
 * the resulting object readable through an immediate head.
 */
export async function completeAndVerify(
  bucket: R2Bucket,
  objectKey: string,
  r2UploadId: string,
  parts: readonly RecordedPart[],
): Promise<{ ok: true; objectEtag: string; totalBytes: number } | { ok: false; reason: "no_parts" | "not_readable" }> {
  if (parts.length === 0) {
    return { ok: false, reason: "no_parts" };
  }
  const multipart = bucket.resumeMultipartUpload(objectKey, r2UploadId);
  const object = await multipart.complete(
    parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
  );
  const head = await bucket.head(objectKey);
  if (head === null || head.size !== object.size) {
    return { ok: false, reason: "not_readable" };
  }
  return { ok: true, objectEtag: object.etag, totalBytes: object.size };
}

/**
 * Collects one reconciled upload's objects from R2: aborts the multipart
 * session (incomplete bytes) and deletes the object key (completed bytes).
 * Both operations are idempotent; an abort of an already-completed or
 * already-aborted session is swallowed because the ledger decision (never
 * taken for accepted uploads) is the authority and a crashed pass retries.
 */
export async function collectObjects(
  bucket: R2Bucket,
  attachments: readonly { objectKey: string; r2UploadId?: string | undefined }[],
): Promise<{ aborted: string[]; deleted: string[] }> {
  const aborted: string[] = [];
  const deleted: string[] = [];
  for (const attachment of attachments) {
    if (attachment.r2UploadId !== undefined) {
      try {
        await bucket.resumeMultipartUpload(attachment.objectKey, attachment.r2UploadId).abort();
        aborted.push(attachment.objectKey);
      } catch {
        // Already completed or aborted: the delete below is the collector.
      }
    }
    await bucket.delete(attachment.objectKey);
    deleted.push(attachment.objectKey);
  }
  return { aborted, deleted };
}
