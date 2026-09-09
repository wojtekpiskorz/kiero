/**
 * E2 focused verification: typed decode of STT and embeddings provider
 * bodies.
 *
 * FIXTURES ARE SYNTHETIC response bodies shaped on the pinned
 * `@openrouter/sdk` (0.13.20) inbound models for the transcription endpoint
 * (`STTResponse`: text + usage) and `/api/v1/embeddings`
 * (`CreateEmbeddingsResponseBody`: data[].embedding, model, usage). They are
 * NOT recorded live responses. Assertions cover the acceptance criteria:
 * malformed bodies, empty transcripts and wrong vector dimensions are typed
 * rejections, never decoded values.
 */

import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS_BASELINE,
  decodeEmbedding,
  decodeTranscription,
} from "@kiero/providers";

function vectorOf(length: number, fill = 0.25): number[] {
  return Array.from({ length }, () => fill);
}

describe("embeddings provider body decode", () => {
  it("decodes a baseline-dimension float vector with observed model and usage", () => {
    const body = {
      object: "list",
      model: "qwen/qwen3-embedding-8b/nebius",
      data: [{ object: "embedding", index: 0, embedding: vectorOf(EMBEDDING_DIMENSIONS_BASELINE) }],
      usage: { promptTokens: 7, totalTokens: 7, cost: 0.000012 },
    };
    const decoded = decodeEmbedding(body);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.vector).toHaveLength(EMBEDDING_DIMENSIONS_BASELINE);
      expect(decoded.value.observedModel).toContain("qwen3-embedding-8b");
      expect(decoded.value.usage.costUsd).toBe(0.000012);
    }
  });

  it("rejects a wrong-dimension vector (incompatible output, fail closed)", () => {
    const body = {
      object: "list",
      model: "qwen/qwen3-embedding-8b",
      data: [{ object: "embedding", index: 0, embedding: vectorOf(1536) }],
    };
    expect(decodeEmbedding(body).ok).toBe(false);
  });

  it("rejects non-finite vector components", () => {
    const embedding = vectorOf(EMBEDDING_DIMENSIONS_BASELINE);
    embedding[10] = Number.NaN;
    const body = {
      object: "list",
      model: "qwen/qwen3-embedding-8b",
      data: [{ object: "embedding", index: 0, embedding }],
    };
    expect(decodeEmbedding(body).ok).toBe(false);
  });

  it("rejects a base64 string embedding body we did not request", () => {
    const body = {
      object: "list",
      model: "qwen/qwen3-embedding-8b",
      data: [{ object: "embedding", index: 0, embedding: "AAAA//==" }],
    };
    expect(decodeEmbedding(body).ok).toBe(false);
  });

  it("rejects bodies without data or without the observed model", () => {
    expect(decodeEmbedding({}).ok).toBe(false);
    expect(decodeEmbedding({ data: [] }).ok).toBe(false);
    expect(
      decodeEmbedding({ data: [{ embedding: vectorOf(4) }] }).ok,
    ).toBe(false);
    expect(decodeEmbedding("list").ok).toBe(false);
  });
});

describe("transcription provider body decode", () => {
  it("decodes a non-empty transcript with optional usage", () => {
    const decoded = decodeTranscription({
      text: "wycena na Bananie do piatek",
      usage: { seconds: 3.4, totalTokens: 12, cost: 0.0004 },
    });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.text).toBe("wycena na Bananie do piatek");
      expect(decoded.value.usage?.cost).toBe(0.0004);
      expect(decoded.value.usage?.seconds).toBe(3.4);
    }
  });

  it("rejects an empty transcript (a missing segment is pending, not success)", () => {
    expect(decodeTranscription({ text: "" }).ok).toBe(false);
  });

  it("rejects malformed bodies (missing text, non-object, string)", () => {
    expect(decodeTranscription({}).ok).toBe(false);
    expect(decodeTranscription("text").ok).toBe(false);
    expect(decodeTranscription(null).ok).toBe(false);
    expect(decodeTranscription({ usage: {} }).ok).toBe(false);
  });
});
