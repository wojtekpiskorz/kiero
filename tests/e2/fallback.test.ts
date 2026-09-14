/**
 * E2/E8 focused verification: bounded ordered fallback across PROVIDERS.
 *
 * FIXTURES ARE SYNTHETIC failures injected through the server-side attempt
 * seam (`chatWithRoute`/`transcriptionWithRoute`/`embeddingWithRoute`
 * accept an attempt function so verification can stall/fail each route
 * deterministically — the production entry points always use the real
 * adapter). Assertions cover the acceptance criteria: fallback happens only
 * on a classified eligible failure, records the actual route tried
 * (provider AND model), walks the accepted order across the DeepSeek ->
 * OpenRouter boundary, stops on anything else, and leaves the degraded
 * outcome honestly recorded when both providers fail.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  CHAT_MODEL_ORDER,
  STT_MODEL_ORDER,
  chatWithRoute,
  structuredChatWithRoute,
  providerFailure,
  transcriptionWithRoute,
  type ChatTurnCredentials,
  type ProviderFailure,
  type RouteTarget,
  type StreamObservation,
} from "@kiero/providers";

const credentials: ChatTurnCredentials = {
  apiKey: "test-only-not-a-real-key",
  deepseekApiKey: "test-only-not-a-real-key",
};

function failed(kind: ProviderFailure["kind"]): { ok: false; failure: ProviderFailure } {
  return { ok: false, failure: providerFailure(kind) };
}

function succeeded(
  overrides: Partial<StreamObservation> = {},
): { ok: true; observation: StreamObservation } {
  return {
    ok: true,
    observation: {
      observedModel: "observed/primary",
      text: "odp",
      toolCalls: [],
      firstOutputAtMs: 500,
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
      failed: false,
      ...overrides,
    },
  };
}

/** Scripts per-model outcomes for the chat attempt seam. */
function chatScript(
  script: Record<
    string,
    { ok: true; observation: StreamObservation } | { ok: false; failure: ProviderFailure }
  >,
) {
  const calls: RouteTarget[] = [];
  return {
    calls,
    attempt: async (_c: ChatTurnCredentials, target: RouteTarget) => {
      calls.push(target);
      const outcome = script[target.model];
      if (outcome === undefined) {
        throw new Error(`unexpected attempt for ${target.provider}:${target.model}`);
      }
      return outcome;
    },
  };
}

const chatRequest = {
  messages: [{ role: "user" as const, content: [{ kind: "text" as const, text: "pytanie" }] }],
};

const ProbeStrict = Schema.Struct({
  odp: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

describe("bounded ordered fallback (chat, across providers)", () => {
  it("an unavailable direct DeepSeek position advances to the OpenRouter fallback", async () => {
    const [first, second] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first.model]: failed("provider_unavailable"),
      [second.model]: succeeded(),
    });
    const result = await chatWithRoute(
      credentials,
      "chat_analysis",
      { order: CHAT_MODEL_ORDER },
      chatRequest,
      script.attempt,
    );
    expect(script.calls).toEqual([first, second]);
    expect(result.outcome.outcome).toBe("succeeded");
    expect(result.record.attempts).toHaveLength(2);
    expect(result.record.attempts[0]).toMatchObject({
      provider: "deepseek",
      requestedModel: first.model,
      outcome: "failed",
      failureKind: "provider_unavailable",
      fallbackEligible: true,
    });
    expect(result.record.attempts[1]).toMatchObject({
      provider: "openrouter",
      requestedModel: second.model,
      observedModel: "observed/primary",
      outcome: "succeeded",
    });
  });

  it("rate limiting and deadline exhaustion are eligible on either provider; the walk continues", async () => {
    const [first, second, third] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first.model]: failed("rate_limited"),
      [second.model]: failed("deadline_exceeded"),
      [third.model]: succeeded({ observedModel: "observed/gemini" }),
    });
    const result = await chatWithRoute(
      credentials,
      "chat_analysis",
      { order: CHAT_MODEL_ORDER },
      chatRequest,
      script.attempt,
    );
    expect(script.calls).toEqual([first, second, third]);
    expect(result.outcome.outcome).toBe("succeeded");
    expect(result.record.attempts.map((attempt) => attempt.failureKind)).toEqual([
      "rate_limited",
      "deadline_exceeded",
      undefined,
    ]);
    expect(result.record.attempts.map((attempt) => attempt.provider)).toEqual([
      "deepseek",
      "openrouter",
      "openrouter",
    ]);
  });

  it("connection failure before a response is eligible", async () => {
    const [first, second] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first.model]: failed("connection_failed"),
      [second.model]: succeeded(),
    });
    const result = await chatWithRoute(
      credentials,
      "chat_analysis",
      { order: CHAT_MODEL_ORDER },
      chatRequest,
      script.attempt,
    );
    expect(result.outcome.outcome).toBe("succeeded");
    expect(result.record.attempts).toHaveLength(2);
  });

  it("a rejected DeepSeek credential (401) is terminal: OpenRouter is never silently activated", async () => {
    const [first] = CHAT_MODEL_ORDER;
    if (first === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({ [first.model]: failed("unauthenticated") });
    const result = await chatWithRoute(
      credentials,
      "chat_analysis",
      { order: CHAT_MODEL_ORDER },
      chatRequest,
      script.attempt,
    );
    expect(script.calls).toEqual([first]);
    expect(result.outcome.outcome).toBe("failed");
    if (result.outcome.outcome === "failed") {
      expect(result.outcome.failure.kind).toBe("unauthenticated");
      expect(result.outcome.failure.fallbackEligible).toBe(false);
    }
  });

  it("exhausted credits (402) and rejected parameters (400) are terminal on the direct provider", async () => {
    for (const kind of ["insufficient_credits", "unsupported_parameters", "internal_error"] as const) {
      const [first] = CHAT_MODEL_ORDER;
      if (first === undefined) {
        throw new Error("chat order fixture");
      }
      const script = chatScript({ [first.model]: failed(kind) });
      const result = await chatWithRoute(
        credentials,
        "chat_analysis",
        { order: CHAT_MODEL_ORDER },
        chatRequest,
        script.attempt,
      );
      expect(script.calls).toEqual([first]);
      expect(result.outcome.outcome).toBe("failed");
      if (result.outcome.outcome === "failed") {
        expect(result.outcome.failure.kind).toBe(kind);
      }
    }
  });

  it("incompatible output on the fallback provider is terminal for the whole call", async () => {
    const [first, second] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first.model]: failed("provider_unavailable"),
      [second.model]: succeeded({ text: "not json at all {" }),
    });
    const result = await structuredChatWithRoute(
      credentials,
      "chat_analysis",
      { order: CHAT_MODEL_ORDER },
      { ...chatRequest, outputSchema: ProbeStrict },
      script.attempt,
    );
    expect(script.calls).toEqual([first, second]);
    expect(result.outcome.outcome).toBe("failed");
    if (result.outcome.outcome === "failed") {
      expect(result.outcome.failure.kind).toBe("output_rejected");
    }
  });

  it("both providers failing eligible failures records every route and the degraded outcome", async () => {
    const [first, second, third] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first.model]: failed("provider_unavailable"),
      [second.model]: failed("rate_limited"),
      [third.model]: failed("deadline_exceeded"),
    });
    const result = await chatWithRoute(
      credentials,
      "chat_analysis",
      { order: CHAT_MODEL_ORDER },
      chatRequest,
      script.attempt,
    );
    expect(result.outcome.outcome).toBe("failed");
    if (result.outcome.outcome === "failed") {
      // Degraded behavior when every supplier failed: the LAST observed
      // eligible failure stands, honestly recorded — never a silent
      // success, never a fabricated transcript.
      expect(result.outcome.failure.kind).toBe("deadline_exceeded");
      expect(result.outcome.failure.fallbackEligible).toBe(true);
    }
    expect(result.record.attempts.map((attempt) => attempt.requestedModel)).toEqual([
      first.model,
      second.model,
      third.model,
    ]);
    expect(result.record.attempts.every((attempt) => attempt.outcome === "failed")).toBe(true);
  });
});

describe("bounded ordered fallback (STT, retained OpenRouter-only roles)", () => {
  it("MAI failing eligible advances to the Whisper backup in order", async () => {
    const [mai, whisper] = STT_MODEL_ORDER;
    if (mai === undefined || whisper === undefined) {
      throw new Error("stt order fixture");
    }
    const calls: RouteTarget[] = [];
    const attempt = async (_c: ChatTurnCredentials, target: RouteTarget) => {
      calls.push(target);
      if (target.model === mai.model) {
        return failed("provider_unavailable");
      }
      return {
        ok: true as const,
        value: { text: "proba transkrypcji", usage: { seconds: 1.2, cost: 0.0001 } },
        observedModel: undefined,
      };
    };
    const result = await transcriptionWithRoute(
      credentials,
      { order: STT_MODEL_ORDER },
      { audioBase64: "c2lub3NvZmZm", audioFormat: "wav", language: "pl" },
      attempt,
    );
    expect(calls).toEqual([mai, whisper]);
    expect(calls.every((target) => target.provider === "openrouter")).toBe(true);
    expect(result.outcome.outcome).toBe("succeeded");
    if (result.outcome.outcome === "succeeded") {
      expect(result.outcome.value.text).toBe("proba transkrypcji");
    }
    expect(result.record.attempts).toHaveLength(2);
    const usage = result.record.attempts[1]?.usage;
    expect(usage?.costUsd).toBe(0.0001);
    // Audio seconds are duration, not tokens (review finding 2): they land
    // in their own record field and never in totalTokens.
    expect(usage?.audioSeconds).toBe(1.2);
    expect(usage?.totalTokens).toBeUndefined();
  });
});
