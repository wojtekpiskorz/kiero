# Observability qualification evidence (I11 #138)

Issue [I11 #138]. prove actual owner alerts, diagnostic retention and
cost accounting against the LIVE staging stack. Proof ownership row P12;
full-core closure stays with [J5 #64].

- Candidate: see `results.json` (`candidate`, the worktree branch
  `codex/kiero-i11-alerts`; drivers and evidence only. no product code
  changed).
- Environment: web `https://kiero-staging-web.wojtek-524.workers.dev`,
  gateway `https://kiero-staging-gateway.wojtek-524.workers.dev`, Convex
  `wojtek-piskorz-jr:kiero-dev-core:staging` (fiery-raven-417), Axiom
  dataset `kiero-staging` (EU; names `AXIOM_API_TOKEN`/`AXIOM_DATASET`
  present. values never read).
- Constraints honored: `KIERO_GM_EMAILS` untouched (no GM-panel flow), no
  staging env var changed (the guarded proof/fixture flags stayed unset -
  `infra/bindings/convex-functions.md`), no wrangler deploy, nothing sent
  to the owner alert recipient by this session (the product's own
  configured channels were not exercised beyond their natural state; no
  monitor exists yet, so nothing could deliver), no credential value
  written anywhere.

## Drivers (how to reproduce)

```bash
# Ops diagnostic surface (no browser, no GM):
node e2e/observability/ops-surface.mjs --out /tmp/kiero-i11/ops-run

# Funnel + task-reminder chain (one real headless Chromium + one fresh
# mail.tm mailbox; ~20 min; polls the evaluator):
node e2e/observability/funnel-reminders.mjs --out /tmp/kiero-i11/funnel-run

# Assemble results.json + sanitized run copies:
node e2e/observability/collect-evidence.mjs \
  --ops /tmp/kiero-i11/ops-run/ops-surface-result.json \
  --funnel /tmp/kiero-i11/funnel-run/funnel-result.json
```

Server truth comes from `npx convex export` snapshots parsed locally
(`e2e/observability/lib/snapshot.mjs`); nothing trusts the application's
self-report for the alert-side rows.

## What the live deployment actually does today (observed 2026-09-16)

- The every-minute telemetry tick demonstrably runs: the incident scan
  emitted one deduplicated `ops.job.attempts_exhausted` event per failed
  durable job (11/11 at the run), and the 15-minute backup tick emitted
  the `ops.backup.stale` episode event.
- `ops.backup.stale` fires NATURALLY: 140/140 backup manifests fail
  `export_not_configured` (the owner-deferred
  `STAGING_CONVEX_BACKUP_ADMIN_KEY`), no snapshot ever verified, so the
  freshness check reports `never_verified`. deduplicated to a single
  episode event (`backup_stale:0`). Nothing was fabricated.
- The heartbeat ledger holds `backup.job` alone (ok/degraded pair per
  15-minute slot. the run handler records `ok`, the fail handler
  `degraded`); `gateway.worker`, `media.worker`, `export.worker` are
  honestly `never_seen` (their probers are not wired: the gateway Worker
  has no cron trigger on staging).
- The composed public state `GET /platform/telemetry/health` answers with
  the full honesty block (retention, blind spots, authority) and cost
  thresholds honestly false.
- Zero events have ever been forwarded to Axiom Convex-side: all stored
  `diagnosticEvents` rows carry `forwardedAtMs: 0` while the tick runs
  and the `AXIOM_*` names are present. the ingest leg fails invisibly
  (see defect F1).

## The task-reminder chain, end to end through designed surfaces (PASS)

One namespaced ordinary session (`Firma I11 Obs <runId>`, fresh mail.tm
mailbox, company timezone `America/Los_Angeles` so the run sat outside the
default quiet hours and past 07:00 local) proved the whole F4/F3 chain
with zero page errors (`runs/funnel-reminders.json`):

1. Delivered-OTP sign-in, company creation (explicit company timezone -
   "Strefa czasu firmy"), one source message asking the agent to record
   `termin oddania wyceny 2026-09-16 (cały dzień, bez godziny)` plus a
   unique run marker and a deliberately fake `sk-proj-…` token.
2. The agent published the project (`#1: I11 Obs <runId>`) AND the
   temporal ustalenie. server truth:
   `semanticKey wycena_plytki_taras_termin`,
   `value {temporal, role:"agreed", shape day 2026-09-16}` (bindable as a
   deadline; the /projekty identification UI is honestly "W przygotowaniu",
   so the agent's publication is the only live project source. defect F5).
3. `/praca`: task `Wycena I11 <runId>` bound to that date ustalenie, plus
   `Zadanie bez terminu I11 <runId>` with none.
4. The reminder evaluator's honest states, all in server truth:
   - dated task → `reminderSchedules.status = scheduled` with a
     `pre_due` and an `overdue` slot; the `pre_due` intent (ideal 07:00
     company-local, already passed) CLAMPED and was DELIVERED ~1 s after
     task creation (`deliveryJson` bucket `task_reminders`,
     `reminderKinds ["pre_due"]`); the `overdue` intent stays pending for
     the next 07:00 company-local slot (dedup keys
     `task_reminder:pre_due:<task>:<user>:e0` and
     `task_reminder:overdue:<task>:<user>:e0:2026-09-17`).
   - undated task → `status = no_deadline`, zero intents ("Undated tasks
     remain only in Co teraz").
   - unassigned coordinator → the intent addresses every active boss
     (this session's single member), per "Przypomnienie o zadaniu".
   - `/co-teraz` renders the same states in copy: "przypomnienie
     zaplanowane na 17.09.2026, 14:00:00" / "brak zaplanowanych
     przypomnień"; the personal snooze ("Odroczenie przypomnień")
     deferred this boss's pending reminders (`reminderSnoozes` row), not
     the task's deadline.
   - `/powiadomienia`: the server reports push configured (VAPID present
     server-side); "Włącz na tym urządzeniu" in headless Chromium lands on
     the honest permission-denied recovery copy; zero `pushSubscriptions`,
     zero `pushDeliveries`. physical-device delivery stays J4's.
5. The run marker, the fake `sk-proj-…` token and the mailbox address
   never appeared in any of the 292 live diagnostic events (the same
   content the sink payload carries).

## Results matrix

See `results.json` for the machine-readable form (every row: status,
expected, observed). Summary by acceptance criterion:

| Criterion | Rows | Status |
| --- | --- | --- |
| Real emitted event reaches the Axiom dataset; fallback explicit | O3e, owner rows 1-2 | **BLOCKED** (owner-side verification; Convex-side marker proves the ingest leg never succeeded. nothing was ingested to verify) |
| Actual owner alerts for source-save failures, failed/stuck processing, stale backup, missing health; independent missing-heartbeat detector | O3h-O3l (Convex side PASS), owner rows 2-3, 6 | Convex side PASS; **alert delivery BLOCKED** (no monitors/destination exist); external prober **inert** (gateway cron not wired) |
| 400/500 PLN thresholds with fixtures + actual metered costs; no shutdown at 500 | O3m, owner rows 4-5, [cost report](cost-report-2026-09.md) | Live accounting = 0 rows (producer gaps recorded); fixture crossing on staging **BLOCKED** (guarded); metered numbers **BLOCKED** (owner dashboards) |
| Logs/sink payloads free of source bodies, media, credentials; retention/query access | O3a-O3d, O1 leak scan, R11 marker scan | **PASS** (live redaction + leak scans; retention within window; query access = export + public health) |
| De-duplication/routing, transport failure, recovery, useful operator diagnosis | O3j/O3k (dedup PASS), defects F1/F2 | Dedup PASS; transport failure observed but **invisible in product** (F1); diagnosis weakened by redaction of actionable error kinds (F2); recovery owner-side |
| Task-reminder intents, evaluator honest states, quiet-hours/snooze seams, web-push honest states | R1-R12 | **PASS** end to end through designed surfaces (delivered clamped prompt, pending overdue slot, no_deadline, snooze, permission-denied push copy); physical push delivery **NOT RUN** (J4) |
| Reproducible operator procedure with expected alert/recipient/timing | this README + `runs/` + owner rows | **PASS** (procedures); delivery evidence **BLOCKED** owner-side |

## Product defects found (recorded, not repaired. coordinator files)

- **F1. Convex→Axiom transport failure is invisible.** `cronTick`'s
  `forwarded` summary (ok/reason) is returned but persisted nowhere: on
  staging the ingest has failed for every event for 30+ hours
  (`forwardedAtMs` 0 on 288/288 rows while `AXIOM_API_TOKEN`/`AXIOM_DATASET`
  names exist and the tick runs every minute), and no operator surface can
  distinguish `axiom_status_401` / `axiom_status_404` / `axiom_unreachable`
  / dead cron. Minimal repro: read `diagnosticEvents.forwardedAtMs` after
  any tick window with events; then compare with the (dropped) tick
  summary. Files: `convex/operations/telemetry/cron.ts`
  (`forwardRecentToSink`), no persistence of `SinkIngestResult`.
- **F2. Actionable error kinds are redacted out of incident events.**
  Durable jobs fail with kinds like `unavailable:images_executor_unavailable`
  (a colon. legal in the job's `lastErrorKind` vocabulary, illegal under
  the `errorKind` metadata format `^[a-z][a-z0-9_]{1,63}$`), so every live
  `ops.job.attempts_exhausted` event on staging carries
  `errorKind: <redacted>` instead of the diagnosis the monitor would page
  with. Minimal repro: the 11 live events (job rows show
  `unavailable:images_executor_unavailable`; events show `<redacted>`).
  Files: producer vocabulary vs `convex/operations/telemetry/redact.ts`
  `METADATA_KEY_FORMATS.errorKind`.
- **F3. Metered AI spend has no cost producer** (see the cost report):
  120+ real provider calls, zero `costEntries`, envelope lacks token/price
  data; `ops.provider.call` unwritten in production. The 400/500 PLN
  thresholds cannot fire from real spend.
- **F4. monitors.json dataset drift (corrected in this PR).** The APL
  filters read the I2-era placeholder dataset `kiero-observability`; the
  owner provisioned `kiero-staging`. `infra/observability/monitors.json`
  and the README owner steps were corrected in this branch (owned path).
- **F5. the /projekty identification UI is pending** ("W przygotowaniu"):
  projects arise only from the agent's publication, so a boss cannot
  create the project a task needs through the UI. Observed live during the
  funnel run; recorded for the owning lane.

## Owner actions (BLOCKED rows. exact steps)

See `results.json` → `ownerRows` for the machine-readable list:

1. Verify Axiom ingest actually works (start from the dataset's ingest
   monitor; the token/dataset may be wrong. F1 explains why nobody was
   notified).
2. Create the three monitors exactly as `infra/observability/monitors.json`
   defines against `kiero-staging`, replacing `OWNER_PLACEHOLDER` with the
   owner-decided recipient (`docs/evidence/staging/candidate.json`).
3. Record one real delivered alert (message id + timestamp) into this
   directory once the chain works.
4. Append the metered September numbers to
   [cost-report-2026-09.md](cost-report-2026-09.md).
5. Decide the guarded-window approach for the 400/500 PLN fixture crossing
   on staging (`KIERO_PROBE_ENABLED` must stay unset on the qualification
   path otherwise).
6. Gateway lane: add the `*/5` cron trigger to the staging env of
   `apps/gateway/wrangler.jsonc` so the external heartbeat prober exists.

## NOT RUN (with reasons)

- Physical web-push delivery (VAPID at runtime + real devices): J4 #63.
- In-app silence episode on staging: no natural >45 min heartbeat gap
  occurred; fabricating one needs the guarded probe or stopping the backup
  container (an owner infrastructure action). Logic is covered by tests/i2
  and the dev/i2 round-1 proof.
- Malformed-provider-response log verification: forcing malformed provider
  responses needs fixtures outside this issue's automatable scope
  (provider qualification is B5/D7); the secret-bearing-error half is
  covered by the live leak scans (fake `sk-proj-…` marker in a real source
  message never reached any diagnostic event).
- GM-panel flows: out of scope by instruction (KIERO_GM_EMAILS untouched).
