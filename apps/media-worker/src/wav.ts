/**
 * Pure WAV (RIFF/PCM) parsing, measuring and slicing (D6).
 *
 * ONE authority for the byte-level time mapping of PCM WAV audio, imported
 * by BOTH sides of the D6 seam:
 *
 * - `apps/media-worker` (this package): the media executor that serves
 *   `/probe` (duration/format) and `/segment` (ranged slices) over the
 *   retained object bytes;
 * - `convex/processing/audio` (the workflow owner): manifest planning and
 *   the guarded proof byte channel slice with the SAME arithmetic, so a
 *   segment's bytes can never disagree with its original-time anchors.
 *
 * The module is deliberately dependency-free and runtime-neutral: plain
 * `Uint8Array`/`DataView` only, so it runs unchanged inside the Cloudflare
 * Worker, the EU container (Node) and Convex actions.
 *
 * Honest scope (recorded in the D6 evidence): PCM WAV in and PCM WAV out.
 * Browser recorder containers (webm/ogg/...) need FFmpeg conversion — the
 * EU Container's job; until it deploys, non-WAV retained audio is refused
 * with a typed code, never silently mis-sliced.
 */

/** The closed vocabulary of measured audio formats this seam understands. */
export type MeasuredAudioFormat = "wav";

/** A parsed PCM WAV header (the facts slicing needs; nothing more). */
export interface WavHeader {
  readonly format: "wav";
  /** 1 = PCM. Anything else (ADPCM, float, ALAW...) is refused. */
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  /** bytes per second (sampleRate * blockAlign). */
  readonly byteRate: number;
  /** bytes per frame (channels * bitsPerSample / 8); the alignment unit. */
  readonly blockAlign: number;
  /** absolute byte offset of the data chunk payload inside the file. */
  readonly dataOffset: number;
  /** length in bytes of the data chunk payload. */
  readonly dataBytes: number;
}

/** A typed refusal; closed codes only, never raw error text. */
export type WavRefusal =
  | "not_riff"
  | "not_wav"
  | "truncated"
  | "no_fmt_chunk"
  | "no_data_chunk"
  | "unsupported_audio_format"
  | "unsupported_bit_depth";

export type WavParseResult =
  | { readonly ok: true; readonly header: WavHeader }
  | { readonly ok: false; readonly code: WavRefusal };

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return out;
}

/**
 * Parses a PCM WAV header by walking the RIFF chunk list (fmt and data may
 * appear in either order and other chunks may sit between them). Only the
 * first `min(bytes.length, 8192)` bytes are inspected for `fmt`; the data
 * chunk only needs its 8-byte header inside that window.
 */
export function parseWav(bytes: Uint8Array): WavParseResult {
  if (bytes.length < 12) {
    return { ok: false, code: "truncated" };
  }
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    return { ok: false, code: "not_wav" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt: { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number } | null =
    null;
  let data: { offset: number; bytes: number } | null = null;
  while (offset + 8 <= bytes.length) {
    const chunkId = ascii(bytes, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (chunkId === "fmt " && fmt === null) {
      if (payload + 16 > bytes.length) {
        return { ok: false, code: "truncated" };
      }
      fmt = {
        audioFormat: view.getUint16(payload, true),
        channels: view.getUint16(payload + 2, true),
        sampleRate: view.getUint32(payload + 4, true),
        bitsPerSample: view.getUint16(payload + 14, true),
      };
    } else if (chunkId === "data" && data === null) {
      // RIFF chunk sizes are uint32; the payload may extend beyond the
      // buffer window when the caller supplied only the file head.
      data = { offset: payload, bytes: chunkSize };
    }
    if (fmt !== null && data !== null) {
      break;
    }
    // Chunks are word-aligned: odd sizes carry one pad byte.
    offset = payload + chunkSize + (chunkSize % 2);
    if (chunkSize === 0 && chunkId !== "fmt " && chunkId !== "data") {
      break; // defensive: a zero-size unknown chunk cannot advance the walk
    }
  }
  if (fmt === null) {
    return { ok: false, code: "no_fmt_chunk" };
  }
  if (data === null) {
    return { ok: false, code: "no_data_chunk" };
  }
  if (fmt.audioFormat !== 1) {
    return { ok: false, code: "unsupported_audio_format" };
  }
  if (fmt.bitsPerSample !== 16 || fmt.channels < 1 || fmt.sampleRate < 1) {
    return { ok: false, code: "unsupported_bit_depth" };
  }
  const blockAlign = fmt.channels * (fmt.bitsPerSample / 8);
  return {
    ok: true,
    header: {
      format: "wav",
      audioFormat: fmt.audioFormat,
      channels: fmt.channels,
      sampleRate: fmt.sampleRate,
      bitsPerSample: fmt.bitsPerSample,
      byteRate: fmt.sampleRate * blockAlign,
      blockAlign,
      dataOffset: data.offset,
      dataBytes: data.bytes,
    },
  };
}

/** The playable duration of the parsed audio, in milliseconds. */
export function wavDurationMs(header: WavHeader): number {
  return (header.dataBytes / header.byteRate) * 1000;
}

/**
 * The absolute byte range [start, end) of one original-time interval,
 * FRAME-ALIGNED: boundaries floor/ceil to whole sample frames so a slice
 * can never tear a frame, and the range is clamped to the data chunk.
 */
export function wavRangeForInterval(
  header: WavHeader,
  startMs: number,
  endMs: number,
): { readonly byteStart: number; readonly byteEnd: number } {
  const dataStart = header.dataOffset;
  const dataEnd = header.dataOffset + header.dataBytes;
  const rawStart = dataStart + Math.floor((startMs / 1000) * header.byteRate);
  const rawEnd = dataStart + Math.ceil((endMs / 1000) * header.byteRate);
  const align = (value: number, mode: "floor" | "ceil"): number => {
    const frames = value - dataStart;
    const aligned =
      mode === "floor"
        ? Math.floor(frames / header.blockAlign) * header.blockAlign
        : Math.ceil(frames / header.blockAlign) * header.blockAlign;
    return dataStart + aligned;
  };
  const byteStart = Math.max(dataStart, align(rawStart, "floor"));
  const byteEnd = Math.min(dataEnd, align(rawEnd, "ceil"));
  return { byteStart: Math.min(byteStart, dataEnd), byteEnd: Math.max(byteEnd, byteStart) };
}

/** Serializes a complete PCM WAV file from raw PCM data. */
export function serializeWav(header: Omit<WavHeader, "format" | "dataOffset" | "dataBytes">, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + data.length);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + data.length, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  out.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, header.audioFormat, true);
  view.setUint16(22, header.channels, true);
  view.setUint32(24, header.sampleRate, true);
  view.setUint32(28, header.byteRate, true);
  view.setUint16(32, header.blockAlign, true);
  view.setUint16(34, header.bitsPerSample, true);
  out.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/** The result of slicing one interval out of a whole WAV file. */
export type WavSliceResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      /** Actual sliced duration; differs from the asked interval by < 1 frame. */
      readonly durationMs: number;
    }
  | { readonly ok: false; readonly code: WavRefusal | "interval_out_of_range" };

/** Slices [startMs, endMs) of the original timeline into a standalone WAV. */
export function sliceWav(file: Uint8Array, startMs: number, endMs: number): WavSliceResult {
  const parsed = parseWav(file);
  if (!parsed.ok) {
    return { ok: false, code: parsed.code };
  }
  const header = parsed.header;
  const durationMs = wavDurationMs(header);
  if (startMs < 0 || endMs <= startMs || startMs >= durationMs) {
    return { ok: false, code: "interval_out_of_range" };
  }
  const clampedEnd = Math.min(endMs, durationMs);
  const { byteStart, byteEnd } = wavRangeForInterval(header, startMs, clampedEnd);
  const data = file.subarray(byteStart, byteEnd);
  return {
    ok: true,
    bytes: serializeWav(header, data),
    durationMs: ((byteEnd - byteStart) / header.byteRate) * 1000,
  };
}

// --- portable base64 (Node Buffer when present, web fallback otherwise) ---

/** Decodes base64 to bytes in any supported runtime. */
export function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** Encodes bytes as base64 in any supported runtime. */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

// --- synthetic fixtures (proofs and tests; clearly labeled synthetic) ------

/** Builds a tone-bearing PCM WAV fixture (synthetic; no real speech). */
export function toneWav(options: {
  seconds: number;
  frequency?: number;
  sampleRate?: number;
  amplitude?: number;
}): Uint8Array {
  const sampleRate = options.sampleRate ?? 8_000;
  const amplitude = options.amplitude ?? 12_000;
  const frequency = options.frequency ?? 440;
  const total = Math.floor(sampleRate * options.seconds);
  const data = new Uint8Array(total * 2);
  const view = new DataView(data.buffer);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, Math.min(t, options.seconds - t) * 20);
    view.setInt16(i * 2, Math.round(Math.sin(2 * Math.PI * frequency * t) * amplitude * envelope), true);
  }
  return serializeWav(
    { audioFormat: 1, channels: 1, sampleRate, bitsPerSample: 16, byteRate: sampleRate * 2, blockAlign: 2 },
    data,
  );
}
