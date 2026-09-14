# Deployment environment label consolidation evidence (R13 #182)

Status date: 2026-09-14. Worktree `/projects/kiero-worktrees/r13-env-labels`
from `main` at `2f4fa55` (uncommitted, per the coordinator-owned Git
lifecycle). Scope: the `KIERO_ENVIRONMENT` closed-label read existed in
four runtime copies; a label added in one copy but not another silently
classified that deployment as dev, and dev is exactly what re-allows a
plain-http return link in the Calendar resolver. R13 consolidates the
read into one canonical helper in `packages/runtime` and migrates every
copy to it. Deterministic coverage in `tests/g6/` (new directory; 73
tests).

This session held no cloud credentials and deployed nothing. Everything
executable locally was executed and is recorded in section 4.

## 1. The accepted semantics (preserved exactly)

Extracted from the four pre-R13 copies before any edit:

- the closed label set is exactly `dev`, `staging`, `alpha-production`
  (that order in the accepted regex);
- `?? "dev"`: an absent (`undefined`) or `null` value reads as dev;
- an empty string fails the closed pattern and reads as dev;
- any other string (unknown label, wrong case, padded, embedded) reads
  as dev: the honest unknown-means-dev rule, never a guess;
- `redact.ts` is not a classifier but the label SET: its
  `environment` metadata format was the same regex
  `/^(dev|staging|alpha-production)$/`, and `diagnosticEventSpec()`
  serializes that regex's `.source` into the spec that
  `infra/observability/events.json` mirrors (pinned byte-for-byte by
  `tests/i2/schema.test.ts`).

No label was added or removed; no rule changed. The one behavioral
definition R13 adds is for inputs the typed seams cannot produce: a
non-string value now deterministically reads as dev (previously
unreachable; `regex.test` would have coerced). Classification never
throws.

## 2. The canonical helper and the four migrations

New module `packages/runtime/src/deployment.ts` (barrel-exported from
`packages/runtime/src/index.ts` beside the other shared rules):

- `DEPLOYMENT_ENVIRONMENT_LABELS`: the closed list, `as const`, the one
  definition of the vocabulary;
- `DeploymentEnvironmentLabel`: the label union;
- `DEPLOYMENT_ENVIRONMENT_PATTERN`: the validation pattern DERIVED from
  the list (`new RegExp(\`^(\${labels.join("|")})$\`)`), so the
  validation side can never drift from the classification side. Its
  `.source` is byte-identical to the accepted regex
  `^(dev|staging|alpha-production)$` (pinned by test and by the untouched
  i2 events.json mirror). One shared instance; no user passes the `g`
  flag, so `.test` carries no state;
- `deploymentEnvironment(env)`: the classifier; `typeof env !== "string"`
  (covers absent and null) reads as dev.

Call sites, before to after:

1. `convex/operations/telemetry/cron.ts:44` (classification):

   before:
   ```ts
   const rawEnvironment = process.env.KIERO_ENVIRONMENT ?? "dev";
   const environment = /^(dev|staging|alpha-production)$/.test(rawEnvironment)
     ? rawEnvironment
     : "dev";
   ```
   after:
   ```ts
   const environment = deploymentEnvironment(process.env.KIERO_ENVIRONMENT);
   ```

2. `convex/operations/backups/http.ts:99` (classification): the same
   three-line read in the complete handler, replaced by the same
   one-line call; the surrounding "the deployment knows its own
   environment" comment is preserved (extended to name the shared rule).

3. `convex/operations/telemetry/redact.ts:117` (the label set): the
   private regex twin `environment: /^(dev|staging|alpha-production)$/`
   became `environment: DEPLOYMENT_ENVIRONMENT_PATTERN` (the shared
   object itself, not a rebuilt twin). The module header's purity claim
   was updated to stay truthful: the module still imports no Convex or
   Node APIs directly; its single import is the shared pattern from
   `@kiero/runtime` (itself Convex-free and pure). Transitive Effect
   reaches this module's graph through the runtime barrel, which both
   existing consumers (the Convex bundle and the gateway Worker, via
   `apps/gateway/src/telemetry/emit.ts` and the Worker's own many
   `@kiero/runtime` imports) already bundle.

4. `convex/calendar/connection/return.ts` (the R10 resolver in its R12
   shared home): the same three-line read, replaced by
   `deploymentEnvironment(env.KIERO_ENVIRONMENT)`. The module stays
   pure (no Convex imports; `@kiero/runtime` is Convex-free), so both
   callback surfaces keep importing it.

After the migration a repo-wide search finds the
`dev|staging|alpha-production` regex in exactly one runtime place: the
derived pattern constructor in `deployment.ts`.

## 3. Test strategy: the matrix and the routing proofs

`tests/g6/deployment-environment.test.ts` (the helper):

- the full classification matrix: each accepted label, absent, empty,
  unknown (`production`, `prod`, `qa`, `alpha`, `internal`, `dev-eu`),
  wrong case (`Dev`, `DEV`, `Staging`), padded (` dev`, `dev `),
  embedded (`staging;dev`, `alpha-production1`, `alpha_prod`,
  `https://dev`), plus explicit `null` and wrong types (`42`, `true`,
  `{}`, `[]`, a symbol; every wrong type reads as dev, nothing throws);
- the label list is exactly `["dev", "staging", "alpha-production"]` in
  that order;
- the derived pattern's `.source` is the exact accepted string
  `^(dev|staging|alpha-production)$`, flags empty;
- the pattern is anchored both ends (no partial matches);
- classification equals label-set membership for the whole matrix.

`tests/g6/environment-call-sites.test.ts` (the four call sites), each
driven through its REAL seam with an 8-row shared matrix, asserting the
module's observable classification equals the helper's answer, plus a
pass-through spy over the `@kiero/runtime` barrel asserting the call
site actually invoked the shared helper with the exact server-side input
(routing, not just today's equivalence):

- cron: `cronTick`'s `internalAction` `_handler` seam with a stub action
  context dispatched by function name (the `tests/g1` pattern, via
  `getFunctionName`), generated Axiom token/dataset fixtures so the REAL
  `axiomHttpSink` is built, and a stubbed global `fetch` capturing the
  ingest payload. One unforwarded row without its own environment, so
  the payload's `environment` is exactly the cron's classification.
  Observed label asserted per matrix row.
- backups: `backupsCompleteHandler`'s `httpAction` `_handler` seam with
  a generated `KIERO_SERVICE_TOKEN` (digest-verified like production)
  and a stub context recording `recordCostEntry` calls. All three cost
  entries (export/storage/egress) must carry the helper's label.
- redact: `METADATA_KEY_FORMATS.environment` IS the shared pattern
  object (identity), and `sanitizeDiagnosticEvent` keeps an environment
  value (both the metadata entry and the event-level field) exactly when
  the shared rule admits it; otherwise the value is redacted.
- resolver: `calendarAppReturnHref` allows a plain-http return origin
  exactly when the helper classifies the environment as dev (the
  security property that motivated R13), keeps https valid for every
  row, and calls the helper with the resolver's env input.

Mutation drill (preserved verification, not a defect): with `cron.ts`
temporarily reverted to an inline drifted copy
(`/^(dev|staging|prod)$/`), the cron routing tests failed on both
layers: the spy reported zero helper calls, and the payload rows
diverged. The drill was reverted; `cron.ts` is the migrated version in
this worktree.

## 4. Commands and results

Executed in the worktree root, 2026-09-14:

- `rtk npm ci`:
  `added packages, audited; found 0 vulnerabilities` (clean install).
- `rtk npm run typecheck` (root project plus every workspace, including
  `packages/runtime` and the new test files):
  exits 0, no diagnostics.
- `rtk npx vitest run tests/g6`:
  `Test Files 2 passed (2)`, `Tests 73 passed (73)`.
- Focused suites for the touched modules
  (`tests/h1`, `tests/i5`, `tests/g6`,
  `tests/g1/callback-return.test.ts`,
  `tests/g1/gateway-callback-return.test.ts`, `tests/i2` for the
  redaction mirror):
  `Test Files 17 passed (17)`, `Tests 289 passed (289)`.
- Full deterministic suite (`rtk npm test`):
  `Test Files 177 passed | 1 skipped (178)`,
  `Tests 2482 passed | 5 skipped (2487)`.

## 5. Notes, boundaries and prerequisites

- The gateway adapter `apps/gateway/src/calendar-oauth/routes.ts`
  (R12's `gatewayReturnHref`) was read as instructed: it does NOT
  duplicate label logic; it maps the Worker's `ENVIRONMENT` binding onto
  the resolver's `KIERO_ENVIRONMENT` contract key and delegates the
  classification entirely to the shared resolver, which now routes
  through the helper. No edit needed (and none allowed there).
- `tests/g1/gateway-callback-return.test.ts` (R12's file) was run but
  not edited, as ruled; it stayed green.
- `infra/release/*.mjs` and `tests/i7/*` also mention
  `KIERO_ENVIRONMENT` (R9's target verification treats the label as a
  deployment descriptor, not a classification rule). Outside R13
  ownership; read, not edited. No prerequisite proposed: those reads are
  release-descriptor consumers, not copies of the closed-label
  classification.
- No failed attempts to preserve: the implementation and all suites
  passed on the first run; the only intentional failure is the mutation
  drill recorded in section 3.
