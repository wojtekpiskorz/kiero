/**
 * D4 focused tests: the voice recording engine.
 *
 * The media boundary (getUserMedia / MediaRecorder / clock) is mocked at
 * EXACTLY the seam production injects; everything below the seam is the
 * real engine: incremental chunk delivery, duration accounting, the typed
 * permission/mic/unsupported failures, and the storage-degraded honesty
 * rule (a chunk that cannot be persisted keeps the recording alive but
 * reports that recovery is not promised — never a false saved state).
 */

import { describe, expect, it } from "vitest";
import {
  RECORDING_TIMESLICE_MS,
  VoiceRecorder,
  classifyMediaFailure,
  negotiateMimeType,
  type MediaBoundary,
  type MediaRecorderLike,
  type MediaStreamLike,
  type RecorderFailure,
} from "../../apps/web/src/features/capture/recorder";

// ---------------------------------------------------------------------------
// The fake media boundary (the ONLY mocked layer)
// ---------------------------------------------------------------------------

class FakeRecorder implements MediaRecorderLike {
  ondataavailable: ((event: { readonly data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  startedWithTimeslice: number | null = null;
  stopped = false;

  constructor(readonly stream: MediaStreamLike, readonly mimeType: string) {}

  start(timesliceMs: number): void {
    this.startedWithTimeslice = timesliceMs;
  }

  stop(): void {
    this.stopped = true;
    this.onstop?.();
  }

  /** The test drives the browser's cadence: emits one chunk. */
  emit(data: Blob): void {
    this.ondataavailable?.({ data });
  }
}

class FakeStream implements MediaStreamLike {
  readonly stoppedTracks: number[] = [];
  private tracks = [
    { stop: () => this.stoppedTracks.push(0) },
    { stop: () => this.stoppedTracks.push(1) },
  ];
  getAudioTracks(): readonly { stop(): void }[] {
    return this.tracks;
  }
}

interface BoundaryScript {
  readonly getUserMediaError?: unknown;
  readonly supported?: readonly string[];
}

function fakeBoundary(script: BoundaryScript = {}) {
  const supported = script.supported ?? [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  const created: FakeRecorder[] = [];
  const streams: FakeStream[] = [];
  let clock = 1_000_000;
  const boundary: MediaBoundary = {
    getUserMedia: async () => {
      if (script.getUserMediaError !== undefined) {
        throw script.getUserMediaError;
      }
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    },
    isTypeSupported: (mimeType) => supported.includes(mimeType),
    createMediaRecorder: (stream, mimeType) => {
      const recorder = new FakeRecorder(stream, mimeType);
      created.push(recorder);
      return recorder;
    },
    now: () => clock,
  };
  return {
    boundary,
    created,
    streams,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

function fakeSinks() {
  const chunks: { seq: number; blob: Blob }[] = [];
  const failures: RecorderFailure[] = [];
  const events: string[] = [];
  return {
    chunks,
    failures,
    events,
    sinks: {
      onChunk: async (seq: number, blob: Blob) => {
        chunks.push({ seq, blob });
      },
      onRecordingStart: (mimeType: string, startedAtMs: number) => {
        events.push(`start:${mimeType}:${startedAtMs}`);
      },
      onRecordingStop: (totalDurationMs: number) => {
        events.push(`stop:${totalDurationMs}`);
      },
      onFailure: (failure: RecorderFailure) => {
        failures.push(failure);
      },
    },
  };
}

// ---------------------------------------------------------------------------

describe("negotiateMimeType", () => {
  it("prefers Opus/WebM, then WebM, then MP4, then Ogg", () => {
    expect(negotiateMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(negotiateMimeType((m) => m === "audio/mp4")).toBe("audio/mp4");
    expect(negotiateMimeType(() => false)).toBeNull();
  });
});

describe("classifyMediaFailure", () => {
  it("maps the permission denials to permission_denied", () => {
    expect(classifyMediaFailure(new DOMException("denied", "NotAllowedError")).kind).toBe(
      "permission_denied",
    );
    expect(classifyMediaFailure({ name: "PermissionDeniedError" }).kind).toBe(
      "permission_denied",
    );
  });

  it("maps missing hardware and aborts to mic_unavailable", () => {
    expect(classifyMediaFailure(new DOMException("none", "NotFoundError")).kind).toBe(
      "mic_unavailable",
    );
    expect(classifyMediaFailure(new Error("aborted")).kind).toBe("mic_unavailable");
  });
});

describe("VoiceRecorder", () => {
  it("starts incremental recording in one call after permission", async () => {
    const media = fakeBoundary();
    const sink = fakeSinks();
    const recorder = new VoiceRecorder(media.boundary, sink.sinks);
    await recorder.start();
    expect(recorder.currentState).toBe("recording");
    expect(media.streams).toHaveLength(1);
    expect(media.created).toHaveLength(1);
    const created = media.created[0]!;
    expect(created.mimeType).toBe("audio/webm;codecs=opus");
    expect(created.startedWithTimeslice).toBe(RECORDING_TIMESLICE_MS);
    expect(sink.events[0]).toBe("start:audio/webm;codecs=opus:1000000");
  });

  it("delivers every chunk in order as it is emitted", async () => {
    const media = fakeBoundary();
    const sink = fakeSinks();
    const recorder = new VoiceRecorder(media.boundary, sink.sinks);
    await recorder.start();
    const created = media.created[0]!;
    created.emit(new Blob(["a"]));
    created.emit(new Blob(["bb"]));
    created.emit(new Blob(["ccc"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sink.chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
    expect(sink.chunks.map((chunk) => chunk.blob.size)).toEqual([1, 2, 3]);
  });

  it("stops with the measured duration and releases the mic", async () => {
    const media = fakeBoundary();
    const sink = fakeSinks();
    const recorder = new VoiceRecorder(media.boundary, sink.sinks);
    await recorder.start();
    media.tick(2_500);
    recorder.stop();
    expect(recorder.currentState).toBe("stopped");
    expect(sink.events).toContain("stop:2500");
    // Both audio tracks stopped: the mic is released.
    expect(media.streams[0]!.stoppedTracks).toEqual([0, 1]);
  });

  it("reports permission denial typed, without creating a recorder", async () => {
    const media = fakeBoundary({
      getUserMediaError: new DOMException("denied", "NotAllowedError"),
    });
    const sink = fakeSinks();
    const recorder = new VoiceRecorder(media.boundary, sink.sinks);
    await recorder.start();
    expect(recorder.currentState).toBe("idle");
    expect(sink.failures).toEqual([{ kind: "permission_denied" }]);
    expect(media.created).toHaveLength(0);
  });

  it("reports an unsupported browser typed (no usable container)", async () => {
    const media = fakeBoundary({ supported: [] });
    const sink = fakeSinks();
    const recorder = new VoiceRecorder(media.boundary, sink.sinks);
    await recorder.start();
    expect(recorder.currentState).toBe("idle");
    expect(sink.failures).toEqual([{ kind: "recorder_unsupported" }]);
  });

  it("keeps recording when a chunk cannot be persisted, reporting storage_degraded once", async () => {
    const media = fakeBoundary();
    let failChunks = true;
    const chunks: { seq: number; blob: Blob }[] = [];
    const failures: RecorderFailure[] = [];
    const recorder = new VoiceRecorder(media.boundary, {
      onChunk: async (seq, blob) => {
        if (failChunks) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        chunks.push({ seq, blob });
      },
      // (created/stopped below are driven through the sinks' contracts)
      onRecordingStart: () => undefined,
      onRecordingStop: () => undefined,
      onFailure: (failure) => {
        failures.push(failure);
      },
    });
    await recorder.start();
    media.created[0]!.emit(new Blob(["a"]));
    media.created[0]!.emit(new Blob(["b"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // One honest degraded report; the recording itself continues.
    expect(failures).toEqual([{ kind: "storage_degraded" }]);
    expect(recorder.currentState).toBe("recording");
    failChunks = false;
    media.created[0]!.emit(new Blob(["c"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Later chunks persist again (no repeated failure spam).
    expect(chunks.map((chunk) => chunk.blob.size)).toEqual([1]);
    expect(failures).toHaveLength(1);
  });

  it("release() stops the tracks without the stop event (the discard path)", async () => {
    const media = fakeBoundary();
    const sink = fakeSinks();
    const recorder = new VoiceRecorder(media.boundary, sink.sinks);
    await recorder.start();
    recorder.release();
    expect(recorder.currentState).toBe("stopped");
    expect(media.streams[0]!.stoppedTracks).toEqual([0, 1]);
    expect(sink.events.filter((event) => event.startsWith("stop:"))).toHaveLength(0);
  });
});
