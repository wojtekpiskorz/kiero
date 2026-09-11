/**
 * Minimal SigV4 client for the EU R2 buckets over their S3-compatible
 * endpoints (I5), the D6 `s3r2.ts` reader pattern extended to the write
 * side this lane owns: PUT (with sha256 metadata), HEAD, GET, DELETE and
 * LIST (the orphan-cleanup listing). Hand-rolled on WebCrypto so the
 * container image needs no added dependency.
 *
 * Credential rules (infra/bindings/backup-worker.md):
 * - the BACKUP store is built from R2_BACKUP_* (the only credential that
 *   can write/read/delete backup sets);
 * - the MEDIA reader is built from R2_MEDIA_READ_* (a read-only token held
 *   only by this worker);
 * - values arrive as runtime env, are never logged or echoed, and missing
 *   credentials refuse with a closed code (typed `not_configured`, the
 *   honest-pending pattern - never a fabricated byte).
 */

import type { BackupStore, MediaReader } from "./ports.ts";
import { sha256BytesHex } from "./hash.ts";

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(key: Uint8Array | string, value: string): Promise<Uint8Array> {
  // Copy into a plain ArrayBuffer-backed view (the strict lib types reject
  // SharedArrayBuffer-backed BufferSources).
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return hex(new Uint8Array(digest));
}

export interface S3Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

type S3Refusal = "not_configured" | "not_found" | "request_failed";

/** One SigV4-signed request (PUT bodies carry their sha256 payload hash). */
async function signedFetch(
  config: S3Config,
  path: string,
  init: {
    method: "GET" | "HEAD" | "PUT" | "DELETE";
    query?: string;
    body?: Uint8Array;
    bodySha256Hex?: string;
    metadata?: Record<string, string>;
  },
): Promise<Response> {
  const url = new URL(
    `${config.endpoint.replace(/\/$/, "")}/${config.bucket}/${path}${init.query ?? ""}`,
  );
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = init.bodySha256Hex ?? (init.body === undefined ? await sha256Hex("") : await sha256BytesHex(init.body));  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (init.metadata !== undefined) {
    for (const [name, value] of Object.entries(init.metadata)) {
      headers[`x-amz-meta-${name}`] = value;
    }
  }
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name]}\n`)
    .join("");
  const canonicalRequest = [
    init.method,
    `/${config.bucket}/${path}`,
    url.search.replace(/^\?/, ""),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
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
    // The strict lib types of the two programs disagree on BodyInit; the
    // runtime accepts a plain Uint8Array in both (workerd and undici).
    ...(init.body === undefined ? {} : { body: new Uint8Array(init.body) as never }),
  });
}

function parseConfig(
  env: Record<string, string | undefined>,
  prefix: "R2_BACKUP" | "R2_MEDIA_READ",
  bucketName: string,
): { ok: true; config: S3Config } | { ok: false; code: S3Refusal } {
  const endpoint = env[`${prefix}_ENDPOINT`];
  const accessKeyId = env[`${prefix}_ACCESS_KEY_ID`];
  const secretAccessKey = env[`${prefix}_SECRET_ACCESS_KEY`];
  if (
    endpoint === undefined || endpoint === "" ||
    accessKeyId === undefined || accessKeyId === "" ||
    secretAccessKey === undefined || secretAccessKey === "" ||
    bucketName === ""
  ) {
    return { ok: false, code: "not_configured" };
  }
  return { ok: true, config: { endpoint, bucket: bucketName, accessKeyId, secretAccessKey } };
}

/**
 * The backup-bucket store (the ONLY write path of the complete sets).
 * Object sha256 values ride as x-amz-meta-sha256 so the pipeline's
 * head-first resume can skip verified objects without re-reading them.
 */
export function s3BackupStore(env: {
  R2_BACKUP_ENDPOINT?: string;
  R2_BACKUP_BUCKET?: string;
  R2_BACKUP_ACCESS_KEY_ID?: string;
  R2_BACKUP_SECRET_ACCESS_KEY?: string;
}): BackupStore | { readonly notConfigured: "store_not_configured" } {
  const resolved = parseConfig(env as Record<string, string | undefined>, "R2_BACKUP", env.R2_BACKUP_BUCKET ?? "");
  if (!resolved.ok) {
    return { notConfigured: "store_not_configured" };
  }
  const config = resolved.config;
  return {
    head: async (key) => {
      const response = await signedFetch(config, key, { method: "HEAD" });
      if (response.status !== 200) {
        // Absent (404) and unusable statuses are both "not present"; the
        // copy pass then takes the read-and-put path.
        return { ok: true as const, present: false };
      }
      const meta = response.headers.get("x-amz-meta-sha256") ?? undefined;
      const length = Number(response.headers.get("content-length") ?? "0");
      return { ok: true as const, present: true, ...(meta === undefined ? {} : { sha256Hex: meta }), ...(Number.isFinite(length) ? { bytes: length } : {}) };
    },
    put: async (key, bytes, sha256HexValue) => {
      try {
        const response = await signedFetch(config, key, {
          method: "PUT",
          body: bytes,
          bodySha256Hex: sha256HexValue,
          metadata: { sha256: sha256HexValue },
        });
        if (response.status !== 200 && response.status !== 201) {
          return { ok: false, code: "store_write_failed" as const };
        }
        return { ok: true as const };
      } catch {
        return { ok: false, code: "store_write_failed" as const };
      }
    },
    get: async (key) => {
      try {
        const response = await signedFetch(config, key, { method: "GET" });
        if (response.status !== 200 && response.status !== 206) {
          return { ok: false, code: "store_not_found" as const };
        }
        return { ok: true as const, bytes: new Uint8Array(await response.arrayBuffer()) };
      } catch {
        return { ok: false, code: "store_not_found" as const };
      }
    },
    delete: async (key) => {
      await signedFetch(config, key, { method: "DELETE" }).catch(() => null);
    },
    list: async (prefix) => {
      const objects: { key: string; bytes: number; lastModifiedMs: number }[] = [];
      let continuation: string | null = null;
      // Bounded pagination (100 pages x 1000 keys is far past the orphan
      // pass's needs; a larger pool means a louder failure, not a hang).
      // SigV4 requires the canonical query string sorted by parameter name.
      for (let page = 0; page < 100; page += 1) {
        const params: Record<string, string> = { "list-type": "2", prefix };
        if (continuation !== null) {
          params["continuation-token"] = continuation;
        }
        const query = `?${Object.keys(params)
          .sort()
          .map((name) => `${name}=${encodeURIComponent(params[name]!)}`)
          .join("&")}`;
        const response = await signedFetch(config, "", { method: "GET", query });
        if (response.status !== 200) {
          break;
        }
        const xml = await response.text();
        for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
          const key = block.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
          const size = Number(block.match(/<Size>([\s\S]*?)<\/Size>/)?.[1] ?? "0");
          const lastModified = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)?.[1];
          if (key === undefined) {
            continue;
          }
          objects.push({
            key,
            bytes: Number.isFinite(size) ? size : 0,
            lastModifiedMs: lastModified === undefined ? 0 : Date.parse(lastModified),
          });
        }
        const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        continuation = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? null;
        if (!truncated || continuation === null) {
          break;
        }
      }
      return objects;
    },
  };
}

/** The read-only media reader (R2_MEDIA_READ_* token; copy source only). */
export function s3MediaReader(env: {
  R2_MEDIA_ENDPOINT?: string;
  R2_MEDIA_BUCKET?: string;
  R2_MEDIA_READ_ACCESS_KEY_ID?: string;
  R2_MEDIA_READ_SECRET_ACCESS_KEY?: string;
}): MediaReader | { readonly notConfigured: "media_not_configured" } {
  const resolved = parseConfig(env as Record<string, string | undefined>, "R2_MEDIA_READ", env.R2_MEDIA_BUCKET ?? "");
  if (!resolved.ok) {
    return { notConfigured: "media_not_configured" };
  }
  const config = resolved.config;
  return {
    get: async (objectKey) => {
      try {
        const response = await signedFetch(config, objectKey, { method: "GET" });
        if (response.status !== 200 && response.status !== 206) {
          return { ok: false, code: "media_object_missing" as const };
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { ok: true as const, bytes, sha256Hex: await sha256BytesHex(bytes) };
      } catch {
        return { ok: false, code: "media_object_missing" as const };
      }
    },
  };
}
