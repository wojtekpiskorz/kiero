# Contracts and schema ownership manifest

Defined by A2 ([issue #17](https://github.com/wojtekpiskorz/kiero/issues/17)).

**Status: CERTIFIED baseline as of 2026-09-09 (A3, [issue #18](https://github.com/wojtekpiskorz/kiero/issues/18)).** A3 proved the actual validation and runtime conversion on the real Convex dev deployment `steady-basilisk-613` (packages, procedure and the 29-row PASS matrix: `docs/evidence/platform/README.md`) and certified this baseline with the sequential amendments listed below. Production consumers start behind this gate. Later domain lanes own their fragment through their declared path; shared-meaning changes remain coordinated prerequisites.

## A3 certification note (2026-09-09)

**Certified interface inventory state:** 56 operations, 40 events, 7 executors, 9 event-consumer edges, 16 durable job kinds, 52 tables (`TABLE_ID_NAMES`), one workflow engine (`@convex-dev/workflow` 0.4.6 + the native scheduler). The certified revision is A3's merge commit on `main` (recorded by the coordinator at integration); in-tree, this README plus `docs/evidence/platform/` are the certification record.

**Sequential amendments the proof forced** (all inside A3-owned paths, all covered by updated tests):

1. `platform` module surface added (3 operations: `platform.probeEcho`, `platform.health`, `platform.outboxState`; 1 event: `platform.echoRequested`) so the composition proof validates through the registry like every consumer, and the Worker bridge has honest operations to forward.
2. `platform.echo_delivery` job kind + `platform.echo` executor + the `platform.echoRequested` consumer edge: the platform's external-delivery proof executor (echo stand-in; E2 later points the same mechanism at OpenRouter).
3. `externalEffects` table (52nd): the observable external-effect ledger the no-duplicate-effect proof counts; written only by the echo endpoint.
4. `durableJobs` gains `dedupKey` (+ `by_dedup` index), `by_jobKey` index, `lastErrorKind`, `externalOutcome`, `finishedAtMs`: job-key/dedup lookup inside the registration transaction and sanitized outcome recording.
5. Job kinds renamed `notifications.*` -> `attention.*` (one concept, one name: the module surface is `attention`).
6. `DateRange` now enforces cross-precision bound ordering by period start (the A2 deferral, resolved): `start=2026-05-10/end=2026-05` rejects, `start=2026-05/end=2026-05-10` accepts; `dateOnlyPeriodStart` is exported.
7. `convex/schema.ts` passes the literal spread to `defineSchema` (runtime uniqueness/inventory checks unchanged) so per-table index types survive into the generated data model: `withIndex("by_dedup", ...)` typechecks against real index names.
8. Pinned counts in `tests/contracts/` updated (52 tables, 56/40 registry, 7 features) and the unknown-event branch of `assertFeaturesCoherent` got its fixture (the A2 round-6 residual).

**Deferred A2 ruling items, disposition:**

- Registration builder refactor (ruling item 2): knowingly carried. The platform surface was added with the existing entry pattern; a generic builder would churn all 10 module files with zero behavioral gain while no consumer lane has registered a feature yet. Better done when B/C/D lanes actually register; the registry's import-time checks keep the current pattern safe.
- One-concept-one-name renames (ruling item 8): done where the scan found a real split (the `notifications.*` -> `attention.*` job kinds, amendment 5). No other one-concept-two-names pair was found across the operation/event surfaces; consumers should flag further candidates during their integration instead of churning the baseline now.

**Post-certification repairs (PR #73 review rounds 1-2, 2026-09-09, before merge):**

9. `outboxEvents` gains `lastErrorKind` and `platform.outboxState` exposes
   it (on events, and `externalOutcome`/`lastErrorKind` on jobs): the
   drain's loud failure for unprojected consumer edges
   (`consumer_projection_missing`) is machine-readable on the row instead of
   a silent in_flight stranding. Durable registration is ONE row per dedup
   key: re-registration (allowed only for DEFINITE failures, per
   `decideJobRegistration`) patches the existing row back to queued and keeps
   its attempt count, so a sibling row can never hide an uncertain failure
   behind an older definitely-failed one, and the row's maxAttempts bounds
   total executions across every replay of the logical operation. The
   uncertain-failure predicate (`isUncertainJobFailure`: failed +
   externalOutcome timeout/unknown; failures without an external outcome are
   never uncertain) is defined once in @kiero/runtime and consumed by both
   the registration decision and the executor entry. Proved live in
   `docs/evidence/platform/README.md`: rows O3a (uncertain replay refused),
   O7 (unprojected edge fails loudly) and O8 (the full adversarial
   definite-fail -> replay -> uncertain-fail -> replay sequence on one row:
   one external effect, attempts bounded at 2 of 3); 34/34 rows PASS.

**Runtime facts proved against this baseline** (details in `docs/evidence/platform/README.md`): the single Effect-Schema -> Convex-validator conversion table survives real deployment; command envelopes decode through Effect Schema at the function boundary (Convex-level args validation is deliberately delegated to the contract schemas to keep ONE conversion path); `ctx.db.normalizeId` is the runtime id well-formedness bridge between branded contract ids and Convex `Id`s; the TanStack schema converter consumes `~standard.jsonSchema` (draft-07) attached by `Schema.toStandardJSONSchemaV1`.

**Convex generated-file policy (proved):** `convex/_generated` is never hand-edited. Regeneration is `npm run convex:codegen` (`npx --yes convex@1.45.0 codegen`), which requires an authenticated deployment context (convex 1.45 CLI limitation), so CI checks presence/integrity of the committed output plus the strict typecheck that consumes it; the one coordinating writer regenerates and commits the output on every change to `convex/**` (merge flow).

## What lives where

| Location | Owns | Amended by |
| --- | --- | --- |
| `packages/contracts/src/` | Semantic value contracts (Effect Schema 4), actor context, command/result envelopes, closed sanitized errors, event/outbox envelopes, durable job envelopes, staged media/publication states, typed id convention, module operation/event surfaces, composed registry with the initial producer/consumer registrations | A3 first; later shared changes are coordinated prerequisites |
| `convex/schema/shared.ts` | Cross-domain Convex value definitions (`v.*`) and the ONE proved conversion path from Effect Schema semantic values to Convex validators | A3 first (runtime proof of the conversion) |
| `convex/schema.ts` | Composition only: imports each domain fragment, checks table-name uniqueness and inventory equality, calls `defineSchema` | A3; new fragments are coordinated additions |
| `convex/<domain>/schema.ts` (below) | One fragment per domain: tables, load-bearing fields, indexes for the architecture's named reads | The owning lane named below |
| `tests/contracts/` | Focused contract tests (value semantics, conversion round-trip, fragment integrity, registry integrity) plus the compile-time placeholder consumers | One subdirectory per issue; A2 owns `tests/contracts/` files listed at the bottom |

There is deliberately **no general-purpose Schema→Validator compiler**. The only conversion is the hand-written, type-checked mapping table in `convex/schema/shared.ts`, where every entry's Convex validator type must equal the Effect schema's `Encoded` type exactly or the build fails.

## Naming rules

- Table and operation names are English. Polish domain meanings ("Ustalenie", "Wiadomość źródłowa", "Alias projektu", ...) map to English names via `CONTEXT.md`; the glossary remains authoritative for meaning.
- Operations: `<module>.<verbPhrase>` in lowerCamelCase (`memory.publishChangeSet`). Events: `<module>.<nounPhrase>` (`sources.sourceAccepted`).
- Job kinds: `<area>.<action>` (`deletion.purge_source`).
- Tables: lowerCamelCase plural (`findingRevisions`). Indexes: `by_` + their field list (`by_company_order`).
- The module surface object keys equal the full operation/event name; the composed registry enforces key/name agreement and cross-module uniqueness at import time.
- New vocabularies (error kinds, job kinds, task/event/project states, money roles, temporal roles) are closed unions; extending them is a coordinated contract change, never a silent fragment edit.

## Fragment ownership (23 paths: 21 fragments + shared + composition)

| Fragment path | Tables | Owning implementer |
| --- | --- | --- |
| `convex/access/identity/schema.ts` | `users`, `sessions` | B1 (sign-in), B2 (linking) |
| `convex/access/membership/schema.ts` | `companies`, `memberships`, `invitations` | B3 |
| `convex/access/gm/schema.ts` | `gmAccessGrants` | B4 |
| `convex/projects/schema.ts` | `contacts`, `contactRoles`, `projects`, `projectAliases` | C1 |
| `convex/memory/findings/schema.ts` | `findings`, `findingRevisions`, `evidenceLinks`, `findingDependencies`, `changeSets`, `publicationGroups`, `clarifications` | C2 (+C5, E3 reads) |
| `convex/memory/extensions/schema.ts` | `extensionDefinitions`, `extensionVersions`, `extensionUsage` | C3 |
| `convex/work/schema.ts` | `tasks`, `checklistItems`, `events` | C4 |
| `convex/sources/accept/schema.ts` | `sources`, `sourceProjectLinks`, `extractions`, `sourceFragments` | D1 (+C5/I3/I4 reads) |
| `convex/sources/uploads/schema.ts` | `uploads`, `attachments`, `mediaRepresentations` | D2 (+D5) |
| `convex/platform/schema.ts` | `processingRuns`, `processingSteps`, `processingAttempts`, `durableJobs`, `outboxEvents`, `externalEffects` | A3 (composition + outbox delivery mechanics), H4 (inspection), D6/E2 (stages); every publishing lane writes outbox rows through publication |
| `convex/search/schema.ts` | `searchEntries`, `searchIndexGenerations` | E5 |
| `convex/attention/read-state/schema.ts` | `readStates` | F1 |
| `convex/attention/preferences/schema.ts` | `notificationPreferences` | F1 |
| `convex/attention/delivery/schema.ts` | `notificationIntents`, `pushSubscriptions`, `notificationAttempts` | F2 (+F3) |
| `convex/calendar/connection/schema.ts` | `calendarConnections` | G1 |
| `convex/calendar/projection/schema.ts` | `calendarCopies`, `calendarSyncState` | G2 (+G3) |
| `convex/operations/exports/schema.ts` | `exports`, `exportSourceLinks` | I3 |
| `convex/operations/deletion/schema.ts` | `deletionRecords` | I4 |
| `convex/operations/backups/schema.ts` | `recoveryManifests` | I5 (+I6 drills) |
| `convex/operations/telemetry/schema.ts` | `auditRecords`, `diagnosticEvents` | I2 |
| `convex/schema/shared.ts` | shared values + proved conversion | A2 → A3 |
| `convex/schema.ts` | composition entry | A2 → A3 |

52 tables total since the A3 certification amendment (`externalEffects`); the inventory is the closed `TABLE_ID_NAMES` union in `@kiero/contracts`, and `convex/schema.ts` fails at import time if the composed tables and the inventory differ in either direction. `outboxEvents` (platform fragment) is the durable home of `DomainEventEnvelope`: publishers write it atomically with their state change, and the 9 registered consumer edges drain it through durable jobs.

Lanes that create NEW tables (B2 `convex/access/linking/**`, D6 `convex/processing/audio/**`, F3 `convex/attention/push/**`, F4 `convex/attention/reminders/**`, G3 `convex/calendar/sync/**`, H4 `convex/operations/processing/**`, E5 additions) add their own fragment file and register the new table names in `TABLE_ID_NAMES` plus the composition import: a small coordinated change named in their issue, not a shared mega-schema edit.

## Producer and consumer registration entries

Registration shapes live in `packages/contracts/src/modules/registration.ts` (`OperationEntry`, `EventEntry`, `FeatureEntry`, `ExecutorEntry`, `EventConsumerEntry`). The composed registry (`.../modules/registry.ts`) holds the initial entries and checks at import time that every consumer edge references a declared event and a registered executor. Feature registrations are DERIVED, not hand-written: one feature per executor, `consumesEvents` grouped from the consumer edges by job kind (an edge belongs to the executor owning its job kind), so attribution cannot disagree with the executor table. Consumer edges carry no feature id of their own for exactly this reason; `assertFeaturesCoherent` (hand-written parts) and `assertFeaturesCoverRegistrations` (derived edges equal declared edges) run at import.

Initial registrations (candidates until implemented; dispatching any unimplemented entry fails closed with the `unsupported` closed error):

- **Executors**: `access.cleanup` (access-revocation cleanup), `memory.recompute` (dependency re-evaluation), `deletion.purge` (source purge), `calendar.reconcile` (unknown Calendar outcomes), `processing.extract` / `processing.analyze` (publication pipeline).
- **Event consumers** (edge → job kind; the owning feature is derived from the executor table): access.membershipRevoked / access.sessionRevoked → `access.cleanup_revocation`; sources.sourceWithdrawn / memory.dependentsMarkedStale → `memory.recompute_dependents`; sources.sourcePurged → `deletion.purge_source`; calendar.copyOutcomeRecorded → `calendar.reconcile_outcome`; sources.sourceAccepted → `processing.extract_fragments` (owned by the `processing.extract` feature); operations.reanalysisRequested → `processing.analyze_change_plan`.

The four cross-module outcomes the architecture names explicitly are therefore wired: access-revocation cleanup, reanalysis, deletion, and Calendar outcomes. Later lanes register their own features/executors/consumers in their fragments and extend the registry import list (a named prerequisite when shared files are touched).

## Honest failures

- No operation here performs business work. A placeholder executor is `(entry) => () => errorResult(notImplemented(entry.name))`. See `tests/contracts/consumers.ts` for the compile-time shape.
- The closed error type has no field that could carry stacks, provider payloads or internal messages.
- A schema entry is not business implementation and not proof of access safety; authorization is rechecked at every command by the implementing lanes.
- UI and agent use the same checked domain operations: an agent plan is untrusted input decoded against the same operation entry (`ActorContext.via: "agent"` records the boss on whose behalf it acts), and the server resolves the actor, validates expected revisions and controls persistence.

## What A3 must prove or amend (integration notes)

1. **Deployment-time validator enforcement.** The pinned convex 1.45.0 exposes no untyped local validate entry; `convexToJson` is fully typed. Runtime rejection of malformed values against `v.*` validators happens at deployment/function boundaries; A3 proves it on the real runtime.
2. **The conversion path stays one.** If A3 needs richer validators (e.g. `v.record`, search/vector indexes), extend the same hand-checked table in `convex/schema/shared.ts`; do not introduce a second mechanism.
3. **Effect 4 RC quirks found here** (A3 inherits): `Schema.Union`/`Schema.Literals` take arrays; `Schema.TaggedUnion` takes one record keyed by case and always discriminates on `_tag`; primitives are not callable; **`Schema.mutable` applied after piped checks drops them** (checks must be piped after `mutable`); decoded `BigDecimal` instances carry lazy internal fields, so structural equality assertions should compare encoded forms.
4. **Vocabulary pins.** Every fragment closed union that mirrors a contracts-side vocabulary is annotated `ValueValidator<Encoded<typeof ContractsSchema>>` with the mechanism exported from `convex/schema/shared.ts`: job kinds/states, processing run state, task/event/checklist states, project stages, contact kinds/roles, upload stages, media kinds/roles, publication and export states, extension field kinds, membership roles (memberships and invitations), outbox delivery states, and Calendar remote outcomes. Vocabulary ownership stays in the fragment. Added, renamed or misspelled literals fail typecheck; a silently DROPPED literal does not (the Validator type parameter is covariant, so a subset union still assigns), which is exactly what the runtime literal-equality test in `fragments.test.ts` catches by comparing both sides. Fragment-local lifecycles with no contracts-side vocabulary (e.g. `memberships.state`, `sources.lifecycle`, `processingSteps.state`) are fragment-owned by design; if a later operation surface starts mirroring one, hoist a named schema on the contracts side and pin it.
5. **Encoded arrays are mutable by declaration** in `ExtensionValue`/`ExtensionFieldShape` so the wire form matches Convex's mutable-array value model; keep that pattern for new array-bearing semantic values.
6. **Timestamps**: table columns are epoch-ms floats (trusted system time); timestamps inside semantic payloads remain encoded ISO strings. If A3 prefers a different storage rule, it amends `shared.ts` in sequence.
7. `parseTableId` only checks string-ness; Convex id well-formedness and existence are runtime concerns (`ctx.db.normalizeId`) proven in A3/B-lanes.

## Test surface (A2-owned files under tests/contracts/)

- `values.test.ts`: semantic value semantics (knowledge states; date-only vs timed vs range vs open bounds; exact money with `not_specified`; extension bounds).
- `conversion.test.ts`: the proved conversion (decode → encode → pinned Convex JSON wire → decode → equal); malformed/unknown input rejects with `SchemaError`; the Convex-value assignability of every encoded form is compile-checked.
- `fragments.test.ts`: composed table inventory (52 since the A3 certification), vocabulary pins checked at runtime against the contracts schemas, indexes for the architecture's named reads, extension version immutability, source immutability, independent parent/checklist state.
- `surfaces.test.ts`: registry integrity, fail-closed placeholders, typed/generated ids, envelope decoding.
- `consumers.ts`: compile-time placeholder consumers (not run by vitest; typechecked by the root program) with no unchecked assertions.
