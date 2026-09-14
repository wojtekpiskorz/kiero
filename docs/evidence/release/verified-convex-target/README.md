# Verified Convex target evidence (R9 #168)

Status date: 2026-09-14. Worktree `r9-verify-target` from `main` at
`3304fdc8b7f3774493a75a90185810a2a5905715` (uncommitted changes; the
coordinator owns the Git lifecycle). This document records how the
credential-selected Convex target was investigated and gated before
mutation, with every command reproducible from a clean checkout
(`rtk npm ci`, then the commands below).

R15 addendum (2026-09-14): the first real staging release exposed a parser
defect under non-TTY CI; [section 10](#10-repair-record-the-non-tty-ci-spinner-line-r15-192-2026-09-14)
is the dated repair record, and it extends this document without rewriting
the R9 observations below.

No mutating deploy command ran anywhere in this work, and no credential
value was read, printed or written. The only Convex CLI invocations
against the live account were READ-ONLY (`--help`, `env list --names-only`,
`logs`, `function-spec`, and `deploy --dry-run`, which the pinned CLI
documents as "Print out the generated configuration without deploying to
your Convex deployment"); their captured outputs contain identity fields
only (slugs, references, URLs, types). The staging deployment's function
list was verified EMPTY before and after every probe (`function-spec`).

## 1. The defect under repair

The R6 Convex transport deployed with `CONVEX_DEPLOY_KEY` but recorded the
caller-provided `CONVEX_DEPLOYMENT` label as the remote identity
(`infra/release/transports/convex-deploy.mjs` before this issue). The
scratch reproduction
(`/tmp/opencode/kiero-release-probe/verify-target-report.mjs`, not a
committed dependency) demonstrated false target evidence with a local fake
`npx`. Reproduced against THIS worktree before the fix
(`/tmp/opencode/kiero-release-probe/r9-repro-before.mjs`, same fake-npx
boundary):

```json
{
  "defectStillPresent": true,
  "providerReportedUrl": "https://different-proof-target.convex.cloud",
  "recordedIdentity": "wojtek-piskorz-jr:kiero-dev-core:staging",
  "observation": "The transport recorded the caller label as identity although the provider announced a different deployment."
}
```

After the fix (`/tmp/opencode/kiero-release-probe/r9-repro-after.mjs`),
the same boundary refuses instead:

```json
{
  "defectFixed": true,
  "refusedWith": "convex deploy targeted a deployment that is not the pinned target (bytes may have landed there): reference: expected \"staging\", observed \"production\"; slug: expected \"fiery-raven-417\", observed \"different-proof-target\"; url: expected \"https://fiery-raven-417.eu-west-1.convex.cloud\", observed \"https://different-proof-target.convex.cloud\"; isDefault: expected false, observed true",
  "observation": "The transport refused to record identity for a provider-announced deployment that is not the pinned target."
}
```

## 2. The pinned CLI's identity surface (read-only probes, CLI 1.45.0)

All probes ran from the worktree root with the logged-in CLI
(`node_modules/convex/bin/main.js`, the same package `npx --yes
convex@1.45.0` resolves). `rtk` prefixes and long paths omitted for
readability; full outputs are paraphrased field-by-field below (identity
fields only).

| # | Probe | Command shape | Result (non-secret identity fields) |
| --- | --- | --- | --- |
| P1 | Flag surface | `convex deploy --help`, `convex env --help`, `convex env list --help`, `convex logs --help`, `convex function-spec --help`, `convex deployment --help` | `deploy` has `--dry-run`, `--typecheck`, `--codegen`, `--env-file`, and NO `--deployment` flag; `env`/`logs`/`function-spec` have `--deployment` accepting `team:project:reference`; `env list --names-only` exists |
| P2 | Names-only env read | `convex env list --names-only --deployment wojtek-piskorz-jr:kiero-dev-core:staging` | exit 0; stdout lists variable NAMES alphabetically; stderr EMPTY: no identity announcement at all |
| P3 | Announcement shape | `convex logs --history 1 --deployment wojtek-piskorz-jr:kiero-dev-core:staging` (killed by a 60 s timeout) | stderr carries the identity block; `logs` never self-terminates (infinite tail loop in the CLI source), so it cannot gate a release |
| P4 | Full-reference deploy selection | `CONVEX_DEPLOYMENT=wojtek-piskorz-jr:kiero-dev-core:staging convex deploy --dry-run --typecheck disable --codegen disable` | exit 1: `✖ Error fetching GET https://api.convex.dev/api/deployment/staging/team_and_project 400 Bad Request: InvalidDeploymentName: Couldn't parse deployment name staging` ; the env path reads the reference TAIL as a deployment NAME |
| P5 | Type-prefixed label | `CONVEX_DEPLOYMENT=prod:fiery-raven-417 … deploy --dry-run …` | the CLI announced and would push to the PROJECT'S DEFAULT PRODUCTION deployment: `▌ [Production] wojtek-piskorz-jr:kiero-dev-core:production (prod) … wary-coyote-511 … https://wary-coyote-511.convex.cloud`, noting `fiery-raven-417 (set in CONVEX_DEPLOYMENT)`; aborted at the non-interactive push confirmation (exit 1), `--dry-run` regardless |
| P6 | Bare-slug label | `CONVEX_DEPLOYMENT=fiery-raven-417 … deploy --dry-run …` | identical to P5: target = default production `wary-coyote-511`; the label is only a notice |
| P7 | Invalid key | `CONVEX_DEPLOY_KEY='prod:definitely-fake-000000|deadbeef-not-a-real-key' CONVEX_DEPLOYMENT=<staging ref> … deploy --dry-run …` | exit 1: `✖ Error fetching POST https://api.convex.dev/api/deployment/url_for_key 401 Unauthorized: AuthenticationFailed: Invalid Convex deploy key` ; the KEY branch runs (label ignored) and the provider resolves the URL through `deployment/url_for_key` |
| P8 | Mutation guard | `convex function-spec --deployment <staging ref>` before and after every probe | `{"url": "https://fiery-raven-417.eu-west-1.convex.cloud", "functions": []}` both times: staging held ZERO functions before and after all probes; `git status` stayed clean (probes used `--codegen disable`) |
| P9 | CLI source reading | `node_modules/convex/dist/cli.bundle.cjs` | selection order, key decoding and announcement rendering pinned exactly (below) |

### 2.1 Selection semantics of `convex deploy` (CLI 1.45.0)

From `getDeploymentSelectionFromEnv` (P9): the deploy key is read FIRST
(`CONVEX_DEPLOY_KEY` or `CONVEX_DEPLOYMENT_TOKEN`);

- `preview:<team>:<project>|…` → a branch/`--preview-name`-named preview
  deployment (`deployToNewPreviewDeployment`; under `--dry-run` it logs
  "Would have claimed preview deployment" and does NOT call
  `claim_preview_deployment`);
- `project:…|…` → a within-project selection (not deployment-pinned);
- anything else with a `|` separator → a DEPLOYMENT-SCOPED key: the slug is
  decoded from the key prefix, the URL comes from the provider
  (`POST deployment/url_for_key`) and team/project/reference/default-ness
  from `POST deployment/team_and_project_for_key`. `CONVEX_DEPLOYMENT` is
  NOT consulted at all on this path;
- no `|` separator → the CLI crashes ("Please set CONVEX_DEPLOY_KEY to a
  new key"); the CI placeholders `<ignore_deploy_key>` /
  `<missing_deploy_key:…>` are special-cased by the CLI to mean "no key",
  which would silently fall back to the label path below.

Only then `CONVEX_DEPLOYMENT` (or `--env-file`) is consulted, and for
`deploy` it selects THE PROJECT'S DEFAULT PRODUCTION DEPLOYMENT whatever
the value: full references fail (`InvalidDeploymentName`, P4); bare or
`<type>:`-prefixed slugs resolve to the default production deployment with
the value reduced to a notice (P5, P6). This is the documented help text:
"If the CONVEX_DEPLOYMENT environment variable is set (typical during
local development), the target is the project's default production
deployment."

### 2.2 The announcement: fields the provider does and does not expose

`deploy` (and `dev`/`logs`) print the credential-resolved identity before
doing anything else (`announceDeploymentTarget`). Non-TTY shape (P3/P5):

```
▌ Deploying code to deployment:
▌ [Production] wojtek-piskorz-jr:kiero-dev-core:staging (dashboard: https://dashboard.convex.dev/t/wojtek-piskorz-jr/kiero-dev-core/fiery-raven-417)
▌ └─ https://fiery-raven-417.eu-west-1.convex.cloud
```

| Field | Exposed? | Where |
| --- | --- | --- |
| Deployment type | yes | the `[Production]` tag (`prod`; also `Development`/`dev`, `Preview`/`preview`, `Custom`, `Local`) |
| Team slug | yes | `team:project:reference` in the reference line |
| Project slug | yes | reference line |
| Reference | yes | reference line |
| Default-ness | yes | the `(prod)`/`(dev)` alias suffix appears IFF the deployment is the project default; non-default prints none (staging: none) |
| Deployment slug | yes | URL host first label; also the dashboard URL's last path segment |
| Deployment URL | yes | the `└─` line |
| Region | DERIVED only | the URL host's second label (`eu-west-1`); the legacy default production URL has NO region segment (observed `wary-coyote-511.convex.cloud`, region null). The platform region identifier (`aws-eu-west-1`, per the issue's pin wording) is not returned by any probed surface; the gate pins the region through the full URL instead |
| Cloud account id / project uuid / deployment uuid / created-at | NO | not exposed by any read-only command probed |

`env list --names-only` authenticates the credential but prints variable
names only (P2), no identity. `logs` announces but never terminates (P3).
The one terminating read-only command that resolves and prints the
credential-selected identity is therefore `deploy --dry-run`.

## 3. Design of the gate (where it sits)

```
release.yml job
  └─ verify-target.mjs        (structure/label/descriptor guards, unchanged)
  └─ verify-checks.mjs        (exact-SHA Checks gate, unchanged)
  └─ deploy-component.mjs     (checked adapter)
       ├─ unauthorized-environment / checks-refused / missing-configuration  (unchanged, before everything)
       ├─ NEW: verify-convex-target.mjs  (R9 pre-mutation gate, convex-deploy components only)
       │    1. descriptor pin present?        else refuse expected-identity-unpinned   (no command spawned)
       │    2. CONVEX_DEPLOY_KEY present?     else refuse missing-credential           (no command spawned)
       │    3. key prefix is deployment-scoped? else refuse unsupported-credential     (no command spawned)
       │    4. spawn `npx --yes convex@1.45.0 deploy --dry-run --typecheck disable
       │       --codegen disable` (read-only probe; codegen off so the probe cannot
       │       mutate the checked-out tree)
       │    5. parse the announcement          else refuse identity-lookup-failed      (sanitized tail only)
       │    6. compare with the pinned identity else refuse identity-mismatch         (observed vs expected, names only)
       └─ build → digest → transports/convex-deploy.mjs
            └─ runs the REAL `convex deploy`, re-parses its own announcement,
               refuses on mismatch (defense in depth), returns the
               PROVIDER-OBSERVED identity as remoteIdentity
```

- The refusal detail is names-only everywhere; probe output reaches
  evidence only through `sanitizeConvexOutput`, which drops every line
  containing a secret-bearing environment VALUE (compared, never printed)
  and bounds the tail.
- `CONVEX_DEPLOYMENT` is still required BY NAME (declared intent) but is
  never identity: with a deployment-scoped key the CLI ignores it entirely
  (2.1), which is exactly why the label could previously mint false
  evidence.
- The staging descriptor pins
  `fiery-raven-417 / wojtek-piskorz-jr:kiero-dev-core:staging / prod /
  non-default / https://fiery-raven-417.eu-west-1.convex.cloud`
  (AC2). The production descriptor intentionally ships UNPINNED (the alpha
  Convex deployment does not exist yet): its Convex component now honestly
  blocks `target-verification-failed` (`expected-identity-unpinned`)
  instead of attempting a reference-only deploy, and it requires
  `CONVEX_DEPLOY_KEY` by name like staging.

## 4. The refusal matrix (deterministic proof)

`tests/i7/verify-convex-target.test.ts` (24 tests) drives the gate and the
adapter through a PATH-shim `npx` that replays the recorded provider
responses (`tests/i7/fixtures/convex-identity/`) and records EVERY
invocation. The recording boundary is the acceptance proof: a mutating
deploy is an argv containing `deploy` without `--dry-run`.

| Scenario | Recorded fixture / input | Refusal code | Mutating deploy commands |
| --- | --- | --- | --- |
| Wrong key target (credential resolves the project's default production) | `default-production-announcement.txt` (the real P5 capture) | `identity-mismatch` (observed `production`/`wary-coyote-511`/default vs pinned staging) | ZERO (only the probe ran) |
| Missing identity (probe completes with no announcement) | `no-announcement.txt` (P2 shape) | `identity-lookup-failed` ("without a deployment announcement") | ZERO |
| Lookup failure (invalid key) | `invalid-key-401.txt` (the real P7 capture), probe exit 1 | `identity-lookup-failed` (`probeExitCode: 1`, sanitized tail names the 401) | ZERO |
| Unsupported key type | `project:…|…` and `preview:…|…` fixture keys | `unsupported-credential` | ZERO, no command spawned at all |
| Missing credential | no `CONVEX_DEPLOY_KEY` | `missing-credential` | ZERO, no command spawned |
| Unpinned identity | descriptor without `expectedIdentity` | `expected-identity-unpinned` | ZERO, no command spawned |
| Success | `staging-announcement.txt` (the real P3 capture, staging) | pass | the probe, then EXACTLY ONE deploy; outcome `deployed` with the provider-observed identity (`slug fiery-raven-417`, `identitySource: "provider-observed"`) |
| Post-deploy divergence (defense in depth) | probe = staging, deploy output = default production | `transport-failed` ("not the pinned target") | one (honest: the transport caught a wrong landing after the fact) |

Adapter-level rows prove the ordering: the refusal is recorded as
`target-verification-failed` in the ledger BEFORE any build or transport
step, `exact-SHA Checks` and environment guards unchanged (the existing
i7 suite still passes untouched semantics). Additional unit rows pin the
local key-prefix classifier (deployment/preview/project/unparseable,
including the CI placeholders), the announcement parser (incl. ANSI/OSC8
stripping and the no-region legacy URL), the field-difference wording, the
closed refusal-code inventory, the committed descriptor pins (AC2) and the
workflow's name-only credential mappings.

## 5. Commands and results (all run 2026-09-14)

| # | Check | Command | Result |
| --- | --- | --- | --- |
| C1 | Clean install | `rtk npm ci` | exit 0 |
| C2 | Typecheck (root + workspaces) | `rtk npm run typecheck` | exit 0, no errors |
| C3 | Environment shape (incl. secret-leak heuristic over owned paths) | `rtk npm run verify:environments` | `shape check passed` |
| C4 | Focused deterministic suite | `rtk npx vitest run tests/i7` | 12 files, 174 tests passed (24 new) |
| C5 | Full repository suite | `rtk npm test` | 172 files passed, 1 skipped; 2359 tests passed, 5 skipped; exit 0 |
| C6 | Defect reproduction before the fix | `node /tmp/opencode/kiero-release-probe/r9-repro-before.mjs` | `defectStillPresent: true` (section 1) |
| C7 | Defect refusal after the fix | `node /tmp/opencode/kiero-release-probe/r9-repro-after.mjs` | `defectFixed: true` with the exact observed/expected differences (section 1) |
| C8 | Staging unchanged by all probes | `convex function-spec --deployment wojtek-piskorz-jr:kiero-dev-core:staging` | `functions: []` before and after every probe; worktree clean |

## 6. Failed attempts (preserved)

1. **`convex deploy --deployment <ref>` does not exist.** The first dry-run
   probe attempt failed with `error: unknown option '--deployment'`.
   Correct surface: deploy selects ONLY through the credential/env (2.1);
   the reference-accepting `--deployment` flags belong to `env`, `logs`,
   `function-spec` and friends. This is itself a corrected fact for the
   repo's earlier "verified flag surface" note.
2. **Full-reference `CONVEX_DEPLOYMENT` fails for deploy** (P4,
   `InvalidDeploymentName`), and the type-prefixed and bare-slug forms
   that DO parse select the DEFAULT PRODUCTION deployment (P5, P6). The
   pre-R9 local runbook line ("deploy --env-file setting CONVEX_DEPLOYMENT
   to the staging reference") was therefore not just unverifiable;
   followed literally it reaches the default production deployment. Both
   probe runs aborted at the non-interactive confirmation and were
   `--dry-run` anyway; `function-spec` confirmed nothing landed. The
   guidance is rewritten in `infra/environments/synthetic-staging.md`.
3. **`convex logs` cannot gate.** Chosen first because it announces the
   identity read-only, it turned out to be an infinite tail loop (killed
   at the 60 s timeout, exit 124). The probe moved to
   `deploy --dry-run`, which terminates.
4. **`env list --names-only` has no identity surface.** Verified empty
   stderr on success (P2): it can prove a credential authenticates, but
   not WHICH deployment it addresses, so it cannot anchor the gate alone.
5. **First test run had 7 failures.** The announcement parser picked the
   dashboard URL from the reference line instead of the `└─` deployment
   URL (fixed by selecting the non-dashboard `convex.cloud` line), a
   default-parameter swallowed an explicit `undefined` in the unpinned
   test (switched to an explicit `null`), and one assertion expected a
   difference-string format the comparator never produced. All fixed; 24
   green.

## 7. NOT RUN (by design; I8 owns the release proof)

- **The actual staging deployment.** No real `convex deploy` (without
  `--dry-run`) ran against any deployment. The first real release with the
  real `STAGING_CONVEX_DEPLOY_KEY` belongs to I8 #133 through the Release
  workflow; the gate's live end-to-end success path (probe resolving
  `fiery-raven-417` from the real key) executes there for the first time.
- **A real deploy key in the gate.** No deploy-key value was available or
  used locally; the key-dependent behaviors (precedence, 401 shape) were
  verified through the CLI source (P9), an invalid fabricated key (P7) and
  the recorded fixtures.
- **GitHub `staging` environment provisioning** (`STAGING_CONVEX_DEPLOYMENT`,
  `STAGING_CONVEX_DEPLOY_KEY`, …): unchanged owner/I8 actions; until they
  exist the staging job blocks `missing-configuration` exactly as before
  (R6 P-row semantics).
- **The production (alpha) Convex identity pin**: `kiero-alpha-core` does
  not exist yet; the production descriptor stays unpinned and its Convex
  component will block `target-verification-failed` until the owning
  ticket pins the real identity and provisions
  `PRODUCTION_CONVEX_DEPLOY_KEY` (mapped by name in `release.yml` here).

## 8. Prerequisites outside this issue's owned paths (proposals, not edited)

1. `docs/evidence/staging/README.md` (I8-owned): the runbook's R11 success
   check ("the deployment URL/slug it reports matches that reference") is
   now enforced pre-mutation by the gate; the runbook may reference the
   R9 gate and the pinned descriptor identity instead of a manual glance,
   and its local-deploy guidance (if it repeats the reference-only
   instruction) needs the same correction as synthetic-staging.md got.
2. `infra/bindings/convex-functions.md` (not owned): if it documents the
   CI credential mapping, it should mention that `CONVEX_DEPLOYMENT` is
   intent-only and the key is identity.

## 9. Changed/added files (all uncommitted, owned paths only)

Added: `infra/release/verify-convex-target.mjs`,
`infra/release/verify-convex-target.d.mts`,
`tests/i7/verify-convex-target.test.ts`,
`tests/i7/fixtures/convex-identity/` (4 recorded responses), this
evidence directory.
Modified: `infra/release/deploy-component.mjs`,
`infra/release/target-descriptor.mjs`,
`infra/release/transports/convex-deploy.mjs`,
`infra/release/targets/staging.json`,
`infra/release/targets/production.json`,
`infra/release/README.md`, `.github/workflows/release.yml`,
`infra/environments/synthetic-staging.md`, `tests/i7/deploy-adapter.test.ts`.

No secret value appears in any file, command output, fixture or ledger row
above: fixtures carry fabricated key strings and recorded non-secret
identity blocks; probe tails are sanitized against secret-bearing
environment values before capture.

## 10. Repair record: the non-TTY CI spinner line (R15 #192, 2026-09-14)

Status date: 2026-09-14. Worktree `r15-parser` from `main` at
`f1ac8d45a5f75bc8b6cf17467d0682c8231273a9` (uncommitted changes; the
coordinator owns the Git lifecycle). Owned paths only: the parser in
`infra/release/verify-convex-target.mjs`, the refusal matrix in
`tests/i7/verify-convex-target.test.ts`, the fixtures in
`tests/i7/fixtures/convex-identity/` and this document.

### 10.1 What the live release run proved

The first real staging release ([run 34874172423](https://github.com/wojtekpiskorz/kiero/actions/runs/34874172423),
I8 #133, main `3cf9f6e`, dispatched 2026-09-14T17:20:41Z) passed every gate
and then honestly refused the `convex-functions` leg with
`target-verification-failed` although the credential-selected identity
matched the pinned target on every field except `url`: observed
`https://fiery-raven-417.eu-west-1.convex.cloud...` with the trailing
ellipsis (and `region` parsed null for the same reason) against the pinned
exact URL. Zero mutations ran; `convex function-spec --deployment
wojtek-piskorz-jr:kiero-dev-core:staging` after the run reported
`functions: []`. The refusal was the gate working on bad input; the defect
was that the gate could never PASS in CI against the correct target.

### 10.2 Mechanism (provider CLI 1.45.0 source)

The deploy pipeline starts a progress spinner whose message is
`Deploying to ${url}...` plus ` [dry run]` under `--dry-run`
(`node_modules/convex/src/cli/lib/deploy2.ts:458`). On a TTY that text is
spinner frames and never pollutes captured output, which is why every R9
probe (section 2, all run on a TTY) missed it. In non-TTY CI the spinner
text reaches stderr verbatim AFTER the announcement block, inside
`parseConvexAnnouncement`'s 5-line window below the header, and the pre-fix
URL selection took the LAST window line matching `convex.cloud`: the
spinner line beat the announcement's own `└─ <url>` line and the URL regex
captured the trailing `...`.

### 10.3 The repair

1. Progress lines (the `Deploying to <url>...` shape, with or without the
   ` [dry run]` marker) are dropped from the announcement window before any
   field is selected: a progress line is never an announcement line, for
   the reference line or the URL line.
2. The URL carrier is the announcement's own tree-drawing `└─`/`┌` line; a
   generic URL-bearing line backs it up only when no tree line exists (and
   takes the first match, because the announcement block leads the output
   and trailing lines are more likely noise).
3. Spinner-only output carries no announcement header at all, so it still
   parses to null and the gate still refuses `identity-lookup-failed`
   (missing identity), never minting an observed identity from progress.

Because `infra/release/transports/convex-deploy.mjs` (not edited; outside
this issue's ownership) reuses `parseConvexAnnouncement` for its
defense-in-depth re-parse, the same repair covers the REAL deploy leg,
whose progress line carries no dry-run marker; that marker-less shape is
pinned by a dedicated parser test.

### 10.4 The recorded CI shape (new fixtures)

- `staging-announcement-ci-spinner.txt`: the exact CI stderr shape of run
  34874172423, the recorded staging announcement block followed by the
  spinner line `Deploying to https://fiery-raven-417.eu-west-1.convex.cloud... [dry run]`.
- `spinner-progress-only.txt`: the progress line alone.

Pre-fix selection reproduced on the new fixture locally (names-only check,
no network, no command spawned): the last-match rule picks the spinner line
and the URL regex captures `https://fiery-raven-417.eu-west-1.convex.cloud...`,
exactly the observed false mismatch. Post-fix the same fixture parses to
the announced identity with ZERO differences against the pinned
`PINNED_STAGING_IDENTITY`.

### 10.5 New refusal-matrix rows (all deterministic, same PATH-shim boundary)

| Scenario | Recorded fixture / input | Decision | Mutating deploy commands |
| --- | --- | --- | --- |
| CI stderr: announcement plus spinner line | `staging-announcement-ci-spinner.txt` | parser: announced identity, zero differences vs the pin; gate: `pass` | ZERO (only the probe ran) |
| Real-deploy spinner (no dry-run marker) | CI fixture with the marker stripped | parser: exact `└─` URL and region `eu-west-1` | n/a (parser unit row) |
| Spinner-only output | `spinner-progress-only.txt` | parser `null`; gate refuses `identity-lookup-failed` ("without a deployment announcement") | ZERO |
| Adapter end to end with the CI shape | CI fixture as probe AND deploy output | `deployed`; ledger row records the exact pinned URL (no trailing ellipsis) | the probe, then EXACTLY ONE deploy |

Every pre-existing row and fixture passes unchanged (the recorded R9
captures parse to the same identities as before).

### 10.6 Commands and results (all run 2026-09-14 in this worktree)

| # | Check | Command | Result |
| --- | --- | --- | --- |
| C1 | Clean install | `rtk npm ci` | exit 0 |
| C2 | Typecheck (root + workspaces) | `rtk npm run typecheck` | exit 0, no errors |
| C3 | Focused deterministic suite | `rtk npx vitest run tests/i7` | 12 files, 180 tests passed (6 new; was 174) |
| C4 | Full repository suite | `rtk npm test` | 178 files passed, 1 skipped; 2531 tests passed, 6 skipped; exit 0 |

No secret value appears in this section: the run reference, the CLI source
line and the recorded non-secret identity block are names and URLs only.
