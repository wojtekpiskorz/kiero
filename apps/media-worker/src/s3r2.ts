/**
 * Minimal SigV4 reader for the EU R2 media bucket over its S3-compatible
 * endpoint (D6), scoped to exactly two calls: HeadObject and ranged
 * GetObject. Hand-rolled on WebCrypto so the container image needs NO added
 * dependency (the root manifest is a coordinated shared change; D6 does not
 * make one).
 *
 * Credential rules (architecture "Deployment and ownership"):
 * - ONLY the media bucket token reaches this process
 *   (R2_MEDIA_ACCESS_KEY_ID / R2_MEDIA_SECRET_ACCESS_KEY / R2_MEDIA_ENDPOINT
 *   / R2_MEDIA_BUCKET); the backup executor's credentials are never present
 *   here and no code path could use them.
 * - Values arrive as container runtime env; they are never logged, never
 *   echoed in responses, and missing credentials refuse with a closed code.
 */

import type { ObjectReader } from "./segment-service.ts";

/** The non-secret shape the S3 reader needs. */
export interface S3ReaderConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** Refusal codes surfaced to callers (closed vocabulary). */
export type S3Refusal = "not_configured" | "not_found" | "request_failed";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(key: Uint8Array | string, value: string): Promise<Uint8Array> {
  // Copy into a plain ArrayBuffer-backed view: WebCrypto's BufferSource
  // rejects SharedArrayBuffer-backed views under the strict lib types both
  // compile programs use.
  const keyBytes =
    typeof key === "string" ? encoder.encode(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

/** One signed request against the bucket's virtual-hosted endpoint. */
async function signedFetch(
  config: S3ReaderConfig,
  path: string,
  init: { method: "HEAD" | "GET"; range?: { start: number; end: number } },
): Promise<Response> {
  const url = new URL(`${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${path}`);
  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[:-]|\.\d{3}/g, "")}`; // 20260909T121314Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(""); // S3 SigV4 signs the EMPTY hash for streaming-free reads
  const host = url.host;
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (init.range !== undefined) {
    headers.range = `bytes=${init.range.start}-${init.range.end}`;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const canonicalRequest = [
    init.method,
    url.pathname,
    "", // no query string on plain object reads
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");
  // The SigV4 derivation chain (region "auto", service "s3"): each key
  // signs the next stage; the final key signs the string-to-sign.
  const kDate = await hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(url, { method: init.method, headers });
}

/**
 * Builds the container's object reader from env values. Returns a typed
 * refusal channel when the media credentials are not configured — the
 * container then answers `not_configured` instead of touching anything.
 */
export function s3ObjectReader(env: {
  R2_MEDIA_ENDPOINT?: string;
  R2_MEDIA_BUCKET?: string;
  R2_MEDIA_ACCESS_KEY_ID?: string;
  R2_MEDIA_SECRET_ACCESS_KEY?: string;
}): { ok: true; read: ObjectReader } | { ok: false; code: S3Refusal } {
  const endpoint = env.R2_MEDIA_ENDPOINT;
  const bucket = env.R2_MEDIA_BUCKET;
  const accessKeyId = env.R2_MEDIA_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_MEDIA_SECRET_ACCESS_KEY;
  if (
    endpoint === undefined || endpoint === "" ||
    bucket === undefined || bucket === "" ||
    accessKeyId === undefined || accessKeyId === "" ||
    secretAccessKey === undefined || secretAccessKey === ""
  ) {
    return { ok: false, code: "not_configured" };
  }
  const config: S3ReaderConfig = { endpoint, bucket, accessKeyId, secretAccessKey };
  return {
    ok: true,
    read: async (objectKey, range) => {
      // ONE signed request (round-2 finding c): the GET alone answers
      // 404/403 for missing/unreadable objects — a HEAD-first probe would
      // double every segment's signed-request count for no information.
      try {
        const response = await signedFetch(config, objectKey, {
          method: "GET",
          ...(range === undefined ? {} : { range }),
        });
        if (response.status !== 200 && response.status !== 206) {
          return null;
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}
