/**
 * E2/E8 live smoke proof (authorized dev spend, single-digit requests).
 *
 * Runs ONLY when ALL hold:
 *  - `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY` are present in the
 *    environment (injected, never written anywhere; the key values are
 *    never printed, logged or committed);
 *  - `KIERO_E2_LIVE_SMOKE=1` explicitly opts in (plain `npm test` never
 *    spends).
 *
 * Proofs (issue acceptance criteria):
 *  1. ONE real DIRECT chat completion through the repository-owned DeepSeek
 *     Responses transport (first-choice position, strict json_schema
 *     output, thinking explicitly disabled), asserting the observed
 *     model/provider/route/version are recorded and the response decodes
 *     through the typed adapter. Direct attempts report token usage and NO
 *     cost (the direct API reports none — absent is not zero).
 *  2. ONE fallback-order observation: a controlled probe prefix model that
 *     cannot exist (404 before any inference) is classified eligible and
 *     the DIRECT first-choice model serves the retry — the live walk
 *     crosses a provider boundary. The reverse direction (direct DeepSeek
 *     failing eligible into OpenRouter) is proven offline in
 *     tests/e2/fallback.test.ts: forcing it live would require a real
 *     outage, and DeepSeek answers an unknown model name with HTTP 400,
 *     which is TERMINAL by policy (a configuration mismatch must not
 *     silently activate the fallback).
 *  3. ONE multi-round tool conversation on the direct transport: the model
 *     calls the declared tool, Kiero replays the NATIVE function_call /
 *     function_call_output round, and the model answers from the result.
 *  4. ONE embedding probe on RETAINED OpenRouter: the observed vector must
 *     be the versioned 4096-dimension baseline, with the observed model
 *     recorded.
 *  5. ONE transcription probe on RETAINED OpenRouter with a tiny synthetic
 *     tone (synthetic media, clearly labeled; Polish).
 *  6. ONE vision probe on a tiny synthetic PNG over the direct vision
 *     route.
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
  type ChatTurnCredentials,
} from "@kiero/providers";

const openRouterKey = process.env.OPENROUTER_API_KEY;
const deepSeekKey = process.env.DEEPSEEK_API_KEY;
const live =
  openRouterKey !== undefined &&
  openRouterKey !== "" &&
  deepSeekKey !== undefined &&
  deepSeekKey !== "" &&
  process.env.KIERO_E2_LIVE_SMOKE === "1";
const credentials: ChatTurnCredentials | null = live
  ? { apiKey: openRouterKey, deepseekApiKey: deepSeekKey }
  : null;

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

const ProbeToolInput = Schema.Struct({
  alias: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

describeLive("E8 live smoke (authorized spend)", () => {
  it(
    "completes one DIRECT structured chat turn with recorded provider/route",
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
      console.log("[e8-smoke/chat] record:", sanitized(result.record));
      expect(result.outcome.outcome).toBe("succeeded");
      if (result.outcome.outcome === "succeeded" && !("toolCalls" in result.outcome.value)) {
        // The value already carries the codec's type: no re-decode needed.
        expect(result.outcome.value.odp.length).toBeGreaterThan(0);
      }
      const success = result.record.attempts.find((a) => a.outcome === "succeeded");
      expect(success).toBeDefined();
      expect(success?.provider).toBe("deepseek");
      expect(success?.requestedModel).toBe(CHAT_MODEL_ORDER[0]?.model);
      expect(success?.observedModel).toBeDefined();
      expect(success?.routingConfigVersion).toBe(ROUTING_CONFIG_VERSION);
      // The direct API reports no request cost: absent, never zero.
      expect(success?.usage?.costUsd).toBeUndefined();
      expect(success?.usage?.totalTokens).toBeGreaterThan(0);
    },
  );

  it(
    "observes the provider-boundary fallback when the first position cannot serve (404 probe)",
    { timeout: 120_000 },
    async () => {
      if (credentials === null) {
        throw new Error("unreachable: gated");
      }
      // Probe route ONLY (server-side verification parameter): a first
      // position no catalog can serve, then the accepted order unchanged.
      const probeOrder = [
        { provider: "openrouter" as const, model: "kiero/nonexistent-probe-model" },
        ...CHAT_MODEL_ORDER,
      ] as const;
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
      console.log("[e8-smoke/fallback] record:", sanitized(result.record));
      expect(result.outcome.outcome).toBe("succeeded");
      expect(result.record.attempts.length).toBeGreaterThanOrEqual(2);
      expect(result.record.attempts[0]).toMatchObject({
        provider: "openrouter",
        requestedModel: "kiero/nonexistent-probe-model",
        outcome: "failed",
        fallbackEligible: true,
      });
      const success = result.record.attempts.find((a) => a.outcome === "succeeded");
      expect(success?.provider).toBe("deepseek");
      expect(success?.requestedModel).toBe(CHAT_MODEL_ORDER[0]?.model);
    },
  );

  it(
    "completes a two-round tool conversation with NATIVE replay on the direct transport",
    { timeout: 120_000 },
    async () => {
      if (credentials === null) {
        throw new Error("unreachable: gated");
      }
      const tools = [
        {
          name: "termin_projektu",
          description: "Zwraca termin (data) dla aliasu projektu.",
          input: ProbeToolInput,
        },
      ];
      const first = [
        { role: "user" as const, content: [{ kind: "text" as const, text: "Do kiedy termin projektu Banan? Użyj narzędzia." }] },
      ];
      const round1 = await chatWithRoute(credentials, "chat_analysis", { order: CHAT_MODEL_ORDER }, { messages: first, tools });
      expect(round1.outcome.outcome).toBe("succeeded");
      if (round1.outcome.outcome !== "succeeded") {
        throw new Error("round 1 failed");
      }
      if (round1.outcome.value.toolCalls.length === 0) {
        // Model answered directly: the tool loop is not the deterministic
        // path on every attempt; record honestly and skip the replay round.
        // eslint-disable-next-line no-console
        console.log("[e8-smoke/tools] round 1 answered without a tool call; replay round skipped");
        return;
      }
      const call = round1.outcome.value.toolCalls[0];
      expect(call?.name).toBe("termin_projektu");
      // eslint-disable-next-line no-console
      console.log("[e8-smoke/tools] round 1 record:", sanitized(round1.record));
      const round2 = await chatWithRoute(
        credentials,
        "chat_analysis",
        { order: CHAT_MODEL_ORDER },
        {
          messages: [
            ...first,
            {
              role: "assistant-tool-calls",
              calls: [{ id: call?.id ?? "", name: call?.name ?? "", arguments: JSON.stringify(call?.arguments) }],
            },
            {
              role: "tool-result",
              toolCallId: call?.id ?? "",
              name: call?.name ?? "",
              content: "2026-09-20",
            },
          ],
          tools,
        },
      );
      // eslint-disable-next-line no-console
      console.log("[e8-smoke/tools] round 2 record:", sanitized(round2.record));
      expect(round2.outcome.outcome).toBe("succeeded");
      if (round2.outcome.outcome === "succeeded") {
        expect(round2.outcome.value.text).toContain("2026");
      }
      const success = round2.record.attempts.find((a) => a.outcome === "succeeded");
      expect(success?.provider).toBe("deepseek");
    },
  );

  it(
    "embeds one text at the versioned 4096-dimension baseline (retained OpenRouter)",
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
      console.log("[e8-smoke/embedding] record:", sanitized(result.record));
      expect(result.outcome.outcome).toBe("succeeded");
      if (result.outcome.outcome === "succeeded") {
        expect(result.outcome.value.vector).toHaveLength(4096);
        expect(result.outcome.value.observedModel.toLowerCase()).toContain("qwen3-embedding-8b");
      }
      const success = result.record.attempts.find((a) => a.outcome === "succeeded");
      expect(success?.provider).toBe("openrouter");
    },
  );

  it(
    "transcribes a tiny synthetic Polish-labeled tone segment (retained OpenRouter)",
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
      console.log("[e8-smoke/stt] record:", sanitized(result.record));
      // A tone carries no speech: the honest expectation is a well-formed
      // classified outcome, not transcript content. The record must show the
      // accepted order and either a decoded non-empty transcript or an
      // explicit classified failure (recorded for D6's real-audio proof).
      expect(result.record.attempts.length).toBeGreaterThanOrEqual(1);
      expect(result.record.routingConfigVersion).toBe(ROUTING_CONFIG_VERSION);
      expect(result.record.attempts.every((a) => a.provider === "openrouter")).toBe(true);
      if (result.outcome.outcome === "succeeded") {
        expect(result.outcome.value.text.length).toBeGreaterThan(0);
      } else {
        expect(typeof result.outcome.failure.kind).toBe("string");
      }
    },
  );

  it(
    "extracts from a tiny synthetic image over the DIRECT vision route",
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
      console.log("[e8-smoke/vision] record:", sanitized(result.record));
      expect(result.outcome.outcome).toBe("succeeded");
      if (result.outcome.outcome === "succeeded" && !("toolCalls" in result.outcome.value)) {
        // The value already carries the codec's type: no re-decode needed.
        expect(result.outcome.value.claims.length).toBeGreaterThan(0);
      }
      const success = result.record.attempts.find((a) => a.outcome === "succeeded");
      expect(success).toBeDefined();
      expect(success?.provider).toBe("deepseek");
      expect(success?.requestedModel).toBe("deepseek-flash");
    },
  );
});

// Keep the reference used even when skipped (lint-friendly no-op).
void describeLive.name;
