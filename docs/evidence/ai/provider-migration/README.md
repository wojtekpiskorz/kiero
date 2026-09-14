# E8 provider-migration evidence

Implementation evidence for [E8 #170](https://github.com/wojtekpiskorz/kiero/issues/170):
direct DeepSeek chat/vision with retained OpenRouter STT/embeddings and the
explicitly authorized OpenRouter chat/vision fallback. Routing decision
record: [ADR](../../../adr/provider-routing-2026-09.md). Research input:
[Direct DeepSeek API facts](../../research/deepseek-direct-api-facts.md)
(its full-removal alternatives are superseded by the owner amendment).

## Files

| File | Content |
| --- | --- |
| [routing-and-models.md](./routing-and-models.md) | Routing version, frozen provider-qualified orders, model aliases with observation dates, fallback policy (owner decision citation), deadline/retry semantics |
| [live-smoke-2026-09-14.md](./live-smoke-2026-09-14.md) | Bounded live verification against the dev-context credentials: protocol probes, model availability checks, the gated live smoke (chat, cross-provider fallback, multi-turn tools, vision, embedding, STT), sanitized records |
| [adapter-selection.md](./adapter-selection.md) | Issue criterion 6: the exercised `@tanstack/ai-openai` 0.22.5 candidate (with preserved failed attempts) and the reasons the repository-owned transport was selected; zero dependency movement |

## Verification commands (all run 2026-09-14 in this worktree)

```bash
rtk npm ci
rtk npm run typecheck
rtk npx vitest run tests/e2 tests/e3 tests/e4 tests/e5 tests/e6
rtk npm run verify:corpus
# gated live smoke (keys injected via environment, never printed):
rtk npx vitest run tests/e2/live-smoke.test.ts   # with DEEPSEEK_API_KEY,
                                                 # OPENROUTER_API_KEY and
                                                 # KIERO_E2_LIVE_SMOKE=1
```

Observed outcomes are recorded in the files above. No credential value was
printed, logged or written anywhere in this evidence; dev keys were read
from the `kiero-dev-core:staging` Convex deployment environment into
process memory only, and only names, statuses, latencies, models and error
classes were recorded.
