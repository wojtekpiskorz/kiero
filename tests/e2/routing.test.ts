/**
 * E2 focused verification: server-owned routing configuration.
 *
 * The accepted model order per role is application configuration (issue E2
 * acceptance criteria: no user or GM model selector exists; every role
 * follows the fixed application configuration). These tests pin the frozen
 * table and the closed error surface so any change is a deliberate,
 * version-bumping code change.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CHAT_MODEL_ORDER,
  EMBEDDING_DIMENSIONS_BASELINE,
  EMBEDDING_MODEL_ORDER,
  PROVIDER_ROUTING,
  ROUTING_CONFIG_VERSION,
  STT_MODEL_ORDER,
  VISION_MODEL_ORDER,
  failureToClosedError,
  providerFailure,
} from "@kiero/providers";

describe("server-owned routing configuration", () => {
  it("pins the accepted chat order exactly", () => {
    expect([...CHAT_MODEL_ORDER]).toEqual([
      "z-ai/glm-5.3-flash",
      "google/gemini-3.8-flash",
      "deepseek/deepseek-v4-flash-0731",
    ]);
  });

  it("vision uses GLM then Gemini and never the text-only DeepSeek route", () => {
    expect([...VISION_MODEL_ORDER]).toEqual([
      "z-ai/glm-5.3-flash",
      "google/gemini-3.8-flash",
    ]);
    expect(VISION_MODEL_ORDER).not.toContain("deepseek/deepseek-v4-flash-0731");
  });

  it("STT uses MAI-Transcribe 2 first with Whisper Large V3 backup", () => {
    expect([...STT_MODEL_ORDER]).toEqual([
      "microsoft/mai-transcribe-2",
      "openai/whisper-large-v3",
    ]);
  });

  it("embeddings pin the single accepted model and the 4096 baseline", () => {
    expect([...EMBEDDING_MODEL_ORDER]).toEqual(["qwen/qwen3-embedding-8b"]);
    expect(EMBEDDING_DIMENSIONS_BASELINE).toBe(4096);
  });

  it("the routing table equals the literal orders and is versioned", () => {
    expect(PROVIDER_ROUTING.chat_analysis.order).toEqual(CHAT_MODEL_ORDER);
    expect(PROVIDER_ROUTING.vision_extraction.order).toEqual(VISION_MODEL_ORDER);
    expect(PROVIDER_ROUTING.speech_to_text.order).toEqual(STT_MODEL_ORDER);
    expect(PROVIDER_ROUTING.embedding.order).toEqual(EMBEDDING_MODEL_ORDER);
    expect(ROUTING_CONFIG_VERSION).toMatch(/^e\d+\.\d+$/);
  });

  it("failure projections are closed sanitized errors with no provider payloads", () => {
    const incompatible = failureToClosedError(providerFailure("output_rejected"));
    expect(Schema.decodeUnknownSync(
      Schema.Struct({ _tag: Schema.String, code: Schema.String, retryable: Schema.optionalKey(Schema.Boolean) }),
    )(incompatible)._tag).toBe("validation");

    const auth = failureToClosedError(providerFailure("unauthenticated"));
    expect(auth._tag).toBe("unauthenticated");
    expect(auth.code).toBe("provider_key_rejected");

    const deadline = failureToClosedError(providerFailure("deadline_exceeded"));
    expect(deadline._tag).toBe("unavailable");
    if (deadline._tag === "unavailable") {
      expect(deadline.retryable).toBe(true);
    }

    // The sanitized failure value itself has nowhere to carry provider text.
    const failure = providerFailure("rate_limited");
    expect(Object.keys(failure).sort()).toEqual(["fallbackEligible", "kind"]);
  });
});
