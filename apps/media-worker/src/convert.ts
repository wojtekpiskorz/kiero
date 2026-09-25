/**
 * Container-only FFmpeg conversion (the voice byte channel): non-WAV
 * retained audio (the composer's `audio/webm;codecs=opus`) converts to ONE
 * complete PCM WAV file so the segment protocol's exact measure/slice
 * discipline applies to it unchanged.
 *
 * This module is the FFmpeg-backed `AudioConverter` implementation for
 * ./segment-service.ts. It runs ONLY inside the EU container (the Dockerfile
 * ships the ffmpeg binary; the Worker/DO isolates cannot spawn processes and
 * never import this file), and it converts under EXPLICIT bounds — every
 * breach answers a typed refusal, never a silent truncation:
 *
 * - input byte cap: `maxInputBytes` — the object is read in ONE window of
 *   exactly that size; a fuller window answers `conversion_input_too_large`;
 * - output byte cap: `maxOutputBytes` — ffmpeg's `-fs` stops writing at the
 *   cap (disk can never overflow past it) and the finished file at or over
 *   the cap answers `conversion_output_too_large`; a cap-sized file is never
 *   served, so truncation is impossible by construction;
 * - output duration cap: `maxOutputDurationMs` — measured from the parsed
 *   converted WAV, `conversion_output_too_long` beyond it;
 * - wall-clock timeout: `timeoutMs` — a hard SIGKILL answers
 *   `conversion_timed_out`.
 *
 * Cache (honest, measurable, stated): conversions are cached on the
 * container's disk, keyed by the INPUT bytes' sha-256 (idempotent per
 * object version — a changed object can never hit a stale entry), bounded
 * to a total byte budget with oldest-first eviction, and process-local:
 * a fresh process wipes the directory, so nothing survives a restart. The
 * cache exists because one transcript slices the SAME object once per
 * segment; without it every `/segment` call would re-read and re-convert
 * the whole object — honest, but measurably wasteful.
 *
 * No npm dependency anywhere: node builtins + the image's ffmpeg only.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWav, wavDurationMs, type WavHeader } from "./wav.ts";
import type { AudioConverter } from "./segment-service.ts";

/** The explicit bounds one conversion runs under (all enforced, all typed). */
export interface ConversionBounds {
  /** Largest retained object conversion will ever read. */
  readonly maxInputBytes: number;
  /** Largest converted WAV ever served; `-fs` stops ffmpeg exactly here. */
  readonly maxOutputBytes: number;
  /** Longest converted audio ever served (measured, never truncated). */
  readonly maxOutputDurationMs: number;
  /** Wall-clock budget of one ffmpeg run; a hard kill beyond it. */
  readonly timeoutMs: number;
}

/**
 * The production bounds: a 128 MiB webm/opus object is hours of voice; the
 * 192 MiB output cap covers the 30-minute duration cap at 48 kHz stereo
 * 16-bit (345 MiB would breach the byte cap first — bounds are bounds, the
 * first breach refuses); ffmpeg decodes minutes of audio in seconds, the
 * 120 s wall clock leaves multiples of headroom.
 */
export const FFMPEG_CONVERSION_BOUNDS: ConversionBounds = {
  maxInputBytes: 128 * 1024 * 1024,
  maxOutputBytes: 192 * 1024 * 1024,
  maxOutputDurationMs: 30 * 60 * 1000,
  timeoutMs: 120_000,
};

/** The typed outcome of parsing and bound-checking one conversion output. */
export type ConvertedWavAssessment =
  | { ok: true; header: WavHeader }
  | { ok: false; code: "conversion_output_too_large" | "conversion_output_too_long" | "conversion_failed" };

/**
 * Parses and bound-checks one conversion output (pure; the spawn glue's
 * post-run decision). A file at/over the byte cap means `-fs` stopped it —
 * refused, never served truncated; an unparseable output means the
 * conversion itself failed — refused, never a guess.
 */
export function assessConvertedWav(
  bytes: Uint8Array,
  bounds: ConversionBounds,
): ConvertedWavAssessment {
  if (bytes.length >= bounds.maxOutputBytes) {
    return { ok: false, code: "conversion_output_too_large" };
  }
  const parsed = parseWav(bytes);
  if (!parsed.ok) {
    return { ok: false, code: "conversion_failed" };
  }
  if (wavDurationMs(parsed.header) > bounds.maxOutputDurationMs) {
    return { ok: false, code: "conversion_output_too_long" };
  }
  return { ok: true, header: parsed.header };
}

/** The cache key of one input: its sha-256 (the object-version identity). */
export function conversionCacheKey(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Total bytes the conversion cache may hold on disk. */
export const CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

/** One cache entry's bookkeeping (the file on disk plus its size). */
interface CacheEntry {
  readonly path: string;
  readonly bytes: number;
}

/**
 * The bounded, process-local disk cache: files under one fixed directory,
 * keyed by input content hash, oldest-first eviction over the byte budget.
 * Map order is the recency order (reads re-insert), so eviction drops the
 * least recently served conversions first.
 */
export class ConversionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private ready: Promise<void> | undefined;
  private readonly dir: string;
  private readonly budgetBytes: number;

  // Explicit assignment (no parameter properties): this file runs under
  // Node type stripping, which refuses non-erasable TypeScript syntax.
  constructor(dir: string, budgetBytes: number) {
    this.dir = dir;
    this.budgetBytes = budgetBytes;
  }

  /**
   * One wipe per process: the directory is fixed, so leftovers of a prior
   * process (same container, restarted server) cannot leak past the budget.
   */
  private ensureReady(): Promise<void> {
    this.ready ??= (async () => {
      await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
      await mkdir(this.dir, { recursive: true }).catch(() => undefined);
    })();
    return this.ready;
  }

  /** Returns the cached WAV for this key, or null (miss or unreadable). */
  async read(key: string): Promise<Uint8Array | null> {
    await this.ensureReady();
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    try {
      const wav = new Uint8Array(await readFile(entry.path));
      this.entries.delete(key);
      this.entries.set(key, entry); // LRU touch
      return wav;
    } catch {
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      return null;
    }
  }

  /** Adopts an already-written temp file into the cache (a move, not a copy). */
  async store(key: string, tempPath: string, bytes: number): Promise<void> {
    await this.ensureReady();
    if (bytes > this.budgetBytes) {
      return; // one entry beyond the whole budget is simply not cached
    }
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.totalBytes -= previous.bytes;
    }
    const target = join(this.dir, `${key}.wav`);
    try {
      await rename(tempPath, target);
    } catch {
      if (previous !== undefined) {
        this.entries.set(key, previous);
        this.totalBytes += previous.bytes;
      }
      return; // honest degradation: the next call re-converts
    }
    this.entries.set(key, { path: target, bytes });
    this.totalBytes += bytes;
    await this.evictOverBudget();
  }

  /** Drops least-recent entries until the budget holds again. */
  private async evictOverBudget(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (this.totalBytes <= this.budgetBytes) {
        return;
      }
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
      await rm(entry.path, { force: true }).catch(() => undefined);
    }
  }
}

let defaultCache: ConversionCache | undefined;

/** The container's singleton cache (one fixed directory, one budget). */
function defaultConversionCache(): ConversionCache {
  defaultCache ??= new ConversionCache(join(tmpdir(), "kiero-convert-cache"), CACHE_BUDGET_BYTES);
  return defaultCache;
}

/** Whether this process can spawn ffmpeg at all (the healthz truth source). */
export async function ffmpegAvailability(): Promise<{ ok: true } | { ok: false }> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve({ ok: false }));
    child.on("close", (code) => resolve(code === 0 ? { ok: true } : { ok: false }));
  });
}

/** What one ffmpeg run decided (closed facts; no stderr text survives). */
interface FfmpegOutcome {
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly spawnFailed: boolean;
}

/**
 * Runs one bounded ffmpeg conversion: the temp input file in, 16-bit PCM WAV
 * out, `-fs` capping the written bytes at the output bound. The wall-clock
 * timer SIGKILLs — a partial output can never be finalized and served.
 */
function spawnFfmpegToWav(
  inputPath: string,
  outputPath: string,
  bounds: ConversionBounds,
): Promise<FfmpegOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (outcome: FfmpegOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(outcome);
    };
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel", "error",
        "-i", inputPath,
        "-map", "0:a:0", // the first audio stream; no audio stream fails honestly
        "-vn",
        "-map_metadata", "-1",
        "-acodec", "pcm_s16le",
        "-f", "wav",
        "-fs", String(bounds.maxOutputBytes),
        "-y", outputPath,
      ],
      { stdio: "ignore" },
    );
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle({ timedOut: true, exitCode: null, spawnFailed: false });
    }, bounds.timeoutMs);
    child.on("error", () => settle({ timedOut: false, exitCode: null, spawnFailed: true }));
    child.on("close", (exitCode) => settle({ timedOut: false, exitCode, spawnFailed: false }));
  });
}

/**
 * Builds the container's FFmpeg-backed converter (the `AudioConverter` the
 * shared protocol boundary receives on this surface only). Bounds and cache
 * are injectable so tests drive the decisions without the binary.
 */
export function ffmpegConverter(options?: {
  readonly bounds?: ConversionBounds;
  readonly cache?: ConversionCache;
}): AudioConverter {
  const bounds = options?.bounds ?? FFMPEG_CONVERSION_BOUNDS;
  const cache = options?.cache ?? defaultConversionCache();
  return async (call) => {
    // ONE capped window (inclusive): a fuller window means the input object
    // is larger than conversion will ever accept — refuse, never read on.
    const input = await call.readObject(call.objectKey, { start: 0, end: bounds.maxInputBytes });
    if (input === null) {
      return { ok: false, code: "object_not_found" as const };
    }
    if (input.length === 0) {
      return { ok: false, code: "object_read_failed" as const };
    }
    if (input.length > bounds.maxInputBytes) {
      return { ok: false, code: "conversion_input_too_large" as const };
    }
    const key = conversionCacheKey(input);
    const cached = await cache.read(key);
    if (cached !== null) {
      return { ok: true, wav: cached };
    }
    let workDir: string | undefined;
    try {
      workDir = await mkdtemp(join(tmpdir(), "kiero-convert-"));
      const inputPath = join(workDir, "input.bin");
      const outputPath = join(workDir, "output.wav");
      await writeFile(inputPath, input);
      const run = await spawnFfmpegToWav(inputPath, outputPath, bounds);
      if (run.spawnFailed) {
        return { ok: false, code: "conversion_unavailable" as const };
      }
      if (run.timedOut) {
        return { ok: false, code: "conversion_timed_out" as const };
      }
      if (run.exitCode !== 0) {
        return { ok: false, code: "conversion_failed" as const };
      }
      const output = new Uint8Array(await readFile(outputPath));
      const assessed = assessConvertedWav(output, bounds);
      if (!assessed.ok) {
        return { ok: false, code: assessed.code };
      }
      // The cache ADOPTS the finished file (a move); a cache that cannot
      // take it is not a conversion failure — the bytes are already served.
      // The finally below removes the input and the emptied work directory.
      await cache.store(key, outputPath, output.length).catch(() => undefined);
      return { ok: true, wav: output };
    } catch {
      return { ok: false, code: "conversion_failed" as const };
    } finally {
      if (workDir !== undefined) {
        await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}
