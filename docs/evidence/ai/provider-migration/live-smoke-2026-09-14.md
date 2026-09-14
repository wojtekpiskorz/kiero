# Live verification against the direct and retained providers (2026-09-14)

All requests used the dev-context credentials carried by the Convex
deployment `wojtek-piskorz-jr:kiero-dev-core:staging` (`DEEPSEEK_API_KEY`,
`OPENROUTER_API_KEY` present in its environment; read into process memory
only — names, statuses, latencies, models and error classes are recorded
here, never headers, bodies or key material). Total spend: roughly twenty
small inference calls, nearly all under 100 output tokens, plus read-only
catalog requests.

## Protocol probes (direct DeepSeek, `https://api.deepseek.com`)

| Probe | Request | Outcome |
| --- | --- | --- |
| Catalog | `GET /models` | HTTP 200, 0.30 s. ids: `deepseek-flash`, `deepseek-v4-pro` (both `owned_by: deepseek`) |
| Responses basics | `POST /responses` non-stream: `instructions` + `reasoning {effort:"none"}` + `max_output_tokens` | HTTP 200, 0.99 s. `status: completed`, `model: deepseek-flash`, usage keys `input_tokens`, `input_tokens_details`, `output_tokens`, `output_tokens_details`, `total_tokens`; output is a `message` item with text content |
| Responses streaming | same, `stream: true` | HTTP 200, 0.98 s. Events: `response.created` → `response.in_progress` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta` → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed` (terminal carries the response with model + usage; no `[DONE]` marker) |
| JSON Schema output | `text.format {type:"json_schema", name, strict:true, schema}` (all-required, `additionalProperties:false`) | HTTP 200, 0.97 s. Accepted; answer conformed to the schema exactly; `total_tokens` 133 |
| Vision input | `input_image` with a `data:image/png;base64` URL in a user message | HTTP 200, 0.94 s. Accepted; the model described the image; `total_tokens` 206 |
| Tool round 1 | one declared function tool | HTTP 200, 0.87 s. Output item `function_call` with `call_id`/`name`/`arguments`; argument fragments arrive as `response.function_call_arguments.delta` keyed by the OUTPUT ITEM id (a UUID distinct from `call_id`); usage 290/41/331 |
| Tool round 2 | replay: original user item + `function_call` + `function_call_output` items | HTTP 200, 0.57 s. The model answered in Polish from the tool result — the native multi-turn tool contract works |
| Truncation | `max_output_tokens: 16`, longer task | HTTP 200, 0.80 s. Terminal `response.incomplete`, `status: "incomplete"`, **`incomplete_details: { reason: "max_output_tokens" }`** (NOT `incomplete_reason`), usage present (35 tokens) |
| Unknown model | model `kiero-nonexistent-probe-model` | HTTP 400, 0.58 s, `invalid_request_error` — terminal `unsupported_parameters` by policy; no fallback |

## OpenRouter catalog and retained roles

`GET /api/v1/models` → HTTP 200, 8.53 s:

- `z-ai/glm-5.3-flash` — listed, `text+image+video -> text` (vision-capable).
- `google/gemini-3.8-flash` — listed, `text+image+file+audio+video -> text`.
- `deepseek/deepseek-v4-flash-0731` — listed but `text -> text` only; EXCLUDED
  from the orders (duplicated Flash alias, not an independent fallback).
- STT/embedding models are not in the chat catalog; they were verified
  through actual endpoint calls in the smoke below.

## Gated live smoke (`tests/e2/live-smoke.test.ts`)

Run with `KIERO_E2_LIVE_SMOKE=1` and both dev keys injected. Result:
**6/6 passed** (`Test Files 1 passed; Tests 6 passed`).

| Proof | Outcome |
| --- | --- |
| Direct structured chat (first-choice position) | succeeded; served by `deepseek` / `deepseek-flash`; routing version `e8.0`; usage recorded; `costUsd` ABSENT (the direct API reports no cost); strict `json_schema` output decoded through the caller's Effect codec |
| Provider-boundary fallback | first probe position `openrouter`/`kiero/nonexistent-probe-model` failed eligible (404-class); the DIRECT `deepseek`/`deepseek-flash` position served the retry — the ordered walk crossed a supplier boundary live |
| Two-round tool conversation | round 1: the model called the declared tool, arguments decoded through the Effect schema; round 2: NATIVE `function_call`/`function_call_output` replay accepted, the model answered from the tool result; both rounds served by `deepseek` |
| Embedding (retained OpenRouter) | succeeded; 4096-dimension vector; observed model contains `qwen3-embedding-8b`; provider recorded `openrouter` |
| Transcription (retained OpenRouter) | well-formed classified outcome on a synthetic tone (openrouter; either a non-empty transcript or an explicit failure kind is accepted — a tone carries no speech) |
| Vision (direct route) | succeeded; tiny synthetic PNG through `input_image`; extraction decoded; served by `deepseek` / `deepseek-flash` |

### Sanitized machine record (separate one-call evidence probe, same day)

```json
{"probe":"direct-structured-chat","wallClockMs":984,
 "outcome":{"outcome":"succeeded","decoded":true,"odp":"tak"},
 "record":{"routeId":"chat_analysis","routingConfigVersion":"e8.0","attempts":[
   {"routeId":"chat_analysis","routingConfigVersion":"e8.0","provider":"deepseek",
    "requestedModel":"deepseek-flash","observedModel":"deepseek-flash",
    "outcome":"succeeded","startedAtMs":1789400677546,"finishedAtMs":1789400678529,
    "firstOutputAtMs":1789400678421,
    "usage":{"promptTokens":71,"completionTokens":7,"totalTokens":78}}]},
 "frozenRoute":[{"provider":"deepseek","model":"deepseek-flash"},
   {"provider":"openrouter","model":"z-ai/glm-5.3-flash"},
   {"provider":"openrouter","model":"google/gemini-3.8-flash"}]}
```

(984 ms wall clock, first streamed output ~875 ms after request, 78 total
tokens, no cost field.)

## Honest limits of this evidence

- The live fallback proof walks an OpenRouter 404 position INTO the direct
  provider. Forcing the reverse direction (direct DeepSeek failing
  ELIGIBLY into OpenRouter) live would require a real outage: DeepSeek
  answers an unknown model with HTTP 400, which is terminal by policy.
  That direction is proven offline with synthetic failures in
  `tests/e2/fallback.test.ts`.
- The live smoke did not exercise every Effect-derived schema shape against
  `text.format json_schema`; the smoke's contracts (required struct with a
  bounded array) and the probe's strict all-required schema were accepted.
  Richer optional/nullable conversions ride the same TanStack conversion
  path already proved for OpenRouter strict mode.
- D7/J6/J3 own complete application qualification; this smoke proves the
  transport, routing and decode seams only.
