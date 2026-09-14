# E8 integration record: advisory review findings (PR #188, 2026-09-14)

The advisory review on PR #188 withheld approval until three findings
landed. All three were applied in the same worktree as uncommitted changes
on top of the branch; deterministic checks were green before and after.

## Finding 1: extract the attempt skeleton in chat.ts

`deepSeekChatAttempt` and `openRouterChatAttempt` duplicated the declared
tools mapping, the AbortController + `setTimeout` deadline, the
`harvestStream` call, the stream-failure classification and the thrown
error classification (abort shapes to `deadline_exceeded`, everything else
to `internal_error`). Extracted `boundedChatAttempt(open)` so the shared
discipline lives once and both attempts reduce to pure request mapping:

```ts
async function boundedChatAttempt(
  open: (abort: AbortController) => AsyncIterable<AdapterYieldChunk>,
): Promise<ChatAttemptResult>
```

`open` receives the deadline's controller because the two transports want
different handles: the pinned TanStack OpenRouter adapter takes the
controller itself (`abortController`), the direct DeepSeek transport takes
its signal. Behavior note: the OpenRouter adapter construction moved inside
`open`, so a construction throw is now classified `internal_error` by the
skeleton instead of propagating unclassified (strictly safer; no caller
depended on the old shape).

## Finding 2: delete the legacy slug shim

The temporary compatibility shim from the first E8 round is gone:

- `packages/providers/src/routing.ts`: `RouteSlug`, `RoutePosition` and
  `normalizeRoutePosition` deleted; `ModelRoute.order` tightened to
  `readonly [RouteTarget, ...RouteTarget[]]`, so a bare model slug is a
  COMPILE-TIME error instead of a silently normalized OpenRouter target.
- `packages/providers/src/runner.ts`: the normalize call and its import
  removed; the loop iterates provider-qualified targets directly.
- `tests/e2/routing.test.ts`: the slug-normalization test replaced by a
  typecheck guard (`@ts-expect-error` on a deliberately slug-typed route),
  which pins the closed type: if the type ever reopens, typecheck fails.
- `tests/d6/pipeline.test.ts` (coordinator-touched territory, explicitly
  authorized in the same coordinated lane): the two `probeRoute` literals
  qualified as `{ provider: "openrouter", model: ... }` targets. The
  coordinator had already applied the `scriptedAttempt` fixture fix
  (`target.model`) on the branch; with both changes the D6 seam tests pass
  against the closed route type.

## Finding 3: deepseek.ts cleanups

- The emit-callback plus pending-buffer indirection became one generator:
  `mapEvent` yields AG-UI chunks directly and the read loop composes it
  with `yield*`; `processLine` owns the SSE line filter and JSON parsing.
  A malformed frame sets a flag the outer loop checks (a nested generator
  cannot abort the outer one), preserving the stop-after-malformed
  behavior.
- The dead `""` branch in the `openCalls.delete` ternary is gone: the
  item id is narrowed to a string before the map lookup.
- One shared `runFinished(model, finishReason, usage)` literal replaces
  the three hand-built RUN_FINISHED chunks (completed, incomplete length,
  incomplete content_filter).
- The unparsed-tail case is closed: after the read loop ends, the final
  unterminated buffered line is processed once, so a terminal event whose
  frame the stream closed without its trailing newline is honored instead
  of degrading to `stream_terminated`. Covered by a new offline test
  (terminal frame delivered without a trailing newline).

## Verification (after the findings)

Run in this worktree; tails reported in the final lane report:

```bash
rtk npm run typecheck
rtk npx vitest run tests/e2 tests/d6 tests/e3
rtk npm test
```

No credential value was printed, logged or written at any point.
