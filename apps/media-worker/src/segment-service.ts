/**
 * The media executor's segment protocol (D6): bounded, honest, closed.
 *
 * TWO operations over retained object bytes, both answered as JSON:
 *
 * - `probe`  {objectKey}            -> {format, durationMs, sampleRate?}
 * - `segment` {objectKey, startMs, endMs}
 *        -> {format: "wav", audioBase64, durationMs}
 *
 * The byte source is INJECTED (`readObject`): the EU container supplies the
 * S3-credential R2 reader (./s3r2.ts); local/self-test callers may supply a
 * directory reader. The service itself never sees a credential, never
 * touches a bucket other than the configured media bucket, and answers
 * every refusal with a closed code — no stack, no key material, no raw
 * payloads in responses or logs.
 *
 * Non-WAV retained audio is refused with `format_requires_container`: PCM
 * WAV slicing is exact; other containers need FFmpeg conversion inside the
 * container, which is this app's reason to exist as a Container. Until that
 * runtime deploys, the refusal is the honest answer (Kiero records a
 * pending transcript, never a fabricated conversion).
 */

import {
  bytesToBase64,
  parseWav,
  sliceWav,
  wavDurationMs,
  type MeasuredAudioFormat,
} from "./wav.ts";

/** Reads (a window of) one object; null when the object does not exist. */
export type ObjectReader = (
  objectKey: string,
  range?: { start: number; end: number },
) => Promise<Uint8Array | null>;

/** One protocol request (already JSON-parsed at the HTTP boundary). */
export type SegmentRequest =
  | { op: "probe"; objectKey: string }
  | { op: "segment"; objectKey: string; startMs: number; endMs: number };

/** Every protocol response; refusals carry a closed code only. */
export type SegmentResponse =
  | { ok: true; format: MeasuredAudioFormat; durationMs: number; sampleRate?: number }
  | { ok: true; format: "wav"; audioBase64: string; durationMs: number }
  | { ok: false; code: SegmentRefusal };

export type SegmentRefusal =
  | "malformed_request"
  | "object_not_found"
  | "object_read_failed"
  | "format_requires_container"
  | "interval_out_of_range";

/** The window the header walk needs (fmt+data chunk headers live here). */
const HEAD_WINDOW_BYTES = 8_192;

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
    const whole = await readObject(value.objectKey);
    if (whole === null) {
      return { ok: false, code: "object_not_found" };
    }
    const sliced = sliceWav(whole, value.startMs, value.endMs);
    if (!sliced.ok) {
      return {
        ok: false,
        code:
          sliced.code === "interval_out_of_range"
            ? "interval_out_of_range"
            : "format_requires_container",
      };
    }
    return {
      ok: true,
      format: "wav",
      audioBase64: bytesToBase64(sliced.bytes),
      durationMs: sliced.durationMs,
    };
  }
  return { ok: false, code: "malformed_request" };
}
