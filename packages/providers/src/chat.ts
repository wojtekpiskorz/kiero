/**
 * The chat adapter over TanStack AI's OpenRouter Chat Completions forwarding
 * (E2).
 *
 * Every chat request goes through `@tanstack/ai-openrouter`
 * (`createOpenRouterText` -> `adapter.chatStream`, the pinned published
 * adapter), one accepted model per attempt, so the observed route is always
 * unambiguous. The AG-UI event stream the adapter yields is harvested here:
 *
 * - `RUN_STARTED`/`RUN_FINISHED` carry the model that actually served the
 *   response (`chunk.model` from OpenRouter, not the requested name) and
 *   `RUN_FINISHED` carries usage/cost when reported;
 * - `TEXT_MESSAGE_CONTENT` deltas accumulate the completion text;
 * - `TOOL_CALL_START`/`ARGS`/`END` accumulate the RAW argument text per call.
 *
 * Decoding is owned here, not by the adapter: the adapter silently tolerates
 * malformed tool-argument JSON (it yields an empty `input` object), so the
 * raw accumulated arguments are re-parsed and decoded against the caller's
 * Effect Schema before anything is returned. Structured output requests pin
 * `responseFormat: json_schema` with the schema converted through the A3
 * runtime's `toolJsonSchemaForStructuredOutput` (the proved conversion path;
 * tool input schemas use `toolJsonSchema`). Provider output that does not
 * decode fails closed — it never falls back to another model (see
 * ./failures.ts).
 *
 * One bounded deadline per attempt (AbortController + SDK timeout, retries
 * disabled in the SDK: the ordered fallback loop owns retries).
 */

import { Schema } from "effect";
import {
  toolDefinition,
  type AdapterYieldChunk,
  type JSONSchema,
  type ModelMessage,
} from "@tanstack/ai";
import { resolveDebugOption } from "@tanstack/ai/adapter-internals";
import { createOpenRouterText } from "@tanstack/ai-openrouter";
import { toolJsonSchema, toolJsonSchemaForStructuredOutput } from "@kiero/runtime";
import {
  CHAT_ATTEMPT_DEADLINE_MS,
  PROVIDER_ROUTING,
  type ModelRoute,
} from "./routing";
import {
  classifyChatFailure,
  providerFailure,
  type ProviderFailure,
} from "./failures";
import { runOrderedRoute } from "./runner";
import type { ProviderCallRecord } from "./callRecord";

/** Server-side OpenRouter credentials; never constructed from client input. */
export interface OpenRouterCredentials {
  readonly apiKey: string;
}

/** Typed message content: plain text or inline image data for vision routes. */
export type ChatContent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly base64: string;
      readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
    };

/**
 * One conversation message in the typed request shape. System instructions
 * travel only through `ChatRequest.systemPrompt` (the adapter maps them to
 * the provider's system messages); tool-result turns belong to the consumer's
 * loop (E3+/E6), not to this single-turn interface.
 */
export interface ChatMessagePart {
  readonly role: "user" | "assistant";
  readonly content: readonly ChatContent[];
}

/**
 * One declared tool. The input codec is an Effect Schema contract: it is
 * converted to the JSON Schema the provider receives (A3 `toolJsonSchema`)
 * and every returned argument object is decoded through it before the caller
 * can consume the call. The provider never receives an execute function;
 * executing a checked domain operation from tool arguments is the consumer's
 * (E3+/E6) responsibility through the same dispatch every other command uses.
 */
export interface ChatToolSpec<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: Schema.Codec<I, unknown, never, never>;
}

/** Widened tool spec type for heterogeneous request-level collections. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyChatToolSpec = ChatToolSpec<any>;

/** The typed chat request (no model field: the route is server-owned). */
export interface ChatRequest {
  readonly messages: readonly ChatMessagePart[];
  /** Declared tools; the model's calls are returned decoded, never executed. */
  readonly tools?: readonly AnyChatToolSpec[];
  /**
   * Structured output contract. When present the request pins strict
   * `json_schema` and the completion text must decode through this schema.
   */
  readonly outputSchema?: Schema.Codec<unknown, unknown, never, never>;
  readonly systemPrompt?: string;
}

/** One decoded tool call: arguments decoded through the declared schema. */
export interface DecodedToolCall<I = unknown> {
  readonly id: string;
  readonly name: string;
  readonly arguments: I;
}

/** The result of one chat turn (a single provider round, no agent loop). */
export interface ChatTurnResult {
  readonly text: string;
  readonly toolCalls: readonly DecodedToolCall[];
  readonly finishReason: "stop" | "tool_calls";
}

/** The union every chat call resolves to. */
export type ChatCallOutcome =
  | { readonly outcome: "succeeded"; readonly value: ChatTurnResult | unknown }
  | { readonly outcome: "failed"; readonly failure: ProviderFailure };

/** What one chat call returns: typed output plus the route record. */
export interface ChatCallResult {
  readonly outcome: ChatCallOutcome;
  readonly record: ProviderCallRecord;
}

/**
 * The observed model/usage harvested from the adapter's event stream.
 * Exported for the focused verification fixtures (tests/e2): synthetic AG-UI
 * stream observations feed the decode/fallback proofs without network.
 */
export interface StreamObservation {
  observedModel?: string;
  text: string;
  firstOutputAtMs?: number;
  toolCalls: { id: string; name: string; rawArguments: string }[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  failureCode?: string | number;
  failed: boolean;
}

/** The model-name parameter of the adapter factory (catalogued slugs). */
type OpenRouterModelName = Parameters<typeof createOpenRouterText>[0];

/** Converts the typed message shape to TanStack `ModelMessage`s. */
function toModelMessages(messages: readonly ChatMessagePart[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content.map((part) =>
      part.kind === "text"
        ? { type: "text" as const, content: part.text }
        : {
            type: "image" as const,
            source: {
              type: "data" as const,
              value: part.base64,
              mimeType: part.mimeType,
            },
          },
    ),
  }));
}

/**
 * Harvests one adapter event stream into the raw observation. Exported for
 * the focused verification fixtures (tests/e2), like `decodeEmbedding` and
 * `decodeTranscription`: synthetic AG-UI event sequences drive the REAL
 * harvest (text/argument accumulation, observed model, usage, failure code)
 * offline, including fragmented deltas.
 */
export async function harvestStream(
  stream: AsyncIterable<AdapterYieldChunk>,
): Promise<StreamObservation> {
  const observation: StreamObservation = { text: "", toolCalls: [], failed: false };
  const pending = new Map<string, { id: string; name: string; rawArguments: string }>();
  for await (const event of stream) {
    switch (event.type) {
      case "RUN_STARTED":
      case "RUN_FINISHED": {
        const model = event.model;
        if (typeof model === "string" && model.length > 0) {
          observation.observedModel = model;
        }
        if (event.type === "RUN_FINISHED") {
          const usage = (event as { usage?: StreamObservation["usage"] & { cost?: unknown } })
            .usage;
          if (usage !== undefined) {
            observation.usage = {
              ...(typeof usage.promptTokens === "number" ? { promptTokens: usage.promptTokens } : {}),
              ...(typeof usage.completionTokens === "number"
                ? { completionTokens: usage.completionTokens }
                : {}),
              ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
              ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
            };
          }
        }
        break;
      }
      case "TEXT_MESSAGE_CONTENT": {
        const delta = event.delta;
        if (typeof delta === "string" && delta.length > 0) {
          observation.text += delta;
          observation.firstOutputAtMs ??= Date.now();
        }
        break;
      }
      case "TOOL_CALL_START": {
        const id = event.toolCallId;
        const name = event.toolCallName;
        if (typeof id === "string" && typeof name === "string") {
          pending.set(id, { id, name, rawArguments: "" });
        }
        break;
      }
      case "TOOL_CALL_ARGS": {
        const id = event.toolCallId;
        const delta = event.delta;
        const call = typeof id === "string" ? pending.get(id) : undefined;
        if (call !== undefined && typeof delta === "string") {
          call.rawArguments += delta;
        }
        break;
      }
      case "TOOL_CALL_END": {
        const id = event.toolCallId;
        const call = typeof id === "string" ? pending.get(id) : undefined;
        if (call !== undefined) {
          pending.delete(id);
          observation.toolCalls.push(call);
        }
        break;
      }
      case "RUN_ERROR": {
        observation.failed = true;
        const code = event.code;
        if (typeof code === "string" || typeof code === "number") {
          observation.failureCode = code;
        }
        break;
      }
      default:
        break;
    }
  }
  // Calls the stream ended without closing still count: their raw arguments
  // are what the provider produced and must face the same decode.
  for (const call of pending.values()) {
    observation.toolCalls.push(call);
  }
  return observation;
}

/** Parses and decodes accumulated tool arguments against a declared schema. */
function decodeToolArguments<I>(
  input: Schema.Codec<I, unknown, never, never>,
  raw: string,
): { ok: true; value: I } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const decoded = Schema.decodeUnknownOption(input)(parsed);
  return decoded._tag === "Some" ? { ok: true, value: decoded.value } : { ok: false };
}

/** Extracts a JSON value from completion text (strict: no fenced repair). */
function parseCompletionJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Runs ONE chat attempt against one model through the TanStack OpenRouter
 * adapter: one bounded request, raw stream harvested, no fallback decisions.
 */
export async function chatAttempt(
  credentials: OpenRouterCredentials,
  model: string,
  request: ChatRequest,
): Promise<
  | { ok: true; observation: StreamObservation }
  | { ok: false; failure: ProviderFailure }
> {
  const adapter = createOpenRouterText(
    // The frozen accepted order (and probe prefixes over its slugs) contains
    // only catalogued OpenRouter identifiers; the live probes verify the
    // current catalog during implementation. The cast is name-level only.
    model as OpenRouterModelName,
    credentials.apiKey,
    {
      timeoutMs: CHAT_ATTEMPT_DEADLINE_MS,
      retryConfig: { strategy: "none" },
    },
  );
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), CHAT_ATTEMPT_DEADLINE_MS);
  const providerTools = request.tools?.map((tool) =>
    toolDefinition({
      name: tool.name,
      description: tool.description,
      inputSchema: toolJsonSchema(tool.input) as JSONSchema,
    }),
  );
  const responseFormat =
    request.outputSchema === undefined
      ? undefined
      : {
          type: "json_schema" as const,
          jsonSchema: {
            name: "kiero_structured_output",
            strict: true,
            schema: toolJsonSchemaForStructuredOutput(request.outputSchema) as JSONSchema,
          },
        };
  try {
    const stream = adapter.chatStream({
      model,
      messages: toModelMessages(request.messages),
      ...(request.systemPrompt === undefined ? {} : { systemPrompts: [request.systemPrompt] }),
      ...(providerTools === undefined || providerTools.length === 0
        ? {}
        : { tools: providerTools }),
      abortController: abort,
      // Silent logger: the adapter's default logs provider chunks and raw
      // tool arguments on error; diagnostics stay closed unless explicitly
      // opened by an operations owner (I2).
      logger: resolveDebugOption(false),
      modelOptions: {
        // Capability-aware routing: exclude providers that do not support
        // the parameters this request uses (schema/tools).
        //
        // Recorded live finding (E2 probes, 2026-09-09): sending
        // `maxCompletionTokens` together with `requireParameters: true`
        // excluded EVERY GLM endpoint ("No endpoints found that can handle
        // the requested parameters"), so this adapter never sends an output
        // token cap; strict `json_schema` + `requireParameters` alone is
        // served by the accepted first-choice route. Output bounding is the
        // caller's prompt discipline and later per-role budgets, not a
        // silently-dropped provider parameter.
        provider: { requireParameters: true },
        ...(responseFormat === undefined ? {} : { responseFormat }),
      },
    });
    const observation = await harvestStream(stream);
    if (observation.failed) {
      return { ok: false, failure: classifyChatFailure(observation.failureCode) };
    }
    return { ok: true, observation };
  } catch (cause) {
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
      return { ok: false, failure: providerFailure("deadline_exceeded") };
    }
    // Transport-level failure before any provider output existed.
    return { ok: false, failure: classifyChatFailure(undefined) };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Decodes a successful stream observation into the typed turn result.
 * Incompatible output fails closed (`output_rejected` / `unknown_tool`);
 * these are never eligible for fallback.
 */
function decodeObservation(
  request: ChatRequest,
  observation: StreamObservation,
): { ok: true; value: ChatTurnResult | unknown } | { ok: false; failure: ProviderFailure } {
  const toolSchemas = new Map<string, Schema.Codec<unknown, unknown, never, never>>();
  for (const tool of request.tools ?? []) {
    toolSchemas.set(tool.name, tool.input as Schema.Codec<unknown, unknown, never, never>);
  }
  if (observation.toolCalls.length > 0) {
    const decodedCalls: DecodedToolCall[] = [];
    for (const call of observation.toolCalls) {
      const schema = toolSchemas.get(call.name);
      if (schema === undefined) {
        return { ok: false, failure: providerFailure("unknown_tool") };
      }
      const decoded = decodeToolArguments(schema, call.rawArguments);
      if (!decoded.ok) {
        return { ok: false, failure: providerFailure("output_rejected") };
      }
      decodedCalls.push({ id: call.id, name: call.name, arguments: decoded.value });
    }
    return {
      ok: true,
      value: {
        text: observation.text,
        toolCalls: decodedCalls,
        finishReason: "tool_calls",
      } satisfies ChatTurnResult,
    };
  }
  if (request.outputSchema !== undefined) {
    const parsed = parseCompletionJson(observation.text);
    if (!parsed.ok) {
      return { ok: false, failure: providerFailure("output_rejected") };
    }
    const decoded = Schema.decodeUnknownOption(request.outputSchema)(parsed.value);
    if (decoded._tag === "None") {
      return { ok: false, failure: providerFailure("output_rejected") };
    }
    return { ok: true, value: decoded.value };
  }
  return {
    ok: true,
    value: {
      text: observation.text,
      toolCalls: [],
      finishReason: "stop",
    } satisfies ChatTurnResult,
  };
}

/**
 * Runs one chat-shaped call over an ordered route (server-owned): the shared
 * ordered-route runner owns the loop, records, eligibility short-circuit and
 * record seal; this adapter supplies only the per-model attempt (one bounded
 * request through the TanStack adapter, then the typed decode of the
 * harvested stream — incompatible output fails closed with its observed
 * routing metadata still recorded).
 *
 * `route` is a server-side parameter so verification probes (and only they)
 * can exercise the fallback order against controlled first positions; the
 * public entry point always passes the frozen configuration route. No client
 * input reaches this parameter.
 */
export async function chatWithRoute(
  credentials: OpenRouterCredentials,
  recordRouteId: "chat_analysis" | "vision_extraction",
  route: ModelRoute,
  request: ChatRequest,
  attemptFunction: typeof chatAttempt = chatAttempt,
): Promise<ChatCallResult> {
  return runOrderedRoute(recordRouteId, route, async (model) => {
    const attempt = await attemptFunction(credentials, model, request);
    if (!attempt.ok) {
      return { ok: false as const, failure: attempt.failure };
    }
    const observation = attempt.observation;
    const decoded = decodeObservation(request, observation);
    if (!decoded.ok) {
      return {
        ok: false as const,
        failure: decoded.failure,
        ...(observation.observedModel === undefined ? {} : { observedModel: observation.observedModel }),
        ...(observation.firstOutputAtMs === undefined ? {} : { firstOutputAtMs: observation.firstOutputAtMs }),
        ...(observation.usage === undefined ? {} : { usage: observation.usage }),
      };
    }
    return {
      ok: true as const,
      value: decoded.value,
      ...(observation.observedModel === undefined ? {} : { observedModel: observation.observedModel }),
      ...(observation.firstOutputAtMs === undefined ? {} : { firstOutputAtMs: observation.firstOutputAtMs }),
      ...(observation.usage === undefined ? {} : { usage: observation.usage }),
    };
  });
}

/** The public chat entry point: the frozen accepted chat route. */
export async function runChatTurn(
  credentials: OpenRouterCredentials,
  request: ChatRequest,
): Promise<ChatCallResult> {
  return chatWithRoute(credentials, "chat_analysis", PROVIDER_ROUTING.chat_analysis, request);
}
