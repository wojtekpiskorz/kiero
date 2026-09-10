/**
 * R2 object helpers for the images lane (D5): the ONLY place this lane
 * reads received bytes, writes retained/thumbnail objects and deletes
 * verified-away received originals in the private EU media bucket.
 *
 * Reads hash while collecting (one pass), writes are plain puts under the
 * lane's server-owned retained namespace (convex/processing/images/
 * protocol.ts key builders), and every deletion happens only after the
 * Convex verify step returned the cleanup decision.
 */

/** The R2 binding this lane consumes (wrangler.jsonc `MEDIA_BUCKET`, EU). */
export interface ImagesR2Env {
  readonly MEDIA_BUCKET: R2Bucket;
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/** Reads the first `length` bytes (magic-prefix sniffing without full reads). */
export async function readHead(
  bucket: R2Bucket,
  objectKey: string,
  length: number,
): Promise<Uint8Array | null> {
  const object = await bucket.get(objectKey, { range: { offset: 0, length } });
  if (object === null) {
    return null;
  }
  return new Uint8Array(await object.arrayBuffer());
}

/** Reads the whole object and returns its bytes plus the SHA-256 digest. */
export async function readAll(
  bucket: R2Bucket,
  objectKey: string,
): Promise<{ bytes: Uint8Array; sha256Hex: string } | null> {
  const object = await bucket.get(objectKey);
  if (object === null) {
    return null;
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  return { bytes, sha256Hex: await sha256Hex(bytes) };
}

/** Writes one representation object with its content type. */
export async function putObject(
  bucket: R2Bucket,
  objectKey: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ etag: string; size: number }> {
  const put = await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType },
  });
  return { etag: put.etag, size: Number(put.size) };
}

/**
 * Durability evidence of one written object: the head must exist with the
 * written size, and a re-read must return the same bytes (hash equality) —
 * the object is durable AND readable before verify is asked to stamp it.
 */
export async function verifyObject(
  bucket: R2Bucket,
  objectKey: string,
  expectedSha256Hex: string,
  expectedBytes: number,
): Promise<
  | { ok: true; evidence: { objectKey: string; contentHash: string; bytes: number } }
  | { ok: false; reason: "missing" | "size_mismatch" | "hash_mismatch" }
> {
  const head = await bucket.head(objectKey);
  if (head === null) {
    return { ok: false, reason: "missing" };
  }
  if (Number(head.size) !== expectedBytes) {
    return { ok: false, reason: "size_mismatch" };
  }
  const reread = await readAll(bucket, objectKey);
  if (reread === null) {
    return { ok: false, reason: "missing" };
  }
  if (reread.sha256Hex !== expectedSha256Hex) {
    return { ok: false, reason: "hash_mismatch" };
  }
  return {
    ok: true,
    evidence: { objectKey, contentHash: reread.sha256Hex, bytes: reread.bytes.length },
  };
}

/** Deletes one object (idempotent at R2). */
export async function deleteObject(bucket: R2Bucket, objectKey: string): Promise<void> {
  await bucket.delete(objectKey);
}

/** True when the object is absent (post-cleanup confirmation). */
export async function objectAbsent(bucket: R2Bucket, objectKey: string): Promise<boolean> {
  return (await bucket.head(objectKey)) === null;
}

export { sha256Hex };
