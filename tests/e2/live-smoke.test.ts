/**
 * E2 live smoke proof (authorized dev spend, single-digit requests).
 *
 * Runs ONLY when BOTH hold:
 *  - `OPENROUTER_API_KEY` is present in the environment (injected, never
 *    written anywhere; the key value is never printed, logged or committed);
 *  - `KIERO_E2_LIVE_SMOKE=1` explicitly opts in (plain `npm test` never
 *    spends).
 *
 * Proofs (issue acceptance criteria):
 *  1. ONE real chat completion through the pinned `@tanstack/ai-openrouter`
 *     adapter with the first-choice model and a strict json_schema output,
 *     asserting the observed model/route/version are recorded and the
 *     response decodes through the typed adapter.
 *  2. ONE fallback-order observation: a controlled probe prefix model that
 *     cannot exist (404 before any inference) is classified eligible and the
 *     accepted first-choice model serves the retry. This is an honest forced
 *     first-position failure, labeled as a probe route — the production
 *     entry points take no model parameter.
 *  3. ONE embedding probe: the observed vector must be the versioned
 *     4096-dimension baseline, with the observed model recorded.
 *  4. ONE transcription probe on the dedicated endpoint with a tiny
 *     synthetic tone (synthetic media, clearly labeled; Polish).
 *  5. ONE vision probe on a tiny synthetic PNG through the vision order.
 *
 * Everything printed is sanitized routing metadata only.
 */

import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CHAT_MODEL_ORDER,
  ROUTING_CONFIG_VERSION,
  chatWithRoute,
  runEmbedding,
  runStructuredChat,
  runTranscription,
  runVisionExtraction,
  type OpenRouterCredentials,
} from "@kiero/providers";

const apiKey = process.env.OPENROUTER_API_KEY;
const live = apiKey !== undefined && apiKey !== "" && process.env.KIERO_E2_LIVE_SMOKE === "1";
const credentials: OpenRouterCredentials | null = live ? { apiKey } : null;

/** Sanitized routing-only dump for the evidence record. */
function sanitized(record: unknown): string {
  return JSON.stringify(record);
}

const describeLive = live ? describe : describe.skip;

/** Builds a minimal valid grayscale PNG (synthetic fixture, no assets). */
function tinyGrayPng(size = 16): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) {
      const index = (c ^ byte) & 0xff;
      c = (crcTable[index] ?? 0) ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  const raw = Buffer.alloc(size * (size + 1));
  for (let y = 0; y < size; y += 1) {
    const row = y * (size + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      raw[row + 1 + x] = (x * 16 + y * 16) % 256;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Builds a short 8 kHz 16-bit mono PCM WAV carrying a quiet tone. */
function tinyToneWav(seconds = 0.8, frequency = 440): Buffer {
  const sampleRate = 8_000;
  const total = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) {
    const t = i / sampleRate;
    const envelope = Math.min(1, Math.min(t, seconds - t) * 20); // fade in/out
    const sample = Math.round(Math.sin(2 * Math.PI * frequency * t) * 12_000 * envelope);
    data.writeInt16LE(sample, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const ProbeOutput = Schema.Struct({
  odp: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

const ProbeExtraction = Schema.Struct({
  claims: Schema.Array(
    Schema.Struct({
      text: Schema.String.pipe(
        Schema.check(Schema.isMinLength(1)),
        Schema.check(Schema.isMaxLength(2_000)),
      ),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(50))),
});

describeLive("E2 live smoke (authorized spend)", () => {
  it(
    "completes one structured chat turn on the first-choice model with recorded route",
    { timeout: 90_000 },
    async () => {
      if (credentials === null) {
        throw new Error("unreachable: gated");
      }
      const result = await runStructuredChat(credentials, {
        messages: [
          {
            role: "user",
            content: [{ kind: "text", text: "Odpowiedz jednym słowem: tak" }],
          },
        ],
        outputSchema: ProbeOutput,
      });
      // eslint-disable-next-line no-console
      console.log("[e2-smoke/chat] record:", sanitized(result.record));
      expect(result.outcome.outcome).toBe("succeeded");
      if (result.outcome.outcome === "succeeded" && !("toolCalls" in result.outcome.value)) {
        // The value already carries the codec's type: no re-decode needed.
        expect(result.outcome.value.odp.length).toBeGreaterThan(0);
      }
      const success = result.record.attempts.find((a) => a.outcome === "succeeded");
      expect(success).toBeDefined();
      expect(success?.requestedModel).toBe(CHAT_MODEL_ORDER[0]);
      expect(success?.observedModel).toBeDefined();
      expect(success?.routingConfigVersion).toBe(ROUTING_CONFIG_VERSION);
    },
  );

  it(
    "observes ordered fallback when the first position cannot serve (404 probe)",
    { timeout: 120_000 },
    async () => {
      if (credentials === null) {
        throw new Error("unreachable: gated");
      }
      // Probe route ONLY (server-side verification parameter): a first
      // position no catalog can serve, then the accepted order unchanged.
      const probeOrder = ["kiero/nonexistent-probe-model", ...CHAT_MODEL_ORDER] as const;
      const result = await chatWithRoute(
        credentials,
        "chat_analysis",
        { order: probeOrder },
        {
          messages: [
            { role: "user", content: [{ kind: "text", text: "Odpowiedz jednym słowem: ok" }] },
          ],
        },
      );
      // eslint-disable-next-line no-console
      console.log("[e2-smoke/fallback] record:", sanitized(result.record));
      expect(result.outcome.outcome).toBe("succeeded");
      expect(result.record.attempts.length).toBeGreaterThanOrEqual(2);
      expect(result.record.attempts[0]).toMatchObject({
        requestedModel: "kiero/nonexistent-probe-model",
        outcome: "failed",
        fallbackEligible: true,
      });
      const success = result.record.attempts.find((a) => a.outcome === "succeeded");
      expect(success?.requestedModel).toBe(CHAT_MODEL_ORDER[0]);
    },
  );

  it(
    "embeds one text at the versioned 4096-dimension baseline",
    { timeout: 90_000 },
    async () => {
      if (credentials === null) {
        throw new Error("unreachable: gated");
      }
      const result = await runEmbedding(credentials, {
        text: "wycena dla projektu Banan",
        inputKind: "search_document",
      });
      // eslint-disable-next-line no-console
      console.log("[e2-smoke/embedding] record:", sanitized(result.record));
      expect(result.outcome.outcome).toBe("succeeded");
      if (result.outcome.outcome === "succeeded") {
        expect(result.outcome.value.vector).toHaveLength(4096);
        expect(result.outcome.value.observedModel.toLowerCase()).toContain("qwen3-embedding-8b");
      }
    },
  );

  it(
    "transcribes a tiny synthetic Polish-labeled tone segment (typed probe)",
    { timeout: 120_000 },
    async () => {
      if (credentials === null) {
        throw new Error("unreachable: gated");
      }
      const wav = tinyToneWav();
      const result = await runTranscription(credentials, {
        audioBase64: wav.toString("base64"),
        audioFormat: "wav",
        language: "pl",
      });
      // eslint-disable-next-line no-console
      console.log("[e2-smoke/stt] record:", sanitized(result.record));
      // A tone carries no speech: the honest expectation is a well-formed
      // classified outcome, not transcript content. The record must show the
      // accepted order and either a decoded non-empty transcript or an
      // explicit classified failure (recorded for D6's real-audio proof).
      expect(result.record.attempts.length).toBeGreaterThanOrEqual(1);
      expect(result.record.routingConfigVersion).toBe(ROUTING_CONFIG_VERSION);
      if (result.outcome.outcome === "succeeded") {
        expect(result.outcome.value.text.length).toBeGreaterThan(0);
      } else {
        expect(typeof result.outcome.failure.kind).toBe("string");
      }
    },
  );

  it(
    "extracts from a tiny synthetic image over the vision order",
    { timeout: 120_000 },
    async () => {
      if (credentials === null) {
        throw new Error("unreachable: gated");
      }
      const png = tinyGrayPng();
      const result = await runVisionExtraction(credentials, {
        images: [{ base64: png.toString("base64"), mimeType: "image/png" }],
        instruction: "Opisz obrazek jednym krótkim zdaniem.",
        outputSchema: ProbeExtraction,
      });
      // eslint-disable-next-line no-console
      console.log("[e2-smoke/vision] record:", sanitized(result.record));
      expect(result.outcome.outcome).toBe("succeeded");
      if (result.outcome.outcome === "succeeded" && !("toolCalls" in result.outcome.value)) {
        // The value already carries the codec's type: no re-decode needed.
        expect(result.outcome.value.claims.length).toBeGreaterThan(0);
      }
      const success = result.record.attempts.find((a) => a.outcome === "succeeded");
      expect(success).toBeDefined();
      // The vision order never includes the text-only route.
      expect(
        result.record.attempts.every(
          (a) => a.requestedModel !== "deepseek/deepseek-v4-flash-0731",
        ),
      ).toBe(true);
    },
  );
});

// Keep the reference used even when skipped (lint-friendly no-op).
void describeLive.name;
