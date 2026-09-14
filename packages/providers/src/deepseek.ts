/**
 * The DIRECT DeepSeek transport (E8): one bounded streaming request against
 * `POST https://api.deepseek.com/responses`, mapped onto the same AG-UI event
 * vocabulary `@tanstack/ai-openrouter` emits, so the existing harvest
 * (`harvestStream`), typed decode and ordered-route recording serve the
 * direct provider unchanged.
 *
 * Why a repository-owned transport instead of the researched
 * `@tanstack/ai-openai` candidate (ADR "adapter selection"): Kiero must own
 * the exact wire contract the issue demands be proved — explicit thinking
 * mode (`reasoning: { effort: "none" }`), native Responses JSON-Schema
 * output, native tool rounds, terminal-state classification
 * (`response.incomplete` / `response.failed` must NEVER decode as success)
 * and final usage collection. A generic OpenAI-compatible adapter does not
 * prove those cases (issue criterion: generic compatibility is not proof),
 * and adopting it would add a dependency graph movement the pinned core
 * does not need. Every wire fact below was verified against the live direct
 * API on 2026-09-14 (docs/evidence/ai/provider-migration/).
 *
 * Wire contract (verified live, sources [D10], [D11] in
 * docs/research/deepseek-direct-api-facts.md):
 * - Bearer `DEEPSEEK_API_KEY`; canonical base, no `/v1` suffix.
 * - `instructions` carries the system prompt; `input` accepts message items
 *   (`input_text` / `input_image` data URLs in user messages) and native
 *   tool-round items (`function_call` / `function_call_output`).
 * - `text.format: { type: "json_schema", name, strict, schema }` is the
 *   documented JSON-Schema output path (the Chat Completions enum stops at
 *   `json_object`, which would be a generation-contract relaxation no owner
 *   has accepted).
 * - Streams are SSE; observed event sequence: `response.created` ->
 *   `response.in_progress` -> `response.output_item.added` ->
 *   `response.content_part.added` -> `response.output_text.delta` ->
 *   `response.output_text.done` -> `response.content_part.done` ->
 *   `response.output_item.done` -> `response.completed` (function calls
 *   arrive as `function_call` items with `response.function_call_arguments.
 *   delta` fragments keyed by the OUTPUT ITEM id, not the call id).
 * - Terminal events: `response.completed` (usage on `response.usage`),
 *   `response.incomplete` (truncated; must not decode as success),
 *   `response.failed`. There is no `[DONE]` marker; a stream that ends
 *   without a terminal event is a provider-side protocol failure.
 * - Usage fields: `input_tokens` / `output_tokens` / `total_tokens` (plus
 *   cache/reasoning details Kiero's record contract does not carry). No
 *   request-cost field exists, so no `costUsd` is ever reported for direct
 *   attempts — absent is not zero.
 *
 * Sanitization: provider response bodies, error payloads and the API key
 * have nowhere to go here. Non-2xx statuses surface as a numeric RUN_ERROR
 * code only; the body is never read.
 */

import { type AdapterYieldChunk, EventType } from "@tanstack/ai";
import type { ChatContent, ChatMessagePart } from "./chat";
import { DEEPSEEK_API_BASE_URL } from "./routing";

/** Server-side direct DeepSeek credentials; never constructed from client input. */
export interface DeepSeekCredentials {
  readonly apiKey: string;
}

/**
 * The server-held direct DeepSeek key from the environment; presence only,
 * never its value. Canonical reader (E8): the chat/vision entry points call
 * it when a caller did not inject `deepseekApiKey` explicitly, matching the
 * `openRouterCredentialsFromEnv` precedent.
 */
export function deepSeekCredentialsFromEnv(): DeepSeekCredentials | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return null;
  }
  return { apiKey };
}

/** One declared tool on the direct wire (JSON Schema, no `strict` flag). */
export interface DeepSeekToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

/** The native JSON-Schema output format for a direct structured request. */
export interface DeepSeekStructuredFormat {
  readonly name: string;
  readonly schema: Record<string, unknown>;
}

/** One bounded direct streaming request, already provider-shaped. */
export interface DeepSeekResponsesCall {
  readonly model: string;
  readonly messages: readonly ChatMessagePart[];
  readonly systemPrompt?: string;
  readonly tools?: readonly DeepSeekToolDeclaration[];
  readonly outputSchema?: DeepSeekStructuredFormat;
  /** Application-owned output budget (`max_output_tokens`). */
  readonly maxOutputTokens: number;
  /** The caller's deadline signal (the ordered runner owns the deadline). */
  readonly signal?: AbortSignal;
}

/** Maps a Responses usage object onto the harvest's usage vocabulary. */
function mapUsage(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const usage = raw as Record<string, unknown>;
  const mapped: Record<string, number> = {};
  if (typeof usage.input_tokens === "number") {
    mapped.promptTokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    mapped.completionTokens = usage.output_tokens;
  }
  if (typeof usage.total_tokens === "number") {
    mapped.totalTokens = usage.total_tokens;
  }
  // DeepSeek reports no request cost; `costUsd` stays absent (not zero).
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/** Builds the wire `input` items from the typed message parts. */
function toInputItems(messages: readonly ChatMessagePart[]): unknown[] {
  const items: unknown[] = [];
  for (const message of messages) {
    if (message.role === "assistant-tool-calls") {
      for (const call of message.calls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
      continue;
    }
    if (message.role === "tool-result") {
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }
    items.push({
      role: message.role,
      content: message.content.map((part: ChatContent) =>
        part.kind === "text"
          ? { type: "input_text", text: part.text }
          : {
              type: "input_image",
              // Inline base64 data URL; the documented direct vision input
              // (JPEG/PNG/GIF/WebP detected from bytes).
              image_url: `data:${part.mimeType};base64,${part.base64}`,
            },
      ),
    });
  }
  return items;
}

/** Builds the request body for one direct streaming call. */
function toRequestBody(call: DeepSeekResponsesCall): Record<string, unknown> {
  return {
    model: call.model,
    ...(call.systemPrompt === undefined ? {} : { instructions: call.systemPrompt }),
    input: toInputItems(call.messages),
    // EXPLICIT non-thinking selection (ADR): reasoning replay for thinking
    // tool loops is an unproven continuation contract, so E8 pins effort
    // "none" — the documented Responses non-thinking switch.
    reasoning: { effort: "none" },
    max_output_tokens: call.maxOutputTokens,
    stream: true,
    ...(call.tools === undefined || call.tools.length === 0
      ? {}
      : {
          tools: call.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }),
    ...(call.outputSchema === undefined
      ? {}
      : {
          text: {
            format: {
              type: "json_schema",
              name: call.outputSchema.name,
              strict: true,
              schema: call.outputSchema.schema,
            },
          },
        }),
  };
}

/**
 * A sanitized RUN_ERROR chunk: machine code only, never provider text.
 * Numeric HTTP statuses are stringified; `classifyChatFailure` parses
 * numeric strings back into status classification.
 */
function runError(runId: string, code: string | number): AdapterYieldChunk {
  return {
    type: EventType.RUN_ERROR,
    runId,
    timestamp: Date.now(),
    // Fixed sanitized literals: the provider's message text never travels.
    message: "deepseek transport failure",
    code: String(code),
    error: { message: "deepseek transport failure", code: String(code) },
  };
}

/**
 * Runs ONE bounded direct DeepSeek request and yields the AG-UI event
 * sequence the shared harvest consumes. Never throws across the seam:
 * every failure (HTTP status, network, abort, malformed frame, terminal
 * error state) is reported as a sanitized RUN_ERROR code for
 * `classifyChatFailure`; only a malformed REQUEST (our side) throws, which
 * the chat attempt classifies as `internal_error`.
 */
export async function* deepSeekResponsesStream(
  credentials: DeepSeekCredentials,
  call: DeepSeekResponsesCall,
): AsyncGenerator<AdapterYieldChunk> {
  const runId = `ds-${Date.now()}`;
  const threadId = runId;
  const messageId = `${runId}-m`;
  let textStarted = false;
  // Output items being streamed: the SSE argument deltas key by the OUTPUT
  // ITEM id while the tool round-trip (and the harvest) keys by call id.
  const openCalls = new Map<string, { callId: string; name: string }>();
  let sawFunctionCall = false;
  let sawTerminal = false;
  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_API_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(toRequestBody(call)),
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
  } catch (cause) {
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
      yield runError(runId, "aborted");
      return;
    }
    // fetch rejects on network-level failure before any provider response.
    yield runError(runId, "network_error");
    return;
  }
  if (!response.ok || response.body === null) {
    // Status only: the error body is provider-controlled and stays unread.
    yield runError(runId, response.status);
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let malformedFrame = false;
  /** The one RUN_FINISHED literal every terminal finish shares. */
  const runFinished = (
    model: unknown,
    finishReason: "stop" | "tool_calls" | "length" | "content_filter",
    usage: Record<string, number> | undefined,
  ): AdapterYieldChunk => ({
    type: EventType.RUN_FINISHED,
    runId,
    threadId,
    timestamp: Date.now(),
    ...(typeof model === "string" && model.length > 0 ? { model } : {}),
    finishReason,
    ...(usage === undefined ? {} : { usage }),
  });
  /** Maps one parsed wire event onto the AG-UI chunks the harvest consumes. */
  function* mapEvent(event: unknown): Generator<AdapterYieldChunk> {
    if (typeof event !== "object" || event === null) {
      return;
    }
    const typed = event as Record<string, unknown>;
    switch (typed.type) {
      case "response.created":
      case "response.in_progress": {
        const model = (typed.response as Record<string, unknown> | undefined)?.model;
        yield {
          type: EventType.RUN_STARTED,
          runId,
          threadId,
          timestamp: Date.now(),
          ...(typeof model === "string" && model.length > 0 ? { model } : {}),
        };
        break;
      }
      case "response.output_item.added": {
        const item = typed.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          sawFunctionCall = true;
          const itemId = item.id;
          const callId = item.call_id;
          const name = item.name;
          if (typeof itemId === "string" && typeof callId === "string" && typeof name === "string") {
            openCalls.set(itemId, { callId, name });
            yield {
              type: EventType.TOOL_CALL_START,
              runId,
              timestamp: Date.now(),
              toolCallId: callId,
              toolCallName: name,
            };
          }
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const itemId = typed.item_id;
        const delta = typed.delta;
        const open = typeof itemId === "string" ? openCalls.get(itemId) : undefined;
        if (open !== undefined && typeof delta === "string") {
          yield {
            type: EventType.TOOL_CALL_ARGS,
            runId,
            timestamp: Date.now(),
            toolCallId: open.callId,
            delta,
          };
        }
        break;
      }
      case "response.function_call_arguments.done":
      case "response.output_item.done": {
        const item = typed.item as Record<string, unknown> | undefined;
        if (typed.type === "response.output_item.done" && item?.type !== "function_call") {
          break;
        }
        const itemId =
          typed.type === "response.function_call_arguments.done" ? typed.item_id : item?.id;
        if (typeof itemId !== "string") {
          break;
        }
        const open = openCalls.get(itemId);
        if (open === undefined) {
          break;
        }
        openCalls.delete(itemId);
        yield {
          type: EventType.TOOL_CALL_END,
          runId,
          timestamp: Date.now(),
          toolCallId: open.callId,
          toolCallName: open.name,
        };
        break;
      }
      case "response.output_text.delta": {
        const delta = typed.delta;
        if (typeof delta === "string" && delta.length > 0) {
          if (!textStarted) {
            textStarted = true;
            yield {
              type: EventType.TEXT_MESSAGE_START,
              runId,
              threadId,
              messageId,
              timestamp: Date.now(),
              role: "assistant",
            };
          }
          yield {
            type: EventType.TEXT_MESSAGE_CONTENT,
            runId,
            messageId,
            timestamp: Date.now(),
            delta,
          };
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        sawTerminal = true;
        const finished = typed.response as Record<string, unknown> | undefined;
        const model = finished?.model;
        const usage = mapUsage(finished?.usage);
        if (typed.type === "response.completed") {
          yield runFinished(model, sawFunctionCall ? "tool_calls" : "stop", usage);
          break;
        }
        // Incomplete: the generation stopped before a whole answer. Known
        // reasons (observed live 2026-09-14: incomplete_details.reason =
        // "max_output_tokens") map onto the harvest's finish vocabulary so
        // the typed decode rejects truncated output TERMINALLY; unknown
        // reasons stay a classified provider failure (eligible) rather than
        // a silent acceptance.
        const details = finished?.incomplete_details as { reason?: unknown } | undefined;
        const reason = details?.reason;
        if (reason === "max_output_tokens") {
          yield runFinished(model, "length", usage);
        } else if (reason === "content_filter") {
          yield runFinished(model, "content_filter", usage);
        } else {
          yield runError(runId, "incomplete");
        }
        break;
      }
      case "response.failed":
      case "error": {
        sawTerminal = true;
        const failed = typed.response as Record<string, unknown> | undefined;
        const error = (typed.error ?? failed?.error) as Record<string, unknown> | undefined;
        const code = error?.code;
        yield runError(runId, typeof code === "number" ? code : "response_failed");
        break;
      }
      default:
        // response.content_part.*, reasoning summaries, unknown events:
        // content parts carry no harvestable payload; reasoning is disabled
        // and must never be surfaced as answer text.
        break;
    }
  }
  /** Parses one SSE line; sets the malformed flag when the frame is junk. */
  function* processLine(rawLine: string): Generator<AdapterYieldChunk> {
    const line = rawLine.trimEnd();
    // SSE `data:` lines carry the JSON events; `event:` lines and
    // `: keep-alive` comments carry nothing the mapping needs.
    if (!line.startsWith("data:")) {
      return;
    }
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      malformedFrame = true;
      yield runError(runId, "malformed_stream");
      return;
    }
    yield* mapEvent(event);
  }
  try {
    let done = false;
    while (!done) {
      const read = await reader.read();
      done = read.done;
      buffer += decoder.decode(read.value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        yield* processLine(line);
        if (malformedFrame) {
          return;
        }
      }
    }
    // A stream can close mid-frame: the final unterminated data line still
    // belongs to the response, so a terminal event arriving without its
    // trailing newline must not degrade to `stream_terminated`.
    yield* processLine(buffer);
  } catch (cause) {
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
      yield runError(runId, "aborted");
      return;
    }
    yield runError(runId, "network_error");
    return;
  } finally {
    reader.releaseLock();
  }
  if (!sawTerminal) {
    // A Responses stream must end with completed/incomplete/failed; its
    // absence is a provider-side protocol failure, never a silent success.
    yield runError(runId, "stream_terminated");
    return;
  }
  // Calls the stream ended without closing still count downstream: the
  // harvest drains pending TOOL_CALL_START entries by design.
}
