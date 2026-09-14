/**
 * The chat adapter over two transports (E2; split by E8): DIRECT DeepSeek
 * for the primary chat/vision position, the pinned
 * `@tanstack/ai-openrouter` adapter for the authorized fallback positions.
 *
 * Every chat request goes through ONE attempt function,
 * {@link chatAttempt}, which dispatches on the provider-qualified route
 * target it receives from the ordered-route runner:
 *
 * - `deepseek` targets run the repository-owned direct transport
 *   (`deepseekResponsesStream`, ./deepseek.ts): one bounded streaming
 *   request against `POST https://api.deepseek.com/responses` with thinking
 *   explicitly disabled and native Responses JSON-Schema output, mapped
 *   onto the same AG-UI event vocabulary;
 * - `openrouter` targets run `createOpenRouterText` -> `adapter.chatStream`
 *   exactly as before (the retained fallback + STT/embeddings supplier).
 *
 * The AG-UI event stream is harvested once, for both transports
 * (`harvestStream`): `RUN_STARTED`/`RUN_FINISHED` carry the model that
 * actually served the response and `RUN_FINISHED` carries usage and its
 * finish reason; `TEXT_MESSAGE_CONTENT` deltas accumulate the completion
 * text; `TOOL_CALL_START`/`ARGS`/`END` accumulate the RAW argument text per
 * call. Truncated (`length`) and refused (`content_filter`) finishes never
 * decode as success: a syntactically valid partial result is not proof of
 * successful completion.
 *
 * Decoding is owned here, not by any adapter: the raw accumulated arguments
 * are re-parsed and decoded against the caller's Effect Schema before
 * anything is returned. Structured output requests pin schema-constrained
 * generation on BOTH transports — strict `json_schema` through OpenRouter,
 * `text.format json_schema` through the direct Responses wire — converted
 * through the A3 runtime's `toolJsonSchemaForStructuredOutput` (the proved
 * conversion path; tool input schemas use `toolJsonSchema`). Provider
 * output that does not decode fails closed — it never falls back to
 * another model (see ./failures.ts).
 *
 * One bounded deadline per attempt (AbortController + transport timeout,
 * retries disabled in the SDK: the ordered fallback loop owns retries).
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
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  PROVIDER_ROUTING,
  type ModelRoute,
  type RouteTarget,
} from "./routing";
import {
  classifyChatFailure,
  providerFailure,
  type ProviderFailure,
} from "./failures";
import {
  runOrderedRoute,
  type AttemptObservation,
  type RouteCallResult,
} from "./runner";
import type { UsageObservation } from "./callRecord";
import {
  deepSeekCredentialsFromEnv,
  deepSeekResponsesStream,
  type DeepSeekCredentials,
} from "./deepseek";

/** Server-side OpenRouter credentials; never constructed from client input. */
export interface OpenRouterCredentials {
  readonly apiKey: string;
}

/**
 * The server-held OpenRouter key from the environment; presence only, never
 * its value. E5 append (flagged coordinated change): the canonical reader;
 * the copies in D6's audio executor, E3's analyze and the ai dispatch are
 * proposed follow-ups for their own lanes.
 */
export function openRouterCredentialsFromEnv(): OpenRouterCredentials | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return null;
  }
  return { apiKey };
}

/**
 * Credentials for the chat/vision roles after the E8 split. The OpenRouter
 * key stays in its legacy position (it serves the authorized fallback
 * positions AND the retained STT/embeddings roles, so every existing wiring
 * site keeps working unchanged); the direct DeepSeek key rides along when
 * the caller holds one, and the canonical environment reader supplies it
 * otherwise. Structurally compatible with `OpenRouterCredentials` on
 * purpose: no caller outside this package needs a coordinated change to
 * start routing chat through DeepSeek-direct.
 */
export interface ChatTurnCredentials extends OpenRouterCredentials {
  /**
   * Direct DeepSeek API key. When absent, `deepSeekCredentialsFromEnv` is
   * consulted; when neither holds, the direct attempt fails TERMINALLY
   * (`unauthenticated`) — a missing primary credential must never silently
   * reroute chat to the OpenRouter fallback.
   */
  readonly deepseekApiKey?: string;
}

/** Resolves the direct DeepSeek credential for one chat/vision call. */
function resolveDeepSeekCredentials(
  credentials: ChatTurnCredentials,
): DeepSeekCredentials | null {
  if (credentials.deepseekApiKey !== undefined && credentials.deepseekApiKey !== "") {
    return { apiKey: credentials.deepseekApiKey };
  }
  return deepSeekCredentialsFromEnv();
}

/** Typed message content: plain text or inline image data for vision routes. */
export type ChatContent =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly base64: string;
      readonly mimeType: "image/png" | "image/jpeg" | "image/webp";
    };

/** One native assistant tool call replayed in a later request. */
export interface ChatAssistantToolCall {
  readonly id: string;
  readonly name: string;
  /**
   * Raw JSON argument text. Re-serialized from the DECODED turn result, so
   * it is schema-valid by construction; replaying the provider's native
   * tool round (instead of rendering it as prose) is what keeps multi-turn
   * tool loops portable across BOTH transports — a conversation whose
   * first rounds served on DeepSeek-direct can continue on the OpenRouter
   * fallback with the identical message history.
   */
  readonly arguments: string;
}

/**
 * One conversation message in the typed request shape. System instructions
 * travel only through `ChatRequest.systemPrompt` (each transport maps them
 * to its system mechanism). Plain turns carry user/assistant content; the
 * `assistant-tool-calls` and `tool-result` members are the NATIVE tool
 * round: after the consumer executes decoded calls, it appends what the
 * assistant asked for and what the execution answered.
 */
export type ChatMessagePart =
  | { readonly role: "user" | "assistant"; readonly content: readonly ChatContent[] }
  | { readonly role: "assistant-tool-calls"; readonly calls: readonly ChatAssistantToolCall[] }
  | {
      readonly role: "tool-result";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
    };

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

/**
 * The internal attempt-level request: either public request shape with the
 * output codec widened, so `chatAttempt` (and verification fakes replacing
 * it) accept plain and structured requests alike.
 */
export type ChatAttemptRequest = ChatRequest & {
  readonly outputSchema?: Schema.Codec<unknown, unknown, never, never>;
};

/**
 * The typed chat request for a plain or tool-calling turn (no model field:
 * the route is server-owned; no output codec: that is the structured variant
 * below, kept separate so the result value's type is real instead of
 * collapsing to `unknown`).
 */
export interface ChatRequest {
  readonly messages: readonly ChatMessagePart[];
  /** Declared tools; the model's calls are returned decoded, never executed. */
  readonly tools?: readonly AnyChatToolSpec[];
  readonly systemPrompt?: string;
}

/**
 * The structured chat request: the same turn plus a REQUIRED output codec,
 * in the style of `ChatToolSpec<I>`. The request pins schema-constrained
 * generation converted from this codec (A3 `toolJsonSchemaForStructuredOutput`)
 * and the completion text must decode through it. With tools declared, the
 * model may still answer with tool calls, so the value type is
 * `Output | ChatTurnResult`.
 */
export interface StructuredChatRequest<Output = unknown> extends ChatRequest {
  readonly outputSchema: Schema.Codec<Output, unknown, never, never>;
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

/** What one plain chat call returns: the turn result plus the route record. */
export type ChatCallResult = RouteCallResult<ChatTurnResult>;

/** What one structured chat call returns: decoded output or a tool turn. */
export type StructuredChatCallResult<Output = unknown> =
  RouteCallResult<ChatTurnResult | Output>;

/**
 * The observed model/usage/finish harvested from an adapter event stream.
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
  /**
   * Terminal finish reason as reported by the provider's run-finished
   * event, when it reported one. `length` (truncated) and
   * `content_filter` (refused) are never accepted as complete output.
   */
  finishReason?: "stop" | "tool_calls" | "length" | "content_filter";
  failureCode?: string | number;
  failed: boolean;
}

/** The model-name parameter of the adapter factory (catalogued slugs). */
type OpenRouterModelName = Parameters<typeof createOpenRouterText>[0];

/** One declared tool in the shared provider-neutral declaration shape. */
interface DeclaredTool {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Record<string, unknown>;
}

/** Converts the typed tool specs to the shared declaration shape. */
function declaredTools(request: ChatAttemptRequest): DeclaredTool[] | undefined {
  if (request.tools === undefined || request.tools.length === 0) {
    return undefined;
  }
  return request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    jsonSchema: toolJsonSchema(tool.input),
  }));
}

/** Converts the typed message shape to TanStack `ModelMessage`s. */
function toModelMessages(messages: readonly ChatMessagePart[]): ModelMessage[] {
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant-tool-calls") {
      // Native replay through the TanStack message model: the OpenRouter
      // adapter forwards assistant toolCalls and role-"tool" results, so a
      // tool loop started on the direct transport continues unchanged when
      // an eligible failure moves the route to the fallback provider.
      converted.push({
        role: "assistant",
        content: [],
        toolCalls: message.calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      continue;
    }
    if (message.role === "tool-result") {
      converted.push({
        role: "tool",
        content: message.content,
        toolCallId: message.toolCallId,
      });
      continue;
    }
    converted.push({
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
    });
  }
  return converted;
}

/**
 * Harvests one adapter event stream into the raw observation. Exported for
 * the focused verification fixtures (tests/e2), like `decodeEmbedding` and
 * `decodeTranscription`: synthetic AG-UI event sequences drive the REAL
 * harvest (text/argument accumulation, observed model, usage, finish
 * reason, failure code) offline, including fragmented deltas.
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
          const finish = (event as { finishReason?: StreamObservation["finishReason"] }).finishReason;
          if (
            finish === "stop" ||
            finish === "tool_calls" ||
            finish === "length" ||
            finish === "content_filter"
          ) {
            observation.finishReason = finish;
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

/** The shape every transport-level chat attempt returns. */
export type ChatAttemptResult =
  | { ok: true; observation: StreamObservation }
  | { ok: false; failure: ProviderFailure; observation?: StreamObservation };

/**
 * The ONE bounded-attempt skeleton every chat transport reuses: the
 * per-attempt deadline (AbortController + CHAT_ATTEMPT_DEADLINE_MS), the
 * real harvest of the opened stream, the stream-level failure
 * classification and the thrown-error classification (abort shapes are the
 * deadline; anything else thrown on Kiero's side of the seam (adapter
 * construction, request wiring, transport defect) is `internal_error`,
 * terminal, so an internal defect never silently burns the accepted order)
 * live here exactly once. `open` receives the deadline's controller: the
 * TanStack adapter wants the controller itself, the direct transport
 * wants its signal.
 */
async function boundedChatAttempt(
  open: (abort: AbortController) => AsyncIterable<AdapterYieldChunk>,
): Promise<ChatAttemptResult> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), CHAT_ATTEMPT_DEADLINE_MS);
  try {
    // A stream-level failure still carries the observation's routing
    // metadata (the model that served RUN_STARTED, any first-output time):
    // recorded with the failure, not discarded.
    const observation = await harvestStream(open(abort));
    if (observation.failed) {
      return {
        ok: false,
        failure: classifyChatFailure(observation.failureCode),
        observation,
      };
    }
    return { ok: true, observation };
  } catch (cause) {
    if (cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")) {
      return { ok: false, failure: providerFailure("deadline_exceeded") };
    }
    return { ok: false, failure: providerFailure("internal_error") };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Runs ONE direct DeepSeek chat attempt against one model through the
 * repository-owned Responses transport: pure request mapping over the
 * shared bounded-attempt skeleton. The transport reports every failure as
 * a sanitized RUN_ERROR code; only a malformed request (our side of the
 * seam) throws, which the skeleton classifies as `internal_error`.
 */
async function deepSeekChatAttempt(
  credentials: DeepSeekCredentials,
  model: string,
  request: ChatAttemptRequest,
): Promise<ChatAttemptResult> {
  const tools = declaredTools(request);
  return boundedChatAttempt((abort) =>
    deepSeekResponsesStream(credentials, {
      model,
      messages: request.messages,
      ...(request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt }),
      ...(tools === undefined
        ? {}
        : {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.jsonSchema,
            })),
          }),
      ...(request.outputSchema === undefined
        ? {}
        : {
            outputSchema: {
              name: "kiero_structured_output",
              schema: toolJsonSchemaForStructuredOutput(request.outputSchema),
            },
          }),
      maxOutputTokens: DEEPSEEK_MAX_OUTPUT_TOKENS,
      signal: abort.signal,
    }),
  );
}

/**
 * Runs ONE OpenRouter chat attempt against one model through the pinned
 * TanStack adapter: pure request mapping over the shared bounded-attempt
 * skeleton. Unchanged from E2 apart from the provider-qualified call
 * shape; it now serves the authorized fallback positions.
 */
async function openRouterChatAttempt(
  credentials: OpenRouterCredentials,
  model: string,
  request: ChatAttemptRequest,
): Promise<ChatAttemptResult> {
  const tools = declaredTools(request);
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
  return boundedChatAttempt((abort) => {
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
    return adapter.chatStream({
      model,
      messages: toModelMessages(request.messages),
      ...(request.systemPrompt === undefined ? {} : { systemPrompts: [request.systemPrompt] }),
      ...(tools === undefined
        ? {}
        : {
            tools: tools.map((tool) =>
              toolDefinition({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.jsonSchema as JSONSchema,
              }),
            ),
          }),
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
  });
}

/**
 * Runs ONE chat attempt against ONE provider-qualified target, dispatching
 * on the target's supplier. A `deepseek` target without a resolvable direct
 * credential fails TERMINALLY as `unauthenticated`: a missing primary key
 * is a configuration problem that must surface, never a silent reroute to
 * the OpenRouter fallback (routing decision record, E8 amendment).
 */
export async function chatAttempt(
  credentials: ChatTurnCredentials,
  target: RouteTarget,
  request: ChatAttemptRequest,
): Promise<ChatAttemptResult> {
  if (target.provider === "deepseek") {
    const direct = resolveDeepSeekCredentials(credentials);
    if (direct === null) {
      return { ok: false, failure: providerFailure("unauthenticated") };
    }
    return deepSeekChatAttempt(direct, target.model, request);
  }
  return openRouterChatAttempt(credentials, target.model, request);
}

/**
 * Finish states that must never decode as a successful turn, whatever
 * syntactically valid content accompanied them.
 */
function rejectedFinish(observation: StreamObservation): ProviderFailure | null {
  if (observation.finishReason === "length" || observation.finishReason === "content_filter") {
    return providerFailure("output_rejected");
  }
  return null;
}

/**
 * Decodes tool calls from a successful stream observation into the typed
 * turn result. Malformed JSON, schema mismatches and undeclared tool names
 * fail closed (`output_rejected` / `unknown_tool`); these are never eligible
 * for fallback. Truncated and content-filtered finishes fail the same way
 * BEFORE any output is accepted.
 */
function decodeToolTurn(
  request: ChatRequest,
  observation: StreamObservation,
): { ok: true; value: ChatTurnResult } | { ok: false; failure: ProviderFailure } {
  const finish = rejectedFinish(observation);
  if (finish !== null) {
    return { ok: false, failure: finish };
  }
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
 * Decodes a structured turn: with tools declared the model may answer with
 * tool calls (the typed turn result) or the structured final answer, so the
 * honest value type is `Output | ChatTurnResult`. Malformed JSON and schema
 * mismatches fail closed (`output_rejected`), never eligible for fallback.
 */
function decodeStructuredTurn<Output>(
  request: StructuredChatRequest<Output>,
  observation: StreamObservation,
): { ok: true; value: ChatTurnResult | Output } | { ok: false; failure: ProviderFailure } {
  const finish = rejectedFinish(observation);
  if (finish !== null) {
    return { ok: false, failure: finish };
  }
  if (observation.toolCalls.length > 0) {
    return decodeToolTurn(request, observation);
  }
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

/** Attaches an observation's routing metadata to an attempt outcome. */
function withObservation<T extends object>(
  outcome: T,
  observation: StreamObservation,
): T & AttemptObservation {
  const enriched: T & {
    observedModel?: string;
    usage?: UsageObservation;
    firstOutputAtMs?: number;
  } = { ...outcome };
  if (observation.observedModel !== undefined) {
    enriched.observedModel = observation.observedModel;
  }
  if (observation.firstOutputAtMs !== undefined) {
    enriched.firstOutputAtMs = observation.firstOutputAtMs;
  }
  if (observation.usage !== undefined) {
    enriched.usage = observation.usage;
  }
  return enriched;
}

/**
 * A failed attempt's outcome for the runner: the classified failure plus the
 * observation's routing metadata when the failure came from a stream (a
 * thrown pre-stream failure has none to attach).
 */
function attemptFailure(failure: {
  readonly failure: ProviderFailure;
  readonly observation?: StreamObservation;
}): { ok: false; failure: ProviderFailure } & AttemptObservation {
  return failure.observation === undefined
    ? { ok: false, failure: failure.failure }
    : withObservation({ ok: false as const, failure: failure.failure }, failure.observation);
}

/**
 * Runs one chat-shaped call over an ordered route (server-owned): the shared
 * ordered-route runner owns the loop, records, eligibility short-circuit and
 * record seal; this adapter supplies only the per-target attempt (one
 * bounded request through the transport the target selects, then the typed
 * decode of the harvested stream — incompatible output fails closed with its
 * observed routing metadata still recorded).
 *
 * `route` is a server-side parameter so verification probes (and only they)
 * can exercise the fallback order against controlled first positions; the
 * public entry point always passes the frozen configuration route. No client
 * input reaches this parameter.
 */
export async function chatWithRoute(
  credentials: ChatTurnCredentials,
  recordRouteId: "chat_analysis" | "vision_extraction",
  route: ModelRoute,
  request: ChatRequest,
  attemptFunction: typeof chatAttempt = chatAttempt,
): Promise<ChatCallResult> {
  return runOrderedRoute(recordRouteId, route, async (target) => {
    const attempt = await attemptFunction(credentials, target, request);
    if (!attempt.ok) {
      return attemptFailure(attempt);
    }
    const decoded = decodeToolTurn(request, attempt.observation);
    return withObservation(decoded, attempt.observation);
  });
}

/** The structured variant over the same runner and attempt protocol. */
export async function structuredChatWithRoute<Output>(
  credentials: ChatTurnCredentials,
  recordRouteId: "chat_analysis" | "vision_extraction",
  route: ModelRoute,
  request: StructuredChatRequest<Output>,
  attemptFunction: typeof chatAttempt = chatAttempt,
): Promise<StructuredChatCallResult<Output>> {
  return runOrderedRoute(recordRouteId, route, async (target) => {
    const attempt = await attemptFunction(credentials, target, request);
    if (!attempt.ok) {
      return attemptFailure(attempt);
    }
    const decoded = decodeStructuredTurn(request, attempt.observation);
    return withObservation(decoded, attempt.observation);
  });
}

/** The public plain chat entry point: the frozen accepted chat route. */
export async function runChatTurn(
  credentials: ChatTurnCredentials,
  request: ChatRequest,
): Promise<ChatCallResult> {
  return chatWithRoute(credentials, "chat_analysis", PROVIDER_ROUTING.chat_analysis, request);
}

/** The public structured chat entry point: the frozen accepted chat route. */
export async function runStructuredChat<Output>(
  credentials: ChatTurnCredentials,
  request: StructuredChatRequest<Output>,
): Promise<StructuredChatCallResult<Output>> {
  return structuredChatWithRoute(credentials, "chat_analysis", PROVIDER_ROUTING.chat_analysis, request);
}
