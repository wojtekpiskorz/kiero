/**
 * @kiero/providers: server-owned OpenRouter routing and typed provider
 * adapters (E2).
 *
 * Small public interface, deep internals (execution charter: "OpenRouter
 * chat/STT/vision/embedding adapters and server-owned routing"):
 *
 * - `PROVIDER_ROUTING` / `ROUTING_CONFIG_VERSION` (+ the per-role `*Route()`
 *   accessors): the frozen accepted model order per role. There is no
 *   user- or GM-facing model selector; the ordered-attempt runners are
 *   parameterized only for server-side verification probes.
 * - `runChatTurn` / `chatWithRoute`: chat completions through the pinned
 *   `@tanstack/ai-openrouter` adapter with tools (decoded against the
 *   caller's Effect Schema) and strict structured output through the A3
 *   conversion (`toolJsonSchema` / `toolJsonSchemaForStructuredOutput`).
 * - `runVisionExtraction`: image-extraction request shapes over the vision
 *   order (GLM -> Gemini; never the text-only route).
 * - `runTranscription`: STT over the transcription endpoint (MAI-Transcribe 2
 *   first, Whisper Large V3 backup).
 * - `runEmbedding`: embeddings over `/api/v1/embeddings`
 *   (qwen3-embedding-8b, native 4096-dimension baseline asserted on the
 *   observed output).
 * - `ProviderFailure`/classification + `failureToClosedError`: sanitized
 *   closed-vocabulary failures; eligible failures (deadline, connection,
 *   rate limit, unavailability) advance the accepted order, incompatible
 *   output fails closed.
 * - `ProviderCallRecord`: per-attempt route/model/version/latency/usage
 *   recording for `processingAttempts` rows and the J3 corpus run reports.
 *
 * Everything here is server-only by construction: credentials are an explicit
 * parameter, never read from environment or client input inside this package
 * (the Convex wiring owns environment injection).
 */

export * from "./routing";
export * from "./failures";
export * from "./callRecord";
export * from "./chat";
export * from "./vision";
export * from "./stt";
export * from "./embeddings";
export * from "./payloads";
