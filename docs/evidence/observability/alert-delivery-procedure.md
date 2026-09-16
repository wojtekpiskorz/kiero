# Owner alert procedure (I11 #138)

The reproducible operator procedure for each alert class: trigger,
expected event (Convex side), expected alert (sink side), destination,
timing, delivery evidence and recovery state. Everything Convex-side is
verified live by the drivers in `e2e/observability/`; everything in the
ALERT column is owner-side until the monitors exist (see `results.json`
`ownerRows`).

Destination identifier (owner decision 2026-09-15,
`docs/evidence/staging/candidate.json` `ownerDecisions.ownerAlertRecipient`):
the owner mailbox `wojtek@honestly.design`, attached as the email
notification channel of all three Axiom monitors (Axiom Personal permits
exactly three — `infra/observability/monitors.json`).

## 1. Processing/save incidents

| Step | Procedure | Expected | Observed 2026-09-16 |
| --- | --- | --- | --- |
| Trigger | Any durable job that exhausts `maxAttempts` (live: photo normalization against the unavailable images executor), a failed outbox delivery, a processing run stuck > 30 min, or a source save failure | `ops.job.attempts_exhausted` / `ops.outbox.delivery_failed` / `ops.processing.stuck` / `ops.save.failed`, one event per incident (dedup by jobKey/eventId/runId) | PASS: 11 failed jobs → 11 events, 0 jobs missing an event; 0 failed outbox rows; 0 stuck runs (23 runs) |
| Tick | Automatic (every minute, `telemetry-tick`) — no operator action | the scan emits on the first tick after the row lands | the live events carry minute-aligned timestamps matching the tick |
| Convex read-back | `node e2e/observability/ops-surface.mjs` (row O3k) | counts match, no duplicates | PASS |
| ALERT | monitor `kiero-processing-save-incidents` (count > 0, window 15 m, interval 5 m) | email at the destination within ~5 min of the event | **BLOCKED**: monitor not created (owner row 2); additionally the sink leg fails today (defect F1), so even a created monitor would see nothing |
| Recovery | the operator resolves the job; the dedup key guarantees no re-page for the same incident; a NEW failing job pages again | no further alerts for the same jobKey | dedup verified live (single event per jobKey) |

## 2. Backend silence / missing heartbeat (two independent layers)

| Step | Procedure | Expected | Observed 2026-09-16 |
| --- | --- | --- | --- |
| In-app layer | a service with heartbeat history stops: its newest heartbeat ages past 3× its cadence (gateway 5 min, backup/media/export 15 min) | `ops.health.silence_detected`, one event per silence episode (anchor = newest heartbeat atMs) | NOT RUN on staging: no natural gap (backup.job heartbeats every 15 min without fail); logic proven in `tests/i2` + dev round-1 |
| never_seen lanes | a lane that never reported stays silent by design | no event (permanent noise avoided); the sink-side monitor owns this case | 3 of 4 services are honestly `never_seen` |
| External layer | the gateway Worker cron prober posts `gateway.worker` heartbeats every 5 min; when they stop arriving at the sink, the backend is silent even if Convex itself is down | monitor `kiero-backend-silence` (heartbeat stream older than 15 m) pages | **INERT on staging**: `apps/gateway/wrangler.jsonc` has no `triggers.crons` block (owner row 6) — the independent-of-the-application detector does not exist yet |
| Recovery | the service resumes; the next heartbeat starts a fresh episode (new anchor) | the next silence gets a NEW dedup key and can page again | model-verified (`heartbeat.ts`); no live episode to show |

## 3. Stale complete backup

| Step | Procedure | Expected | Observed 2026-09-16 |
| --- | --- | --- | --- |
| Trigger | the newest VERIFIED snapshot ages past one hour, or attempts exist but none ever verified | `ops.backup.stale` with `state=stale\|never_verified`, deduped per newest-verified anchor | PASS, naturally: 138/138 manifests failed `export_not_configured` (deferred `STAGING_CONVEX_BACKUP_ADMIN_KEY`) → 1 `never_verified` episode event (`backup_stale:0`); no backup was fabricated |
| Tick | automatic (every 15 min, `backup-schedule-tick`) | freshness from SNAPSHOT time, never completion time | verified by the driver recomputing freshness from the manifest rows |
| ALERT | monitor `kiero-backend-silence` (the same stream) | email on the stale/silence stream | **BLOCKED** (owner rows 2-3 + defect F1) |
| Recovery | a snapshot verifies again → freshness `fresh` → no further stale events; a later regression opens a NEW episode (new anchor) | state transition observable in `/platform/telemetry/health` | the transition itself is NOT RUN (no verification possible until the backup admin key lands — I10's decision) |

## 4. Cost thresholds (400/500 PLN)

| Step | Procedure | Expected | Observed 2026-09-16 |
| --- | --- | --- | --- |
| Trigger | current-month `costEntries` total crosses 40 000 minor (warning) then 50 000 minor (alert) | `ops.cost.threshold_warning` / `ops.cost.threshold_alert` + a `costAlertStates` row; per-level 24 h cooldown; the 500 alert is never silenced by the recent 400 warning; NO product shutdown | logic PASS on the dev deployment (`docs/evidence/telemetry/README.md`); on staging: 0 entries, thresholds false (honest) |
| Fixture | `operations/telemetry/proof:probeSeedCost` (labeled synthetic rows) | crossing fires exactly once, re-tick suppressed | **BLOCKED on staging**: the guard `KIERO_PROBE_ENABLED` must stay unset on the qualification path (owner row 5); no staging env var was touched |
| ALERT | monitor `kiero-cost-thresholds` (count > 0, window 1 h, interval 15 m) | email at the crossing | **BLOCKED** (owner rows 2-3) |
| Recovery | spend stays above the level: at most one alert per level per 24 h (cooldown); dropping below resets nothing retroactively | fireCount bookkeeping in `costAlertStates` | model-verified (`costs.ts`); no live crossing to show |

## Sink transport (shared by all four)

- Forwarding: the every-minute tick forwards up to 50 unforwarded events
  from the last hour to `POST https://api.axiom.co/v1/datasets/{dataset}/ingest`;
  success marks `forwardedAtMs`, failure leaves 0 for retry inside the
  window (rows stay stored 30 days regardless).
- Live transport failure: **all** stored events on staging carry
  `forwardedAtMs: 0` while the tick demonstrably runs and the `AXIOM_*`
  names are present — the leg fails and nobody can see why (defect F1).
- Delivery evidence + recovery state: owner-side once ingest works
  (owner row 1); record the first ingested event id + timestamp and the
  first delivered monitor email here.
