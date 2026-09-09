/**
 * E2 focused verification: bounded ordered fallback.
 *
 * FIXTURES ARE SYNTHETIC failures injected through the server-side attempt
 * seam (`chatWithRoute`/`transcriptionWithRoute`/`embeddingWithRoute`
 * accept an attempt function so verification can stall/fail each route
 * deterministically — the production entry points always use the real
 * adapter). Assertions cover the acceptance criteria: fallback happens only
 * on a classified eligible failure, records the actual route tried, walks
 * the accepted order, and stops on anything else.
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
  type OpenRouterCredentials,
  type ProviderFailure,
  type StreamObservation,
} from "@kiero/providers";

const credentials: OpenRouterCredentials = { apiKey: "test-only-not-a-real-key" };

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
function chatScript(script: Record<string, { ok: true; observation: StreamObservation } | { ok: false; failure: ProviderFailure }>) {
  const calls: string[] = [];
  return {
    calls,
    attempt: async (_c: OpenRouterCredentials, model: string) => {
      calls.push(model);
      const outcome = script[model];
      if (outcome === undefined) {
        throw new Error(`unexpected attempt for ${model}`);
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

describe("bounded ordered fallback (chat)", () => {
  it("an unavailable first route (404-class) advances to the next accepted model", async () => {
    const first = CHAT_MODEL_ORDER[0];
    const second = CHAT_MODEL_ORDER[1];
    if (first === undefined || second === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first]: failed("provider_unavailable"),
      [second]: succeeded(),
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
      requestedModel: first,
      outcome: "failed",
      failureKind: "provider_unavailable",
      fallbackEligible: true,
    });
    expect(result.record.attempts[1]).toMatchObject({
      requestedModel: second,
      observedModel: "observed/primary",
      outcome: "succeeded",
    });
  });

  it("rate limiting and deadline exhaustion are eligible; the walk continues", async () => {
    const [first, second, third] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first]: failed("rate_limited"),
      [second]: failed("deadline_exceeded"),
      [third]: succeeded({ observedModel: "observed/deepseek" }),
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
  });

  it("connection failure before a response is eligible", async () => {
    const [first, second] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first]: failed("connection_failed"),
      [second]: succeeded(),
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

  it("an unauthenticated route (401) is terminal: no second model is tried", async () => {
    const [first] = CHAT_MODEL_ORDER;
    if (first === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({ [first]: failed("unauthenticated") });
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
    }
  });

  it("exhausted credits (402) and rejected parameters (400) are terminal", async () => {
    for (const kind of ["insufficient_credits", "unsupported_parameters"] as const) {
      const [first] = CHAT_MODEL_ORDER;
      if (first === undefined) {
        throw new Error("chat order fixture");
      }
      const script = chatScript({ [first]: failed(kind) });
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

  it("incompatible output on a later model is terminal for the whole call", async () => {
    const [first, second] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first]: failed("provider_unavailable"),
      [second]: succeeded({ text: "not json at all {" }),
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

  it("all routes failing eligible failures records each tried route and the last failure", async () => {
    const [first, second, third] = CHAT_MODEL_ORDER;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("chat order fixture");
    }
    const script = chatScript({
      [first]: failed("provider_unavailable"),
      [second]: failed("rate_limited"),
      [third]: failed("deadline_exceeded"),
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
      expect(result.outcome.failure.kind).toBe("deadline_exceeded");
    }
    expect(result.record.attempts.map((attempt) => attempt.requestedModel)).toEqual([
      first,
      second,
      third,
    ]);
  });
});

describe("bounded ordered fallback (STT)", () => {
  it("MAI failing eligible advances to the Whisper backup in order", async () => {
    const [mai, whisper] = STT_MODEL_ORDER;
    if (mai === undefined || whisper === undefined) {
      throw new Error("stt order fixture");
    }
    const calls: string[] = [];
    const attempt = async (_c: OpenRouterCredentials, model: string) => {
      calls.push(model);
      if (model === mai) {
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
