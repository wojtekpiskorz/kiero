/**
 * E2 focused verification: typed decode of chat provider output.
 *
 * FIXTURES ARE SYNTHETIC. The event sequences below mirror the exact AG-UI
 * shapes `@tanstack/ai-openrouter`'s `chatStream` emits (RUN_STARTED /
 * TEXT_MESSAGE_* / TOOL_CALL_* / RUN_FINISHED / RUN_ERROR, with the observed
 * model and usage on the run events), as read from the pinned adapter source
 * (0.19.8). They are NOT recorded live provider responses; no network runs
 * here. The fixtures drive the REAL exported `harvestStream` (the
 * export-for-fixtures pattern, like `decodeEmbedding`/`decodeTranscription`),
 * so the full offline chain is exercised: event harvest -> typed decode ->
 * ordered-route recording. The assertions cover the acceptance criteria:
 * every provider response and tool argument passes its Effect Schema before
 * a checked domain operation can consume it, and malformed output is
 * rejected (typed fail-closed), including the adapter's own lenient
 * empty-input behavior on malformed tool-argument JSON.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { AdapterYieldChunk } from "@tanstack/ai";
import {
  chatWithRoute,
  classifyChatFailure,
  harvestStream,
  structuredChatWithRoute,
  type ChatRequest,
  type OpenRouterCredentials,
  type ProviderFailure,
  type StreamObservation,
} from "@kiero/providers";
import type { ModelRoute } from "@kiero/providers";

/** Synthetic credentials; the injected attempts never touch the network. */
const credentials: OpenRouterCredentials = { apiKey: "test-only-not-a-real-key" };
const route: ModelRoute = { order: ["model-a", "model-b"] };

/** A sample tool input contract: strict enum + bounded text (A2-style). */
const ProbeToolInput = Schema.Struct({
  findingKey: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)),
  ),
  knowledgeState: Schema.Literals(["known", "unknown", "conflicted", "not_applicable"]),
});

/** A sample structured-output contract. */
const ProbeOutput = Schema.Struct({
  odp: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

/** Wraps plain fixture objects as the adapter's chunk iterable. */
async function* eventsOf(events: unknown[]): AsyncIterable<AdapterYieldChunk> {
  for (const event of events) {
    yield event as AdapterYieldChunk;
  }
}

/** AG-UI fixture builders matching the pinned adapter's emissions. */
function runStarted(model = "model-a"): unknown {
  return { type: "RUN_STARTED", runId: "r1", threadId: "t1", model, timestamp: 1 };
}
function textDelta(delta: string): unknown {
  return { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta, timestamp: 2 };
}
function toolStart(id: string, name: string): unknown {
  return { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, timestamp: 2 };
}
function toolArgs(id: string, delta: string): unknown {
  return { type: "TOOL_CALL_ARGS", toolCallId: id, delta, timestamp: 2 };
}
function toolEnd(id: string, name: string, input: unknown = {}): unknown {
  return { type: "TOOL_CALL_END", toolCallId: id, toolCallName: name, input, timestamp: 3 };
}
function runFinished(model = "model-a", usage?: unknown): unknown {
  return {
    type: "RUN_FINISHED",
    runId: "r1",
    threadId: "t1",
    model,
    finishReason: "stop",
    ...(usage === undefined ? {} : { usage }),
    timestamp: 4,
  };
}
function runError(code?: string | number): unknown {
  return {
    type: "RUN_ERROR",
    runId: "r1",
    threadId: "t1",
    message: "provider text",
    ...(code === undefined ? {} : { code }),
    timestamp: 4,
  };
}

/**
 * Builds a fake chat attempt that replaces ONLY the network adapter: the
 * REAL harvestStream consumes the fixture events, exactly like chatAttempt
 * consumes the adapter's stream.
 */
function fakeStreamAttempts(script: Record<string, unknown[]>) {
  const calls: string[] = [];
  const attempt = async (
    _creds: OpenRouterCredentials,
    model: string,
    _request: ChatRequest,
  ): Promise<
    | { ok: true; observation: StreamObservation }
    | { ok: false; failure: ProviderFailure }
  > => {
    calls.push(model);
    const scripted = script[model];
    if (scripted === undefined) {
      throw new Error(`unexpected attempt for ${model}`);
    }
    const observation = await harvestStream(eventsOf(scripted));
    if (observation.failed) {
      return { ok: false, failure: classifyChatFailure(observation.failureCode) };
    }
    return { ok: true, observation };
  };
  return { attempt, calls };
}

const tinyUsage = {
  promptTokens: 5,
  completionTokens: 1,
  totalTokens: 6,
  cost: 0.000001,
};

describe("the real event harvest (offline, synthetic streams)", () => {
  it("accumulates fragmented text deltas and captures first output", async () => {
    const observation = await harvestStream(
      eventsOf([
        runStarted("model-a"),
        textDelta('{"od'),
        textDelta('p":'),
        textDelta('"tak"}'),
        runFinished("model-a", tinyUsage),
      ]),
    );
    expect(observation.text).toBe('{"odp":"tak"}');
    expect(observation.observedModel).toBe("model-a");
    expect(observation.firstOutputAtMs).toBeTypeOf("number");
    expect(observation.usage).toEqual({
      promptTokens: 5,
      completionTokens: 1,
      totalTokens: 6,
      costUsd: 0.000001,
    });
  });

  it("accumulates fragmented tool-argument deltas keyed by call id", async () => {
    const observation = await harvestStream(
      eventsOf([
        runStarted(),
        toolStart("call-1", "record_finding"),
        toolStart("call-2", "other"),
        toolArgs("call-2", '{"x":1}'),
        toolArgs("call-1", '{"findingKey":"dea'),
        toolArgs("call-1", 'dline","knowledgeState":"known"}'),
        toolEnd("call-1", "record_finding"),
        runFinished(),
      ]),
    );
    expect(observation.toolCalls).toHaveLength(2);
    const first = observation.toolCalls.find((call) => call.id === "call-1");
    expect(first?.name).toBe("record_finding");
    expect(JSON.parse(first?.rawArguments ?? "{}")).toEqual({
      findingKey: "deadline",
      knowledgeState: "known",
    });
  });

  it("captures the failure code from RUN_ERROR and keeps provider text out", async () => {
    const observation = await harvestStream(eventsOf([runStarted(), runError(404)]));
    expect(observation.failed).toBe(true);
    expect(observation.failureCode).toBe(404);
    expect(JSON.stringify(observation)).not.toContain("provider text");
  });

  it("drains tool calls the stream ended without closing", async () => {
    const observation = await harvestStream(
      eventsOf([runStarted(), toolStart("call-1", "record_finding"), toolArgs("call-1", '{"a":1}')]),
    );
    expect(observation.toolCalls).toHaveLength(1);
    expect(observation.toolCalls[0]?.rawArguments).toBe('{"a":1}');
  });

  it("lets the later run event correct the observed model", async () => {
    const observation = await harvestStream(
      eventsOf([runStarted("requested/model"), textDelta("x"), runFinished("observed/model")]),
    );
    expect(observation.observedModel).toBe("observed/model");
  });
});

describe("chat provider output decode (harvest -> decode -> record)", () => {
  it("decodes a plain text turn and records the observed model/usage", async () => {
    const fake = fakeStreamAttempts({
      "model-a": [runStarted("model-a"), textDelta("odp"), runFinished("model-a", tinyUsage)],
    });
    const result = await chatWithRoute(
      credentials,
      "chat_analysis",
      route,
      { messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }] },
      fake.attempt,
    );
    expect(result.outcome.outcome).toBe("succeeded");
    if (result.outcome.outcome === "succeeded") {
      // The plain-call value type is the real ChatTurnResult: no casts.
      const turn = result.outcome.value;
      expect(turn.text).toBe("odp");
      expect(turn.toolCalls).toEqual([]);
      expect(turn.finishReason).toBe("stop");
    }
    expect(result.record.attempts).toHaveLength(1);
    const attempt = result.record.attempts[0];
    expect(attempt?.requestedModel).toBe("model-a");
    expect(attempt?.observedModel).toBe("model-a");
    expect(attempt?.usage?.totalTokens).toBe(6);
    expect(attempt?.usage?.costUsd).toBe(0.000001);
    expect(attempt?.routingConfigVersion).toBe("e2.0");
    expect(fake.calls).toEqual(["model-a"]);
  });

  it("decodes tool arguments through the declared Effect Schema", async () => {
    const fake = fakeStreamAttempts({
      "model-a": [
        runStarted(),
        toolStart("call-1", "record_finding"),
        toolArgs("call-1", '{"findingKey":"deadline","knowledgeState":"known"}'),
        toolEnd("call-1", "record_finding"),
        runFinished(),
      ],
    });
    const request: ChatRequest = {
      messages: [{ role: "user", content: [{ kind: "text", text: "ustal" }] }],
      tools: [
        {
          name: "record_finding",
          description: "record one finding",
          input: ProbeToolInput,
        },
      ],
    };
    const result = await chatWithRoute(credentials, "chat_analysis", route, request, fake.attempt);
    expect(result.outcome.outcome).toBe("succeeded");
    if (result.outcome.outcome === "succeeded") {
      const turn = result.outcome.value;
      expect(turn.finishReason).toBe("tool_calls");
      expect(turn.toolCalls[0]?.name).toBe("record_finding");
      expect(turn.toolCalls[0]?.arguments).toEqual({
        findingKey: "deadline",
        knowledgeState: "known",
      });
    }
  });

  it("rejects malformed tool-argument JSON even though the adapter yields empty input", async () => {
    // The pinned adapter silently substitutes input: {} when tool-argument
    // JSON fails to parse (fixture TOOL_CALL_END carries that empty input);
    // Kiero's decode uses the RAW accumulated argument text from the real
    // harvest, so this must fail closed with NO second-model attempt.
    const fake = fakeStreamAttempts({
      "model-a": [
        runStarted(),
        toolStart("call-1", "record_finding"),
        toolArgs("call-1", '{"findingKey": "deadline", '),
        toolEnd("call-1", "record_finding", {}),
        runFinished(),
      ],
    });
    const request: ChatRequest = {
      messages: [{ role: "user", content: [{ kind: "text", text: "ustal" }] }],
      tools: [{ name: "record_finding", description: "record", input: ProbeToolInput }],
    };
    const result = await chatWithRoute(credentials, "chat_analysis", route, request, fake.attempt);
    expect(result.outcome.outcome).toBe("failed");
    if (result.outcome.outcome === "failed") {
      expect(result.outcome.failure.kind).toBe("output_rejected");
      expect(result.outcome.failure.fallbackEligible).toBe(false);
    }
    expect(fake.calls).toEqual(["model-a"]);
  });

  it("rejects an undeclared tool name (unknown_tool, fail closed)", async () => {
    const fake = fakeStreamAttempts({
      "model-a": [
        runStarted(),
        toolStart("call-1", "drop_all_tables"),
        toolArgs("call-1", "{}"),
        toolEnd("call-1", "drop_all_tables"),
        runFinished(),
      ],
    });
    const request: ChatRequest = {
      messages: [{ role: "user", content: [{ kind: "text", text: "ustal" }] }],
      tools: [{ name: "record_finding", description: "record", input: ProbeToolInput }],
    };
    const result = await chatWithRoute(credentials, "chat_analysis", route, request, fake.attempt);
    expect(result.outcome.outcome).toBe("failed");
    if (result.outcome.outcome === "failed") {
      expect(result.outcome.failure.kind).toBe("unknown_tool");
    }
    expect(fake.calls).toEqual(["model-a"]);
  });

  it("rejects tool arguments outside the declared enum vocabulary", async () => {
    const fake = fakeStreamAttempts({
      "model-a": [
        runStarted(),
        toolStart("call-1", "record_finding"),
        toolArgs("call-1", '{"findingKey":"deadline","knowledgeState":"maybe"}'),
        toolEnd("call-1", "record_finding"),
        runFinished(),
      ],
    });
    const request: ChatRequest = {
      messages: [{ role: "user", content: [{ kind: "text", text: "ustal" }] }],
      tools: [{ name: "record_finding", description: "record", input: ProbeToolInput }],
    };
    const result = await chatWithRoute(credentials, "chat_analysis", route, request, fake.attempt);
    expect(result.outcome.outcome).toBe("failed");
    if (result.outcome.outcome === "failed") {
      expect(result.outcome.failure.kind).toBe("output_rejected");
    }
  });

  it("decodes structured output assembled from fragmented text deltas", async () => {
    const fake = fakeStreamAttempts({
      "model-a": [
        runStarted(),
        textDelta('{"od'),
        textDelta('p":"ta'),
        textDelta('k"}'),
        runFinished(),
      ],
    });
    const result = await structuredChatWithRoute(
      credentials,
      "chat_analysis",
      route,
      {
        messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
        outputSchema: ProbeOutput,
      },
      fake.attempt,
    );
    expect(result.outcome.outcome).toBe("succeeded");
    if (result.outcome.outcome === "succeeded" && !("toolCalls" in result.outcome.value)) {
      // Narrowed to the codec's type: the value is typed, not re-decoded.
      expect(result.outcome.value.odp).toBe("tak");
    }
  });

  it("rejects malformed structured-output JSON (fail closed, no fallback)", async () => {
    const fake = fakeStreamAttempts({
      "model-a": [runStarted(), textDelta('{"odp": "tak'), runFinished()],
    });
    const result = await structuredChatWithRoute(
      credentials,
      "chat_analysis",
      route,
      {
        messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
        outputSchema: ProbeOutput,
      },
      fake.attempt,
    );
    expect(result.outcome.outcome).toBe("failed");
    if (result.outcome.outcome === "failed") {
      expect(result.outcome.failure.kind).toBe("output_rejected");
    }
    expect(fake.calls).toEqual(["model-a"]);
  });

  it("rejects schema-mismatching structured output (image claims, wrong shape)", async () => {
    const fake = fakeStreamAttempts({
      "model-a": [runStarted(), textDelta('{"claim":"obiecal rurke"}'), runFinished()],
    });
    const result = await structuredChatWithRoute(
      credentials,
      "chat_analysis",
      route,
      {
        messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
        outputSchema: ProbeOutput,
      },
      fake.attempt,
    );
    expect(result.outcome.outcome).toBe("failed");
    if (result.outcome.outcome === "failed") {
      expect(result.outcome.failure.kind).toBe("output_rejected");
    }
  });

  it("classifies a code-less stream failure as eligible route unavailability", async () => {
    // The pinned adapter reports HTTP-level failures as RUN_ERROR events
    // without a numeric code; classification must still walk the order.
    const fake = fakeStreamAttempts({
      "model-a": [runStarted(), runError()],
      "model-b": [runStarted("model-b"), textDelta("odp"), runFinished("model-b")],
    });
    const result = await chatWithRoute(
      credentials,
      "chat_analysis",
      route,
      { messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }] },
      fake.attempt,
    );
    expect(result.outcome.outcome).toBe("succeeded");
    expect(fake.calls).toEqual(["model-a", "model-b"]);
    expect(result.record.attempts[0]?.failureKind).toBe("provider_unavailable");
    expect(result.record.attempts[1]?.observedModel).toBe("model-b");
  });
});
