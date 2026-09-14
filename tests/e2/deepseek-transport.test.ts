/**
 * E8 focused verification: the DIRECT DeepSeek transport, offline.
 *
 * FIXTURES ARE SYNTHETIC SSE frames matching the event vocabulary observed
 * live on `POST https://api.deepseek.com/responses` on 2026-09-14
 * (evidence: docs/evidence/ai/provider-migration/). `fetch` is stubbed; no
 * network runs here. The REAL transport (`deepSeekResponsesStream`), the
 * REAL harvest (`harvestStream`) and the REAL dispatch (`chatAttempt`) are
 * exercised end to end:
 *
 * - the exact request body (thinking explicitly disabled, native Responses
 *   JSON-Schema output, function tools, `input_image` data URLs, native
 *   tool-round replay) and credential routing per provider;
 * - the event mapping (text deltas, function_call items keyed by the
 *   output-item id, terminal states);
 * - terminal-state classification: `response.incomplete` and
 *   `response.failed` never decode as success;
 * - sanitization: provider error bodies are never read, the API key never
 *   appears in any emitted chunk.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  CHAT_ATTEMPT_DEADLINE_MS,
  DEEPSEEK_API_BASE_URL,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  chatAttempt,
  chatWithRoute,
  deepSeekResponsesStream,
  harvestStream,
  type ChatTurnCredentials,
  type RouteTarget,
} from "@kiero/providers";

/** Fixture credentials; the stubbed fetch never leaves the process. */
const DEEPSEEK_KEY = "test-only-not-a-real-deepseek-key";
const credentials: ChatTurnCredentials = {
  apiKey: "test-only-not-a-real-openrouter-key",
  deepseekApiKey: DEEPSEEK_KEY,
};
const directTarget: RouteTarget = { provider: "deepseek", model: "deepseek-flash" };

/** Captured fetch calls (url + init) for request-shape assertions. */
const fetchCalls: { url: string; init: RequestInit }[] = [];

/** Builds one SSE frame from a wire event object. */
function frame(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** Builds a 200 SSE Response carrying the given frames. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of frames) {
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Stubs global fetch with a per-call script of Response producers. */
function stubFetch(script: ((init: RequestInit) => Response)[]) {
  let call = 0;
  fetchCalls.length = 0;
  vi.stubGlobal("fetch", (async (_url: string | URL | Request, init: RequestInit) => {
    fetchCalls.push({ url: String(_url), init });
    const produce = script[Math.min(call, script.length - 1)];
    call += 1;
    if (produce === undefined) {
      throw new Error("unexpected fetch");
    }
    return produce(init);
  }) as typeof fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const created = (model = "deepseek-flash") =>
  frame({ type: "response.created", response: { model } });

const completed = (model = "deepseek-flash", output: unknown[] = []) =>
  frame({
    type: "response.completed",
    response: {
      model,
      status: "completed",
      output,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });

describe("request shape (the exact direct wire contract)", () => {
  it("sends the documented Responses body: non-thinking, bounded, schema-constrained, native tools", async () => {
    stubFetch([() => sseResponse([created(), completed()])]);
    const ProbeOutput = Schema.Struct({
      odp: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    });
    await chatAttempt(credentials, directTarget, {
      messages: [
        { role: "user", content: [{ kind: "text", text: "pytanie" }] },
        { role: "assistant-tool-calls", calls: [{ id: "call_1", name: "szukaj", arguments: "{}" }] },
        { role: "tool-result", toolCallId: "call_1", name: "szukaj", content: "wynik" },
      ],
      systemPrompt: "instrukcja",
      tools: [{ name: "szukaj", description: "szukaj w wiedzy", input: ProbeOutput }],
      outputSchema: ProbeOutput,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(`${DEEPSEEK_API_BASE_URL}/responses`);
    const init = fetchCalls[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${DEEPSEEK_KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe("deepseek-flash");
    expect(body.instructions).toBe("instrukcja");
    // Explicit thinking selection: non-thinking on the Responses wire.
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.max_output_tokens).toBe(DEEPSEEK_MAX_OUTPUT_TOKENS);
    expect(body.stream).toBe(true);
    // Native JSON-Schema output (strict), not json_object relaxation.
    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "kiero_structured_output",
        strict: true,
        schema: expect.any(Object),
      },
    });
    // Function tools without the beta strict flag.
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "szukaj",
        description: "szukaj w wiedzy",
        parameters: expect.any(Object),
      },
    ]);
    // Native tool-round replay: function_call + function_call_output items.
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "pytanie" }] },
      { type: "function_call", call_id: "call_1", name: "szukaj", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "wynik" },
    ]);
  });

  it("maps inline images to input_image data URLs in user messages", async () => {
    stubFetch([() => sseResponse([created(), completed()])]);
    await chatAttempt(credentials, directTarget, {
      messages: [
        {
          role: "user",
          content: [
            { kind: "text", text: "co jest na zdjeciu" },
            { kind: "image", base64: "aW1n", mimeType: "image/png" },
          ],
        },
      ],
    });
    const body = JSON.parse(String(fetchCalls[0]?.init.body)) as { input: unknown[] };
    expect(body.input[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "co jest na zdjeciu" },
        { type: "input_image", image_url: "data:image/png;base64,aW1n" },
      ],
    });
  });
});

describe("credential routing per provider", () => {
  const savedDeepSeek = process.env.DEEPSEEK_API_KEY;

  afterEach(() => {
    if (savedDeepSeek === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = savedDeepSeek;
    }
  });

  it("a deepseek target without any resolvable key fails TERMINALLY without a request", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    let fetched = false;
    vi.stubGlobal("fetch", (async () => {
      fetched = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch);
    const attempt = await chatAttempt(
      { apiKey: "test-only-not-a-real-openrouter-key" },
      directTarget,
      { messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }] },
    );
    expect(fetched).toBe(false);
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.failure.kind).toBe("unauthenticated");
      expect(attempt.failure.fallbackEligible).toBe(false);
    }
  });

  it("an explicit deepseekApiKey routes the direct request even without environment keys", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    stubFetch([() => sseResponse([created(), completed()])]);
    const attempt = await chatAttempt(credentials, directTarget, {
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
    });
    expect(attempt.ok).toBe(true);
    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${DEEPSEEK_KEY}`);
  });

  it("the environment key is the canonical fallback when none is injected", async () => {
    process.env.DEEPSEEK_API_KEY = "test-only-not-a-real-env-key";
    stubFetch([() => sseResponse([created(), completed()])]);
    const attempt = await chatAttempt(
      { apiKey: "test-only-not-a-real-openrouter-key" },
      directTarget,
      { messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }] },
    );
    expect(attempt.ok).toBe(true);
    const headers = fetchCalls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-only-not-a-real-env-key");
  });
});

describe("event mapping (live-observed vocabulary, synthetic frames)", () => {
  it("maps a completed text stream onto the harvest with model and usage", async () => {
    stubFetch([() => sseResponse([created(), completed()])]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 64,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(false);
    expect(observation.observedModel).toBe("deepseek-flash");
    // No cost exists on the direct wire: absent, never zero.
    expect(observation.usage).toEqual({
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    expect(observation.finishReason).toBe("stop");
  });

  it("maps function_call items: argument deltas keyed by output-item id become call-id events", async () => {
    const itemId = "fa72f9b9-7bf7-40aa-837d-4f8e309aab06";
    const frames = [
      created(),
      frame({
        type: "response.output_item.added",
        item: { type: "function_call", id: itemId, status: "in_progress", arguments: "", call_id: "call_00_X", name: "szukaj" },
      }),
      frame({ type: "response.function_call_arguments.delta", item_id: itemId, delta: '{"quer' }),
      frame({ type: "response.function_call_arguments.delta", item_id: itemId, delta: 'y":"rura"}' }),
      frame({ type: "response.function_call_arguments.done", item_id: itemId, arguments: '{"query":"rura"}' }),
      frame({ type: "response.output_item.done", item: { type: "function_call", id: itemId, call_id: "call_00_X", name: "szukaj" } }),
      completed("deepseek-flash", [{ type: "function_call", call_id: "call_00_X", name: "szukaj", arguments: '{"query":"rura"}' }]),
    ];
    stubFetch([() => sseResponse(frames)]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 64,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.toolCalls).toEqual([
      { id: "call_00_X", name: "szukaj", rawArguments: '{"query":"rura"}' },
    ]);
    expect(observation.finishReason).toBe("tool_calls");
  });

  it("a completed stream with no function call finishes stop", async () => {
    const frames = [
      created(),
      frame({ type: "response.in_progress", response: { model: "deepseek-flash" } }),
      frame({ type: "response.output_text.delta", delta: '{"odp":"ta' }),
      frame({ type: "response.output_text.delta", delta: 'k"}' }),
      completed(),
    ];
    stubFetch([() => sseResponse(frames)]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 64,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.text).toBe('{"odp":"tak"}');
    expect(observation.finishReason).toBe("stop");
  });
});

describe("terminal-state classification (never a silent success)", () => {
  it("response.incomplete with max_output_tokens finishes length (decode rejects it)", async () => {
    const frames = [
      created(),
      frame({ type: "response.output_text.delta", delta: '{"odp":"' }),
      frame({
        type: "response.incomplete",
        response: { model: "deepseek-flash", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 } },
      }),
    ];
    stubFetch([() => sseResponse(frames)]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(false);
    expect(observation.finishReason).toBe("length");
  });

  it("response.incomplete with content_filter finishes content_filter", async () => {
    const frames = [
      created(),
      frame({
        type: "response.incomplete",
        response: { model: "deepseek-flash", status: "incomplete", incomplete_details: { reason: "content_filter" } },
      }),
    ];
    stubFetch([() => sseResponse(frames)]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.finishReason).toBe("content_filter");
  });

  it("an unknown incomplete reason stays a classified eligible provider failure", async () => {
    const frames = [
      created(),
      frame({
        type: "response.incomplete",
        response: { model: "deepseek-flash", status: "incomplete", incomplete_details: { reason: "something_new" } },
      }),
    ];
    stubFetch([() => sseResponse(frames)]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(true);
    expect(observation.failureCode).toBe("incomplete");
  });

  it("response.failed reports a sanitized classified failure", async () => {
    const frames = [
      created(),
      frame({
        type: "response.failed",
        response: { status: "failed", error: { code: "server_error", message: "provider secret text" } },
      }),
    ];
    stubFetch([() => sseResponse(frames)]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(true);
    expect(observation.failureCode).toBe("response_failed");
    // Provider-controlled text never travels: only the machine code does.
    expect(JSON.stringify(observation)).not.toContain("provider secret text");
  });

  it("a stream that ends without a terminal event is a provider protocol failure", async () => {
    const frames = [created(), frame({ type: "response.output_text.delta", delta: "czesc" })];
    stubFetch([() => sseResponse(frames)]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(true);
    expect(observation.failureCode).toBe("stream_terminated");
  });

  it("honors a terminal frame the stream closed without its trailing newline", async () => {
    // The stream ends mid-frame: the completed event's data line never got
    // its newline terminator. The unparsed tail must still be processed, so
    // a RECEIVED terminal event is honored instead of degrading to
    // stream_terminated.
    const terminated = created() + completed();
    const unterminated = terminated.slice(0, -2);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(unterminated));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(false);
    expect(observation.observedModel).toBe("deepseek-flash");
    expect(observation.finishReason).toBe("stop");
    expect(observation.usage?.totalTokens).toBe(18);
  });
});

describe("transport-level failure classification (HTTP, network, framing)", () => {
  it("a non-2xx status reports the status code only; the error body is never read", async () => {
    vi.stubGlobal("fetch", (async () =>
      // No body at all: nothing to read, nothing to leak.
      new Response(null, { status: 503 })) as typeof fetch);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(true);
    expect(observation.failureCode).toBe("503");
  });

  it("a fetch-level network failure classifies as connection-level (eligible)", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(true);
    expect(observation.failureCode).toBe("network_error");
  });

  it("an aborted request classifies as deadline (eligible)", async () => {
    vi.stubGlobal("fetch", (async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }) as typeof fetch);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failureCode).toBe("aborted");
  });

  it("a malformed SSE frame classifies as a provider framing failure", async () => {
    stubFetch([() => sseResponse(["data: {not json\n\n"])]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    const observation = await harvestStream(chunks as never);
    expect(observation.failed).toBe(true);
    expect(observation.failureCode).toBe("malformed_stream");
  });

  it("no emitted chunk ever carries the API key or provider text", async () => {
    const frames = [
      created(),
      frame({ type: "response.output_text.delta", delta: "tekst" }),
      frame({
        type: "response.failed",
        response: { status: "failed", error: { code: 500, message: `secret ${DEEPSEEK_KEY}` } },
      }),
    ];
    stubFetch([() => sseResponse(frames)]);
    const chunks = [];
    for await (const chunk of deepSeekResponsesStream({ apiKey: DEEPSEEK_KEY }, {
      model: "deepseek-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
      maxOutputTokens: 8,
    })) {
      chunks.push(chunk);
    }
    expect(JSON.stringify(chunks)).not.toContain(DEEPSEEK_KEY);
  });

  it("the deadline constant stays bounded (the runner owns per-attempt time)", () => {
    expect(CHAT_ATTEMPT_DEADLINE_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("multi-turn tools through the real decode (offline two-round loop)", () => {
  const ProbeToolInput = Schema.Struct({
    query: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  });

  /** Round 1: the model calls the tool; round 2: it answers from the result. */
  function twoRoundScript() {
    const itemId = "item-1";
    const round1 = sseResponse([
      created(),
      frame({
        type: "response.output_item.added",
        item: { type: "function_call", id: itemId, status: "in_progress", arguments: "", call_id: "call_00_R1", name: "szukaj" },
      }),
      frame({ type: "response.function_call_arguments.delta", item_id: itemId, delta: '{"query' }),
      frame({ type: "response.function_call_arguments.delta", item_id: itemId, delta: '":"rura"}' }),
      frame({ type: "response.function_call_arguments.done", item_id: itemId, arguments: '{"query":"rura"}' }),
      completed("deepseek-flash", [{ type: "function_call", call_id: "call_00_R1", name: "szukaj", arguments: '{"query":"rura"}' }]),
    ]);
    const round2 = sseResponse([
      created(),
      frame({ type: "response.output_text.delta", delta: "Termin dostawy rur to 20 wrzesnia." }),
      completed(),
    ]);
    return [() => round1, () => round2];
  }

  it("decodes the call round, then replays it natively and decodes the answer round", async () => {
    stubFetch(twoRoundScript());
    const baseMessages = [
      { role: "user" as const, content: [{ kind: "text" as const, text: "Kiedy dostawa rur?" }] },
    ];
    const tools = [
      { name: "szukaj", description: "szukaj w wiedzy firmy", input: ProbeToolInput },
    ];
    const round1 = await chatWithRoute(
      credentials,
      "chat_analysis",
      { order: [directTarget] },
      { messages: baseMessages, tools },
      chatAttempt,
    );
    expect(round1.outcome.outcome).toBe("succeeded");
    if (round1.outcome.outcome !== "succeeded") {
      throw new Error("round 1 failed");
    }
    expect(round1.outcome.value.finishReason).toBe("tool_calls");
    const call = round1.outcome.value.toolCalls[0];
    expect(call?.arguments).toEqual({ query: "rura" });

    // The consumer executed the call and appends the NATIVE tool round.
    const round2 = await chatWithRoute(
      credentials,
      "chat_analysis",
      { order: [directTarget] },
      {
        messages: [
          ...baseMessages,
          {
            role: "assistant-tool-calls",
            calls: [{ id: call?.id ?? "", name: call?.name ?? "", arguments: JSON.stringify(call?.arguments) }],
          },
          { role: "tool-result", toolCallId: call?.id ?? "", name: call?.name ?? "", content: "dostawa 20.09" },
        ],
        tools,
      },
      chatAttempt,
    );
    expect(round2.outcome.outcome).toBe("succeeded");
    if (round2.outcome.outcome === "succeeded") {
      expect(round2.outcome.value.text).toContain("wrzesnia");
    }
    // The replayed request carried the native function_call round.
    const replayBody = JSON.parse(String(fetchCalls[1]?.init.body)) as { input: unknown[] };
    expect(replayBody.input[1]).toEqual({
      type: "function_call",
      call_id: "call_00_R1",
      name: "szukaj",
      arguments: '{"query":"rura"}',
    });
    expect(replayBody.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_00_R1",
      output: "dostawa 20.09",
    });
  });
});
