# Telemetry evidence (I2)

Issue [I2 #54]. Proof ownership row P12 (redacted diagnostics, health
checks, cost alerts). All results below were produced against the REAL
Convex dev deployment `brazen-cardinal-240` (project `kiero-dev-core`, team
`wojtek-piskorz-jr`, reference `dev/i2`, region eu-west-1 - the I2 resource
lease) on 2026-09-09. No staging/alpha/production resource was touched. No
secret value was printed, logged or committed: `KIERO_SERVICE_TOKEN` is a
deployment variable plus a gitignored `.env.local` entry (name only here);
it was generated fresh for this session and is flagged for rotation at
integration. No `AXIOM_API_TOKEN` exists anywhere (checked by name) - the
Axiom account is a PENDING owner action (see
[infra/observability/README.md](../../infra/observability/README.md)).

## Versions and revision

| Item | Value |
| --- | --- |
| Worktree branch | `codex/kiero-i2` (base `762b1c8`) |
| node / npm | v22.22.3 / 10.9.8 |
| convex package + CLI | 1.45.0 (`npx --yes convex@1.45.0`) |
| Deployment | `brazen-cardinal-240.eu-west-1.convex.cloud` / `.convex.site` |
| Deployment vars (names only) | `KIERO_PROBE_ENABLED`, `KIERO_SERVICE_TOKEN`, `KIERO_DEPLOYMENT_LABEL=dev/i2`, `KIERO_ENVIRONMENT=dev` |
| Crons registered | `outbox-drain-safety-net` (`*/5 * * * *` -> `platform/outbox:drainOutbox`), `telemetry-tick` (every minute -> `operations/telemetry/cron:cronTick`) - confirmed in the verbose push output |

## How to reproduce

```
npm ci
npx --yes convex@1.45.0 dev --once        # deploy to dev/i2 (CONVEX_DEPLOYMENT in .env.local)
node docs/evidence/telemetry/scripts/proof-telemetry.mjs
npm test                                   # 137 tests incl. tests/i2
```

## Proof matrix (all rows PASS; Axiom live delivery BLOCKED, see PENDING)

| Row | Result | Evidence line (sanitized transcript below) |
| --- | --- | --- |
| Adversarial payload emitted through the REAL function boundary is stored redacted | PASS | `emitted: true, redactionsApplied: 4` (raw message key dropped; provider error, Polish source text and token-shaped values all `<redacted>`) |
| Unknown event kind rejected at the boundary | PASS | `emitted: false, reason: "kind_unknown"` |
| Incident scan diagnoses a REAL failed outbox row (unprojected consumer edge via A3's own machinery) | PASS | `incidents: 2` (two standing failed rows), each diagnosed EXACTLY once across repeated ticks (dedup by eventId/jobKey) |
| External heartbeat lands in the ledger through the HTTP boundary | PASS | `heartbeat POST: 200 {"recorded":true,"atMs":...}` |
| Composed health endpoint returns platform + telemetry state | PASS | HTTP 200; `gateway.worker:ok`, honesty block, outbox counts, deployment `dev/i2` |
| 400 PLN threshold crossing fires warning once; immediate re-tick suppressed by cooldown | PASS | warning `fireCount: 1` at `totalMinor: 40100`; single `ops.cost.threshold_warning` event across repeated ticks |
| 500 PLN threshold crossing fires the stronger alert (never silenced by the recent warning) | PASS | alert `fireCount: 1` at `totalMinor: 50100` |
| Sub-threshold total produces no alert | PASS | `totalMinor: 39999` -> no threshold event |
| Sink forwarding reports the honest not-configured reason | PASS | `forwarded: { ok: false, reason: "axiom_not_configured" }` on every tick (no Axiom account: BLOCKED live delivery, emitter unit-tested against a local sink) |
| Sensitive-content scan over everything read back | PASS | `leaks: NONE` (no `wycena`, `Baniewice`, `UklGR`, `sk-proj`, `429 Too Many`, `rate limit` anywhere in the composed state) |
| Retention/cost cleanup after the proof | PASS | `removed: 3` (labeled synthetic entries + affected alert states) |
| Sanitizer/threshold/cooldown/retention logic under adversarial input | PASS | `tests/i2/*` (50 tests): redaction, costs, heartbeat silence, retention, sink, gateway emit, schema/descriptor drift |

## Sanitized transcript (canonical clean run, 2026-09-09)

```
== T1: adversarial emit through the real boundary ==
adversarial emit: { "_tag": "ok", "value": { "diagnosticEventId": "ks7echst...",
  "emitted": true, "redactionsApplied": 4 } }
honest emit: { "_tag": "ok", "value": { "diagnosticEventId": "ks75tt38...",
  "emitted": true } }
unknown-kind emit: { "_tag": "ok", "value": { "emitted": false, "reason": "kind_unknown" } }

== T2: incident scan over a real failed outbox row ==
published unprojected-edge event: { "_tag": "ok", "value": { "deduplicated": false,
  "eventId": "15480385-0b4c-4f3a-810f-96849dede549" } }
tick 1 (scan): { costs: { period: "2026-09", totalMinor: 0 },
  forwarded: { attempted: 18, ingested: 0, ok: false, reason: "axiom_not_configured" },
  incidents: 2, pruned: { prunedAlertStates: 0, prunedCostEntries: 0, prunedDiagnostics: 0 } }
tick 2 (dedup): incidents: 2  (same standing rows, ZERO new diagnostic events)

== T3: heartbeat + composed health ==
heartbeat POST: 200 {"_tag":"ok","value":{"atMs":1788940432205,"recorded":true}}

== T4: cost thresholds ==
below 400 PLN (39999 minor): totalMinor: 39999 -> no threshold event
crossing 400 PLN (40100 minor): ops.cost.threshold_warning fired, fireCount: 1
immediate re-tick: suppressed (cooldown_active; fireCount stays 1)
crossing 500 PLN (50100 minor): ops.cost.threshold_alert fired, fireCount: 1

== composed health read-back ==
HTTP status: 200
deployment: dev/i2
platform health: { status: "ok", runtimeVersion: "a3.0",
  observability: { nativeConvexLogHistory: "unavailable_on_free_plan",
    applicationEvents: "explicit_redacted_events_only", diagnosticWindowDays: 30,
    blindSpots: [convex_platform_logs..., cloudflare_worker_console_logs...,
                 provider_console_metrics...] },
  outbox: { delivered: 0, failed: 1, inFlight: 0, pending: 0, superseded: 0 } }
telemetry state: { healthServices: ["gateway.worker:ok", "backup.job:never_seen",
    "media.worker:never_seen", "export.worker:never_seen"],
  costs: { period: "2026-09", totalMinor: 50100,
    thresholds: { alert: true, warning: true },
    alertStates: [ { level: "alert_500", fireCount: 1, thresholdMinor: 50000, ... },
                   { level: "warning_400", fireCount: 1, thresholdMinor: 40000, ... } ] } }
sensitive-content scan leaks: NONE (PASS)

cleanup: { "_tag": "ok", "value": { "removed": 3 } }
```

## NOT-RUN / honest limits

- Live Axiom ingest delivery: BLOCKED (no account; owner action PENDING).
  The emitter (`axiomHttpSink`) is implemented behind `TelemetrySink` and
  unit-tested against a local sink with injected fetch; deployment carries
  no `AXIOM_API_TOKEN`.
- Alert destination delivery (email/webhook for the three monitors):
  BLOCKED on the same owner action; monitors.json holds the exact
  definitions to create.
- The gateway cron trigger is not yet wired to a wrangler config (none
  exists yet - I1/I7 own it); the `scheduled` handler and heartbeat client
  are implemented and unit-tested. The proof's heartbeat was sent by the
  evidence script acting as the external prober.
- `never_seen` heartbeat states for backup/media/export workers are honest:
  those lanes (I5/D5/I3) have not shipped their heartbeat calls yet; the
  exported boundary (`POST /platform/telemetry/heartbeat` and
  `sendGatewayHeartbeat`) is what they call.
