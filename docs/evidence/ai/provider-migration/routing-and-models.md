# Routing version, models and fallback policy (E8, 2026-09-14)

## Routing version

`ROUTING_CONFIG_VERSION = "e8.0"` (was `e2.0`). Every recorded attempt
carries it plus a `provider` column (`deepseek` | `openrouter`, optional so
pre-split stored records still decode).

## Frozen provider-qualified orders

| Route | Order (`provider` / model) | Live availability check (2026-09-14) |
| --- | --- | --- |
| `chat_analysis` | `deepseek`/`deepseek-flash` → `openrouter`/`z-ai/glm-5.3-flash` → `openrouter`/`google/gemini-3.8-flash` | direct `GET /models` HTTP 200 (ids `deepseek-flash`, `deepseek-v4-pro`); OpenRouter `GET /api/v1/models` HTTP 200 lists both fallbacks |
| `vision_extraction` | `deepseek`/`deepseek-flash` → `openrouter`/`z-ai/glm-5.3-flash` → `openrouter`/`google/gemini-3.8-flash` | both OpenRouter fallbacks list `text+image` input modalities (vision-capable); direct vision verified with a real image request (see live smoke) |
| `speech_to_text` | `openrouter`/`microsoft/mai-transcribe-2` → `openrouter`/`openai/whisper-large-v3` | retained unchanged; STT endpoint exercised in the live smoke |
| `embedding` | `openrouter`/`qwen/qwen3-embedding-8b` (4096-dim baseline) | retained unchanged; embeddings endpoint exercised in the live smoke (4096-dim vector observed) |

The OpenRouter chat-models catalog (`/api/v1/models`) does not list the
STT/embeddings models; those ride OpenRouter's dedicated endpoints and were
verified through actual endpoint calls, not the catalog.

## Model alias identity (mutable aliases; dates recorded)

- `deepseek-flash`: observed 2026-09-14 as the direct API's served model
  (`response.model` echoes `deepseek-flash`; `GET /models` lists it
  `owned_by: deepseek`). Documentation dated the alias to DeepSeek-V4.1
  Flash, released 2026-09-10. The alias is NOT a version pin: every attempt
  records `observedModel` next to the requested name under routing version
  `e8.0`. Legacy aliases (`deepseek-v4-flash`,
  `deepseek-v4-flash-vision-exp`) were not used.
- `z-ai/glm-5.3-flash` and `google/gemini-3.8-flash`: OpenRouter catalog
  entries verified listed and available 2026-09-14, both vision-capable,
  distinct from any DeepSeek alias.

## Fallback policy

Authority: owner decision recorded on
[issue #170](https://github.com/wojtekpiskorz/kiero/issues/170) (comment
dated 2026-09-14): OpenRouter is EXPLICITLY AUTHORIZED as the chat/vision
fallback when DeepSeek fails; a duplicated Flash alias through OpenRouter
does NOT count as independent fallback. Consequences implemented:

- The former `deepseek/deepseek-v4-flash-0731` OpenRouter chat position is
  removed (same model as the direct primary — a disguised same-model
  retry, not a fallback).
- Fallback positions are models on the OTHER supplier, distinct from the
  DeepSeek alias, availability-verified with dates above.
- Failure classes that advance the order (on either supplier):
  `deadline_exceeded`, `connection_failed`, `rate_limited`,
  `provider_unavailable`. Terminal: `unauthenticated`,
  `insufficient_credits`, `unsupported_parameters`, `output_rejected`,
  `unknown_tool`, `internal_error`.
- Verified live (2026-09-14): DeepSeek answers an unknown model name with
  HTTP 400 `invalid_request_error` → terminal `unsupported_parameters`; it
  does not fall back. A missing direct credential is terminal
  `unauthenticated` (no request is made).
- Deadline/retry semantics: 45 s per chat attempt on both suppliers
  (`CHAT_ATTEMPT_DEADLINE_MS`), 55 s STT, 30 s embeddings; one attempt per
  position; SDK retry disabled (`retryConfig: { strategy: "none" }`); the
  ordered-route runner owns the loop. DeepSeek documents queue waits up to
  ten minutes — the client deadline remains the authority.
- Degraded outcome when every position failed: the last observed eligible
  failure stands, all attempts recorded. Covered offline in
  `tests/e2/fallback.test.ts` ("both providers failing eligible failures
  records every route and the degraded outcome").

## Credentials

- `DEEPSEEK_API_KEY` — direct chat/vision primary. Canonical reader
  `deepSeekCredentialsFromEnv`; callers may inject `deepseekApiKey`
  explicitly (the E6 answer loop does). Absent key + `deepseek` target →
  terminal `unauthenticated`, no request issued.
- `OPENROUTER_API_KEY` — retained STT/embeddings AND the authorized
  chat/vision fallback positions. Canonical reader
  `openRouterCredentialsFromEnv` (unchanged).
- Credential routing is proven offline in
  `tests/e2/deepseek-transport.test.ts` ("credential routing per
  provider"): the direct request carries only the DeepSeek bearer key; no
  resolvable key means no request.

## Usage and cost accounting

- OpenRouter attempts: unchanged (`promptTokens`/`completionTokens`/
  `totalTokens`/`costUsd`/`audioSeconds` as reported).
- Direct DeepSeek attempts: `promptTokens`/`completionTokens`/
  `totalTokens` from the Responses usage object; `costUsd` stays ABSENT
  (the direct API reports no request cost — absent is not zero). Cache
  (`prompt_cache_hit/miss`) and reasoning token breakdowns are NOT added
  to the record contract; an evidence-contract change for estimated-cost
  analysis belongs to its own owner (research decision point 6).
- The provider column on every attempt keeps per-supplier accounting
  separable for the J3 corpus reports.
