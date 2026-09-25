# Kiero observability descriptors

These files define NAMES, schemas and monitor
definitions only - never credential values. What is implemented in code vs
what requires OWNER action is stated exactly.

## Files

| File | What it defines |
| --- | --- |
| [events.json](events.json) | The redacted diagnostic event contract (kinds, per-kind metadata allow-lists, per-key value formats). Mirrors the single definition in `convex/operations/telemetry/redact.ts`; `tests/i2/schema.test.ts` asserts the two cannot drift. |
| [monitors.json](monitors.json) | The three Axiom monitor groups: processing/save incidents, backend silence (recovery/health), costs/limits (400/500 PLN). Exact APL queries and trigger definitions. |
| [retention.json](retention.json) | The 30-day diagnostic window, heartbeat tail bounds, cost-accounting retention, enforced Convex-side and configured sink-side. |
| [cost-limits.json](cost-limits.json) | All-in budget thresholds (PLN), tracked providers and their dated native caps. |
| [dashboards.md](dashboards.md) | The honesty annotations every dashboard must display (retention, native-log unavailability on Free, blind spots, authority). |

## What is implemented (no account needed)

- Redacted diagnostic events with redaction enforced by construction (the
  sanitizer in `convex/operations/telemetry/redact.ts` is the only writer
  path; adversarial content is redacted or rejected, never stored).
- Convex-side surfaces: sanitized emit boundary, HTTP ingest + heartbeat +
  composed health endpoints, incident scan (attempts-exhausted durable jobs,
  failed outbox rows, stuck runs), cost threshold evaluation with cooldown,
  windowed retention, cron tick (`convex/crons.ts`, which also carries the
  outbox-drain safety net).
- Gateway telemetry (`apps/gateway/src/telemetry/`): request-scoped redacted
  events (GW -> OBS), heartbeat prober via the Worker cron trigger, Axiom
  emitter behind an interface with a Convex-ingest dev fallback.
- The Axiom emitter behind `TelemetrySink` with the real HTTP client
  implemented and unit-tested against a local sink (no network).

## PENDING owner actions (exact steps)

Update (2026-09-16): steps 1-2 are DONE by the owner; the Axiom
account exists, the dataset is `kiero-staging` (EU), and the names
`AXIOM_API_TOKEN` / `AXIOM_DATASET` are present on the Convex staging
deployment `wojtek-piskorz-jr:kiero-dev-core:staging` (verified by name
only). Steps 3-5 remain open and own the actual alert delivery:

1. ~~Create the Axiom Personal account and the dataset~~ (DONE 2026-09-15:
   dataset `kiero-staging`, EU).
2. ~~Set the credentials by name~~ (DONE: names present on the staging
   Convex deployment and injected into the workers by the release flow).
   LIVE CAVEAT (2026-09-16): every stored `diagnosticEvents` row on
   staging still carries `forwardedAtMs: 0` (288/288 at the evidence run)
   while the every-minute telemetry tick demonstrably runs, so the
   Convex-to-Axiom ingest leg has never succeeded within the one-hour
   forward window. The failure reason (token rejected, dataset missing,
   unreachable) is not persisted anywhere observable; the owner's first
   dashboard action should be to check ingest in Axiom and correct the
   token/dataset if needed.
3. **Create the three monitors** exactly as defined in [monitors.json](monitors.json)
   against the `kiero-staging` dataset (Axiom Personal permits exactly
   three - all are allocated). The APL dataset filters were corrected from
   the earlier `kiero-observability` placeholder to `kiero-staging` on
   2026-09-16.
4. **Configure the email alert destination(s)** for all three monitors,
   replacing `OWNER_PLACEHOLDER` in monitors.json. The owner-decided
   recipient is recorded in `docs/evidence/staging/candidate.json`
   (`ownerDecisions.ownerAlertRecipient`, 2026-09-15).
5. **Add the gateway cron trigger** (`*/5 * * * *`) to the staging env
   block of `apps/gateway/wrangler.jsonc` (file owned by the gateway lane,
   not this issue), activating the Worker's external-prober role (the
   handler already exists: `scheduled` in the Worker entry). Until then
   `gateway.worker` stays honestly `never_seen` and the external
   heartbeat-prober layer of backend-silence detection is inert.

Until steps 3-4 are done, alert delivery is BLOCKED (threshold evaluation
and alert events still emit Convex-side and are readable through the query
surface and the snapshot export); until step 5, heartbeat silence
detection runs only through the in-app tick plus any external prober
holding `KIERO_SERVICE_TOKEN` hitting
`POST /platform/telemetry/heartbeat`.
