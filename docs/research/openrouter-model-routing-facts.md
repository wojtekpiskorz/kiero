# OpenRouter model routing facts

Checked on 2026-09-08 against OpenRouter's public model catalog, endpoint API and documentation. The owner prefers GLM 5.3 Flash with a provider exceeding 100 output tokens per second, then Gemini 3.8 Flash, then DeepSeek V4 Flash. The owner subsequently accepted the Q198–Q200 recommendations below: evaluation procedure, temporary speed dips, image-stage roles and DeepSeek 0731 GA. Historical proposal wording describes that accepted direction, not an executed test. No paid inference request, account setting change or integration test was performed.

## Model identities and input support

| Owner preference | Observed OpenRouter identifier | Catalog input support |
| --- | --- | --- |
| Primary GLM 5.3 Flash | `z-ai/glm-5.3-flash` | Text, image, video |
| First backup Gemini 3.8 Flash | `google/gemini-3.8-flash` | Text, image, audio, video, file |
| Second backup DeepSeek V4 Flash | `deepseek/deepseek-v4-flash-0731`, accepted in Q200 | Text |

All three model-level records list tools and structured output parameters. Model-level support is not a guarantee for every serving endpoint or combination of options. The owner initially did not specify a DeepSeek revision and subsequently accepted 0731 in Q200. The 0731 page calls it the GA release; the shorter `deepseek/deepseek-v4-flash` catalog record names the older 0423 revision. The separate `deepseek/deepseek-v4-flash-vision-exp` is experimental and is not silently substituted. [Public model catalog](https://openrouter.ai/api/v1/models), [GLM](https://openrouter.ai/z-ai/glm-5.3-flash), [Gemini](https://openrouter.ai/google/gemini-3.8-flash), [DeepSeek GA](https://openrouter.ai/deepseek/deepseek-v4-flash-0731)

Proposed Kiero use: GLM then Gemini for image interpretation. The text-only DeepSeek route can analyze completed, source-linked visual extraction results but cannot substitute for an unavailable visual extraction stage. If both image-capable routes fail, retain the image and its pending extraction state; process only independent information whose basis is available. Ordinary conversational analysis of text and completed extraction results can use all three in the owner's order. STT and embedding model choices remain separate.

## Serving speed and endpoint differences

OpenRouter's model pages displayed the following P50 values during this check. These are published recent aggregates, not measurements of Kiero requests or guaranteed minimums.

| Model | Provider shown | Throughput | Latency shown |
| --- | --- | --- | --- |
| GLM 5.3 Flash | Modal | 165 tokens/s | 0.29 s |
| GLM 5.3 Flash | Makora | 110 tokens/s | 0.41 s |
| Gemini 3.8 Flash | Google AI Studio Priority | 210 tokens/s | 2.42 s |
| DeepSeek V4 Flash 0731 | Wafer | 123 tokens/s | 0.52 s |

Sources: [GLM provider table](https://openrouter.ai/z-ai/glm-5.3-flash), [Gemini provider table](https://openrouter.ai/google/gemini-3.8-flash), [DeepSeek provider table](https://openrouter.ai/deepseek/deepseek-v4-flash-0731). Prices are deliberately not frozen here: current promotions, service tiers and routing can change the billed rate. Token throughput also does not measure total source-to-memory time, which includes waiting, input processing, reasoning, tools, media stages and publication.

Public endpoint responses listed 25 GLM, 6 Gemini and 29 DeepSeek entries. Every `throughput_last_30m` and `latency_last_30m` field in these responses was null; the numeric table above comes from the model webpages, not that API. Null metrics mean unavailable. Endpoint API and rendered page aggregates need not cover the same interval.

The observed GLM endpoint `modal/fp8` lists `tools`, `response_format` and `structured_outputs` but omits `tool_choice`; its `supports_tool_choice` flags are all false. The `makora` GLM endpoint lists `tool_choice`, with `none`, `auto` and specific-function support true but `required` false. These records justify targeted tests, not a claim that either provider satisfies every Kiero tool loop. Do not add `tool_choice: required` indiscriminately and assume a speed-qualified provider remains eligible. [GLM endpoints](https://openrouter.ai/api/v1/models/z-ai/glm-5.3-flash/endpoints)

Gemini's `google-ai-studio/priority` lists all four tool-choice modes as supported. DeepSeek's `wafer/fast` lists auto, required and specific-function modes, but not none. Exact provider tags, service-tier eligibility and requested tool/schema combinations must be checked through the selected TanStack adapter. [Gemini endpoints](https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints), [DeepSeek endpoints](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints)

## Ordering and performance controls

OpenRouter's `models` list accepts ordered fallback IDs. Its documented error-driven fallback does not establish that a slowly progressing successful request will be abandoned. Kiero's bounded attempt/deadline policy must address that separately. A provider or model retry cannot replay already published domain operations. [Model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks)

`provider.sort` can prioritize throughput. With several models, `sort: { by: "throughput", partition: "model" }` preserves model grouping and the primary model's precedence; `partition: "none"` sorts across all models and can contradict the owner's preferred order. The documented `preferred_min_throughput` and `preferred_max_latency` controls only deprioritize below-target endpoints. They never guarantee the threshold or exclude all slower providers. A numeric threshold applies to P50; routing percentile statistics use a rolling five-minute window. [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)

Proposed alpha policy: prefer measured fast compatible GLM endpoints, preserve GLM/Gemini/DeepSeek order, and permit slower successful service during a speed dip while retaining bounded execution and the existing visible pending state. A strict refusal to use any endpoint below 100 tokens/s would require a different explicit availability tradeoff. A static provider allowlist can restrict serving identities but cannot guarantee the speed of future requests.

`require_parameters: true` rejects providers lacking requested parameters; it is not evidence of correct tool arguments or valid business changes. Runtime schema validation and Kiero's atomic checked operations remain authoritative. The `:nitro` suffix also makes priority-tier endpoints eligible, so it is not merely a harmless alias for throughput sorting. Do not silently use it as an account-independent performance guarantee. [Provider selection](https://openrouter.ai/docs/guides/routing/provider-selection)

## Required proof

Use the owner's three preferred models as the initial evaluation baseline. Verify actual selected provider/model, tools, structured results, Polish dates/amounts/project attribution, image support, first useful output, total latency and bounded failover. Exercise interrupted tool loops and invalid results without duplicate domain changes. Recheck provider metadata before configuration is pinned. Catalog presence and the webpage speed table do not prove the accepted alpha correctness or 60-second processing target.

The approximately 50-case evaluation procedure was accepted with the Q198–Q200 round. It remains unexecuted. These decisions do not authorize a new unrestricted model search or change the app-owned model-selection contract.
