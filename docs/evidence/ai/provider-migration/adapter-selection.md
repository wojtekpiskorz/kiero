# Adapter selection for the direct transport (issue criterion 6, 2026-09-14)

## Decision

No dependency was added or changed: `package.json` and `package-lock.json`
are untouched by E8. The pinned stack stays `@tanstack/ai` 0.53.0,
`@tanstack/ai-openrouter` 0.19.8 (fallback + retained roles), Effect
4.0.0-rc.112. The direct DeepSeek transport is repository-owned
(`packages/providers/src/deepseek.ts`), emitting the TanStack AG-UI event
vocabulary (`AdapterYieldChunk`) into the existing harvest/decode/runner
machinery.

## The researched candidate, compiled and exercised

Per the research file's source-level candidate (`@tanstack/ai-openai`
0.22.5 with `@tanstack/openai-base` 0.10.10), a scratch install (outside
the repository; the repo lockfile never moved) resolved:

```text
@tanstack/ai-openai@0.22.5
├── @tanstack/ai@0.53.0            (deduped against the trial pin)
├── @tanstack/openai-base@0.10.10  (forced via override; 0.10.11 would
│                                     pull peer ^0.54.0 core)
└── openai@6.49.0
18 packages total
```

Trial against the live direct API (dev key; sanitized outcomes only):

1. **Preserved failed attempt** — first run threw
   `TypeError: Cannot read properties of undefined (reading 'errors')`
   before any request: the adapter's `chatStream` crashes without an
   explicit `logger` in the call options. Usable only with a silent logger
   supplied at every call site.
2. **Plain chat** (`api: "responses"`, `reasoning.effort "none"`):
   succeeded in ~1.1 s. Event stream `RUN_STARTED` → `TEXT_MESSAGE_*` →
   `RUN_FINISHED` carrying `model: "deepseek-flash"`, `finishReason:
   "stop"`, usage keys `promptTokens`/`completionTokens`/`totalTokens`.
   The candidate is genuinely viable for the simple case against core
   0.53.0.
3. **Truncation** (`max_output_tokens: 1`): the stream ends with
   `RUN_ERROR` after the text events. Source inspection of the installed
   `openai-base@0.10.10` `responses-text.js` confirms why: the
   `chatStream` path maps `response.incomplete`/`response.failed` to a
   RUN_ERROR whose code is `response.error?.code ?? "incomplete"` (or
   absent). Under Kiero's classifier that is `provider_unavailable` — a
   FALLBACK-ELIGIBLE class — so the ordered loop would retry a truncated
   generation on the next provider and mask a budget/capability problem as
   availability. (The `structuredOutputStream` path in the same file maps
   incomplete to `finishReason: "length"` — the two paths disagree, and
   Kiero's calls use `chatStream`.)

## Why the repository-owned transport was selected

1. **Terminal-state discipline is a hard requirement.** The issue demands
   that truncated/aborted/resource-failed responses are classified before
   output is accepted. The owned transport maps
   `response.incomplete` (`incomplete_details.reason`, field verified live)
   to `finishReason: "length"/"content_filter"`, which the typed decode
   rejects TERMINALLY; unknown reasons and `response.failed` become
   sanitized classified failures. The candidate's eligible-class truncation
   contradicts the accepted fail-closed policy.
2. **No dependency movement.** Adoption would add a permanent
   `@tanstack/openai-base` override pin (to stop 0.10.11 resolving against
   core ^0.54.0) and an 18-package graph including `openai@6.49.0`. The
   R11 precedent is minimal lockfile movement; the pinned core needs none
   of it.
3. **The issue's own standard.** "Generic OpenAI compatibility does not
   prove these cases": thinking-mode selection, native JSON-Schema output,
   native tool rounds, terminal-state classification and no-cost usage
   collection are exactly the wire facts Kiero must own and prove — and
   they were verified live against the documented direct API (see
   [live-smoke-2026-09-14.md](./live-smoke-2026-09-14.md)).
4. **Uniformity.** The fallback positions keep the pinned
   `@tanstack/ai-openrouter` adapter; both transports emit the same event
   vocabulary into the same harvest, so one decode authority and one
   ordered-route runner serve both suppliers.

The candidate remains a reasonable future option if Kiero ever adopts the
Responses protocol across providers; the blocker is behavioral (truncation
classification), not compatibility.
