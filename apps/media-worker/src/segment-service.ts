/**
 * The media executor's segment protocol (D6): bounded, honest, closed — and
 * the ONE HTTP boundary implementation shared by the Cloudflare Worker entry
 * (./index.ts), the EU container's Node server (./container-main.ts) and the
 * container's Durable Object proxy, so the three surfaces cannot drift.
 *
 * TWO operations over retained object bytes, both answered as JSON:
 *
 * - `probe`  {objectKey}            -> {format, durationMs, sampleRate?}
 * - `segment` {objectKey, startMs, endMs}
 *        -> {format: "wav", audioBase64, durationMs}
 *
 * Byte discipline (the review-round-1 structural fix): NOTHING reads whole
 * objects. `probe` parses headers from an 8 KiB window; `segment` computes
 * the frame-aligned byte window for the asked interval and issues exactly
 * ONE ranged read of that window — a 10-hour recording is segmented with
 * two bounded reads per segment, never a gigabyte in an isolate.
 *
 * The byte source is INJECTED (`readObject`, inclusive HTTP-style ranges):
 * the S3-credential R2 reader (./s3r2.ts) in production, in-memory readers
 * in tests. The service itself never sees a credential, never touches a
 * bucket other than the configured media bucket, and answers every refusal
 * with a closed code — no stack, no key material, no raw payloads.
 *
 * Non-WAV retained audio is refused with `format_requires_container`: PCM
 * WAV slicing is exact; other containers need FFmpeg conversion inside the
 * container (container follow-up).
 */

import {
  bytesToBase64,
  parseWav,
  serializeWav,
  wavDurationMs,
  wavRangeForInterval,
} from "./wav.ts";
import { s3ObjectReader } from "./s3r2.ts";

/** Reads (a window of) one object; null when the object does not exist. */
export type ObjectReader = (
  objectKey: string,
  range?: { start: number; end: number },
) => Promise<Uint8Array | null>;

/** The env the deployed Worker/container receives (names only, no values). */
export interface MediaWorkerEnv {
  readonly ENVIRONMENT?: string;
  readonly R2_MEDIA_ENDPOINT?: string;
  readonly R2_MEDIA_BUCKET?: string;
  readonly MEDIA_SEGMENT_TOKEN?: string;
  readonly R2_MEDIA_ACCESS_KEY_ID?: string;
  readonly R2_MEDIA_SECRET_ACCESS_KEY?: string;
}

/** One protocol request (already JSON-parsed at the HTTP boundary). */
export type SegmentRequest =
  | { op: "probe"; objectKey: string }
  | { op: "segment"; objectKey: string; startMs: number; endMs: number };

/** Every protocol response; refusals carry a closed code only. */
export type SegmentResponse =
  | { ok: true; format: "wav"; durationMs: number; sampleRate?: number }
  | { ok: true; format: "wav"; audioBase64: string; durationMs: number }
  | { ok: false; code: SegmentRefusal };

export type SegmentRefusal =
  | "malformed_request"
  | "object_not_found"
  | "object_read_failed"
  | "format_requires_container"
  | "interval_out_of_range";

/** The window the header walk needs (fmt + data chunk headers live here). */
export const HEAD_WINDOW_BYTES = 8_192;

/** Serves one protocol request over the injected byte source. */
export async function serveSegmentRequest(
  readObject: ObjectReader,
  request: unknown,
): Promise<SegmentResponse> {
  if (typeof request !== "object" || request === null) {
    return { ok: false, code: "malformed_request" };
  }
  const value = request as { op?: unknown; objectKey?: unknown; startMs?: unknown; endMs?: unknown };
  if (typeof value.objectKey !== "string" || value.objectKey.length === 0) {
    return { ok: false, code: "malformed_request" };
  }
  if (value.op === "probe") {
    const head = await readObject(value.objectKey, { start: 0, end: HEAD_WINDOW_BYTES });
    if (head === null) {
      return { ok: false, code: "object_not_found" };
    }
    const parsed = parseWav(head);
    if (!parsed.ok) {
      // Any parse refusal over a retained object means "not PCM WAV": the
      // container's FFmpeg stage owns conversion; slicing must not guess.
      return { ok: false, code: "format_requires_container" };
    }
    return {
      ok: true,
      format: "wav",
      durationMs: wavDurationMs(parsed.header),
      sampleRate: parsed.header.sampleRate,
    };
  }
  if (value.op === "segment") {
    if (typeof value.startMs !== "number" || typeof value.endMs !== "number") {
      return { ok: false, code: "malformed_request" };
    }
    // Read 1: the header window (format + data chunk location).
    const head = await readObject(value.objectKey, { start: 0, end: HEAD_WINDOW_BYTES });
    if (head === null) {
      return { ok: false, code: "object_not_found" };
    }
    const parsed = parseWav(head);
    if (!parsed.ok) {
      return { ok: false, code: "format_requires_container" };
    }
    const header = parsed.header;
    const wholeDurationMs = wavDurationMs(header);
    if (value.startMs < 0 || value.endMs <= value.startMs || value.startMs >= wholeDurationMs) {
      return { ok: false, code: "interval_out_of_range" };
    }
    const clampedEnd = Math.min(value.endMs, wholeDurationMs);
    // Read 2: exactly the frame-aligned window of the asked interval
    // (inclusive HTTP range end). Never the whole object.
    const { byteStart, byteEnd } = wavRangeForInterval(header, value.startMs, clampedEnd);
    const data = await readObject(value.objectKey, { start: byteStart, end: byteEnd - 1 });
    if (data === null || data.length === 0) {
      return { ok: false, code: "object_read_failed" };
    }
    return {
      ok: true,
      format: "wav",
      audioBase64: bytesToBase64(serializeWav(header, data)),
      durationMs: (data.length / header.byteRate) * 1000,
    };
  }
  return { ok: false, code: "malformed_request" };
}

// --- the ONE shared HTTP boundary --------------------------------------------

/** Constant-time-ish bearer comparison (length leak is acceptable here). */
function tokenMatches(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return diff === 0;
}

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** The unified status map for protocol refusals (one table, three surfaces). */
function protocolStatus(response: SegmentResponse): number {
  if (response.ok) {
    return 200;
  }
  if (response.code === "object_not_found") {
    return 404;
  }
  return 422;
}

/**
 * The ONE protocol HTTP handler: bearer guard, S3-reader construction,
 * request decode and the unified status map. The Worker entry, the Durable
 * Object and the container server all call exactly this — there is no
 * second copy of the boundary to drift.
 */
export async function handleMediaProtocol(
  request: Request,
  env: MediaWorkerEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse({
      ok: true,
      environment: env.ENVIRONMENT ?? "unknown",
      bytes: "s3-credentials",
      wavSlicing: "ranged-exact",
      ffmpegConversion: "container-pending",
    }, 200);
  }
  if (request.method !== "POST" || (url.pathname !== "/probe" && url.pathname !== "/segment")) {
    return jsonResponse({ ok: false, code: "unknown_route" }, 404);
  }
  const expected = env.MEDIA_SEGMENT_TOKEN ?? "";
  if (expected === "") {
    return jsonResponse({ ok: false, code: "segment_token_not_configured" }, 503);
  }
  const presented = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!tokenMatches(expected, presented)) {
    return jsonResponse({ ok: false, code: "unauthorized" }, 401);
  }
  const reader = s3ObjectReader(env);
  if (!reader.ok) {
    return jsonResponse({ ok: false, code: reader.code }, 503);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const response = await serveSegmentRequest(reader.read, body);
  return jsonResponse(response, protocolStatus(response));
}
