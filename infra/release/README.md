# Release (I7)

The release surfaces for issue #59: the pinned workflow, the
expand-migrate-contract tooling and the append-only evidence ledger. This
directory owns NAMES and MECHANISMS only; secret values never appear here.

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

- Trigger: `workflow_dispatch` with an explicit target choice only.
  Checks and staging success can never implicitly promote production; the
  production job additionally sits behind the protected
  `alpha-production` GitHub environment (human approval).
- Concurrency: one release per target at a time; a concurrent attempt
  queues (never cancels) and still stops at the protected environment.
- Secrets: environment-scoped names only (`STAGING_*` in the staging job,
  `PRODUCTION_*` in the production job). `verify-release-target.mjs`
  re-checks the workflow's own secret references and the runtime
  environment label before every deploy, and fails the job on any
  cross-environment name.
- Provisioning honesty: both deploy targets are PENDING owner actions
  (`infra/environments/synthetic-staging.md`,
  `infra/environments/alpha-production.md`). Until provisioned, the deploy
  steps stop at the guard and print the exact pending commands; the guard
  rails themselves run for real on every dispatch.

## Evidence ledger

`evidence/releases.jsonl` is append-only. One record per release attempt:
target, revision, the rehearsal verdict and row count, the runtime and
client versions, and the SHA-256 of the rehearsal's migration ledger.
`record-release-evidence.mjs` appends; nothing edits or removes lines.
J4/J5 qualification and the owner matrix consume this ledger.

## The PWA update flow (consumer note)

The client half lives in `apps/web/src/pwa/update/`: detection (waiting
service worker) plus the backend version handshake decide an update kind;
the safe-point gate (work holds + input settle + visibility) decides WHEN
a Polish prompt may appear; the draft store migrates BEFORE the prompt;
the reload happens only on the user's click. Feature surfaces integrate
by taking a work hold (`gate.hold("capture.recording")` style) for the
duration of recording/editing/upload work.
