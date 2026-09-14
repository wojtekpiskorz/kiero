# ADR: Provider routing — direct DeepSeek chat/vision with retained OpenRouter audio and embeddings

Status: Accepted (E8 #170; owner decisions 2026-09-14). Routing version `e8.0`.
Amends the E2 provider configuration decision (chat/vision embeddings order)
recorded in docs/mvp/architecture-design.md ("Provider configuration").

## Decision

1. **Chat, memory analysis and vision run DIRECT on DeepSeek.** Base
   `https://api.deepseek.com` (canonical, no `/v1` suffix), credential
   `DEEPSEEK_API_KEY`, model alias `deepseek-flash`. The alias was observed
   resolving to DeepSeek-V4.1-Flash (released 2026-09-10, native visual
   understanding) and was verified AVAILABLE on the direct API on
   2026-09-14 (`GET /models` → HTTP 200, ids `deepseek-flash`,
   `deepseek-v4-pro`). Aliases are mutable: every attempt records the
   model the provider actually served (`observedModel`) next to the
   requested name, under the frozen routing version.
2. **OpenRouter is explicitly authorized as the chat/vision FALLBACK
   provider** (owner decision on issue #170, comment dated 2026-09-14). A
   duplicated Flash alias through OpenRouter does NOT count as independent
   fallback, so the former `deepseek/deepseek-v4-flash-0731` chat position
   is REMOVED: it is the same model the direct route already tried, and a
   second attempt against it would be a disguised same-model retry. The
   fallback positions are `z-ai/glm-5.3-flash` then
   `google/gemini-3.8-flash` — models distinct from the DeepSeek alias,
   both verified listed and AVAILABLE on OpenRouter on 2026-09-14
   (`GET /api/v1/models` → HTTP 200; both text+image input for vision).
3. **STT and embeddings stay on OpenRouter** (owner decision 2026-09-14;
   the full-removal alternatives in
   docs/research/deepseek-direct-api-facts.md are superseded): no supported
   direct DeepSeek transcription or embeddings endpoint exists. The
   accepted orders are unchanged (`microsoft/mai-transcribe-2` with
   `openai/whisper-large-v3` backup; `qwen/qwen3-embedding-8b` at the
   4096-dimension baseline) and still use `OPENROUTER_API_KEY`.
4. **The frozen route is provider-qualified, and the type is closed.** Each
   route position is `{ provider: "deepseek" | "openrouter", model }`;
   every recorded attempt carries its provider, so usage/cost accounting
   distinguishes suppliers even where model names alone would be ambiguous.
   `ModelRoute.order` accepts ONLY provider-qualified targets: a bare model
   slug is a compile-time error, not a silently normalized value. (A
   temporary legacy slug-normalization shim carried D6's pre-split probe
   routes through the first review round; the coordinated review lane
   qualified those literals and deleted the shim; see the integration
   record in docs/evidence/ai/provider-migration/.

Frozen orders (routing version `e8.0`, `packages/providers/src/routing.ts`):

| Route | Order |
| --- | --- |
| `chat_analysis` | deepseek `deepseek-flash` → openrouter `z-ai/glm-5.3-flash` → openrouter `google/gemini-3.8-flash` |
| `vision_extraction` | deepseek `deepseek-flash` → openrouter `z-ai/glm-5.3-flash` → openrouter `google/gemini-3.8-flash` |
| `speech_to_text` | openrouter `microsoft/mai-transcribe-2` → openrouter `openai/whisper-large-v3` |
| `embedding` | openrouter `qwen/qwen3-embedding-8b` (4096-dim baseline) |

## Wire protocol and thinking mode (direct transport)

Selected: **DeepSeek Responses API** (`POST /responses`, `stream: true`)
with **thinking explicitly disabled** (`reasoning: { effort: "none" }`).

Why this selection (sources: docs/research/deepseek-direct-api-facts.md
[D4], [D5], [D10], [D11]; live verification 2026-09-14 in
docs/evidence/ai/provider-migration/):

- **Structured output.** The Responses API documents native JSON-Schema
  output (`text.format: { type: "json_schema", name, strict, schema }`);
  Chat Completions documents only `json_object` [D6], [D10], [D11]. Kiero's
  existing generation contract is strict schema-constrained output through
  the A3 conversion; relaxing to JSON-object prompting is an owner decision
  that has NOT been made. Native JSON Schema was verified live: a strict
  schema with `additionalProperties: false` was accepted (HTTP 200) and
  produced conforming JSON.
- **Thinking.** Thinking defaults ON with effort `high` [D5]; disabling it
  is explicit (`reasoning.effort: "none"` on Responses, verified live).
  Enabling thinking would require replaying the full `reasoning_content`
  of every prior turn for tool-carrying conversations [D4], [D5] — a
  continuation contract Kiero does not own (the answer loop's rounds are
  resumable state, not provider reasoning transcripts). Reasoning is
  provider continuation data, not a `Wiadomość źródłowa` or `Ustalenie`.
- **Multi-turn tools.** Native tool rounds are used on BOTH transports:
  the assistant's calls replay as `function_call` items and results as
  `function_call_output` items (verified live, two-round conversation,
  2026-09-14). The typed request (`ChatMessagePart`) carries the native
  round, and the OpenRouter branch maps it through TanStack's
  `ModelMessage` tool calls, so a loop whose earlier rounds served on
  DeepSeek-direct continues unchanged when an eligible failure moves the
  route to the fallback. The E6 answer loop now replays native rounds
  instead of prose renderings.
- **Vision.** Inline images map to `input_image` data-URL blocks in user
  messages (verified live, HTTP 200 with a synthetic PNG). The E2
  text-only DeepSeek exclusion is obsolete for the direct model; the
  removed OpenRouter DeepSeek slug stays excluded (text-only AND a
  duplicated alias).
- **Output budget.** `max_output_tokens` is pinned to an application-owned
  8192 (`DEEPSEEK_MAX_OUTPUT_TOKENS`, the documented non-thinking default)
  so provider-side default drift can never silently widen spend. A
  truncated generation arrives as `response.incomplete` with
  `incomplete_details.reason` (field verified live) and is classified, see
  below.

## Adapter selection (issue criterion 6)

No dependency was added or changed. The direct transport is
repository-owned (`packages/providers/src/deepseek.ts`): it issues the
documented Responses request itself and emits the SAME AG-UI event
vocabulary (`AdapterYieldChunk`) the pinned `@tanstack/ai-openrouter`
0.19.8 adapter emits, so the existing harvest, Effect decoding, typed
dispatch and ordered-route recording serve the direct provider unchanged.
TanStack (`@tanstack/ai` 0.53.0) and Effect (`4.0.0-rc.112`) stay pinned.

The researched candidate `@tanstack/ai-openai@0.22.5` (with
`@tanstack/openai-base` pinned `0.10.10` via override) was compiled and
exercised against the live direct API in a scratch install (2026-09-14;
details in docs/evidence/ai/provider-migration/adapter-selection.md). It
constructs against core 0.53.0 and serves plain chat correctly, but was
NOT adopted because:

1. its `chatStream` surfaces a truncated (`response.incomplete`)
   generation as a code-less/`"incomplete"`-coded RUN_ERROR — an
   ELIGIBLE failure class — so the ordered loop would retry truncated
   output on the next provider, masking a budget/capability problem as
   availability. Kiero's policy rejects truncated output terminally;
2. adoption adds a permanent override pin (`openai-base` must never
   resolve 0.10.11, whose peer is core ^0.54.0) and an 18-package graph
   movement (including `openai@6.49.0`) that the pinned core does not
   need;
3. the issue's own standard — generic OpenAI compatibility does not prove
     DeepSeek's thinking/schema/terminal cases — favors owning the exact
   wire Kiero must prove.

## Fallback policy (issue criterion 5)

- One ordered-route runner owns the loop on BOTH providers. Eligibility is
  a property of the failure class, not the supplier: `deadline_exceeded`,
  `connection_failed`, `rate_limited`, `provider_unavailable` advance to
  the next position — across the provider boundary; `unauthenticated`,
  `insufficient_credits`, `unsupported_parameters`, `output_rejected`,
  `unknown_tool`, `internal_error` are terminal for the whole call.
- **A rejected DeepSeek key or schema never silently activates
  OpenRouter.** A `deepseek` target with no resolvable direct credential
  fails terminally as `unauthenticated`. Verified live: DeepSeek answers
  an unknown model name with HTTP 400 `invalid_request_error`, which is
  terminal `unsupported_parameters` — a configuration mismatch, not an
  availability problem.
- Per-attempt deadline 45 s on both providers (DeepSeek documents queue
  waits up to ten minutes; the client deadline stays the authority).
  Bounded: each position gets exactly ONE attempt; SDK retries are
  disabled; the ordered loop owns attempts.
- **Degraded behavior when both providers fail:** the call fails with the
  last observed eligible failure standing, every attempt recorded
  (provider, model, classification, latency). No substitution, no silent
  success, no fabricated output. J3 acceptance is not reduced: callers
  keep work pending/failed exactly as the E2 contract prescribed.

## Terminal-state and sanitization discipline (direct transport)

- `response.completed` finishes `stop`/`tool_calls`; usage
  (`input_tokens`/`output_tokens`/`total_tokens`) maps onto the recorded
  observation. The direct API reports NO request cost: `costUsd` stays
  ABSENT for direct attempts (absent is not zero); OpenRouter attempts
  keep reporting cost when the provider sends one. Cache/reasoning token
  breakdowns are not added to the record contract (an evidence-contract
  change owned elsewhere).
- `response.incomplete` with `incomplete_details.reason`
  `max_output_tokens`/`content_filter` finishes `length`/`content_filter`
  and the typed decode REJECTS the output terminally (`output_rejected`)
  — a syntactically valid partial result is not success. Unknown
  incomplete reasons and `response.failed` become sanitized RUN_ERROR
  classifications (`provider_unavailable`, eligible) — never a silent
  acceptance. A stream that ends without a terminal event is a provider
  protocol failure, also classified.
- Provider error bodies are never read; failures carry machine-readable
  codes only. Polish closed-error copy is unchanged.

## Consequences

- `convex/agent` (E6 answer loop) passes both keys explicitly
  (`ChatTurnCredentials`), fails fast naming the missing variable, and
  replays native tool rounds. `convex/search` (E5) is unchanged
  (embeddings stayed OpenRouter).
- The chat/vision entry points keep accepting the legacy
  `{ apiKey }` OpenRouter credential shape (extended optionally with
  `deepseekApiKey`), so call sites outside this issue's ownership
  (`convex/integrations/ai/dispatch.ts`, `convex/processing/*`) compile
  and route through DeepSeek-direct unchanged; their follow-ups are
  recorded as prerequisites below.
- Routing version bumped `e2.0` → `e8.0`; every attempt records it plus
  the provider column (optional, backward-compatible for stored records).

### Prerequisites outside E8's ownership (proposed, not edited here)

1. `.env.example` and `infra/environments/local.md`: document
   `DEEPSEEK_API_KEY` as a server-side secret name (the staging Convex
   deployment and GitHub `staging` environment already carry it).
2. `convex/integrations/ai/dispatch.ts`: its missing-key guard checks only
   `OPENROUTER_API_KEY`; it should also fail fast when
   `DEEPSEEK_API_KEY` is absent for chat/vision routes (chat attempts
   otherwise classify `unauthenticated` per-call).
3. `convex/processing/text/analyze.ts`: the `MODEL_CONFIGURATION_VERSION`
   label prefix `e2.routing/` now reads `e2.routing/e8.0#...`; renaming
   the namespace is its owner's call (tests pin the current value).
4. `docs/mvp/architecture-design.md` "Provider configuration" table: still
   describes the pre-split OpenRouter-only order; should reference this
   ADR.

Resolved in the coordinated review lane (recorded in the integration
record, docs/evidence/ai/provider-migration/integration-record.md): the D6
seam fixture follow-up formerly listed here. The coordinator applied the
`scriptedAttempt` fixture fix (`target.model`) on the branch, and the same
coordinated lane qualified the two `probeRoute` literals in
`tests/d6/pipeline.test.ts` as provider-qualified targets and deleted the
legacy slug-normalization shim from the routing layer.
