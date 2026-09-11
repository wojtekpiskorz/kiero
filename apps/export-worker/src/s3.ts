/**
 * Minimal SigV4 client for the EU R2 media bucket over its S3-compatible
 * endpoint (I3), the D6 reader pattern extended to exactly the calls the
 * bounded archive assembly needs: GetObject (streaming), CreateMultipart-
 * Upload, UploadPart, CompleteMultipartUpload, AbortMultipartUpload and
 * DeleteObject. Hand-rolled on WebCrypto so neither the Worker nor the
 * container image needs an added dependency.
 *
 * Credential rules (the D6 ruling, unchanged): ONLY the media bucket token
 * reaches this process (R2_MEDIA_ENDPOINT / R2_MEDIA_BUCKET /
 * R2_MEDIA_ACCESS_KEY_ID / R2_MEDIA_SECRET_ACCESS_KEY); backup credentials
 * are never present. Values arrive as runtime env/secrets; they are never
 * logged, echoed or serialized. Missing credentials answer the closed
 * `not_configured` refusal — never a fabricated byte.
 */

/** The non-secret shape the S3 client needs. */
export interface S3Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The env names the client reads (vars + secrets; values never logged). */
export interface S3Env {
  readonly R2_MEDIA_ENDPOINT?: string;
  readonly R2_MEDIA_BUCKET?: string;
  readonly R2_MEDIA_ACCESS_KEY_ID?: string;
  readonly R2_MEDIA_SECRET_ACCESS_KEY?: string;
}

export type S3Client =
  | { readonly ok: true; readonly config: S3Config }
  | { readonly ok: false; readonly code: "not_configured" };

/** Builds the client from env; absent credentials refuse closed. */
export function s3Client(env: S3Env): S3Client {
  const { endpoint, bucket, accessKeyId, secretAccessKey } = {
    endpoint: env.R2_MEDIA_ENDPOINT,
    bucket: env.R2_MEDIA_BUCKET,
    accessKeyId: env.R2_MEDIA_ACCESS_KEY_ID,
    secretAccessKey: env.R2_MEDIA_SECRET_ACCESS_KEY,
  };
  if (
    endpoint === undefined || endpoint === "" ||
    bucket === undefined || bucket === "" ||
    accessKeyId === undefined || accessKeyId === "" ||
    secretAccessKey === undefined || secretAccessKey === ""
  ) {
    return { ok: false, code: "not_configured" };
  }
  return { ok: true, config: { endpoint, bucket, accessKeyId, secretAccessKey } };
}

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(key: Uint8Array | string, value: string): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? encoder.encode(key) : new Uint8Array(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const copy = new Uint8Array(bytes); // plain ArrayBuffer-backed view for WebCrypto
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return hex(new Uint8Array(digest));
}

/** One signed request against the bucket's virtual-hosted endpoint. */
async function signedFetch(
  config: S3Config,
  path: string,
  init: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    query?: Record<string, string>;
    body?: Uint8Array;
    contentType?: string;
  },
): Promise<Response> {
  const base = `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${path}`;
  const url = new URL(base);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = init.body === undefined
    ? await sha256Hex("")
    : await sha256Hex(init.body);
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (init.contentType !== undefined) {
    headers["content-type"] = init.contentType;
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${headers[key]}\n`)
    .join("");
  // Canonical query must be sorted by encoded key.
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const canonicalUri = `/${config.bucket}/${path}`
    .split("/")
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join("/");
  const canonicalRequest = [
    init.method,
    canonicalUri,
    canonicalQuery,
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
  const kDate = await hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = await hmac(kDate, "auto");
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return fetch(url, {
    method: init.method,
    headers,
    ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) }),
  });
}

/** An opened media object: the stream plus its ledger-verifying identity. */
export interface OpenedObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly etag: string;
  readonly size: number;
}

/** Opens one object for streaming; null when missing or unreadable. */
export async function s3GetObject(config: S3Config, objectKey: string): Promise<OpenedObject | null> {
  const response = await signedFetch(config, objectKey, { method: "GET" });
  if (response.status !== 200 || response.body === null) {
    return null;
  }
  const etag = response.headers.get("etag")?.replace(/"/g, "") ?? "";
  const size = Number(response.headers.get("content-length") ?? "0");
  if (etag === "" || size <= 0) {
    return null;
  }
  return { body: response.body as ReadableStream<Uint8Array>, etag, size };
}

/** Starts one multipart upload; answers its upload id. */
export async function s3CreateMultipartUpload(
  config: S3Config,
  objectKey: string,
  contentType: string,
): Promise<string> {
  const response = await signedFetch(config, objectKey, {
    method: "POST",
    query: { uploads: "" },
    contentType,
  });
  if (!response.ok) {
    throw new Error(`s3 create multipart failed (${response.status})`);
  }
  const xml = await response.text();
  const id = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
  if (id === undefined) {
    throw new Error("s3 create multipart: no UploadId");
  }
  return id;
}

/** Uploads one part; answers its etag. */
export async function s3UploadPart(
  config: S3Config,
  objectKey: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<string> {
  const response = await signedFetch(config, objectKey, {
    method: "PUT",
    query: { partNumber: String(partNumber), uploadId },
    body,
  });
  if (!response.ok) {
    throw new Error(`s3 upload part failed (${response.status})`);
  }
  const etag = response.headers.get("etag")?.replace(/"/g, "") ?? "";
  if (etag === "") {
    throw new Error("s3 upload part: no etag");
  }
  return etag;
}

/** Completes the upload; answers the object's final etag. */
export async function s3CompleteMultipartUpload(
  config: S3Config,
  objectKey: string,
  uploadId: string,
  parts: readonly { partNumber: number; etag: string }[],
): Promise<string> {
  const xmlBody =
    `<CompleteMultipartUpload>${parts
      .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`)
      .join("")}</CompleteMultipartUpload>`;
  const response = await signedFetch(config, objectKey, {
    method: "POST",
    query: { uploadId },
    body: new TextEncoder().encode(xmlBody),
    contentType: "application/xml",
  });
  if (!response.ok) {
    throw new Error(`s3 complete multipart failed (${response.status})`);
  }
  const xml = await response.text();
  const etag = /<ETag>("?)([^<"]+)\1<\/ETag>/.exec(xml)?.[2];
  if (etag === undefined) {
    throw new Error("s3 complete multipart: no ETag");
  }
  return etag;
}

/** Aborts a failed upload (best-effort teardown). */
export async function s3AbortMultipartUpload(
  config: S3Config,
  objectKey: string,
  uploadId: string,
): Promise<void> {
  try {
    await signedFetch(config, objectKey, { method: "DELETE", query: { uploadId } });
  } catch {
    // The Convex row was never published; no download can reference it.
  }
}

/** Deletes one object; true when the request succeeded. */
export async function s3DeleteObject(config: S3Config, objectKey: string): Promise<boolean> {
  try {
    const response = await signedFetch(config, objectKey, { method: "DELETE" });
    return response.status === 204 || response.ok;
  } catch {
    return false;
  }
}
