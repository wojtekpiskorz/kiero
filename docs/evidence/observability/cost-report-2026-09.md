# Monthly cost report. 2026-09 (I11 #138)

The all-in budget policy is observational: warning at 400 PLN, stronger
alert at 500 PLN (thresholds in `infra/observability/cost-limits.json`,
evaluated Convex-side by `evaluateCostAlerts` with a 24 h per-level
cooldown). Crossing 500 PLN never shuts the product down. Provider caps
stay in their native units; they are never silently converted to PLN.

## Convex-side accrued (server truth, snapshot export)

Source: `npx convex export --deployment wojtek-piskorz-jr:kiero-dev-core:staging`
parsed by `e2e/observability/ops-surface.mjs` (row O3h), 2026-09-16.

| Item | Observed |
| --- | --- |
| `costEntries` rows in 2026-09 | 0 |
| `costAlertStates` rows | 0 (no threshold ever fired) |
| `ops.cost.entry` diagnostic events | 0 |
| `ops.cost.threshold_warning` / `ops.cost.threshold_alert` events | 0 / 0 |
| Composed `/platform/telemetry/health` costs | period 2026-09, totalMinor 0, thresholds false |
| `integrations.providerCallCompleted` outbox envelopes (real AI legs) | 120+ (live sessions of the B5/D7/I11 lanes; chat/vision/STT/embeddings) |
| Backup lane cost rows | none. the only production writer (`backupsCompleteHandler`) records zero-amount rows on VERIFIED snapshots, and no staging snapshot ever verified (see below) |

## Honest gaps in the cost pipeline (recorded, not repaired here)

1. **No AI/media/provider spend producer exists.** 120+ real model calls
   completed on staging with zero accounting rows. The
   `integrations.providerCallCompleted` envelope carries only
   `routeId`/`actualModel`/`outcome`. no token counts, no price, no
   currency. and `ops.provider.call` has no production writer. Until a
   producer lands, the 400/500 PLN thresholds cannot fire from real spend
   and the all-in number understates actual cost by everything except
   zero-value backup rows.
2. **The backup producer cannot run on staging yet.** Every 15-minute slot
   fails `export_not_configured` (the deferred
   `STAGING_CONVEX_BACKUP_ADMIN_KEY`, I10's decision), so even the
   zero-amount `backup` rows never land. 140 manifests, 140 failed, 0
   verified at the evidence run.
3. **Threshold crossing with controlled fixtures is guarded on staging.**
   `operations/telemetry/proof:probeSeedCost` requires
   `KIERO_PROBE_ENABLED`, which must stay unset on the qualification user
   path (`infra/bindings/convex-functions.md`). The logic itself is proven
   on the dev deployment: `docs/evidence/telemetry/README.md` (warning at
   40100 minor, stronger alert at 50100 minor, cooldown suppression,
   sub-threshold silence). Reproducing it on staging needs an
   owner-approved isolated window with the guard set. this session
   changed no staging env var.

## Metered provider numbers (owner-side)

This session has no dashboard access. Dated observations from the issue
record (2026-09-14 amendment): Convex spend USD 4.50 with warning/disable
limits USD 10/20 on the active Starter plan; Cloudflare billing reads
were inaccessible through the current OAuth. The owner must append the
actual September numbers (Convex, Cloudflare Workers/R2/Containers/Images,
OpenRouter, DeepSeek, Resend, Axiom) here. unknown prices and FX stay
visible, per `infra/observability/cost-limits.json`.

| Provider | Metered amount 2026-09 | Status |
| --- | --- | --- |
| convex |. | BLOCKED: owner dashboard read |
| workers |. | BLOCKED: owner dashboard read |
| r2 |. | BLOCKED: owner dashboard read |
| containers |. | BLOCKED: owner dashboard read |
| images |. | BLOCKED: owner dashboard read |
| ai_openrouter |. | BLOCKED: owner dashboard read |
| ai_deepseek (direct) |. | BLOCKED: owner dashboard read |
| email_resend |. | BLOCKED: owner dashboard read |
| observability_axiom |. | BLOCKED: owner dashboard read |
