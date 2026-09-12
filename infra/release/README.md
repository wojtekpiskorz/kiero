# Release (I7, R6)

The release surfaces for issues #59 and #131: the pinned workflow, the
checked deploy adapters, the exact-SHA Checks gate, the expand-migrate-
contract tooling and the append-only evidence ledger. This directory owns
NAMES and MECHANISMS only; secret values never appear here.

## The release order (expand, migrate, contract)

A release that changes schema or workflow shape walks three phases
(`tools/migrations/engine.ts`):

1. **Expand**: the new code ships reading BOTH shapes (the definition's
   `dualRead` proves it); old clients and workers keep working against
   post-expansion data.
2. **Migrate**: bounded idempotent batches over a cursor-paginated
   collection; every completed batch is recorded in the append-only
   migration ledger (`tools/migrations/ledger.ts`) first by applying, then
   by recording, so a kill leaves at most one partially applied batch that
   the resumed run re-applies safely. Batches retry transiently with
   bounded attempts; exhaustion records a failure the next run resumes
   from.
3. **Contract**: old-version support is removed only after MEASURED
   ABSENCE (`tools/migrations/policy.ts`: `decideContractRemoval`); an
   observation of an older version inside the absence window blocks the
   phase.

The release rehearsal (`node --experimental-strip-types
tools/migrations/rehearsal.mts`) walks the whole lifecycle
deterministically, including the mid-batch kill, the mixed-version window
and every refusal rule. The release workflow refuses to deploy anything
when a row fails.

## The release target descriptor (the shared format)

`targets/staging.json` and `targets/production.json` are the ONE format
the guard, the Checks gate, the deploy adapter and the evidence recorder
share (`target-descriptor.mjs` validates it): the target's GitHub
environment name, its secret-name prefix, the identity of the
deterministic Checks job (`checksName`, pinned against
`.github/workflows/checks.yml` by the guard) and the deployable
components, each with its build command, artifact path, transport kind
and the runtime configuration NAMES it requires. Descriptors carry names
only; presence is checked at deploy time, values are never read here.

## The deploy pipeline (every step is a committed executable)

1. `verify-target.mjs --target <t> --workflow release.yml --descriptor
   targets/<t>.json --checks-workflow checks.yml`, the wrong-environment
   guard: secret-name prefixes in the job block, the declared environment,
   the runtime label, the descriptor's own validity and that its
   `checksName` really is a Checks job name.
2. `verify-checks.mjs --repo … --sha <GITHUB_SHA> --descriptor
   targets/<t>.json --token-env CHECKS_GITHUB_TOKEN --out
   checks-report.json`, the deterministic Checks gate: the named Checks
   job must have COMPLETED with SUCCESS for the EXACT revision. Missing,
   pending (queued/in progress), failed, null-conclusion and wrong-SHA
   observations all refuse, and the report (requested SHA + observed
   conclusions, no tokens) is written before the exit code.
3. `deploy-component.mjs --descriptor targets/<t>.json --revision
   <GITHUB_SHA> --checks-report checks-report.json --ledger
   evidence/releases.jsonl --outcomes deploy-outcomes.json`, the checked
   adapter. It re-validates the Checks report itself, requires the
   runtime label to equal the descriptor target, checks configuration
   NAMES for presence, builds the checked-out tree, digests the artifact
   (file-tree manifest SHA-256) and hands the REAL artifact path plus the
   validated descriptor to the component's transport
   (`transports/*.mjs`): `wrangler-pages` (web build), `wrangler-deploy`
   (gateway/media/export/backup workers), `convex-deploy` (functions) and
   `stub` (tests/local rehearsal only). Every component ends in exactly
   one terminal outcome; the exit code is non-zero when any component is
   blocked, after the evidence is appended.
4. `record-release-evidence.mjs` appends the attempt-level record
   (rehearsal verdict, versions, notes, migration-ledger digest).

## The three truthful terminal outcomes

- **deployed**: only with component, revision, artifact digest,
  descriptor id AND the remote identity reported by the transport
  (deployment reference, Pages project + URL, or worker name + version).
- **skipped**: only when the target descriptor excludes the component.
- **blocked**: missing or unauthorized configuration (NAMES only:
  which configuration names were absent, which label was observed),
  refused/missing Checks, failed build or failed transport. Blocked runs
  FAIL the job while the evidence ledger is still uploaded
  (`if: always()`); a green deploy job always means deployed bytes.

## Repair policy

After a bad release, repair is code-level only
(`planReleaseRepair` in policy.ts):

- restoring an old DATABASE as release rollback is refused (it would
  discard newer canonical data; backups serve disaster recovery, not
  routine releases);
- a compatible rollback re-serves older code that keeps the EXPANDED
  schema support; no data is rewritten back and no access row is touched;
- revoked access is never resurrected by any repair: revocation is
  immediate for every client age (the PWA update flow defers only its own
  reload prompt, never a security event).

## The workflow (`.github/workflows/release.yml`)

- Trigger: workflow_dispatch with an explicit target choice only.
  Checks and staging success can never implicitly promote production; the
  production job runs under the alpha-production environment NAME.
  Whether environment protection is actually configured is live GitHub
  state this YAML cannot claim; provisioning and the first protected
  execution are owner/I8 work.
- Concurrency: one release per target at a time; a concurrent attempt
  queues (never cancels) and still stops at the alpha-production
  environment.
- Secrets: environment-scoped names only (`STAGING_*` in the staging job,
  `PRODUCTION_*` in the production job). The Checks gate uses the
  workflow's own `github.token` (a context reference, not a secret).
- Provisioning honesty: both deploy targets are PENDING owner actions
  (`infra/environments/synthetic-staging.md`,
  `infra/environments/alpha-production.md`). Until provisioned the
  adapter records blocked outcomes naming the missing configuration and
  the job FAILS while uploading the evidence.

## Evidence ledger

`evidence/releases.jsonl` is append-only. Two record kinds:
`release-attempt` (target, revision, descriptor, rehearsal verdict and
row count, runtime and client versions, migration-ledger SHA-256, and
the dispatcher's notes when supplied) and
`component-outcome` (the three terminal states above). Nothing edits or
removes lines. J4/J5 qualification and the owner matrix consume this
ledger.

## The PWA update flow (consumer note)

The client half lives in `apps/web/src/pwa/update/`: detection (waiting
service worker) plus the backend version handshake decide an update kind;
the safe-point gate (work holds + input settle + visibility) decides WHEN
a Polish prompt may appear; the draft store migrates BEFORE the prompt;
the reload happens only on the user's click. Feature surfaces integrate
by taking a work hold (`gate.hold("capture.recording")` style) for the
duration of recording/editing/upload work.
