# Platform composition evidence (A3)

Issue [A3 #18]. Proof ownership rows P01, P03, P06 (foundation half). All
results below were produced against the REAL Convex dev deployment
`steady-basilisk-613` (project `kiero-dev-core`, team `wojtek-piskorz-jr`,
region eu-west-1) and the REAL gateway Worker runtime (`wrangler dev`,
workerd) on 2026-09-09. No staging/alpha/production resource was touched.
No secret value was printed, logged or committed; `KIERO_SERVICE_TOKEN` is
a deployment variable plus a gitignored `.env.local` entry (name only in
evidence), and it was ROTATED after the session (see Procedure).

## Versions and revision

| Item | Value |
| --- | --- |
| Worktree branch | `codex/kiero-a3` (base `f9f1c08`, A2 merged) |
| node / npm | v22.22.3 / 10.9.8 (login shell) |
| convex package + CLI | 1.45.0 (`npx --yes convex@1.45.0`) |
| @convex-dev/workflow | 0.4.6 (+ peers convex-helpers 0.1.124, @convex-dev/workpool 0.4.11) |
| @convex-dev/react-query | 0.1.0 (the chosen Convex TanStack Query integration) |
| @tanstack/react-query | 5.102.8 |
| effect | 4.0.0-rc.112 |
| @tanstack/ai | 0.53.0 (schema converter only; NO provider calls) |
| wrangler | 4.130.0 (workerd local runtime for the gateway proof) |
| Deployment | `steady-basilisk-613.eu-west-1.convex.cloud` / `.convex.site` |
| Runtime version constant | `a3.0` (`RUNTIME_VERSION` in @kiero/runtime) |

## How to reproduce

```
npm ci
npx --yes convex@1.45.0 env set KIERO_PROBE_ENABLED 1
npx --yes convex@1.45.0 env set KIERO_ECHO_TARGET \
  "https://steady-basilisk-613.eu-west-1.convex.site/platform/echo?behavior=ok"
npx --yes convex@1.45.0 dev --once        # deploy schema+functions
npx tsx docs/evidence/platform/scripts/proof0-schema-conversion.mts
node  docs/evidence/platform/scripts/proof1-validation-subscription.mjs
node  docs/evidence/platform/scripts/proof2-outbox-replay-uncertainty.mjs
node  docs/evidence/platform/scripts/proof3-workflow-restart.mjs
node  docs/evidence/platform/scripts/proof4-bridge-worker.mjs
```

`KIERO_SERVICE_TOKEN` must be present in the deployment env and in the
gitignored `.env.local` (proof2 also flips `KIERO_ECHO_TARGET` between
`behavior=ok|slow` and redeploys, because Convex snapshots env vars into
functions at deploy time).

## Proof matrix (34 rows, all PASS)

### proof0: TanStack tool/schema adapter conversion (offline, P01)

| Row | Result | Evidence line |
| --- | --- | --- |
| S1 standard-schema -> JSON-schema conversion is deterministic | PASS | `type=object keys=additionalProperties,properties,required,type`; identical across runs |
| S2 union/enums survive conversion | PASS | `amountVariants=2 taxBasis=[net,gross,not_specified]` |
| S3 structured-output mode null-widens (requires all properties) | PASS | `required=[role,amount,currency,currencyOrigin,taxBasis,certainty]` |
| S4 malformed input rejected through `~standard.validate` | PASS | `issues=1` |

Path proved: A2 `MoneyValue` (Effect Schema) -> `Schema.toStandardJSONSchemaV1`
(draft-07) -> `convertSchemaToJsonSchema` from the pinned @tanstack/ai ->
provider JSON Schema. Zero provider calls (OpenRouter is E2's).

### proof1: checked calls, sanitized errors, subscriptions (live, P01)

| Row | Result | Evidence line |
| --- | --- | --- |
| V1 valid bridge command dispatches through the checked path | PASS | `status=200 echo=echo: wycena dachu Buniewice` |
| V2 invalid service credential rejected sanitized | PASS | `status=401 tag=unauthenticated` |
| V3 malformed bridge body fails closed | PASS | `status=400 tag=validation` |
| V4 unknown operation denied | PASS | `status=501 code=unknown_operation` |
| V5 registered-but-unimplemented op fails closed | PASS | `status=501 code=not_implemented` |
| V6 invalid input reaches NO domain effect | PASS | `status=400 tag=validation events=96->96` |
| V7 direct client command without identity fails | PASS | `unauthenticated/no_verified_identity` |
| V8 subscription updates push through the Convex React-Query adapter | PASS | `revision 96 -> 97 (reactive, no invalidation)` |
| V9 malformed subscription args surface as errors | PASS | `ArgumentValidationError` from the Convex boundary |

V8 detail: the proof subscribes via `convexQuery(api.platform/health.health,
{})` on a TanStack `QueryClient` wired through `ConvexQueryClient`
(`hashFn`/`queryFn`), then triggers a real mutation and observes the cache
update WITHOUT `invalidateQueries`. The adapter gates its live subscription
path on `typeof window !== "undefined"`; the Node proof supplies minimal
browser globals BEFORE the dynamic import (no adapter code is replaced);
recorded here because A4's web app gets this path for free in the browser.

### proof2: idempotent outbox/job mechanism, uncertain outcomes (live, P03/P06)

| Row | Result | Evidence line |
| --- | --- | --- |
| O0 fail AFTER registration rolls back event+job+scheduled work | PASS | `events 100->100 jobs 100->100` (mutation threw) |
| O1 transaction publishes canonical event AND durable job together | PASS | `eventId=c4d62f5c... jobKey=job_3aaf3686...` |
| O2 replay of the SAME logical operation dedups | PASS | `sameEventId=true sameJobKey=true events=1 jobs=1` |
| O3 timeout-after-possible-success recorded uncertain, no auto-retry | PASS | `jobState=failed externalEffects=1` |
| O3a replay of an uncertain-failure publisher with the SAME dedup key is refused | PASS | `deduplicated=true sameJobKey=true echoJobs=99 (was 99)` |
| O4 reconciliation observes the external system and confirms delivery | PASS | `reconciled=confirmed_delivered jobState=succeeded` |
| O5 no duplicate external effect across replay+uncertainty+reconcile | PASS | `externalEffects = 1` |
| O6 event consumer edge registers the durable analyze job (drain path) | PASS | `kind=processing.analyze_change_plan state=succeeded` |
| O7 unprojected consumer edge fails loudly (row failed, no job) | PASS | `state=failed lastErrorKind=consumer_projection_missing extractJobs=0` |
| O8 phase 1 definite terminal failure recorded on ONE row | PASS | `externalOutcome=failed errorKind=echo_target_not_configured attempts=1` |
| O8 phase 2 replay re-queues the SAME row which then fails uncertain | PASS | `sameJobKey=true rows=1 attempts=2 externalEffects=1` |
| O8 phase 3 replays of the uncertain row are refused: one effect, bounded attempts | PASS | `replaysReturnedSameRow=true echoJobRows unchanged attempts=2 (max 3) externalEffects=1` |

O3a (review repair 1): the uncertain job (failed + `externalOutcome: timeout`)
sits unreconciled while the publisher is replayed with the SAME idempotency
key; `decideJobRegistration` refuses re-registration (`uncertain_outcome`),
so no second durable row exists and the external effect stays at one.
O7 (review repair 2): an event whose registered consumer edge has no payload
projection yet (`sources.sourceAccepted` -> `processing.extract_fragments`)
is marked failed on the row with the machine-readable
`consumer_projection_missing` error kind; the drain logs it and keeps
processing, and no durable job is registered. Previously such rows were
silently stranded in_flight.
O8 (round-2 repair, adversarial): the full sibling-hiding sequence from the
review. ONE durable row exists per dedup key by construction: when
re-registration is allowed (definite failure only), `registerDurableJob`
patches the existing row back to queued and KEEPS its attempt count, so the
uncertain-outcome decision is always made against the authoritative row, and
the row's maxAttempts bounds total executions across every replay. Observed
live: definite terminal failure (attempts 1), replay re-queues the same row
which then times out after the external system recorded its effect
(attempts 2, exactly one external effect), and two further replays are both
refused (same jobKey returned, no new row, attempts stay at 2 of 3, external
effects stay at one).

The external stand-in is the deployed echo endpoint: it records one
`externalEffects` row per HTTP request BEFORE answering, then (per
`?behavior=`) answers, delays past the caller's 2 s deadline (the
uncertain case: the effect happened but the caller timed out), or answers
5xx. The delivery action enforces its deadline with an explicit
`AbortController` (`AbortSignal.timeout` is not guaranteed in the Convex
action runtime, found during the proof).

### proof3: workflow crash/restart (live, P06)

| Row | Result | Evidence line |
| --- | --- | --- |
| W1 run row and workflow created atomically | PASS | `runId=p97bxdbr... workflowId=jd78j579...` |
| W2 armed transient failure at stage 3 leaves stages 1..2 exactly once | PASS | `run=failed steps=[1,2] markers=1` |
| W3 restart (after disarm) resumes and completes all 5 stages | PASS | `run=succeeded stages=5` |
| W4 journal replay executes each stage exactly once | PASS | `stage ledger = [1,2,3,4,5]` |

Failure model: the arm marker is itself a journaled workflow step; the
stage computation throws while armed (a transient external condition), the
operator disarms it and restarts FROM THE FAILED STEP (`restart(..., {from:
computeStage})`); plain journal replay would re-throw the journaled step
error instead of re-executing the fixed stage (found during the proof;
recorded for D6/E2/E3 who own real pipelines).

### proof4: Worker bridge (real wrangler dev + real backend)

| Row | Result | Evidence line |
| --- | --- | --- |
| B1 gateway health + backend passthrough via verified identity | PASS | `gateway=ok backendReachable=true backendRuntime=a3.0` |
| B2 command forwarding through the verified service identity | PASS | ok envelope with echo value |
| B3 unsupported operation denied sanitized | PASS | `unsupported/unknown_operation` |
| B4 unmatched platform route denied sanitized | PASS | `status=400 code=no_such_route` |
| B5 unreachable backend -> sanitized unavailable, no leak | PASS | `unavailable/backend_unreachable retryable=true`; response contains no URL/host |

## Procedure notes (dated 2026-09-09)

- Deploys used `npx --yes convex@1.45.0 dev --once` (one-shot push to the
  dev deployment; `convex deploy` targets prod/preview deployments only and
  was NOT used).
- HTTP actions are served at the `.convex.site` host, and the router must
  be the default export of the `http` module (`convex/http.ts` composes
  route handlers from `convex/platform/http.ts`).
- Deployment env vars in use (names only): `KIERO_PROBE_ENABLED`,
  `KIERO_SERVICE_TOKEN`, `KIERO_ECHO_TARGET`, `KIERO_DEPLOYMENT_LABEL`.
  Env vars are snapshot-ted into functions at deploy time; the uncertainty
  proof therefore redeploys after flipping the echo behavior.
- `KIERO_SERVICE_TOKEN` was ROTATED at the end of the session (a local
  debug command echoed one value into a terminal transcript; the
  deployment variable and the gitignored `.env.local` were both replaced
  and the full matrix was re-run green against the rotated credential).
- Review repairs (PR #73 round 1, 2026-09-09): uncertain-outcome enforcement
  moved into the pure registration decision (O3a), the drain's projection
  became a three-way result with loud failure for unprojected edges (O7),
  and the boundary errors now reuse @kiero/runtime's constructors.
- Round-2 repairs (PR #73, 2026-09-09): registration is now one row per
  dedup key (re-registration re-queues the existing row with attempts kept,
  so maxAttempts bounds total executions across replays), the
  uncertain-failure predicate lives once in @kiero/runtime
  (`isUncertainJobFailure`; failures without an external outcome are never
  conflated with uncertainty), and O8 proves the full adversarial sequence.
  All five proofs were re-run green after the round-2 repairs (34/34).
- Seeded fixtures (dev deployment only): one company/user/membership/
  service session/source row created by `platform/probe:probeSeed`, real
  rows in B-lane tables, used by context resolution; no business work.

## NOT-RUN / honest limits

- Live OpenRouter provider forwarding: NOT RUN here by scope (E2 owns it);
  the conversion + standard-schema path it will use is proved offline (S1-S4).
- Convex Auth user identities: no sign-in product exists yet (B1); the
  user-identity source is proved fail-closed (V7) and the service-identity
  source is proved end-to-end. B1 swaps the identity source into the same
  canonical resolution seam.
- The outbox drain loop is event-driven (publish schedules drain); under
  total scheduler loss, recovery is a manual `platform/probe:probeDrainNow`
  and a cron table becomes worthwhile when business lanes publish (noted for
  H4/I2, not added: `convex/crons.ts` is outside A3's owned paths).
