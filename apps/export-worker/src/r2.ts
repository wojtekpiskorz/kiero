/**
 * Bucket plumbing for the export worker (I3): the ZIP writer's multipart
 * sink, the media read and the archive delete, ALL through the S3-compatible
 * endpoint with the media bucket token (the I1 environment contract:
 * export workers hold no R2 binding and no backup credentials; see
 * infra/bindings/media-export-workers.md).
 *
 * The sink buffers at most one 8 MiB part at a time — the archive streams,
 * nothing whole-file is ever held. `abort()` tears a failed build down so
 * no partial archive object survives (it was never publishable: the Convex
 * row does not exist).
 */

import {
  s3AbortMultipartUpload,
  s3Client,
  s3CompleteMultipartUpload,
  s3CreateMultipartUpload,
  s3DeleteObject,
  s3GetObject,
  s3UploadPart,
  type S3Config,
} from "./s3.ts";

/** The env the export routes consume (names only; secrets injected). */
export interface ExportStoreEnv {
  readonly ENVIRONMENT?: string;
  readonly R2_MEDIA_ENDPOINT?: string;
  readonly R2_MEDIA_BUCKET?: string;
  readonly R2_MEDIA_ACCESS_KEY_ID?: string;
  readonly R2_MEDIA_SECRET_ACCESS_KEY?: string;
  /** HTTPS endpoint of the Convex deployment's HTTP actions. */
  readonly CONVEX_SITE_URL?: string;
  /** Shared service credential (secret binding; never a committed value). */
  readonly KIERO_SERVICE_TOKEN?: string;
}

/** The resolved client, or the closed not-configured refusal. */
export function storeOf(env: ExportStoreEnv): { ok: true; config: S3Config } | { ok: false; code: "not_configured" } {
  return s3Client(env);
}

/** S3 multipart minimum part size (except the last). */
const PART_BYTES = 8 * 1024 * 1024;

/**
 * The ZIP writer's sink over one S3 multipart upload. `complete()` finishes
 * the upload and answers the object's etag and total size; `abort()` tears
 * a failed build down.
 */
export class MultipartSink {
  private readonly chunks: Uint8Array[] = [];
  private buffered = 0;
  private readonly parts: { partNumber: number; etag: string }[] = [];
  private uploadId: string | null = null;
  private pushed = 0;

  constructor(
    private readonly config: S3Config,
    private readonly objectKey: string,
  ) {}

  async begin(): Promise<void> {
    this.uploadId = await s3CreateMultipartUpload(this.config, this.objectKey, "application/zip");
  }

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    this.pushed += chunk.length;
  }

  private async flush(final: boolean): Promise<void> {
    if (this.uploadId === null) {
      throw new Error("multipart sink: not begun");
    }
    if (this.chunks.length === 0) {
      return;
    }
    if (!final && this.buffered < PART_BYTES) {
      return;
    }
    const body = concatBytes(this.chunks);
    this.chunks.length = 0;
    this.buffered = 0;
    const partNumber = this.parts.length + 1;
    const etag = await s3UploadPart(this.config, this.objectKey, this.uploadId, partNumber, body);
    this.parts.push({ partNumber, etag });
  }

  async complete(): Promise<{ readonly etag: string; readonly bytes: number }> {
    if (this.buffered > 0 || this.parts.length === 0) {
      await this.flush(true);
    }
    if (this.uploadId === null) {
      throw new Error("multipart sink: not begun");
    }
    const etag = await s3CompleteMultipartUpload(this.config, this.objectKey, this.uploadId, this.parts);
    return { etag, bytes: this.pushed };
  }

  async abort(): Promise<void> {
    if (this.uploadId === null) {
      return;
    }
    await s3AbortMultipartUpload(this.config, this.objectId(), this.uploadId);
  }

  private objectId(): string {
    return this.objectKey;
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Opens one media object for streaming (null when missing/unreadable). */
export async function openMediaObject(
  env: ExportStoreEnv,
  objectKey: string,
): Promise<Awaited<ReturnType<typeof s3GetObject>>> {
  const store = storeOf(env);
  if (!store.ok) {
    return null;
  }
  return await s3GetObject(store.config, objectKey);
}

/** True when the store is configured (the honest health answer). */
export function storeConfigured(env: ExportStoreEnv): boolean {
  return storeOf(env).ok;
}

/** Deletes one archive object (expiry/invalidation cleanup). */
export async function deleteArchiveObject(env: ExportStoreEnv, objectKey: string): Promise<boolean> {
  const store = storeOf(env);
  if (!store.ok) {
    return false;
  }
  return await s3DeleteObject(store.config, objectKey);
}
