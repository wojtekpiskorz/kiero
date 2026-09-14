/**
 * Server-owned provider routing configuration (E2; amended by E8).
 *
 * The accepted routing per role is application configuration, exactly as
 * selected in the routing decision record
 * (docs/adr/provider-routing-2026-09.md):
 *
 * - chat / memory analysis: DIRECT DeepSeek `deepseek-flash` at
 *   https://api.deepseek.com (DEEPSEEK_API_KEY) -> OpenRouter
 *   `z-ai/glm-5.3-flash` -> OpenRouter `google/gemini-3.8-flash`
 * - images: DIRECT DeepSeek `deepseek-flash` (native vision) -> the same two
 *   OpenRouter vision-capable models
 * - speech-to-text: OpenRouter `microsoft/mai-transcribe-2` with
 *   `openai/whisper-large-v3` as the designated backup (retained by the E8
 *   owner decision; STT routing differs from chat)
 * - embeddings: OpenRouter `qwen/qwen3-embedding-8b`, native 4096 dimensions
 *   as the versioned initial proof baseline (retained by the E8 owner
 *   decision)
 *
 * E8 amendment (issue #170, owner decision recorded 2026-09-14): direct
 * DeepSeek serves chat and vision; OpenRouter is EXPLICITLY AUTHORIZED as the
 * chat/vision FALLBACK provider. A duplicated Flash alias through OpenRouter
 * does not count as an independent fallback, so the former
 * `deepseek/deepseek-v4-flash-0731` chat position is removed: it is the same
 * model the direct route already tried, and a second attempt against it
 * would be a disguised same-model retry, not a fallback. The fallback
 * positions are models distinct from the DeepSeek alias, verified available
 * on 2026-09-14.
 *
 * This module is deliberately constant: there is no user- or GM-facing model
 * selector anywhere in this package. Every public entry point resolves its
 * route from `PROVIDER_ROUTING`; the ordered-attempt runner is parameterized
 * only for server-side verification probes (and tests), never by client
 * input. Changing the route is a code change that bumps
 * {@link ROUTING_CONFIG_VERSION} so recorded attempts stay interpretable
 * (the corpus run reports pin the configuration they executed against).
 */

/** Version of the frozen routing configuration; recorded on every attempt. */
export const ROUTING_CONFIG_VERSION = "e8.0" as const;

/**
 * The two AI suppliers after the E8 split. `deepseek` is the direct DeepSeek
 * API (https://api.deepseek.com, DEEPSEEK_API_KEY); `openrouter` is the
 * retained OpenRouter integration (OPENROUTER_API_KEY) serving STT,
 * embeddings and the authorized chat/vision fallback positions.
 */
export type ProviderKind = "deepseek" | "openrouter";

/**
 * One position in an ordered route: WHICH supplier serves the attempt and
 * which model name that supplier understands. The provider qualifier is what
 * makes the fallback honest — the runner records it, so a route that fell
 * back to OpenRouter is distinguishable from one served by DeepSeek-direct
 * even when model names alone would be ambiguous.
 */
export interface RouteTarget {
  readonly provider: ProviderKind;
  readonly model: string;
}

/** Canonical direct DeepSeek OpenAI-compatible base (no `/v1` suffix). */
export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com";

/**
 * The direct chat/vision model alias. Observed 2026-09-14 resolving to
 * DeepSeek-V4.1-Flash (released 2026-09-10, native visual understanding);
 * aliases are mutable, so every attempt records the model the provider
 * actually served (`observedModel`) next to this requested name.
 */
export const DEEPSEEK_CHAT_MODEL = "deepseek-flash";

/**
 * Application-owned output budget for direct DeepSeek attempts
 * (`max_output_tokens` on the Responses wire). DeepSeek documents an 8K
 * default output for non-thinking requests and much larger thinking defaults;
 * pinning the non-thinking default explicitly means a provider-side default
 * change can never silently widen Kiero's spend. Requests that hit the cap
 * arrive as `response.incomplete` and are classified, never accepted.
 */
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 8_192;

/** Chat / memory analysis order (accepted application order). */
export const CHAT_MODEL_ORDER = [
  { provider: "deepseek", model: DEEPSEEK_CHAT_MODEL },
  { provider: "openrouter", model: "z-ai/glm-5.3-flash" },
  { provider: "openrouter", model: "google/gemini-3.8-flash" },
] as const;

/**
 * Image-extraction order: direct DeepSeek first (native V4.1 Flash vision),
 * then the two vision-capable OpenRouter models. The E2 text-only DeepSeek
 * exclusion is obsolete for the direct model; the removed OpenRouter slug
 * stays excluded (text-only AND a duplicated Flash alias).
 */
export const VISION_MODEL_ORDER = [
  { provider: "deepseek", model: DEEPSEEK_CHAT_MODEL },
  { provider: "openrouter", model: "z-ai/glm-5.3-flash" },
  { provider: "openrouter", model: "google/gemini-3.8-flash" },
] as const;

/** Speech-to-text order: MAI-Transcribe 2 first, Whisper Large V3 backup. */
export const STT_MODEL_ORDER = [
  { provider: "openrouter", model: "microsoft/mai-transcribe-2" },
  { provider: "openrouter", model: "openai/whisper-large-v3" },
] as const;

/** Embedding order (single accepted candidate; replacement is a versioned change). */
export const EMBEDDING_MODEL_ORDER = [
  { provider: "openrouter", model: "qwen/qwen3-embedding-8b" },
] as const;

/**
 * Native Qwen3-Embedding-8B dimension count; the initial proof baseline.
 * Any reduction is a measured-retrieval decision requiring a new index
 * generation (architecture "Provider configuration").
 */
export const EMBEDDING_DIMENSIONS_BASELINE = 4096;

/**
 * Bounded per-attempt deadline for chat requests, on BOTH providers.
 * OpenRouter warns about upstream ~60s processing timeouts for long
 * multimodal jobs; DeepSeek may keep a queued request open for up to ten
 * minutes before inference starts, and the documented guidance is that the
 * client's own deadline remains the authority. A stalled attempt must
 * release control to the fallback loop instead of hanging the whole call.
 */
export const CHAT_ATTEMPT_DEADLINE_MS = 45_000;

/** Bounded per-attempt deadline for the transcription endpoint. */
export const STT_ATTEMPT_DEADLINE_MS = 55_000;

/** Bounded per-attempt deadline for embedding requests. */
export const EMBEDDING_ATTEMPT_DEADLINE_MS = 30_000;

/**
 * One immutable route definition: an ordered provider-qualified target
 * list. The tuple type encodes non-emptiness, so the ordered-route
 * runner's loop provably runs at least one attempt, and an empty route
 * or a bare model slug without its supplier is a compile-time error
 * here rather than a silent runtime corner: every position must say
 * which supplier serves it.
 */
export interface ModelRoute {
  readonly order: readonly [RouteTarget, ...RouteTarget[]];
}

/** The frozen routing table keyed by the A2 contract route ids. */
export const PROVIDER_ROUTING = {
  chat_analysis: { order: CHAT_MODEL_ORDER },
  vision_extraction: { order: VISION_MODEL_ORDER },
  speech_to_text: { order: STT_MODEL_ORDER },
  embedding: { order: EMBEDDING_MODEL_ORDER },
} as const satisfies Record<string, ModelRoute>;

export type ProviderRouteId = keyof typeof PROVIDER_ROUTING;
