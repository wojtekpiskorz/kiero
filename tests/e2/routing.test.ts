/**
 * E2/E8 focused verification: server-owned routing configuration.
 *
 * The accepted route per role is application configuration (issue E2/E8
 * acceptance criteria: no user or GM model selector exists; every role
 * follows the fixed application configuration). These tests pin the frozen
 * table — including the E8 provider split and the authorized fallback's
 * independence from the direct route — and the closed error vocabulary so
 * any change is a deliberate, version-bumping code change.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CHAT_MODEL_ORDER,
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_CHAT_MODEL,
  EMBEDDING_DIMENSIONS_BASELINE,
  EMBEDDING_MODEL_ORDER,
  PROVIDER_ROUTING,
  ROUTING_CONFIG_VERSION,
  STT_MODEL_ORDER,
  VISION_MODEL_ORDER,
  classifySdkFailure,
  failureToClosedError,
  normalizeRoutePosition,
  providerFailure,
} from "@kiero/providers";

describe("server-owned routing configuration (E8 provider split)", () => {
  it("pins the accepted chat order exactly: direct DeepSeek first, then two OpenRouter models", () => {
    expect([...CHAT_MODEL_ORDER]).toEqual([
      { provider: "deepseek", model: "deepseek-flash" },
      { provider: "openrouter", model: "z-ai/glm-5.3-flash" },
      { provider: "openrouter", model: "google/gemini-3.8-flash" },
    ]);
  });

  it("vision runs the direct vision-capable DeepSeek model first, then the same OpenRouter fallbacks", () => {
    expect([...VISION_MODEL_ORDER]).toEqual([
      { provider: "deepseek", model: "deepseek-flash" },
      { provider: "openrouter", model: "z-ai/glm-5.3-flash" },
      { provider: "openrouter", model: "google/gemini-3.8-flash" },
    ]);
  });

  it("never keeps the duplicated Flash alias as an OpenRouter fallback position", () => {
    // Owner decision (issue #170, 2026-09-14): an OpenRouter-served Flash
    // alias is the SAME model the direct route already tried — a second
    // attempt against it would be a disguised same-model retry.
    for (const order of [CHAT_MODEL_ORDER, VISION_MODEL_ORDER]) {
      const openRouterModels = order
        .filter((target) => target.provider === "openrouter")
        .map((target) => target.model);
      expect(openRouterModels.some((model) => model.includes("deepseek"))).toBe(false);
      expect(openRouterModels).not.toContain("deepseek/deepseek-v4-flash-0731");
    }
  });

  it("every chat/vision fallback position is a model DISTINCT from the direct alias, on the other supplier", () => {
    for (const order of [CHAT_MODEL_ORDER, VISION_MODEL_ORDER]) {
      expect(order[0]?.provider).toBe("deepseek");
      expect(order[0]?.model).toBe(DEEPSEEK_CHAT_MODEL);
      for (const fallback of order.slice(1)) {
        expect(fallback.provider).toBe("openrouter");
        expect(fallback.model).not.toContain("deepseek");
        expect(fallback.model).not.toBe(DEEPSEEK_CHAT_MODEL);
      }
    }
  });

  it("STT stays OpenRouter-only: MAI-Transcribe 2 first with Whisper Large V3 backup", () => {
    expect([...STT_MODEL_ORDER]).toEqual([
      { provider: "openrouter", model: "microsoft/mai-transcribe-2" },
      { provider: "openrouter", model: "openai/whisper-large-v3" },
    ]);
  });

  it("embeddings stay OpenRouter-only on the single accepted model and the 4096 baseline", () => {
    expect([...EMBEDDING_MODEL_ORDER]).toEqual([
      { provider: "openrouter", model: "qwen/qwen3-embedding-8b" },
    ]);
    expect(EMBEDDING_DIMENSIONS_BASELINE).toBe(4096);
  });

  it("the routing table equals the literal orders, uses the canonical direct base, and is versioned", () => {
    expect(PROVIDER_ROUTING.chat_analysis.order).toEqual(CHAT_MODEL_ORDER);
    expect(PROVIDER_ROUTING.vision_extraction.order).toEqual(VISION_MODEL_ORDER);
    expect(PROVIDER_ROUTING.speech_to_text.order).toEqual(STT_MODEL_ORDER);
    expect(PROVIDER_ROUTING.embedding.order).toEqual(EMBEDDING_MODEL_ORDER);
    expect(DEEPSEEK_API_BASE_URL).toBe("https://api.deepseek.com");
    expect(ROUTING_CONFIG_VERSION).toMatch(/^e\d+\.\d+$/);
  });

  it("legacy slug positions normalize to OpenRouter targets; qualified targets pass through", () => {
    expect(normalizeRoutePosition("openai/whisper-large-v3")).toEqual({
      provider: "openrouter",
      model: "openai/whisper-large-v3",
    });
    expect(
      normalizeRoutePosition({ provider: "deepseek", model: DEEPSEEK_CHAT_MODEL }),
    ).toEqual({ provider: "deepseek", model: DEEPSEEK_CHAT_MODEL });
  });

  it("SDK classification is authoritative on the HTTP status, even when wrapped", () => {
    // A retry-machinery wrapper (PermanentError) carrying a status must not
    // be misread as a terminal parameter problem: the STT fallback to
    // Whisper depends on 404/429 staying eligible.
    const wrapped = Object.assign(
      new Error("sdk wrapper"),
      { name: "PermanentError", statusCode: 404 },
    );
    const classified = classifySdkFailure(wrapped);
    expect(classified.kind).toBe("provider_unavailable");
    expect(classified.fallbackEligible).toBe(true);
    expect(classifySdkFailure(
      Object.assign(new Error("limited"), { name: "PermanentError", statusCode: 429 }),
    ).kind).toBe("rate_limited");
    expect(classifySdkFailure(
      Object.assign(new Error("auth"), { statusCode: 401 }),
    ).kind).toBe("unauthenticated");
    expect(classifySdkFailure(
      Object.assign(new Error("t"), { name: "RequestTimeoutError" }),
    ).kind).toBe("deadline_exceeded");
    expect(classifySdkFailure(Object.assign(new Error("a"), { name: "AbortError" })).kind).toBe(
      "deadline_exceeded",
    );
    expect(classifySdkFailure(new TypeError("bug")).kind).toBe("connection_failed");
  });

  it("an internal (pre-stream) defect is terminal and never burns the order", () => {
    const failure = providerFailure("internal_error");
    expect(failure.fallbackEligible).toBe(false);
    const closed = failureToClosedError(failure);
    expect(closed._tag).toBe("unavailable");
    if (closed._tag === "unavailable") {
      expect(closed.retryable).toBe(false);
    }
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
