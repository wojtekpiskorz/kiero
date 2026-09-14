# R14 evidence: E8 provider-split integration follow-ups (issue #187)

Worktree `/projects/kiero-worktrees/r14-followups`, base `main` at `3cf9f6e`
(E8's provider split, PR #188). Every criterion below names its files, the
commands run and the observed result. No credential value was printed,
logged or written at any point; only names and presence appear here.

## 1. `DEEPSEEK_API_KEY` documented (name + consumer)

Files: `.env.example`, `infra/environments/local.md`.

- `.env.example` gains the `DEEPSEEK_API_KEY=` row directly under the
  OpenRouter row, in the same one-comment-plus-name shape, naming the
  consumer (the e8.0 direct chat/vision primary,
  `packages/providers/src/deepseek.ts`) and pointing at
  `docs/adr/provider-routing-2026-09.md`.
- `infra/environments/local.md` gains the secret-inventory row: consumer
  "Convex server actions (AI chat/vision calls: the e8.0 direct DeepSeek
  primary route)". The status cell records only names/presence: the name is
  verified in the Convex `staging` deployment and the GitHub `staging`
  environment (E8 live smoke, 2026-09-14;
  `docs/evidence/ai/provider-migration/live-smoke-2026-09-14.md`), while
  local `.env` and dev-deployment injection stay PENDING (I8 owns runtime
  binding injection). The dev-environment subset framing and the sibling
  OpenRouter row are unchanged.

Command: `rtk npm run verify:environments` (the infra shape check) passed
against the edited file.

## 2. The missing-key guard in `convex/integrations/ai/dispatch.ts`

Files: `convex/integrations/ai/dispatch.ts`,
`tests/e7/provider-key-guard.test.ts` (new).

What changed:

- `directDeepSeekKeyPresent()` mirrors `openRouterCredentials()`: reads
  `process.env.DEEPSEEK_API_KEY`, presence only, never the value; an empty
  string counts as absent.
- `routeStartsAtDirectDeepSeek(routeId)` derives the requirement from
  `PROVIDER_ROUTING[routeId].order[0].provider === "deepseek"` instead of a
  hardcoded route list, so a future routing version that moves a route off
  the direct primary retires the guard with the route definition.
- In the `integrations.executeModelCall` handler the guard sits after the
  OpenRouter guard and after the PURE payload validation
  (`decodePayload`: contract decode + payload-kind/route-id agreement), and
  before `executeDecodedPayload` performs any provider call. Refusal is the
  honest typed `unavailable` error, non-retryable, code
  `provider_deepseek_key_not_configured` (the closed `ErrorCode` contract
  allows only `^[a-z][a-z0-9_]{0,63}$`, so the code names the provider in
  snake_case; the answer loop's raw `provider_key_not_configured:DEEPSEEK_API_KEY`
  throw is not a ClosedError and keeps its own shape). No completion event is
  published on the refusal path.
- Runner semantics read first (`packages/providers/src/runner.ts`,
  `chat.ts`): a `deepseek` target without a resolvable credential fails
  TERMINALLY as `unauthenticated` (`fallbackEligible: false`), so a missing
  primary key can never silently activate the OpenRouter fallback; the guard
  front-runs that doomed attempt with configuration feedback. The 401
  analog is already pinned in `tests/e2/fallback.test.ts` ("a rejected
  DeepSeek credential (401) is terminal: OpenRouter is never silently
  activated").
- Supporting refactor inside the same file: `executePayload` split into
  `decodePayload` (pure validation, unchanged behavior) and
  `executeDecodedPayload` (execution), and `summarize`'s declared return
  type tightened to the executed variant it always returned. This keeps the
  pinned tests/e2 dispatch tests green without editing them (the guard runs
  after payload validation, so the pinned `provider_payload_invalid` and
  `provider_payload_route_mismatch` outcomes are unchanged).

The focused test (`tests/e7/provider-key-guard.test.ts`, fake ActionCtx,
fixture key strings only) pins: the chat_analysis and vision_extraction
refusals with no provider call and no event; OpenRouter-only routes
(embedding, speech_to_text) passing the guard into payload validation; the
OpenRouter guard's pinned code `provider_key_not_configured` unchanged; the
empty-string key refusing like an absent one; the runner-boundary terminal
`unauthenticated` classification for a direct target with no credential; and
the composed-label agreement (criterion 4).

Commands and results:

```bash
rtk npx vitest run tests/e7/provider-key-guard.test.ts
# Tests  9 passed (9)
```

## 3. Provider table in `docs/mvp/architecture-design.md`

File: `docs/mvp/architecture-design.md` ("Provider configuration").

- Lead-in sentence added naming the frozen e8.0 split order and linking
  `docs/adr/provider-routing-2026-09.md`.
- Chat / memory analysis row: `deepseek-flash` direct on DeepSeek, then
  OpenRouter `z-ai/glm-5.3-flash`, then `google/gemini-3.8-flash` (e8.0
  order); constraint adds provider-qualified recording and the
  never-silently-activate-fallback rule.
- Images row: direct DeepSeek (native vision) then the same two OpenRouter
  models; the removed `deepseek/deepseek-v4-flash-0731` slug no longer
  appears anywhere in the table.
- Speech-to-text and Semantic retrieval rows: orders unchanged, annotated
  OpenRouter-only in the e8.0 split.
- AI SDK row: TanStack core with `@tanstack/ai-openrouter` for the
  OpenRouter positions plus the repository-owned direct DeepSeek transport
  (Responses wire, thinking disabled), per the ADR's adapter selection.
- The paragraph under the table drops the stale "GLM provider-selection
  target" wording (GLM is now the first fallback; the throughput target
  stays, unattributed to a single supplier).

## 4. The `e2.routing/e8.0#...` label persists without truncation

Files read (no widening needed, none performed): `convex/processing/text/analyze.ts`,
`convex/platform/schema.ts`, `packages/contracts/src/modules/operations.ts`,
`convex/operations/processing/storeAdapter.ts`,
`convex/operations/processing/operations.ts`,
`apps/web/src/features/conversation/state.ts`.

Observed format: `e2.routing/e8.0#chat_analysis`, 29 characters, composed as
`` `e2.routing/${ROUTING_CONFIG_VERSION}#chat_analysis` `` with
`ROUTING_CONFIG_VERSION = "e8.0"` (`packages/providers/src/routing.ts`).
Both consumers compose identically: `MODEL_CONFIGURATION_VERSION`
(analyze.ts line 104) and `ANSWER_MODEL_CONFIGURATION_VERSION`
(loop.ts), pinned in `tests/e3/surface.test.ts`,
`tests/e6/surface.test.ts` and now `tests/e7/provider-key-guard.test.ts`.

Every persistence/view boundary on the path is an UNBOUNDED string; nothing
truncates:

- Write: `ctx.db.patch(runId, { modelConfigurationVersion: ... })` into
  `processingRuns.modelConfigurationVersion: v.string()`
  (`convex/platform/schema.ts` line 100; Convex `v.string()` has no length
  cap below the document size limit).
- Contract view: `operations.inspectProcessingRun` result declares
  `modelConfigurationVersion: Schema.String`
  (`packages/contracts/src/modules/operations.ts` line 57; no maxLength).
- Store adapter / operation copies pass the field through unchanged
  (`storeAdapter.ts` `runViewOf`, `operations.ts` run summary).
- The web conversation wire deliberately omits the versions block
  (rendering subset), so no client-side cap applies either.

## 5. Per-provider attempt recording in `convex/processing/text/analyze.ts`

Coordinator amendment (same lane, before the PR): `recordModelCall`
hardcoded `provider: "openrouter"` on every `processingAttempts` row, which
after the E8 split is factually wrong for DeepSeek-direct attempts and
undermines per-provider cost accounting (I11's owner alerts). Fixed in
`convex/processing/text/analyze.ts`:

- the row's `provider` now comes from the call record's per-attempt provider
  column (`ProviderCallAttempt.provider`, the E8-added optional literal
  `deepseek`/`openrouter` the runner records);
- a legacy pre-split record without the column defaults to `"openrouter"`,
  preserving old rows' semantics (mirroring the existing observed-then-
  requested `model` fallback pattern);
- the handler body moved verbatim into the exported plain function
  `recordModelCallHandler` (the registered `recordModelCall` internalMutation
  delegates to it unchanged), so the focused offline verification can drive
  it with a fake MutationCtx, the same export-for-verification pattern
  dispatch.ts uses for `eventOutcome`/`summarize`.

Pinned in `tests/e7/provider-key-guard.test.ts` (two new tests): a
DeepSeek-direct walk (direct attempt failing eligible, OpenRouter fallback
succeeding) records `["deepseek", "openrouter"]` per row with their models
and exactly one completion event; a legacy record without the provider
column records `"openrouter"`.

## 6. `convex/agent/loop.ts` decomposition

Files: `convex/agent/loop.ts`, `convex/agent/toolExecution.ts` (new).

- New module: `convex/agent/toolExecution.ts` (522 lines) holds the
  tool-execution half behind its existing typed contracts:
  `ExecutionOutcome`, `tryMutation`, `envelopeValue`, `runEvidenceSearch`,
  `technicalExecutionRefusal`, `runExecution`, `runCheckedExecution`,
  `SubmitGate`, `gateSubmitFreshness`, `DispatchedAnswerCall` and
  `dispatchAnswerToolCall`.
- `loop.ts` keeps the round-state machinery (`AnswerRoundState`,
  `AnswerRoundOutcome`, `AnswerMessageWire`, `startAnswerRun`,
  `runAnswerRound`, `runAnswerLoop`, `answerResult`, `turnLogEntry`), the
  version constants and every Convex entry point (`loadAnswerStage`,
  `answerLoopAction`, `askPermission`, `askAgent`), and re-exports the
  moved public seam (`dispatchAnswerToolCall`, `DispatchedAnswerCall`,
  `ExecutionOutcome`) so tests/e6 and siblings import from loop.ts
  unchanged.
- Purity: the moved code was diffed against the pre-move file; identical
  apart from the new module header/import block and blank separator lines
  at the two extraction seams. Zero logic edits. No circular import arose:
  toolExecution.ts imports only `@kiero/agent/tools`, the generated api and
  `./execute`; `loop.ts` imports `./toolExecution`, never the reverse.
- Line counts: loop.ts 1046 -> 571 (under the 1000-line threshold that PR
  #188 crossed); toolExecution.ts 522.
- Behavior proof: `tests/e6` (routing, resolve-evidence, surface) run
  UNCHANGED (no import-path edits were needed thanks to the re-export) and
  pass.

## Verification (all in the worktree)

```bash
rtk npm ci
rtk npm run typecheck            # 0 errors (root + all workspaces)
rtk npx vitest run tests/e7/provider-key-guard.test.ts   # Tests  9 passed (9)
rtk npx vitest run tests/e7 tests/e3                     # Tests  89 passed (89)
rtk npx vitest run tests/e7 tests/e6 tests/e2 tests/e3
# Test Files  19 passed | 1 skipped (20)
# Tests  269 passed | 6 skipped (275)
rtk npm run verify:environments  # shape check passed
rtk npm test
# Tests  2534 passed | 6 skipped (2540)   [exit code 0]
```

The skipped files/tests are the pre-existing live-gated smokes (they need
real provider credentials); nothing in this issue changed their gating.

## Observed adjacent seams NOT changed here (proposed follow-ups)

- `convex/processing/multimodal/vision.ts` (E4, outside this issue's
  ownership) also guards only `OPENROUTER_API_KEY` before
  `runVisionExtraction`; its vision route now starts at direct DeepSeek,
  where the providers package resolves the direct key from the environment
  and fails terminally per call. A fail-fast guard mirroring dispatch.ts
  would surface the missing-credential case earlier there too. Left alone
  per the coordinator's instruction (the dispatch guard already refuses
  at the boundary).
- `convex/processing/audio/executor.ts` (D6, outside this issue's
  ownership) also writes a literal `provider: "openrouter"` on its
  `processingAttempts` rows. That value is factually correct today (STT
  stayed OpenRouter-only in the e8.0 split); recorded here only so its
  owner can decide whether to derive it from the record for symmetry with
  the analyze.ts fix.
