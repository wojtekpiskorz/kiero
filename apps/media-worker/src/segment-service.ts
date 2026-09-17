/**
 * The media executor's segment protocol (D6): bounded, honest, closed — and
 * the ONE HTTP boundary implementation shared by the Cloudflare Worker entry
 * (./index.ts), the EU container's Node server (./container-main.ts) and the
 * container's Durable Object proxy, so the three surfaces cannot drift.
 *
 * THREE operations over retained object bytes, all answered as JSON:
 *
 * - `probe`  {objectKey}            -> {format, durationMs, sampleRate?}
 * - `segment` {objectKey, startMs, endMs}
 *        -> {format: "wav", audioBase64, durationMs}
 * - `image`  {objectKey}            -> {format: "image", imageBase64, mimeType, bytes}
 *
 * Byte discipline (the review-round-1 structural fix): NOTHING reads whole
 * objects unbounded. `probe` parses headers from an 8 KiB window; `segment`
 * computes the frame-aligned byte window for the asked interval and issues
 * exactly ONE ranged read of that window — a 10-hour recording is segmented
 * with two bounded reads per segment, never a gigabyte in an isolate.
 * `image` (E4's vision byte channel, R22) reads ONE capped window: the
 * vision adapter takes inline png/jpeg/webp of retained-representation
 * size, anything beyond the cap answers `object_too_large` instead of
 * entering the isolate (see MAX_IMAGE_BYTES for the retained-original
 * exception), and non-image bytes answer `format_unsupported` after a
 * magic-byte sniff — never a served guess.
 *
 * The byte source is INJECTED (`readObject`, inclusive HTTP-style ranges):
 * the S3-credential R2 reader (./s3r2.ts) in production, in-memory readers
 * in tests. The service itself never sees a credential, never touches a
 * bucket other than the configured media bucket, and answers every refusal
 * with a closed code — no stack, no key material, no raw payloads.
 *
 * Non-WAV retained audio (the composer's webm/opus) is CONVERTED to PCM WAV
 * (R30, the voice byte channel) through an INJECTED converter
 * (`AudioConverter`): the FFmpeg-backed implementation (./convert.ts) runs
 * only on the container surface, where the image ships the binary — every
 * other surface keeps the honest `format_requires_container` refusal,
 * because an isolate cannot spawn a process. The converted output is a
 * real PCM WAV, so the existing measure/slice discipline applies to it
 * UNCHANGED; every conversion breach (input cap, output duration cap,
 * wall-clock timeout) answers a typed refusal — never silent truncation.
 */

import {
  bytesToBase64,
  parseWav,
  serializeWav,
  wavDurationMs,
  wavRangeForInterval,
  type WavHeader,
} from "./wav.ts";
import { s3ObjectReader } from "./s3r2.ts";

/** Reads (a window of) one object; null when the object does not exist. */
export type ObjectReader = (
  objectKey: string,
  range?: { start: number; end: number },
) => Promise<Uint8Array | null>;

/** What one conversion call receives: the object key and the byte source. */
export interface ConversionCall {
  readonly objectKey: string;
  readonly readObject: ObjectReader;
}

/**
 * Converts one retained non-WAV audio object into ONE complete PCM WAV file
 * (16-bit), under explicit bounds owned by the implementation (input byte
 * cap, output duration cap, wall-clock timeout — see ./convert.ts). Present
 * only on surfaces that can spawn FFmpeg (the container); every breach and
 * every failure answers a closed refusal code, never a truncated guess.
 */
export type AudioConverter = (
  call: ConversionCall,
) => Promise<{ ok: true; wav: Uint8Array } | { ok: false; code: SegmentRefusal }>;

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
  | { op: "segment"; objectKey: string; startMs: number; endMs: number }
  | { op: "image"; objectKey: string };

/** The image mime types the vision adapter accepts (E2's inline set). */
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

/** Every protocol response; refusals carry a closed code only. */
export type SegmentResponse =
  | { ok: true; format: "wav"; durationMs: number; sampleRate?: number; converted?: true }
  | { ok: true; format: "wav"; audioBase64: string; durationMs: number; converted?: true }
  | { ok: true; format: "image"; imageBase64: string; mimeType: ImageMime; bytes: number }
  | { ok: false; code: SegmentRefusal };

export type SegmentRefusal =
  | "malformed_request"
  | "object_not_found"
  | "object_read_failed"
  | "format_requires_container"
  | "interval_out_of_range"
  | "object_too_large"
  | "format_unsupported"
  | "conversion_unavailable"
  | "conversion_input_too_large"
  | "conversion_output_too_large"
  | "conversion_output_too_long"
  | "conversion_timed_out"
  | "conversion_failed";

/** The window the header walk needs (fmt + data chunk headers live here). */
export const HEAD_WINDOW_BYTES = 8_192;

/**
 * The largest object the `image` op will read (inclusive window): the twin
 * of D5's `MAX_INPUT_BYTES` (convex/processing/images/protocol.ts — the
 * container build boundary blocks importing it here, so the value is
 * documented, not shared). Normalized retained representations (≤4096px
 * edge, q85) land far below it. The retained-original exception row is
 * UNBOUNDED by design (`oversized_input` keeps the original), so an
 * oversized original answers `object_too_large` and the vision order pends
 * honestly on `image_read_channel_refused:413` — the accepted partial
 * state: no OCR, while the photo itself stays viewable through the secure
 * channel. The cap keeps any mis-retained or hostile object from entering
 * the isolate as a base64 payload.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Sniffs the three supported image signatures (null when none match). */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * The resolved audio of one object: either the retained object IS PCM WAV
 * (slice via ranged reads of the object) or it was converted (slice the
 * in-memory WAV the converter produced). Both carry the SAME parsed header,
 * so measure/slice discipline is identical for both sources.
 */
type AudioResolution =
  | { ok: true; header: WavHeader; converted: Uint8Array | null }
  | { ok: false; code: SegmentRefusal };

/**
 * Resolves one object's audio for measuring/slicing: the 8 KiB header
 * window first (the bounded read, always), then — only when the object is
 * not PCM WAV — the injected converter, when this surface has one.
 */
async function resolveAudio(
  readObject: ObjectReader,
  objectKey: string,
  converter: AudioConverter | undefined,
): Promise<AudioResolution> {
  const head = await readObject(objectKey, { start: 0, end: HEAD_WINDOW_BYTES });
  if (head === null) {
    return { ok: false, code: "object_not_found" };
  }
  const parsed = parseWav(head);
  if (parsed.ok) {
    return { ok: true, header: parsed.header, converted: null };
  }
  if (converter === undefined) {
    // No FFmpeg on this surface (the Worker/DO isolates cannot spawn): PCM
    // WAV slicing is exact; other containers stay the container's job.
    return { ok: false, code: "format_requires_container" };
  }
  const converted = await converter({ objectKey, readObject });
  if (!converted.ok) {
    return { ok: false, code: converted.code };
  }
  const reparsed = parseWav(converted.wav);
  if (!reparsed.ok) {
    // The converter's output must be real PCM WAV (its own contract); a
    // breach refuses — the service never serves a guess.
    return { ok: false, code: "conversion_failed" };
  }
  return { ok: true, header: reparsed.header, converted: converted.wav };
}

/** Serves one protocol request over the injected byte source. */
export async function serveSegmentRequest(
  readObject: ObjectReader,
  request: unknown,
  converter?: AudioConverter,
): Promise<SegmentResponse> {
  if (typeof request !== "object" || request === null) {
    return { ok: false, code: "malformed_request" };
  }
  const value = request as { op?: unknown; objectKey?: unknown; startMs?: unknown; endMs?: unknown };
  if (typeof value.objectKey !== "string" || value.objectKey.length === 0) {
    return { ok: false, code: "malformed_request" };
  }
  if (value.op === "probe") {
    const resolved = await resolveAudio(readObject, value.objectKey, converter);
    if (!resolved.ok) {
      return { ok: false, code: resolved.code };
    }
    return {
      ok: true,
      format: "wav",
      durationMs: wavDurationMs(resolved.header),
      sampleRate: resolved.header.sampleRate,
      ...(resolved.converted === null ? {} : { converted: true }),
    };
  }
  if (value.op === "image") {
    // ONE capped window (inclusive end): a full window means the object is
    // larger than the vision channel will ever serve — refuse, never read on.
    const bytes = await readObject(value.objectKey, { start: 0, end: MAX_IMAGE_BYTES });
    if (bytes === null) {
      return { ok: false, code: "object_not_found" };
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return { ok: false, code: "object_too_large" };
    }
    if (bytes.length === 0) {
      return { ok: false, code: "object_read_failed" };
    }
    const mimeType = sniffImageMime(bytes);
    if (mimeType === null) {
      return { ok: false, code: "format_unsupported" };
    }
    return { ok: true, format: "image", imageBase64: bytesToBase64(bytes), mimeType, bytes: bytes.length };
  }
  if (value.op === "segment") {
    if (typeof value.startMs !== "number" || typeof value.endMs !== "number") {
      return { ok: false, code: "malformed_request" };
    }
    // Read 1: the header window (format + data chunk location) — or, for a
    // non-WAV object, the conversion that produces the whole PCM WAV.
    const resolved = await resolveAudio(readObject, value.objectKey, converter);
    if (!resolved.ok) {
      return { ok: false, code: resolved.code };
    }
    const header = resolved.header;
    const wholeDurationMs = wavDurationMs(header);
    if (value.startMs < 0 || value.endMs <= value.startMs || value.startMs >= wholeDurationMs) {
      return { ok: false, code: "interval_out_of_range" };
    }
    const clampedEnd = Math.min(value.endMs, wholeDurationMs);
    // Read 2: exactly the frame-aligned window of the asked interval — a
    // ranged read of the retained WAV object, or the same window of the
    // in-memory converted WAV. Never an unbounded whole-object read.
    const { byteStart, byteEnd } = wavRangeForInterval(header, value.startMs, clampedEnd);
    let data: Uint8Array;
    if (resolved.converted === null) {
      const read = await readObject(value.objectKey, { start: byteStart, end: byteEnd - 1 });
      if (read === null || read.length === 0) {
        return { ok: false, code: "object_read_failed" };
      }
      data = read;
    } else {
      data = resolved.converted.subarray(byteStart, byteEnd);
    }
    return {
      ok: true,
      format: "wav",
      audioBase64: bytesToBase64(serializeWav(header, data)),
      durationMs: (data.length / header.byteRate) * 1000,
      ...(resolved.converted === null ? {} : { converted: true }),
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
  if (response.code === "object_too_large") {
    return 413;
  }
  return 422;
}

/**
 * Surface-specific dependencies of the shared boundary (R30): the container
 * server injects the FFmpeg-backed converter (the image ships the binary)
 * and states what its /healthz should report about conversion; the Worker
 * entry injects nothing (its isolates cannot spawn, so non-WAV audio keeps
 * the honest `format_requires_container` refusal there).
 */
export interface ProtocolDeps {
  readonly converter?: AudioConverter;
  /**
   * What /healthz states about this surface's conversion capability: the
   * container's startup probe reports its verified binary state; every
   * converter-less surface keeps the default. A closed pair (plus the
   * default) — a typo cannot quietly misreport health.
   */
  readonly conversionHealth?: "ffmpeg-bounded" | "ffmpeg-unavailable";
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
  deps: ProtocolDeps = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse({
      ok: true,
      environment: env.ENVIRONMENT ?? "unknown",
      bytes: "s3-credentials",
      wavSlicing: "ranged-exact",
      // Honest per surface: the container reports its verified FFmpeg
      // state; everywhere else conversion is the container's job only.
      ffmpegConversion: deps.conversionHealth ?? "container-only",
    }, 200);
  }
  if (
    request.method !== "POST" ||
    (url.pathname !== "/probe" && url.pathname !== "/segment" && url.pathname !== "/image")
  ) {
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
  const response = await serveSegmentRequest(reader.read, body, deps.converter);
  return jsonResponse(response, protocolStatus(response));
}
