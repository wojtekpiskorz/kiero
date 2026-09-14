# Direct DeepSeek API facts for Kiero

Checked on 2026-09-14 against DeepSeek's official documentation, published TanStack package source, and Kiero checkout `8c672ecce4ea5d1b431a3094b9b50992082f138a`.

Published by M2 #166 as the research input for E8 #170.

Owner amendment after this research: direct DeepSeek replaces chat and vision only. OpenRouter remains for transcription and embeddings. The full-removal alternatives below are historical research, not implementation instructions. E8 #170 owns the implementation and unresolved fallback policy. Research used public documentation and package downloads only. No authenticated provider requests, inference calls, dependency changes, issue changes, or cloud changes were made. Package compatibility below is a source-level assessment, not a compiled or live integration proof.

## Conclusion

Direct DeepSeek V4.1 Flash is a documented replacement candidate for Kiero's chat and vision calls. Use `deepseek-flash` at `https://api.deepseek.com`. It does not provide a documented replacement for all four existing provider roles: this research found no supported direct DeepSeek transcription or embedding endpoint. Those roles need explicit replacement suppliers before a complete OpenRouter removal can preserve Kiero's capabilities. [D1], [D2], [D3], [D4], [D8], [K1]

The main integration choices are protocol and thinking mode. Chat Completions documents JSON-object output, but its `response_format` enum excludes `json_schema`. DeepSeek's Responses API explicitly documents JSON-schema output. Both protocols need provider-specific handling before Kiero can enable thinking with tool-history replay. The narrow starting point is direct chat and vision with thinking explicitly disabled, retaining Effect decoding and the existing domain-operation dispatch. [D4], [D5], [D6], [D10], [D11], [K2], [K7]

## Endpoint, authentication, and model identity

| Item | Verified fact |
| --- | --- |
| Canonical OpenAI-format base | `https://api.deepseek.com`. The documented Chat Completions endpoint is `POST https://api.deepseek.com/chat/completions`. [D1], [D4] |
| Authentication | `Authorization: Bearer ${DEEPSEEK_API_KEY}` and JSON content type for chat. `DEEPSEEK_API_KEY` is the recommended Kiero server-side environment name and appears in DeepSeek's own quick-start example. [D1] |
| Responses endpoint | `POST https://api.deepseek.com/responses`, using the same base and API key. [D10], [D11] |
| Anthropic-compatible base | `https://api.deepseek.com/anthropic`; this is another direct protocol, not an OpenRouter route. [D1] |
| Model to request | `deepseek-flash` currently means DeepSeek-V4.1-Flash, released on 2026-09-10, with native visual understanding. Do not send the OpenRouter slug `deepseek/deepseek-v4-flash-0731` to DeepSeek. [D1], [D2], [D3], [K1] |
| Legacy Flash aliases | `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` temporarily route to V4.1 Flash at Flash prices. Their original models have retired. [D1], [D2], [D3] |
| Revision stability | No immutable V4.1 Flash API snapshot ID is documented in the inspected model reference. Alias repointing is explicitly documented, so the request name is not proof of fixed model weights. Preserve requested and returned model identities, routing version, and the response's `system_fingerprint` where available. `GET /models` is documented but was not called. [D2], [D3], [D4], [D12] |

Prefer the provider's canonical base over the `/v1` form found in TanStack examples. A URL path is not a model-version pin. TanStack's examples still use `deepseek-chat` and `deepseek-reasoner`; the DeepSeek changelog announced their discontinuation for 2026-07-24. Those examples are not the current model authority. [D1], [D3], [T1]

### Conflicting Pro retirement statements

The September 10 release article says all `deepseek-v4-pro` requests will route to V4.1 Flash from 04:00 UTC on September 14 until V4.1 Pro launches. The changelog, quick start, and current pricing page instead say V4 Pro service continues after September 14 with unchanged billing. These first-party statements conflict. This draft does not resolve the discrepancy by guessing which deployment is live. Do not use Pro aliases as a V4.1 selector or as a proven independent fallback. [D1], [D2], [D3], [D9]

## Chat, thinking, and tools

### Chat Completions wire contract

Requests contain `model` and a nonempty `messages` array. Supported roles are `system`, `user`, `assistant`, and `tool`. User content can be a string or typed content blocks. Returned assistant messages carry `content`, optional `reasoning_content`, and optional `tool_calls`. A function call contains `id`, `type: "function"`, and `function: { name, arguments }`, where `arguments` is JSON text. Return a tool result as `{ role: "tool", tool_call_id, content }` after the assistant message containing the call. The model requests functions; Kiero executes them. [D4], [D5], [D7]

Declare tools as `{ type: "function", function: { name, description, parameters } }`. Names must be unique, use letters, digits, underscores or hyphens, and have at most 128 characters. `parameters` is a JSON Schema object. Continue decoding arguments against the caller's Effect codec before dispatch; declared JSON Schema alone does not authorize a domain operation. [D4], [K2], [K7]

### Explicit mode selection

| Setting | Documented behavior |
| --- | --- |
| Default | Thinking is enabled with effort `high`. Omitting mode settings changes the behavior of a migration that assumes an ordinary non-thinking chat model. [D5], [D9] |
| Chat non-thinking | Send `thinking: { type: "disabled" }`. The Chat reference also documents `reasoning_effort: "none"` as disabling thinking. Avoid contradictory toggle and effort values. [D4], [D5] |
| Chat thinking | Send `thinking: { type: "enabled" }` and choose `reasoning_effort: "low"`, `"high"`, or `"max"`. Python OpenAI SDK examples put the custom `thinking` field inside `extra_body`; the HTTP body contains `thinking` at the top level. [D5] |
| Responses mode | Use `reasoning: { effort: "none" }` for non-thinking, or `low`, `high`, or `max` for thinking. Responses accepts `summary` but does not generate a reasoning summary. [D5], [D10] |
| Sampling | `temperature` has no effect in thinking mode. Thinking `top_p` is raised to at least `0.95`; non-thinking `top_p` is fixed at `1.0`. Frequency and presence penalties are no longer effective. [D4], [D5] |
| Bounds | Published context is 1M tokens and maximum output is 384K. Chat `max_tokens` accepts 1 through 393216. Defaults are 8K for non-thinking, 64K for thinking, and 128K for maximum effort. Set an application-owned output budget rather than accepting these defaults accidentally. [D4], [D9] |

Chat `tool_choice` supports `none`, `auto`, `required`, and a named function. `auto` is the default with tools. The reference explicitly says `required` and named-function choice return HTTP 400 in thinking mode. Disable thinking for a forced output-tool strategy. The sample under the tool guide's "Non-thinking Mode" heading omits the toggle, so copy the mode contract rather than the sample's omission. [D4], [D5], [D7]

### Reasoning replay is a real compatibility requirement

For Chat requests carrying `tools`, DeepSeek requires the full `reasoning_content` from all previous turns in subsequent requests, including turns with no tool call. Its guide says missing reasoning can cause HTTP 400. Without `tools`, previous reasoning need not be sent and is ignored if supplied. Streamed reasoning arrives in `choices[].delta.reasoning_content`, separate from final-answer `content`. [D4], [D5]

Kiero cannot currently round-trip this contract:

- `packages/providers/src/chat.ts:76-159` represents only user/assistant content, returns text and decoded tool calls, and has no reasoning or native tool-result history field. `harvestStream` ignores reasoning events. [K2]
- `convex/agent/loop.ts:649-666,776-883` stores user/assistant text in `AnswerRoundState`, renders prior tool calls as assistant text, and sends tool results as user text. It does not preserve the original assistant tool-call message or `reasoning_content`. [K7]
- The candidate TanStack Chat Completions base's `extractReasoning` returns `undefined`, and its assistant-message conversion omits `reasoning_content`. Merely changing the base URL does not fix either direction. [T4], `src/adapters/chat-completions-text.ts:678-687,1295-1319`.

Recommendation: explicitly disable thinking for the first migration. Enabling it later requires an owned continuation contract, provider-specific replay conversion, and proof across resumed tool rounds. Reasoning is provider continuation data, not a `Wiadomość źródłowa` or an `Ustalenie`. [D5], [K2], [K7], [K14]

## JSON and structured output differ by protocol

| Path | What the provider documents | Consequence for Kiero |
| --- | --- | --- |
| Chat Completions JSON mode | `response_format: { type: "json_object" }`; the reference enum is exactly `text` or `json_object`. Include "json" and the expected shape in the prompt. Empty content can occur; output can truncate at the token limit. [D4], [D6] | Valid JSON is not the existing strict schema-constrained generation contract. Keep Effect decoding, but make any relaxation from native schema enforcement an explicit owner decision. |
| Chat strict function calling | Beta base `https://api.deepseek.com/beta`, all function definitions set `strict: true`. Supported in thinking and non-thinking modes, subject to tool-choice restrictions. [D7] | A forced result function is an option in non-thinking mode, but it changes how a structured answer is transported. It needs a distinct output-tool mapping rather than accidental execution as a domain tool. |
| Responses JSON Schema | `text: { format: { type: "json_schema", name, schema } }` is explicitly documented, alongside `text` and `json_object`. The guide says `text.format` is fully supported. [D10], [D11] | This is the direct API candidate to prove first if Kiero preserves native schema-constrained output. Do not claim DeepSeek lacks JSON Schema support across all protocols. |

Chat strict-tool schemas require every object property to be required and `additionalProperties: false`. The documented subset supports objects, strings, numbers, integers, booleans, arrays, enums, and `anyOf`; it excludes string `minLength`/`maxLength` and array `minItems`/`maxItems`. DeepSeek validates schemas and rejects unsupported ones. Kiero's Effect-derived schemas contain such bounds, including the extraction probe schema, so forwarding them unchanged to the beta strict path is not established. [D7], [K3]

The Responses reference documents schema conformance, but does not spell out an exhaustive supported JSON Schema dialect or an explicit `strict` field beside `type`, `name`, and `schema`. The TanStack candidate sends `strict: true` and normalizes schemas. Acceptance of that exact request, nullable/optional properties, bounded arrays and strings, and schema plus tools remains unverified. The beta tool-schema restrictions must not be assumed to describe Responses output-schema behavior. [D11], [T4], `src/adapters/responses-text.ts:1853-1877`.

Keep the established conversion and validation authority in `packages/runtime/src/tools.ts`: Effect 4 `Schema.toStandardJSONSchemaV1` followed by TanStack's `convertSchemaToJsonSchema`. Keep output decoding in `packages/providers/src/chat.ts:300-322,433-495`. This task does not justify replacing Effect with Zod or accepting a parsed object without decoding. [K2], [K8]

## Vision inputs

`deepseek-flash` accepts JPEG, PNG, GIF, and WebP, detected from file bytes. Chat images are allowed only in `user` messages. Input forms are an `image_url` block containing a base64 data URL or public HTTP/S URL, or a `file` block containing a Files API `file_id`. Inline `file_data` is also documented. Kiero's current inline JPEG/PNG/WebP user-message contract fits these input forms. [D8], [K2], [K4]

Important documented limits are a 48 MiB request body, 32 MiB per inline or downloaded image, 64 MiB per Files API image, and 600 images per request. Total image size is 64 MiB without file IDs or up to 200 MiB with them. Maximum dimension is 8192 pixels per side, falling to 4096 with at least 15 images. External image URLs are limited to 8192 characters and downloads must finish within 60 seconds. These are provider ceilings, not instructions to enlarge Kiero's existing payload limits. [D8], [K3]

`detail: "low"` downsamples to 512×512. `high`, `original`, and currently `auto` preserve the original detail setting, with the documented inference resizing still applied. Images use at most 1024 tokens each and image tokens are billed with text input tokens. Responses uses `input_image` instead of `image_url` blocks and accepts images in user/developer messages and function outputs. [D8], [D10]

The Files API documents image uploads with `purpose: "user_data"`; it is not an audio-transcription interface. Starting with Kiero's existing inline images avoids needing a file-upload integration to prove chat and vision. [D13], [K4]

## Streaming, final usage, and cost

### Chat stream

Chat streams use data-only SSE and terminate with `data: [DONE]`. Ignore `: keep-alive` comments. Accumulate content and tool argument fragments separately, and retain the terminal finish reason. DeepSeek may keep a queued request open for up to ten minutes before inference starts; Kiero's own deadline should remain the authority. [D4], [D14]

The current Chat reference explicitly says the last chunk before `[DONE]` carries usage regardless of `stream_options.include_usage`. With that flag set, earlier chunks contain `usage: null`; otherwise earlier chunks omit usage. It also explicitly says there is no separate usage-only chunk: the final chunk has exactly one choice, no new content, and a non-null `finish_reason`. This differs from the usual OpenAI usage-only chunk with `choices: []`. The implementation must collect usage independently of content deltas. [D4]

Usage fields include `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`, `prompt_tokens_details.cached_tokens`, and `completion_tokens_details.reasoning_tokens`. Prompt tokens equal cache-hit plus cache-miss tokens. Reasoning tokens are a completion breakdown, not another quantity to add to total output billing. The documented usage object has no request-cost field. [D4], [D9]

Finish reasons include `stop`, `tool_calls`, `length`, `content_filter`, `insufficient_system_resource`, and `aborted`. The existing Kiero harvester does not retain `RUN_FINISHED.finishReason`; its turn decoder derives `stop` solely from the absence of tool calls. The direct integration must classify truncated, aborted, and resource-failed responses before accepting output. A syntactically valid partial result is not proof of successful completion. [D4], [K2]

### Responses stream

Responses streams end with `response.completed`, `response.incomplete`, or `response.failed`, with no `[DONE]` marker. Completion carries the response and usage. Usage uses `input_tokens`, `input_tokens_details.cached_tokens`, `output_tokens`, and `output_tokens_details.reasoning_tokens`. The API is stateless: `previous_response_id`, `conversation`, and storage are unsupported. Supported reasoning input is plain-text `content`; `summary` and `encrypted_content` are unsupported. [D10]

### Published Flash rates

USD per 1M tokens, checked on 2026-09-14. [D9]

| Charge | Off-peak | Peak |
| --- | ---: | ---: |
| Input, cache hit | $0.003 | $0.006 |
| Input, cache miss | $0.15 | $0.30 |
| Output | $0.60 | $1.20 |

Peak windows are Monday through Friday, 01:00-04:00 and 06:00-10:00 UTC. All other times are off-peak. The release dates the new pricing to 04:00 UTC on September 10. The pricing page reserves the right to change prices. It does not specify how a request crossing a pricing boundary is assigned a rate. [D2], [D9]

Context caching is automatic and best-effort. Hits require a complete match with a persisted cache-prefix unit. Units can arise at request boundaries, from repeated common prefixes, or at intervals in long contexts. Persistence takes seconds and idle caches are usually cleared within hours to days. Do not budget every repeated prompt as a cache hit. [D15]

An estimated cost can use `(hitTokens × hitRate + missTokens × missRate + completionTokens × outputRate) / 1_000_000`, with a dated rate table and explicit rate-window assumption. Keep it separate from provider-reported cost. Kiero's `UsageObservation.costUsd` currently means reported cost and should stay absent when DeepSeek does not report one. `callRecord.ts` lacks cache and reasoning counters; the existing harvester also discards TanStack's normalized detail fields. Those additions need owned evidence-contract changes if required for cost analysis. [D4], [D9], [K2], [K9]

## Can DeepSeek replace every current capability?

The current implementation has four distinct role contracts, not one interchangeable model endpoint. The existing chat order has a primary and two backups. [K1], [K3], [K10]

| Role | Current implementation and models | Direct DeepSeek assessment |
| --- | --- | --- |
| `chat_analysis` | `packages/providers/src/chat.ts`; GLM `z-ai/glm-5.3-flash`, then `google/gemini-3.8-flash`, then `deepseek/deepseek-v4-flash-0731`. Typed text, decoded tool calls, and structured output. [K1], [K2] | Documented chat/tool capability, subject to protocol and replay differences above. [D4], [D5], [D11] |
| `vision_extraction` | `packages/providers/src/vision.ts`; GLM then Gemini, required output codec, inline images. The old configuration excludes its text-only DeepSeek route. [K1], [K4] | Native V4.1 Flash vision is documented. The old text-only restriction is obsolete for this new direct model, but structured extraction still needs a compatible output path. [D2], [D8], [D11] |
| `speech_to_text` | `packages/providers/src/stt.ts`; `microsoft/mai-transcribe-2`, then `openai/whisper-large-v3`, via OpenRouter's dedicated transcription endpoint. Polish segment input, nonempty verbatim text, optional usage; original-time segment anchoring belongs to the caller. [K1], [K5] | No supported direct DeepSeek `/audio/transcriptions` endpoint or transcription model was found in the inspected public API reference, guides, model list documentation, or current FAQ content. This is unverified/unlisted service support, not an explicit provider statement that no such service can exist. [D4], [D8], [D12], [D13], [D16] |
| `embedding` | `packages/providers/src/embeddings.ts`; `qwen/qwen3-embedding-8b`, finite 4096-dimensional vectors, query/document input distinction. Index candidate repeats the model, dimensions, preparation, and route-version pins. [K1], [K6], [K11] | No supported direct DeepSeek `/embeddings` endpoint or embedding model was found in those public sources. No inspected current source explicitly declares service-wide absence. Treat the capability as unavailable for this migration until supported documentation or separate authorized proof exists. [D4], [D12], [D16] |

The explicit negative evidence is narrower: Chat content blocks list text, image, and image-file inputs; the Files guide lists image formats; Responses says file inputs are unsupported. None establishes audio transcription or embedding generation. Native multimodal visual understanding must not be expanded into an audio claim. Likewise, an OpenAI-compatible SDK exposing `audio` or `embeddings` methods is not evidence that DeepSeek implements those endpoints. [D4], [D8], [D10], [D13]

### Options that preserve STT and embeddings without OpenRouter

These are candidates for owner selection, not changes authorized by the DeepSeek model choice.

- Preserve the MAI primary model through direct Azure Speech. Microsoft documents `POST https://{resource}.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15`, with multipart audio and `enhancedMode.enabled: true`, `enhancedMode.model: "MAI-Transcribe-2"`. Polish, verbatim transcription, and timing are documented. It requires its own Speech resource and credentials and is still labeled public preview. Kiero's base64 OpenRouter body needs an endpoint-specific conversion. [A1], [K5]
- Preserve the Whisper backup model through direct Groq. Groq documents `POST https://api.groq.com/openai/v1/audio/transcriptions`, model `whisper-large-v3`, file or URL input, and JSON/verbose-JSON/text output. Preserve Kiero's per-segment orchestration and output decoding. This is Groq serving Whisper, not a DeepSeek feature. [A2], [K5]
- Preserve the Qwen model family through direct DeepInfra. Its model page documents `POST https://api.deepinfra.com/v1/openai/embeddings`, model `Qwen/Qwen3-Embedding-8B`, and float encoding. Qwen's own model card documents up to 4096 dimensions and distinct query/document preparation. Serving equivalence, preparation, normalization, and observed vector length still require proof; equal dimensions alone do not establish index compatibility. [A3], [A4], [K6], [K11]
- Self-hosting the same Qwen model is documented through Transformers, vLLM, and Text Embeddings Inference. It preserves a model candidate while adding inference operations. Choosing another embedding model is also possible, but requires an explicitly versioned index generation and retrieval qualification. [A4], [K11]

A complete OpenRouter replacement therefore needs direct STT and embedding work as prerequisites. Retaining the existing OpenRouter routes would be a separately approved transitional exception, not an implicit fallback for requests described as direct DeepSeek. Do not delete audio input or semantic retrieval to make a single-provider migration appear complete.

## TanStack AI options against Kiero's actual pins

Kiero pins `@tanstack/ai` to `0.53.0`, `@tanstack/ai-openrouter` to `0.19.8`, and Effect to `4.0.0-rc.112`. It has no installed `@tanstack/ai-openai`. Current chat calls `createOpenRouterText(...).chatStream(...)`; STT and embeddings use `@openrouter/sdk` directly. Therefore replacing the TanStack chat adapter does not replace those other two integrations. [K12], [K2], [K5], [K6]

### Published compatible-adapter candidate

`@tanstack/ai-openai@0.22.5` publishes `@tanstack/ai-openai/compatible`, including `openaiCompatible` and `openaiCompatibleText`. Its declared core peer is `@tanstack/ai: ^0.53.0`. `openaiCompatible` accepts explicit `apiKey`, `baseURL`, a model list, a provider name, and `api: "chat-completions"` or `"responses"`. It creates the OpenAI client with those options; no OpenRouter client is involved. [T2], [T3], `src/compatible/index.ts`, `src/compatible/types.ts`.

The matching source baseline is `@tanstack/openai-base@0.10.10`, also declaring the `^0.53.0` core peer. Be precise about transitive resolution: `ai-openai@0.22.5` depends on `openai-base: ^0.10.10`, which also permits `0.10.11`, whose core peer is `^0.54.0`. The latest `ai-openai@0.22.6` likewise requires `^0.54.0`. A later owned dependency addition must deliberately lock a compatible graph; installing latest is not a proof against Kiero's current pins. No installation or upgrade was performed here. [T2], [T4], [T5], [T6]

Source-level integration options:

1. **Responses with non-thinking.** Configure the compatible factory with `name: "deepseek"`, canonical DeepSeek base, explicit DeepSeek key, model `deepseek-flash`, and `api: "responses"`. Use `modelOptions.reasoning.effort: "none"`, a bounded `max_output_tokens`, and `text.format` for schema output. This is the first candidate to prove for preserving native structured chat and vision. The base converts image data to `input_image`, forwards provider-native model options, and maps response events into TanStack events. [D10], [D11], [T3], [T4], `src/adapters/responses-text.ts:1851-1900,2038-2069`.
2. **Chat Completions with non-thinking.** The compatible factory defaults to Chat Completions. Provider-native `thinking`, `reasoning_effort`, `max_tokens`, and `response_format` can flow through `modelOptions`. Ordinary chat and image inputs are plausible; use JSON-object output only after owner acceptance of that generation-contract change. The generic `structuredOutput`, `structuredOutputStream`, and combined `outputSchema` paths send `json_schema`, so they cannot be assumed to work on DeepSeek Chat Completions. Kiero already performs its own final decoding, which can remain authoritative. [D4], [D6], [T3], [T4], `src/adapters/chat-completions-text.ts:233-270,402-415,1185-1269`; [K2].
3. **Repository-owned direct TanStack adapter with existing dependencies.** The pinned core exports the `TextAdapter` interface and `AdapterYieldChunk`. Implementing that interface around direct HTTP/SSE is an option if adding a provider package is disallowed or the generic adapter cannot preserve the required wire fields. It must implement the required methods honestly, advertise only supported behavior, and own framing, usage, finish reasons, tools, and decoding. This avoids dependency upgrades but introduces transport code to maintain. A raw HTTP replacement that bypasses TanStack's adapter contract would change the selected invocation boundary. [T7], [K13]

Thinking remains a separate issue on the Responses candidate too. The pinned base replays reasoning as an OpenAI reasoning item with `summary` and optional `encrypted_content`, guarded by a signature. DeepSeek requires plain-text reasoning `content` and says the other two forms are unsupported. Streaming reasoning events successfully is not proof of correct replay. [D10], [T4], `src/adapters/responses-text.ts:1945-1962`.

For all candidates, keep model configuration server-owned, set SDK retries to zero when the existing route runner owns attempts, connect its deadline to the actual request signal, and leave the logger quiet. Preserve Effect input/output decoding and Convex's checked operation dispatch. A future integration proof should inspect the destination host and outgoing request body so OpenRouter-specific `provider.requireParameters`, camelCase options, and model slugs cannot leak into the direct protocol. [K1], [K2], [K7], [K8], [K13]

## Recommended migration boundary and owner decisions

Recommend one issue-owned change for the direct chat/vision transport and configuration, with registered prerequisites for STT and embeddings. Preserve the four route IDs and their typed results. Prove the matched TanStack Responses candidate first with thinking disabled; choose the Chat JSON-object path only if the owner accepts its different generation guarantee. [K1], [K2], [K3], [K4], [K10]

The boundary includes more than `routing.ts`. Current credentials and provider labels are duplicated in `convex/integrations/ai/dispatch.ts`, `convex/agent/loop.ts`, `convex/processing/text/analyze.ts`, `convex/processing/multimodal/modelStage.ts`, `convex/processing/multimodal/vision.ts`, and `convex/processing/audio/executor.ts`. The package-only change would leave production callers reading the old key or recording `provider: "openrouter"`. Register those paths with their owners before editing. Retire superseded provider assertions in architecture/research documentation under the same ownership process. [K2], [K7], [K13], [K15], [K16], [K17], [K18]

Unresolved OWNER decisions:

1. Choose the direct STT primary/backup and embedding supplier. Decide whether the complete OpenRouter removal waits for those prerequisites or has an explicitly authorized transitional exception.
2. Confirm native Responses JSON Schema as the preferred proof target, or explicitly accept Chat JSON-object generation plus Effect rejection. Beta strict output-tool transport is a third, separately specified option.
3. Confirm non-thinking initially. Enabling thinking requires owned message/reasoning replay work rather than a configuration-only switch.
4. Choose the outage policy. If both proposed primary and fallback become `deepseek-flash`, they are duplicate attempts against one model/service. Legacy Flash aliases are also the same model. A different DeepSeek key does not isolate account-level concurrency limits. Collapse duplicate routes, or define a bounded same-provider retry budget honestly; call it a retry rather than an independent fallback. An independent direct provider requires an explicitly selected supplier/model. Pro is not a verified solution to this decision. [D2], [D3], [D14]
5. Set per-role deadlines, output budgets, and the routing-version bump. The existing runner allows fallback only for transport/availability failures and treats authentication, credits, unsupported parameters, unknown tools, and rejected output as terminal. Preserve that discipline unless the owner explicitly changes it. Choose how exhausted direct-provider failures leave work pending or failed; neither missing credentials nor rejected output should silently activate OpenRouter. [K1], [K19], [K20]
6. Decide whether pricing evidence needs cache/reasoning counters, request IDs, fingerprints, and estimated-cost fields beyond the current reported usage contract. Alias tracking and price-window estimates should remain distinguishable from provider-observed values. [D4], [D9], [K9]

Before claiming a working integration, the owning issue needs focused proof of direct destination/auth wiring, image plus schema output, declared tool-argument decoding, terminal usage collection, incomplete/aborted streams, and fallback classification. Thinking replay needs its own multi-round proof if selected. This draft establishes the documented API and package constraints; it does not establish latency, extraction accuracy, Polish transcription quality, retrieval equivalence, or working account access.

## Sources

DeepSeek sources are live official pages checked on the date above. Nested API-reference schemas were read from the official page HTML because the Markdown rendering collapses some fields. The current FAQ's public application bundle was also inspected; its lack of transcription/embedding entries is only absence of documentation, not an explicit service-wide denial.

[D1]: https://api-docs.deepseek.com/
[D2]: https://api-docs.deepseek.com/news/news260910
[D3]: https://api-docs.deepseek.com/updates/#deepseek-v41-flash-release
[D4]: https://api-docs.deepseek.com/api/create-chat-completion
[D5]: https://api-docs.deepseek.com/guides/thinking_mode
[D6]: https://api-docs.deepseek.com/guides/json_mode
[D7]: https://api-docs.deepseek.com/guides/tool_calls
[D8]: https://api-docs.deepseek.com/guides/vision
[D9]: https://api-docs.deepseek.com/quick_start/pricing
[D10]: https://api-docs.deepseek.com/guides/responses_api
[D11]: https://api-docs.deepseek.com/api/create-response
[D12]: https://api-docs.deepseek.com/api/list-models
[D13]: https://api-docs.deepseek.com/guides/files_api
[D14]: https://api-docs.deepseek.com/quick_start/rate_limit
[D15]: https://api-docs.deepseek.com/guides/kv_cache
[D16]: https://static.deepseek.com/faq/index.html?lang=en#/category/4

TanStack source claims refer to exact published archives and file paths within them, not current upstream main. The compatible factory source was also read through version-pinned package file URLs. Registry manifests establish declared peer compatibility only.

[T1]: https://tanstack.com/ai/latest/docs/adapters/openai-compatible
[T2]: https://registry.npmjs.org/@tanstack%2fai-openai/0.22.5
[T3]: https://registry.npmjs.org/@tanstack/ai-openai/-/ai-openai-0.22.5.tgz
[T4]: https://registry.npmjs.org/@tanstack/openai-base/-/openai-base-0.10.10.tgz
[T5]: https://registry.npmjs.org/@tanstack%2fopenai-base/0.10.11
[T6]: https://registry.npmjs.org/@tanstack%2fai-openai/0.22.6
[T7]: https://registry.npmjs.org/@tanstack/ai/-/ai-0.53.0.tgz

`T7` source locations: `src/index.ts` exports `TextAdapter` and `AdapterYieldChunk`; `src/activities/chat/adapter.ts:67-176` defines the interface. These were inspected in Kiero's installed `node_modules/@tanstack/ai` at the pinned version. `T4`'s declared peer version is also available in the [0.10.10 registry manifest](https://registry.npmjs.org/@tanstack%2fopenai-base/0.10.10).

[A1]: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe
[A2]: https://console.groq.com/docs/speech-to-text
[A3]: https://deepinfra.com/Qwen/Qwen3-Embedding-8B/api
[A4]: https://huggingface.co/Qwen/Qwen3-Embedding-8B

Kiero references are fixed to the inspected checkout. They describe existing code, not changes made by this research.

[K1]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/routing.ts#L26-L88
[K2]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/chat.ts
[K3]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/payloads.ts
[K4]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/vision.ts
[K5]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/stt.ts
[K6]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/embeddings.ts
[K7]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/convex/agent/loop.ts#L649-L889
[K8]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/runtime/src/tools.ts
[K9]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/callRecord.ts
[K10]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/contracts/src/modules/integrations.ts
[K11]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/retrieval/src/candidate.ts
[K12]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/package.json#L35-L50
[K13]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/convex/integrations/ai/dispatch.ts
[K14]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/CONTEXT.md
[K15]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/convex/processing/text/analyze.ts
[K16]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/convex/processing/multimodal/modelStage.ts
[K17]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/convex/processing/multimodal/vision.ts
[K18]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/convex/processing/audio/executor.ts
[K19]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/failures.ts#L61-L118
[K20]: https://github.com/wojtekpiskorz/kiero/blob/8c672ecce4ea5d1b431a3094b9b50992082f138a/packages/providers/src/runner.ts
