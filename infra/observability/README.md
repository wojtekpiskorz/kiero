# Kiero observability descriptors (I2)

Owned by issue [I2 #54]. These files define NAMES, schemas and monitor
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
  A3 handoff note's outbox-drain safety net).
- Gateway telemetry (`apps/gateway/src/telemetry/`): request-scoped redacted
  events (GW -> OBS), heartbeat prober via the Worker cron trigger, Axiom
  emitter behind an interface with a Convex-ingest dev fallback.
- The Axiom emitter behind `TelemetrySink` with the real HTTP client
  implemented and unit-tested against a local sink (no network).

## PENDING owner actions (exact steps)

No Axiom account or alert destination exists; no `AXIOM_API_TOKEN` is
present in any environment (checked by name only, 2026-09-09). The owner
must:

1. **Create the Axiom Personal account** (free plan: 1 user, 3 datasets,
   3 monitors, 30-day retention) and create the dataset
   `kiero-observability`.
2. **Set the credentials by name** (values never in the repository):
   - Convex deployments: `npx --yes convex@1.45.0 env set AXIOM_API_TOKEN`
     and `env set AXIOM_DATASET kiero-observability` per deployment.
   - Gateway Worker: `wrangler secret put AXIOM_API_TOKEN --config
     apps/gateway/wrangler.jsonc` plus var `AXIOM_DATASET`.
   Until then the sink reports `axiom_not_configured` and delivery falls
   back to the Convex ingest path (dev) - honest, never simulated.
3. **Create the three monitors** exactly as defined in [monitors.json](monitors.json)
   against the `kiero-observability` dataset (Axiom Personal permits exactly
   three - all are allocated).
4. **Configure the email alert destination(s)** for all three monitors
   (owner mailbox), replacing `OWNER_PLACEHOLDER` in monitors.json.
5. **Add the gateway cron trigger** (`*/5 * * * *`) to the gateway wrangler
   config when it is created by its owning ticket, activating the Worker's
   external-prober role (the handler already exists: `scheduled` in the
   Worker entry).

Until steps 1-4 are done, alert delivery is BLOCKED (threshold evaluation
and alert events still emit Convex-side and are readable through the query
surface); until step 5, heartbeat silence detection runs only through
manual/external probers hitting `POST /platform/telemetry/heartbeat`.
