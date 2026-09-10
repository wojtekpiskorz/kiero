/**
 * Segment byte resolution for the STT workflow actions (D6).
 *
 * The workflow owner (Convex) never holds bucket credentials. Segments
 * resolve through exactly two channels, both recorded on the order row:
 *
 * - `media_worker` (production): the EU media executor's guarded segment
 *   protocol (`POST /segment`) over the S3-credential R2 reader. Missing
 *   configuration or an unreachable executor is a TYPED refusal — the
 *   transcript stays pending/partial, never a fabricated slice.
 * - `proof_inline` (guarded dev proofs only): the proof script supplies the
 *   SAME bytes it uploaded through the real D2 chain; the stash is
 *   length- and sha-256-pinned at order time, so the channel can only
 *   replay bytes that are durably in R2, and rows carry the channel
 *   honestly. It exists because the container runtime and the media S3
 *   token are BLOCKED owner actions (see the D6 evidence), and the durable
 *   flow itself is the deliverable.
 *
 * Slicing arithmetic is the ONE shared authority (`@kiero/media-worker/wav`):
 * the same pure module the media executor serves, so proof-channel bytes can
 * never disagree with production slices for the same interval.
 */

import { base64ToBytes, bytesToBase64, parseWav, sliceWav, wavDurationMs } from "@kiero/media-worker/wav";
import { sha256HexOfBytes } from "./segmentation";

/** Typed refusal codes of byte resolution (closed vocabulary). */
export type SegmentBytesRefusal =
  | "media_worker_not_configured"
  | "media_worker_unreachable"
  | "media_worker_refused"
  | "media_worker_malformed_response"
  | "proof_stash_missing"
  | "proof_stash_corrupt"
  | "wav_slice_refused";

export type SegmentBytesResult =
  | { readonly ok: true; readonly audioBase64: string; readonly durationMs: number }
  | { readonly ok: false; readonly code: SegmentBytesRefusal };

/** The request shape the media executor's `/segment` endpoint expects. */
interface SegmentCall {
  readonly objectKey: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** Resolves one segment through the deployed media executor, if configured. */
export async function segmentFromMediaWorker(call: SegmentCall): Promise<SegmentBytesResult> {
  const base = process.env.KIERO_MEDIA_WORKER_URL;
  const token = process.env.KIERO_MEDIA_WORKER_TOKEN;
  if (base === undefined || base === "" || token === undefined || token === "") {
    return { ok: false, code: "media_worker_not_configured" };
  }
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}/segment`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        op: "segment",
        objectKey: call.objectKey,
        startMs: call.startMs,
        endMs: call.endMs,
      }),
    });
  } catch {
    return { ok: false, code: "media_worker_unreachable" };
  }
  if (response.status === 401 || response.status === 404 || response.status === 422 || response.status === 503) {
    return { ok: false, code: "media_worker_refused" };
  }
  if (!response.ok) {
    return { ok: false, code: "media_worker_unreachable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "media_worker_malformed_response" };
  }
  if (
    typeof body !== "object" || body === null ||
    typeof (body as { audioBase64?: unknown }).audioBase64 !== "string" ||
    typeof (body as { durationMs?: unknown }).durationMs !== "number"
  ) {
    return { ok: false, code: "media_worker_malformed_response" };
  }
  return {
    ok: true,
    audioBase64: (body as { audioBase64: string }).audioBase64,
    durationMs: (body as { durationMs: number }).durationMs,
  };
}

/** Measures a whole retained object through the media executor (`/probe`). */
export async function probeFromMediaWorker(
  objectKey: string,
): Promise<
  | { ok: true; format: "wav"; durationMs: number }
  | { ok: false; code: SegmentBytesRefusal }
> {
  const base = process.env.KIERO_MEDIA_WORKER_URL;
  const token = process.env.KIERO_MEDIA_WORKER_TOKEN;
  if (base === undefined || base === "" || token === undefined || token === "") {
    return { ok: false, code: "media_worker_not_configured" };
  }
  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, "")}/probe`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "probe", objectKey }),
    });
  } catch {
    return { ok: false, code: "media_worker_unreachable" };
  }
  if (!response.ok) {
    return { ok: false, code: "media_worker_refused" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "media_worker_malformed_response" };
  }
  if (
    typeof body !== "object" || body === null ||
    (body as { format?: unknown }).format !== "wav" ||
    typeof (body as { durationMs?: unknown }).durationMs !== "number"
  ) {
    return { ok: false, code: "media_worker_malformed_response" };
  }
  return { ok: true, format: "wav", durationMs: (body as { durationMs: number }).durationMs };
}

/**
 * Slices one interval out of the order's pinned proof stash. The stash was
 * verified against the uploaded object's byte length at order time; here it
 * only re-parses (corruption refuses) and slices with the shared authority.
 */
export function segmentFromProofStash(
  proofAudioBase64: string,
  call: SegmentCall,
): SegmentBytesResult {
  const bytes = base64ToBytes(proofAudioBase64);
  const sliced = sliceWav(bytes, call.startMs, call.endMs);
  if (!sliced.ok) {
    return { ok: false, code: "wav_slice_refused" };
  }
  return { ok: true, audioBase64: bytesToBase64(sliced.bytes), durationMs: sliced.durationMs };
}

/** Parses, measures and pins the proof stash (the manifest planning path). */
export async function measureProofStash(
  proofAudioBase64: string,
): Promise<
  { ok: true; durationMs: number; sha256Hex: string } | { ok: false; code: SegmentBytesRefusal }
> {
  const bytes = base64ToBytes(proofAudioBase64);
  const parsed = parseWav(bytes);
  if (!parsed.ok) {
    return { ok: false, code: "proof_stash_corrupt" };
  }
  return {
    ok: true,
    durationMs: wavDurationMs(parsed.header),
    sha256Hex: await sha256HexOfBytes(bytes),
  };
}
