/**
 * The voice recording engine (D4): tap-to-start / tap-to-stop recording
 * whose EVERY chunk is persisted as MediaRecorder emits it.
 *
 * The media boundary (getUserMedia, MediaRecorder, the clock) is an
 * injected port: production wires the browser APIs; the deterministic
 * tests and the live proof wire fakes at exactly this boundary. Everything
 * below it (incremental persistence, duration accounting, typed
 * permission/mic failures, the storage-degraded honesty rule) is real in
 * every environment.
 *
 * Honesty rules:
 *
 * - a chunk that cannot be persisted does NOT stop the recording (the
 *   in-session send can still work), but it reports `storage_degraded`:
 *   the draft is no longer promised to survive an interruption, and the
 *   UI must say so instead of claiming a saved fragment;
 * - no product duration cap exists here (charter): the engine records
 *   until the boss stops it, and the only limits are the browser's.
 */

// ---------------------------------------------------------------------------
// The media boundary port (mocked AT THIS SEAM only)
// ---------------------------------------------------------------------------

/** The structural media stream surface the recorder uses. */
export interface MediaStreamLike {
  getAudioTracks(): readonly { stop(): void }[];
}

/** The structural MediaRecorder surface the recorder drives. */
export interface MediaRecorderLike {
  start(timesliceMs: number): void;
  stop(): void;
  ondataavailable: ((event: { readonly data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** The browser media APIs the recorder needs, as one injectable port. */
export interface MediaBoundary {
  getUserMedia(constraints: { readonly audio: true }): Promise<MediaStreamLike>;
  isTypeSupported(mimeType: string): boolean;
  createMediaRecorder(stream: MediaStreamLike, mimeType: string): MediaRecorderLike;
  now(): number;
}

/** The typed failures the recording path can produce (closed vocabulary). */
export type RecorderFailure =
  | { readonly kind: "permission_denied" }
  | { readonly kind: "mic_unavailable"; readonly detail?: string }
  | { readonly kind: "recorder_unsupported" }
  | { readonly kind: "storage_degraded" };

/** Classifies one getUserMedia rejection into the closed vocabulary. */
export function classifyMediaFailure(cause: unknown): RecorderFailure {
  const name =
    typeof cause === "object" && cause !== null && "name" in cause
      ? String((cause as { name: unknown }).name)
      : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return { kind: "permission_denied" };
  }
  const detail = cause instanceof Error ? cause.message : undefined;
  return { kind: "mic_unavailable", ...(detail === undefined ? {} : { detail }) };
}

/**
 * Negotiates the recording container: Opus/WebM first (the WhatsApp-style
 * default on Chrome/Android), MPEG-4 second (Safari/iOS), Ogg third; null
 * when the browser supports none of the candidates.
 */
export function negotiateMimeType(isTypeSupported: (mimeType: string) => boolean): string | null {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((candidate) => isTypeSupported(candidate)) ?? null;
}

/** The chunk cadence: one durable fragment per second of speech. */
export const RECORDING_TIMESLICE_MS = 1_000;

// ---------------------------------------------------------------------------
// The production wiring: the browser media APIs as one MediaBoundary
// ---------------------------------------------------------------------------

/** The real MediaRecorder constructor with its static support probe. */
type RecorderConstructor = (new (
  stream: MediaStreamLike,
  options: { readonly mimeType: string },
) => MediaRecorderLike) & { isTypeSupported(mimeType: string): boolean };

/**
 * The browser media APIs as one MediaBoundary. Reached through structural
 * probes so this module typechecks in the node test configuration too;
 * at runtime (browser) the real APIs sit behind the exact same seam the
 * deterministic tests and the live proof mock. Null when the browser
 * offers no MediaRecorder or getUserMedia (rendered honestly as
 * `recorder_unsupported`).
 */
export function browserMediaBoundary(): MediaBoundary | null {
  const recorderClass = (globalThis as unknown as { MediaRecorder?: RecorderConstructor }).MediaRecorder;
  const mediaDevices = (
    globalThis as {
      navigator?: { mediaDevices?: { getUserMedia(constraints: { readonly audio: true }): Promise<MediaStreamLike> } };
    }
  ).navigator?.mediaDevices;
  if (recorderClass === undefined || mediaDevices === undefined) {
    return null;
  }
  return {
    getUserMedia: (constraints) => mediaDevices.getUserMedia(constraints),
    isTypeSupported: (mimeType) => recorderClass.isTypeSupported(mimeType),
    createMediaRecorder: (stream, mimeType) => new recorderClass(stream, { mimeType }),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// The sinks (how the engine reports progress to the feature)
// ---------------------------------------------------------------------------

export interface RecorderSinks {
  /** Persists one chunk; a throw reports `storage_degraded` (once). */
  onChunk(seq: number, chunk: Blob): Promise<void>;
  onRecordingStart(mimeType: string, startedAtMs: number): void;
  /** The final event: every chunk was already delivered or degraded. */
  onRecordingStop(totalDurationMs: number): void;
  onFailure(failure: RecorderFailure): void;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export type RecorderState = "idle" | "starting" | "recording" | "stopped";

/**
 * One voice recording session. Create per recording; `start` resolves once
 * MediaRecorder actually began (permission granted), `stop` is the
 * tap-to-stop that flushes the final chunk through `onChunk` before
 * `onRecordingStop` fires.
 */
export class VoiceRecorder {
  private state: RecorderState = "idle";
  private stream: MediaStreamLike | null = null;
  private recorder: MediaRecorderLike | null = null;
  private seq = 0;
  private startedAtMs = 0;
  private stoppedAtMs: number | null = null;
  private degraded = false;

  constructor(
    private readonly media: MediaBoundary,
    private readonly sinks: RecorderSinks,
  ) {}

  get currentState(): RecorderState {
    return this.state;
  }

  /** Requests the mic and starts incremental recording. */
  async start(): Promise<void> {
    if (this.state !== "idle") {
      return;
    }
    this.state = "starting";
    const mimeType = negotiateMimeType(this.media.isTypeSupported);
    if (mimeType === null) {
      this.state = "idle";
      this.sinks.onFailure({ kind: "recorder_unsupported" });
      return;
    }
    let stream: MediaStreamLike;
    try {
      stream = await this.media.getUserMedia({ audio: true });
    } catch (cause) {
      this.state = "idle";
      this.sinks.onFailure(classifyMediaFailure(cause));
      return;
    }
    this.stream = stream;
    try {
      this.recorder = this.media.createMediaRecorder(stream, mimeType);
    } catch (cause) {
      this.releaseStream();
      this.state = "idle";
      this.sinks.onFailure({ kind: "recorder_unsupported" });
      void cause;
      return;
    }
    this.seq = 0;
    this.degraded = false;
    this.startedAtMs = this.media.now();
    this.recorder.ondataavailable = (event) => this.handleChunk(event.data);
    this.recorder.onstop = () => this.handleStop();
    this.recorder.onerror = () => {
      // A recorder error mid-session: stop honestly through the same path;
      // already-persisted chunks stay recoverable.
      this.handleStop();
    };
    this.state = "recording";
    this.recorder.start(RECORDING_TIMESLICE_MS);
    this.sinks.onRecordingStart(mimeType, this.startedAtMs);
  }

  /** Tap-to-stop: flushes the final chunk, then reports the total length. */
  stop(): void {
    if (this.state !== "recording" || this.recorder === null) {
      return;
    }
    this.stoppedAtMs = this.media.now();
    try {
      this.recorder.stop();
    } catch {
      this.handleStop();
    }
  }

  /** Stops the mic tracks without the stop event (discard path). */
  release(): void {
    if (this.state === "recording" && this.recorder !== null) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      try {
        this.recorder.stop();
      } catch {
        // The stream release below is the guarantee that matters.
      }
    }
    this.releaseStream();
    this.state = "stopped";
  }

  private handleChunk(chunk: Blob): void {
    if (this.state !== "recording") {
      return;
    }
    const seq = this.seq;
    this.seq += 1;
    void this.sinks
      .onChunk(seq, chunk)
      .catch(() => {
        // The honesty rule: keep recording, report degraded exactly once.
        if (!this.degraded) {
          this.degraded = true;
          this.sinks.onFailure({ kind: "storage_degraded" });
        }
      });
  }

  private handleStop(): void {
    if (this.state !== "recording" && this.state !== "starting") {
      return;
    }
    const total =
      this.stoppedAtMs !== null ? this.stoppedAtMs - this.startedAtMs : this.media.now() - this.startedAtMs;
    this.releaseStream();
    this.state = "stopped";
    this.sinks.onRecordingStop(Math.max(total, 0));
  }

  private releaseStream(): void {
    for (const track of this.stream?.getAudioTracks() ?? []) {
      track.stop();
    }
    this.stream = null;
    this.recorder = null;
  }
}
