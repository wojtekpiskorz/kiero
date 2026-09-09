/**
 * Server-owned OpenRouter routing configuration (E2).
 *
 * The accepted model order per role is application configuration, exactly as
 * selected in the architecture decision ("Provider configuration" table):
 *
 * - chat / memory analysis: `z-ai/glm-5.3-flash` -> `google/gemini-3.8-flash`
 *   -> `deepseek/deepseek-v4-flash-0731`
 * - images: GLM -> Gemini (DeepSeek receives completed extraction text only,
 *   so it is never in the vision order)
 * - speech-to-text: `microsoft/mai-transcribe-2` with
 *   `openai/whisper-large-v3` as the designated backup (application-owned
 *   bounded orchestration; STT routing differs from chat)
 * - embeddings: `qwen/qwen3-embedding-8b`, native 4096 dimensions as the
 *   versioned initial proof baseline
 *
 * This module is deliberately constant: there is no user- or GM-facing model
 * selector anywhere in this package. Every public entry point resolves its
 * model order from `PROVIDER_ROUTING`; the ordered-attempt runner is
 * parameterized only for server-side verification probes (and tests), never
 * by client input. Changing the order is a code change that bumps
 * {@link ROUTING_CONFIG_VERSION} so recorded attempts stay interpretable
 * (the corpus run reports pin the configuration they executed against).
 */

/** Version of the frozen routing configuration; recorded on every attempt. */
export const ROUTING_CONFIG_VERSION = "e2.0" as const;

/** Chat / memory analysis order (accepted application order). */
export const CHAT_MODEL_ORDER = [
  "z-ai/glm-5.3-flash",
  "google/gemini-3.8-flash",
  "deepseek/deepseek-v4-flash-0731",
] as const;

/** Image-extraction order: GLM then Gemini; never the text-only route. */
export const VISION_MODEL_ORDER = [
  "z-ai/glm-5.3-flash",
  "google/gemini-3.8-flash",
] as const;

/** Speech-to-text order: MAI-Transcribe 2 first, Whisper Large V3 backup. */
export const STT_MODEL_ORDER = [
  "microsoft/mai-transcribe-2",
  "openai/whisper-large-v3",
] as const;

/** Embedding order (single accepted candidate; replacement is a versioned change). */
export const EMBEDDING_MODEL_ORDER = ["qwen/qwen3-embedding-8b"] as const;

/**
 * Native Qwen3-Embedding-8B dimension count; the initial proof baseline.
 * Any reduction is a measured-retrieval decision requiring a new index
 * generation (architecture "Provider configuration").
 */
export const EMBEDDING_DIMENSIONS_BASELINE = 4096;

/**
 * Bounded per-attempt deadline for chat requests. OpenRouter warns about
 * upstream ~60s processing timeouts for long multimodal jobs; the chat order
 * targets fast flash models, and a stalled attempt must release control to
 * the fallback loop instead of hanging the whole call.
 */
export const CHAT_ATTEMPT_DEADLINE_MS = 45_000;

/** Bounded per-attempt deadline for the transcription endpoint. */
export const STT_ATTEMPT_DEADLINE_MS = 55_000;

/** Bounded per-attempt deadline for embedding requests. */
export const EMBEDDING_ATTEMPT_DEADLINE_MS = 30_000;

/** One immutable route definition: an ordered, non-empty model list. */
export interface ModelRoute {
  readonly order: readonly string[];
}

/** The frozen routing table keyed by the A2 contract route ids. */
export const PROVIDER_ROUTING = {
  chat_analysis: { order: CHAT_MODEL_ORDER },
  vision_extraction: { order: VISION_MODEL_ORDER },
  speech_to_text: { order: STT_MODEL_ORDER },
  embedding: { order: EMBEDDING_MODEL_ORDER },
} as const satisfies Record<string, ModelRoute>;

export type ProviderRouteId = keyof typeof PROVIDER_ROUTING;
