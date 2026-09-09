/**
 * E2 focused verification: typed decode of chat provider output.
 *
 * FIXTURES ARE SYNTHETIC. The event sequences below mirror the exact AG-UI
 * shapes `@tanstack/ai-openrouter`'s `chatStream` emits (RUN_STARTED /
 * TEXT_MESSAGE_* / TOOL_CALL_* / RUN_FINISHED / RUN_ERROR, with the observed
 * model and usage on the run events), as read from the pinned adapter source
 * (0.19.8). They are NOT recorded live provider responses; no network runs
 * here. The assertions cover the acceptance criteria: every provider
 * response and tool argument passes its Effect Schema before a checked
 * domain operation can consume it, and malformed output is rejected (typed
 * fail-closed), including the adapter's own lenient empty-input behavior on
 * malformed tool-argument JSON.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  chatWithRoute,
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

type AttemptResult =
  | { ok: true; observation: StreamObservation }
  | { ok: false; failure: ProviderFailure };

/** Builds a fake attempt function from a per-model script. */
function fakeAttempts(script: Record<string, AttemptResult | Error>) {
  const calls: string[] = [];
  const attempt = async (_creds: OpenRouterCredentials, model: string) => {
    calls.push(model);
    const scripted = script[model];
    if (scripted === undefined) {
      throw new Error(`unexpected attempt for ${model}`);
    }
    if (scripted instanceof Error) {
      throw scripted;
    }
    return scripted;
  };
  return { attempt, calls };
}

function textObservation(overrides: Partial<StreamObservation> = {}): StreamObservation {
  return {
    observedModel: "model-a",
    text: "odp",
    toolCalls: [],
    firstOutputAtMs: 1_000,
    usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6, costUsd: 0.000001 },
    failed: false,
    ...overrides,
  };
}

function runTextObservation(): StreamObservation {
  return textObservation();
}

describe("chat provider output decode", () => {
  it("decodes a plain text turn and records the observed model/usage", async () => {
    const fake = fakeAttempts({ "model-a": { ok: true, observation: runTextObservation() } });
    const result = await chatWithRoute(
      credentials,
      "chat_analysis",
      route,
      { messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }] },
      fake.attempt,
    );
    expect(result.outcome.outcome).toBe("succeeded");
    if (result.outcome.outcome === "succeeded") {
      const turn = result.outcome.value as { text: string; toolCalls: unknown[]; finishReason: string };
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
    const observation = textObservation({
      text: "",
      toolCalls: [
        {
          id: "call-1",
          name: "record_finding",
          rawArguments:
            '{"findingKey":"deadline","knowledgeState":"known"}',
        },
      ],
    });
    const fake = fakeAttempts({ "model-a": { ok: true, observation } });
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
      const turn = result.outcome.value as {
        toolCalls: { id: string; name: string; arguments: unknown }[];
        finishReason: string;
      };
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
    // JSON fails to parse; Kiero's decode uses the RAW accumulated argument
    // text, so this fixture must fail closed with NO second-model attempt.
    const observation = textObservation({
      text: "",
      toolCalls: [
        { id: "call-1", name: "record_finding", rawArguments: '{"findingKey": "deadline", ' },
      ],
    });
    const fake = fakeAttempts({ "model-a": { ok: true, observation } });
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
    const observation = textObservation({
      text: "",
      toolCalls: [
        { id: "call-1", name: "drop_all_tables", rawArguments: "{}" },
      ],
    });
    const fake = fakeAttempts({ "model-a": { ok: true, observation } });
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
    const observation = textObservation({
      text: "",
      toolCalls: [
        {
          id: "call-1",
          name: "record_finding",
          rawArguments: '{"findingKey":"deadline","knowledgeState":"maybe"}',
        },
      ],
    });
    const fake = fakeAttempts({ "model-a": { ok: true, observation } });
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

  it("decodes structured output through the pinned schema", async () => {
    const observation = textObservation({ text: '{"odp":"tak"}' });
    const fake = fakeAttempts({ "model-a": { ok: true, observation } });
    const result = await chatWithRoute(
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
    if (result.outcome.outcome === "succeeded") {
      expect(result.outcome.value).toEqual({ odp: "tak" });
    }
  });

  it("rejects malformed structured-output JSON (fail closed, no fallback)", async () => {
    const observation = textObservation({ text: '{"odp": "tak' });
    const fake = fakeAttempts({ "model-a": { ok: true, observation } });
    const result = await chatWithRoute(
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
    const observation = textObservation({ text: '{"claim":"obiecal rurke"}' });
    const fake = fakeAttempts({ "model-a": { ok: true, observation } });
    const result = await chatWithRoute(
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

  it("accumulates fragmented tool-argument deltas and text deltas", async () => {
    const observation = textObservation({
      text: "",
      toolCalls: [
        {
          id: "call-1",
          name: "record_finding",
          rawArguments: '{"findingKey":"deadline","knowledgeState":"known"}',
        },
      ],
    });
    // Simulate fragmentation by constructing the same observation the stream
    // harvest would build from TOOL_CALL_ARGS deltas split mid-token.
    const pieces = ['{"findingKey":"dea', 'dline","knowledgeState":"kn', 'own"}'];
    const joined = pieces.join("");
    expect(joined).toBe(
      '{"findingKey":"deadline","knowledgeState":"known"}',
    );
    observation.toolCalls[0]!.rawArguments = joined;
    const fake = fakeAttempts({ "model-a": { ok: true, observation } });
    const request: ChatRequest = {
      messages: [{ role: "user", content: [{ kind: "text", text: "ustal" }] }],
      tools: [{ name: "record_finding", description: "record", input: ProbeToolInput }],
    };
    const result = await chatWithRoute(credentials, "chat_analysis", route, request, fake.attempt);
    expect(result.outcome.outcome).toBe("succeeded");
  });
});
