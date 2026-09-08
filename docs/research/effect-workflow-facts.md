# Effect durable workflow and cluster facts

**Research date:** 2026-09-08. **Local contract:** Kiero has no dependency manifest, so no Effect version is selected. This note uses the exact published Effect 4 RC archive and the matching, provenance-resolved Effect-TS/effect commit `2600f62f4532026928454dcea8d1c48557b3f942`. It separates source observations from assessment and does not choose an engine.

## Exact published evidence

- `effect@4.0.0-rc.112` is the current `rc` tag; `3.22.1` remains `latest`. Effect 4 is pre-release. [core registry](https://registry.npmjs.org/effect)
- The exact `rc.112` package exports both `effect/unstable/workflow` and `effect/unstable/cluster`. Its workflow barrel exports `Workflow`, `WorkflowEngine`, `Activity`, `DurableClock`, `DurableDeferred`, and `DurableQueue`; its cluster barrel exports `ClusterWorkflowEngine`, `MessageStorage`, and `SqlMessageStorage`. These modules are bundled in the RC, rather than absent because the old extension packages use Effect 3. [Pinned workflow barrel](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/unstable/workflow/index.ts)
- The archive’s sources mark those exports `@since 4.0.0`, but their public paths remain under `unstable`. This is exact-version export evidence, not a stability guarantee or a successful runtime proof.

The legacy packages are a separate fact: published `@effect/workflow@0.19.1` and `@effect/cluster@0.60.2` declare Effect `^3.22.1` peer ranges. They therefore do not establish a usable RC quartet, but they also do **not** prove that Effect 4 lacks bundled workflow/cluster capability. [workflow registry](https://registry.npmjs.org/@effect%2fworkflow) [cluster registry](https://registry.npmjs.org/@effect%2fcluster)

## What the rc.112 source implements

**Source-code observations from the pinned RC source.** `ClusterWorkflowEngine` builds persisted cluster RPCs for workflow runs, activities, deferreds, resumes, and durable-clock requests. It records activity results by activity name/attempt, uses persisted RPC annotations, and schedules clock work through a `DeliverAt` payload. `Activity.retry` increments `CurrentAttempt`; `Activity.idempotencyKey` derives a deterministic key from workflow execution id, activity name, and optionally attempt. [Pinned cluster workflow engine](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts)

`SqlMessageStorage` is implemented in the pinned source against Effect’s `SqlClient`. It stores request/reply records, considers requests without a terminal reply unprocessed, supports delayed delivery, deduplicates by primary key, and exposes `withTransaction`; its own save/reply/migration operations use that transaction helper. This is durable execution machinery beyond ordinary in-process `Effect.retry`. [Pinned SQL message storage](https://github.com/Effect-TS/effect/blob/2600f62f4532026928454dcea8d1c48557b3f942/packages/effect/src/unstable/cluster/SqlMessageStorage.ts)

**Unverified:** no official Effect 4 RC document or exact RC runtime test was found here that proves a supported PostgreSQL driver/version, deployment topology, migration path, or end-to-end crash semantics. The source is generic SQL infrastructure; PostgreSQL use requires a compatible SQL-driver layer and a real compatibility check. Do not elevate upstream-main documentation to rc.112 behavior without a pinned ref.

## PostgreSQL / Drizzle boundary

**Verified boundary:** the RC archive provides transactions inside its own `SqlMessageStorage` through Effect `SqlClient`. It contains no Drizzle integration or public evidence that an existing Drizzle transaction is adopted when a workflow starts. `ClusterWorkflowEngine` can pass a `withTransaction` flag to activity handling; that is worker-side handling, not proof of atomic origin-side `Kiero domain write + workflow start`.

**Assessment:** sharing PostgreSQL would not by itself create one transaction. That atomicity needs an explicitly designed and tested bridge: for example, an outbox written with the domain mutation and later consumed into the workflow, or one proven transaction spanning the actual Drizzle connection and the Effect storage write. Until proved, workflow start is a separate failure boundary.

Graphile Worker exposes a different documented seam: `graphile_worker.add_job(...)` is a PostgreSQL function callable from application SQL and triggers, with schedule, retries, and a job key. That permits enqueueing on the same database transaction connection as the domain mutation; it does not decide whether Graphile’s job model or Effect’s workflow model is the better fit. [Adding jobs through SQL](https://worker.graphile.org/docs/sql-add-job)

## External LLMs and minimal probes

**Inference:** deterministic workflow/activity keys cannot guarantee exactly-once LLM invocation. After a provider accepts a request but before the activity completion is durably recorded, the outcome may be externally unknown. Provider-side idempotency or reconciliation remains necessary.

Before selection, prove only these boundaries:

1. Verify the selected Effect 4 RC lockfile with its SQL driver; do not assume compatibility from the legacy Effect-3 extension packages.
2. Fault-inject before the request, after provider acceptance, and before durable completion; observe replay, request keys, and duplicate cost.
3. Prove or reject one transaction for `domain write + workflow start` using the actual Drizzle connection. If absent, fault-test the outbox consumer and conditional Kiero publication.
4. Replay an in-flight workflow after a changed activity name/schema and document the migration behavior.
