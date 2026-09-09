# Contracts and schema ownership manifest

Defined by A2 ([issue #17](https://github.com/wojtekpiskorz/kiero/issues/17)).

**Status: these are CANDIDATE contracts until A3 ([issue #18](https://github.com/wojtekpiskorz/kiero/issues/18)) proves the actual validation and runtime conversion on the real runtime and certifies this baseline.** Production consumers start only behind that gate. A3 owns the sequential post-proof freeze and may amend any entry below in sequence; later domain lanes then own their fragment through their declared domain path.

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

## Fragment ownership (22 paths: 20 fragments + shared + composition)

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
| `convex/platform/schema.ts` | `processingRuns`, `processingSteps`, `processingAttempts`, `durableJobs`, `outboxEvents` | A3 (composition + outbox delivery mechanics), H4 (inspection), D6/E2 (stages); every publishing lane writes outbox rows through publication |
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

51 tables total; the inventory is the closed `TABLE_ID_NAMES` union in `@kiero/contracts`, and `convex/schema.ts` fails at import time if the composed tables and the inventory differ in either direction. `outboxEvents` (platform fragment) is the durable home of `DomainEventEnvelope`: publishers write it atomically with their state change, and the 8 registered consumer edges drain it through durable jobs.

Lanes that create NEW tables (B2 `convex/access/linking/**`, D6 `convex/processing/audio/**`, F3 `convex/attention/push/**`, F4 `convex/attention/reminders/**`, G3 `convex/calendar/sync/**`, H4 `convex/operations/processing/**`, E5 additions) add their own fragment file and register the new table names in `TABLE_ID_NAMES` plus the composition import: a small coordinated change named in their issue, not a shared mega-schema edit.

## Producer and consumer registration entries

Registration shapes live in `packages/contracts/src/modules/registration.ts` (`OperationEntry`, `EventEntry`, `FeatureEntry`, `ExecutorEntry`, `EventConsumerEntry`). The composed registry (`.../modules/registry.ts`) holds the initial entries and checks at import time that every consumer edge references a declared event and a registered executor.

Initial registrations (candidates until implemented; dispatching any unimplemented entry fails closed with the `unsupported` closed error):

- **Executors**: `access.cleanup` (access-revocation cleanup), `memory.recompute` (dependency re-evaluation), `deletion.purge` (source purge), `calendar.reconcile` (unknown Calendar outcomes), `processing.extract` / `processing.analyze` (publication pipeline).
- **Event consumers**: access.membershipRevoked / access.sessionRevoked → access-revocation cleanup; sources.sourceWithdrawn / memory.dependentsMarkedStale → dependent recomputation; sources.sourcePurged → deletion purge; calendar.copyOutcomeRecorded → Calendar reconciliation; sources.sourceAccepted → durable extraction; operations.reanalysisRequested → linked reanalysis run.

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
- `fragments.test.ts`: composed table inventory (51), vocabulary pins checked at runtime against the contracts schemas, indexes for the architecture's named reads, extension version immutability, source immutability, independent parent/checklist state.
- `surfaces.test.ts`: registry integrity, fail-closed placeholders, typed/generated ids, envelope decoding.
- `consumers.ts`: compile-time placeholder consumers (not run by vitest; typechecked by the root program) with no unchecked assertions.
