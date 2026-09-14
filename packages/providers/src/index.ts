/**
 * @kiero/providers: server-owned provider routing and typed provider
 * adapters (E2; split across direct DeepSeek and OpenRouter by E8).
 *
 * Small public interface, deep internals (execution charter: the AI provider
 * adapters and server-owned routing):
 *
 * - `PROVIDER_ROUTING` / `ROUTING_CONFIG_VERSION`: the frozen accepted
 *   provider-qualified order per role (`RouteTarget = { provider, model }`).
 *   Chat and vision run DIRECT DeepSeek `deepseek-flash` first, then the
 *   explicitly authorized OpenRouter fallback positions (issue #170 owner
 *   decision, 2026-09-14); STT and embeddings stay on OpenRouter. There is
 *   no user- or GM-facing model selector; the one ordered-route runner is
 *   parameterized only for server-side verification probes.
 * - `runChatTurn` / `chatWithRoute`: chat over the split route. DeepSeek
 *   targets use the repository-owned Responses transport
 *   (`deepSeekResponsesStream`: explicit non-thinking, native JSON-Schema
 *   output, native tool rounds, terminal-state classification); OpenRouter
 *   targets use the pinned `@tanstack/ai-openrouter` adapter unchanged.
 *   Tools are decoded against the caller's Effect Schema; structured output
 *   is schema-constrained on both transports through the A3 conversion
 *   (`toolJsonSchema` / `toolJsonSchemaForStructuredOutput`); the result
 *   value's type follows the request's output codec.
 * - `runOrderedRoute`: the ONE ordered-route runner every role adapter uses
 *   (the bounded fallback loop across provider boundaries, per-attempt
 *   records, eligibility short-circuit, record seal); a new role supplies
 *   only its attempt.
 * - `runVisionExtraction`: image-extraction request shapes over the vision
 *   order (direct DeepSeek first, then the vision-capable OpenRouter
 *   fallbacks).
 * - `runTranscription`: STT over the OpenRouter transcription endpoint
 *   (MAI-Transcribe 2 first, Whisper Large V3 backup; retained by E8).
 * - `runEmbedding`: embeddings over OpenRouter `/api/v1/embeddings`
 *   (qwen3-embedding-8b, native 4096-dimension baseline asserted on the
 *   observed output; retained by E8).
 * - `ProviderFailure`/classification + `failureToClosedError`: sanitized
 *   closed-vocabulary failures; eligible failures (deadline, connection,
 *   rate limit, unavailability) advance the accepted order on EITHER
 *   provider, incompatible output fails closed — a rejected DeepSeek
 *   credential or schema never silently activates OpenRouter.
 * - `ProviderCallRecord`: per-attempt provider/route/model/version/latency/
 *   usage recording for `processingAttempts` rows and the J3 corpus run
 *   reports; `costUsd` stays absent for direct DeepSeek attempts because
 *   the direct API reports no request cost.
 *
 * Everything here is server-only by construction: credentials are an explicit
 * parameter, never constructed from client input. The canonical environment
 * readers (`openRouterCredentialsFromEnv`, `deepSeekCredentialsFromEnv`)
 * exist for the server wiring sites; chat/vision entry points resolve a
 * missing `deepseekApiKey` through the canonical reader and fail TERMINALLY
 * when no direct key is configured.
 */

export * from "./routing";
export * from "./failures";
export * from "./callRecord";
export * from "./runner";
export * from "./deepseek";
export * from "./chat";
export * from "./vision";
export * from "./stt";
export * from "./embeddings";
export * from "./payloads";
