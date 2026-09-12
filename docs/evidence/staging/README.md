# Staging qualification environment evidence (I8 #133)

Status date: 2026-09-12. Worktree branch `codex/kiero-i8` from `main` at
`1ffb4dbc3966024270987da22893fb24f02b4df3`. The machine-readable candidate
manifest is [candidate.json](candidate.json); the living contract for
staging (topology, isolation prohibitions, secret naming) is
[infra/environments/synthetic-staging.md](../../../infra/environments/synthetic-staging.md).
This file is the dated snapshot: how the contract rules were checked, the
binding matrix, the runbook and the BLOCKED records.

This session held no cloud credentials. Everything executable without
authenticated cloud access was executed and is recorded below. Every step
requiring authenticated operations (GitHub environment creation, secret
provisioning, Convex/Cloudflare resource creation, the first real Release
run) is an owner/coordinator action recorded as BLOCKED with the exact
procedure, not simulated.

## 1. What changed and why (topology reconciliation)

The superseded staging descriptor prescribed a new Convex project
`kiero-staging-core`. The owner's binding instruction
([#15 checkpoint, 2026-09-12](https://github.com/wojtekpiskorz/kiero/issues/15#issuecomment-5618841487))
prohibits creating Convex projects to escape limits and requires all proof
refs under the existing `kiero-dev-core`. The staging topology is
therefore:

- Convex: a named prod-type deployment with reference `staging`, full
  selector `wojtek-piskorz-jr:kiero-dev-core:staging`, region `eu`, created
  without `--default`. The pinned CLI's own canonical example for exactly
  this shape is `npx convex deployment create staging --type prod`
  (`deployment create --help`, convex 1.45.0, verified 2026-09-12).
- Cloudflare: unchanged `kiero-staging-*` resources; the R6 descriptor
  (`infra/release/targets/staging.json`) keeps its shape, including the
  Pages web host (`kiero-staging-web`). The advisory-review open question
  (Workers static assets as the alternative web host) remains an owner
  decision; nothing was re-architected here.
- GitHub: `staging` environment with `STAGING_`-prefixed secrets (the
  prefix is guard-enforced by `verify-target.mjs` at deploy time).

How the topology rules were checked (CLI 1.45.0 source and probes, all
reproduced in section 4):

1. In CI the deployment-scoped `CONVEX_DEPLOY_KEY` is the authoritative
   target: a deployment deploy key resolves to its own deployment only
   (`getDeploymentSelectionFromEnv` in
   `node_modules/convex/src/cli/lib/deploymentSelection.ts`). The
   `CONVEX_DEPLOYMENT` reference `wojtek-piskorz-jr:kiero-dev-core:staging`
   is a CLI-accepted reference (probe P7) recorded as the transport's
   remote identity, and runbook R11 verifies the deployment URL/slug
   reported by the actual run against that recorded reference.
2. Without `--default`, bare `npx convex dev` / `npx convex deploy` keep
   resolving to the project's default dev/production deployments: staging
   cannot be reached implicitly (CLI selection logic above; the reference
   is the only addressing path).
3. A CI environment without a Convex login token needs a Convex credential
   beyond the reference: `convex deploy` with only `CONVEX_DEPLOYMENT`
   fails `401 Unauthorized: MissingAccessToken` (probe P7). The release
   workflow's current credential mapping and the follow-up it requires are
   recorded once in runbook R4 (section 5).

## 2. Isolation argument (why staging cannot touch dev data)

| Boundary | Mechanism | Evidence |
| --- | --- | --- |
| Convex data | separate per-deployment database | Convex deployments are isolated runtimes (per-deployment database, scheduler, storage, env vars and auth keys); env injection is per-deployment (`infra/bindings/convex-functions.md`) |
| Convex credentials | per-deployment env vars + deploy key; the staging deploy key authorizes only the staging deployment | CLI source: a deployment deploy key resolves to its own deployment only (`getDeploymentSelectionFromEnv`); probe P7 shows reference and credential resolution |
| Project-level env defaults | `convex env default` values apply per deployment TYPE and staging is prod-type, so any prod-type default would silently inject variables into staging; prohibited: every staging variable is per-deployment, and the prod-type default list must be empty | `env default --help` surface verified 2026-09-12; runbook R9 success check enforces emptiness |
| Convex scheduler | per-deployment cron/durable workflow queues | same per-deployment runtime boundary; no cross-deployment jobs exist in the codebase |
| Convex storage | per-deployment file storage namespace | same boundary; retained media addressed through R2 below |
| Media/backup bytes | distinct R2 buckets `kiero-staging-media` / `kiero-staging-backup`, EU jurisdiction, per-bucket scoped tokens (media/export tokens cannot read backup and vice versa; backup holds only a read-only media token) | `infra/bindings/backup-worker.md` isolation rules; `infra/bindings/media-export-workers.md` |
| Workers | `kiero-staging-*` worker names selected only via `--env staging` blocks that point exclusively at staging names | `apps/*/wrangler.jsonc`; bare `wrangler deploy` targets `kiero-dev-*` |
| Web origin / CORS | staging PWA origin `https://kiero-staging-web.pages.dev`; gateway CORS allow-list pinned to exactly that origin | `apps/gateway/wrangler.jsonc` staging `ALLOWED_APP_ORIGINS` |
| Secrets | GitHub `staging` environment secrets with the enforced `STAGING_` prefix; CI does not read dev names | `verify-target.mjs` secret-prefix guard (probe P3) |
| Release authorization | runtime label must equal the descriptor target; exact-SHA Checks success required before any transport | probes P3/P5/P6 |
| Fixture/probe authorization | forbidden on the qualification user path | the exact flag list is enumerated in `infra/bindings/convex-functions.md` and must stay unset on the staging deployment |
| Shared on purpose | project-level plan usage quota | owner instruction: sharing quota inside `kiero-dev-core` is the sanctioned alternative to escaping it. The owner checkpoint of 2026-09-12 recorded month Database I/O at 1.43 GB / 1 GB from dev-proof polling. If quota blocks qualification, that is an explicit owner decision; a new project or plan trick is never the answer |

## 3. Resource/binding matrix (names only; never values)

Legend for Presence (observed 2026-09-12): `code` = name read by the
runtime (verified by grep over `convex/`, `apps/*/src`); `github-repo` =
present as a repository secret (preflight 2026-09 names:
`OPENROUTER_API_KEY`, `ZAI_API_KEY`); `none` = not provisioned anywhere
yet. Observed behavior cites the reading code path.

| Name | Consumer (scope) | Permissions / least privilege | Injection method | Presence | Observed behavior |
| --- | --- | --- | --- | --- | --- |
| `VITE_CONVEX_URL` | web build (`apps/web/src/app/config.ts`) | read-only deployment URL, baked into the bundle | GitHub env var `STAGING_CONVEX_URL` at build | code | client connects to the staging Convex URL; empty refuses |
| `CONVEX_DEPLOYMENT` | `convex deploy` (release transport) | staging deployment reference `wojtek-piskorz-jr:kiero-dev-core:staging` (a name, not a credential; the deployment-scoped `CONVEX_DEPLOY_KEY` is the authoritative CI target, this reference is CLI-accepted and recorded as identity) | GitHub env secret `STAGING_CONVEX_DEPLOYMENT` | code | CLI-accepted reference (probe P7); R11 checks the run's reported deployment URL/slug against it |
| `CONVEX_DEPLOY_KEY` | `convex deploy` (release transport) | deployment-scoped key for the staging deployment only | GitHub env secret `STAGING_CONVEX_DEPLOY_KEY` | code | authenticates CI deploys; absent means `401 MissingAccessToken` (probe P7) |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | wrangler (Pages + 4 workers) | token scoped to the account's Pages/Workers/R2 needs | GitHub env secrets `STAGING_CLOUDFLARE_API_TOKEN` / `STAGING_CLOUDFLARE_ACCOUNT_ID` | code | wrangler's own credential names |
| `OPENROUTER_API_KEY` | Convex actions (chat, vision, STT, embeddings) | model-call budget holder | `convex env set` per deployment | code, github-repo | absent means model routes return unavailable |
| `RESEND_API_KEY` | `convex/integrations/email/resend.ts` | Resend send permission | `convex env set` | code | absent means email sends fail closed (B1/B5 path) |
| `RESEND_FROM` | same | verified sender identity | `convex env set` | code | sender address for OTP/invites |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | `convex/access/identity/authEntry.ts`, `providerAvailability.ts`, calendar connection | Google OAuth client limited to the staging origin's redirect URIs | `convex env set` | code | absent means the Google provider is reported unavailable (honest degradation) |
| `WEB_PUSH_VAPID_PUBLIC_KEY` / `_PRIVATE_KEY` / `_SUBJECT` | `convex/attention/push/functions.ts`, `proofService.ts` | VAPID keypair for push delivery + subscription proofs | `convex env set` | code | absent means push send/verification refuse |
| `AXIOM_API_TOKEN` / `AXIOM_DATASET` | telemetry forwarder (Convex) + gateway/workers | Axiom ingest into `kiero-observability` | `convex env set` / `wrangler secret put` | code | absent means the forwarder falls back / drops redacted events |
| `KIERO_ENVIRONMENT` / `KIERO_DEPLOYMENT_LABEL` / `ENVIRONMENT` | Convex + workers telemetry | non-secret labels | `convex env set` / wrangler `vars` | code | event/snapshot tagging (`staging`) |
| `R2_MEDIA_ACCESS_KEY_ID` + `R2_MEDIA_SECRET_ACCESS_KEY` | media/export containers | R2 token scoped to `kiero-staging-media` only | container env via deploy flow | code | media bytes read/write; cannot see the backup bucket |
| `R2_BACKUP_ACCESS_KEY_ID` + `R2_BACKUP_SECRET_ACCESS_KEY` | backup container | R2 token scoped to `kiero-staging-backup` only | container env | code | backup writes; cannot see the media bucket |
| `R2_MEDIA_READ_ACCESS_KEY_ID` + `R2_MEDIA_READ_SECRET_ACCESS_KEY` | backup container | read-only media token (copy source) | container env | code | backup copies retained media; can never write media |
| `CONVEX_BACKUP_ADMIN_KEY` | backup container (`convex export`) | Convex access token for the staging deployment's documented export | container env | code | drives pinned `convex export` headless |
| `KIERO_SERVICE_TOKEN` | Convex protocol routes + export/backup workers + calendar http | shared service bearer (per environment VALUE) | Convex env + worker secrets | code | bearer-checked on `/operations/*`, `/platform/*` |
| `KIERO_MEDIA_WORKER_TOKEN` / `MEDIA_SEGMENT_TOKEN` | Convex to media executor | bearer for `/probe`, `/segment` | Convex env / `wrangler secret put` | code (SET on dev) | paired reader/writer values |
| `KIERO_CALENDAR_TOKEN_KEY` | calendar credential store | sealing key for stored Google credentials | Convex env | code | seals/unseals calendar credential ciphertext |
| `ALLOWED_APP_ORIGINS` | gateway | CORS allow-list = staging origin only | wrangler `vars` (staging env block) | code (value pinned in config) | unlisted origins get no CORS headers |
| `CONVEX_SITE_URL` | gateway/workers/containers + `convex/auth.config.ts` | staging deployment HTTP actions URL | wrangler `vars` (fill at provisioning) / generated locally | code | current-access checks + auth issuer |
| `KIERO_GM_EMAILS` | `convex/access/gm/functions.ts` | GM operator allow-list (emails) | Convex env | code | GM panel access per allow-list |
| Executor URLs (`KIERO_MEDIA_WORKER_URL`, `KIERO_IMAGES_EXECUTOR_URL`, `KIERO_EXPORT_EXECUTOR_URL`, `KIERO_BACKUP_WORKER_URL`, `KIERO_PURGE_EXECUTOR_URL`, `KIERO_NORMALIZER_URL`) | Convex actions / gateway | staging worker endpoints (non-secret) | Convex env / wrangler `vars` | code | absent means the honest typed `unavailable`, never a fake success |
| `KIERO_CALENDAR_APP_BASE_URL` / `KIERO_CALENDAR_REDIRECT_URI` | calendar projection/connection | staging origin / registered redirect | Convex env | code | copies link back to staging; OAuth redirect pinned |

## 4. Locally proven probes (all executed 2026-09-12)

All commands ran in the I8 worktree at the base revision above. `<HEAD>` =
`1ffb4dbc3966024270987da22893fb24f02b4df3`.

| # | Probe | Command | Expected | Observed | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | descriptor/binding shape | `node infra/environments/shape-check.mjs` | exit 0 | `shape check passed` | PASS |
| P2 | guard accepts the committed target | `KIERO_ENVIRONMENT=staging node infra/release/verify-target.mjs --target staging --workflow .github/workflows/release.yml --descriptor infra/release/targets/staging.json --checks-workflow .github/workflows/checks.yml` | exit 0 | `release target verified: staging` | PASS |
| P3 | wrong-environment label rejected | same with `KIERO_ENVIRONMENT=production` | exit 1 naming the label | `runtime environment label is "production" but the target is "staging"` | PASS |
| P4 | missing-binding refusal (real descriptor, passing checks fixture, empty config env) | `env -i PATH=$PATH KIERO_ENVIRONMENT=staging node infra/release/deploy-component.mjs --descriptor infra/release/targets/staging.json --revision <HEAD> --checks-report <pass fixture> --outcomes ...` | all components blocked `missing-configuration`, exit 1, no transport invoked | web: `VITE_CONVEX_URL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID`; convex-functions: `CONVEX_DEPLOYMENT`; gateway/media/export/backup: `CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID`; exit 1 | PASS |
| P5 | unauthorized environment refusal | same with `KIERO_ENVIRONMENT=dev` | all blocked `unauthorized-environment` | 6x `unauthorized-environment`, exit 1, no transport | PASS |
| P6 | exact-SHA Checks gate | `node infra/release/verify-checks.mjs --descriptor infra/release/targets/staging.json --sha <HEAD> --fixture <success pinned to HEAD~1 141dd0d4...> --out ...` | refuse, exit 1 | `observed on head SHA 141dd0d4486a..., requested 1ffb4dbc3966...` | PASS |
| P7 | CI Convex credential surface | `env -i PATH=$PATH HOME=<isolated empty home> CONVEX_DEPLOYMENT=wojtek-piskorz-jr:kiero-dev-core:staging npx --yes convex@1.45.0 deploy` | reference accepted; unauthenticated refusal before any mutation | `GET .../deployment/staging/team_and_project 401 Unauthorized: MissingAccessToken` | PASS |

P4/P5/P6 used a fixture checks report generated by `verify-checks.mjs
--fixture` (the tool's own sanctioned local-rehearsal input); no GitHub API
was called and no cloud resource was contacted. P7 used an isolated empty
`HOME` so no real credential could be read; the run crashed at credential
resolution, before typecheck/bundle/push, so no mutation was possible.

Reproduction from a clean checkout: `rtk npm ci`, then run the commands
above. P4/P5 consume a passing checks report and P6 a wrong-SHA one; both
are produced by the gate's own fixture mode from these exact one-line
observation files (the only inputs the tools were given; no GitHub API
call, no cloud contact):

`obs-pass.json` (P4/P5; success pinned to `<HEAD>`):

```json
[{ "name": "npm ci, typecheck, test, build (Node 22.22.3)", "status": "completed", "conclusion": "success", "headSha": "1ffb4dbc3966024270987da22893fb24f02b4df3" }]
```

`obs-wrong-sha.json` (P6; success pinned to `<HEAD~1>`):

```json
[{ "name": "npm ci, typecheck, test, build (Node 22.22.3)", "status": "completed", "conclusion": "success", "headSha": "141dd0d4486afe194d751fe2ea7745fa3c8633cd" }]
```

Turn each into a report with
`node infra/release/verify-checks.mjs --descriptor infra/release/targets/staging.json --sha <HEAD> --fixture <obs-file> --out <report.json>`
and pass `--checks-report <report.json>` to `deploy-component.mjs`.

## 5. Owner/coordinator runbook (authenticated actions)

Every action below is outside this session's reach by design. Each row:
destination, exact variable/resource name, successful-check command,
responsible actor. Values are never recorded, only names and observed
behavior.

| # | Action | Exact procedure | Success check | Actor |
| --- | --- | --- | --- | --- |
| R1 | Verify topology headroom | Convex dashboard `kiero-dev-core`: list deployments + owners, confirm an additional prod-type deployment is allowed on the plan; note month-quota state. Inventory stale dev deployments (owners + evidence) before any deletion request | dashboard shows the deployment list; no deletion performed | owner |
| R2 | Create staging deployment | `npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:staging --type prod --region eu` (no `--default`; no `project create`) | CLI reports the created deployment; record slug + `<slug>.eu-west-1.convex.cloud` in candidate.json | owner |
| R3 | Convex deploy key | dashboard > staging deployment > deploy keys: create a deployment-scoped key; store as GitHub `staging` environment secret `STAGING_CONVEX_DEPLOY_KEY` | `gh secret list --repo wojtekpiskorz/kiero -e staging` lists the name | owner |
| R4 | release.yml credential mapping (FOLLOW-UP; the single record of the current workflow gap) | the committed `release.yml` staging job currently maps only `CONVEX_DEPLOYMENT` and lacks the Convex credential probe P7 requires, so the first real release would fail at `convex-functions` with `MissingAccessToken`. Follow-up (R6-owned files): add `CONVEX_DEPLOY_KEY: ${{ secrets.STAGING_CONVEX_DEPLOY_KEY }}` to the `staging-deploy` env block (and the `PRODUCTION_` counterpart when alpha provisions) in `.github/workflows/release.yml`, keeping the `STAGING_` prefix so the guard passes; also add `CONVEX_DEPLOY_KEY` to the `requiredConfig` array of the `convex-functions` component in `infra/release/targets/staging.json` so the adapter blocks a deploy lacking the key by name (both files are R6-owned: note only, not edited by I8) | P2/P3 probes still pass; guard accepts the job; with `requiredConfig` extended, the P4 missing-binding probe names `CONVEX_DEPLOY_KEY` for `convex-functions` | coordinator (R6 lane) |
| R5 | R2 buckets + tokens | `wrangler r2 bucket create kiero-staging-media --jurisdiction eu --location weur`; same for `kiero-staging-backup`; dashboard R2 > Manage API Tokens: media-read/write token, backup token, media read-only token | `wrangler r2 bucket list --jurisdiction eu` shows both names | owner |
| R6 | Pages project | `npx wrangler pages project create kiero-staging-web --production-branch main` | `npx wrangler pages project list` shows the name | owner |
| R7 | GitHub environments | `gh api -X PUT repos/wojtekpiskorz/kiero/environments/staging`; then create `alpha-production` with protection in one call: write `alpha-env.json` containing `{"deployment_branch_policy":{"restricted":true},"reviewers":[{"type":"User","id":<owner-user-id>}]}` (the numeric id from `gh api user --jq .id`) and run `gh api -X PUT repos/wojtekpiskorz/kiero/environments/alpha-production --input alpha-env.json` (the create-or-update-environment endpoint takes `reviewers` and `deployment_branch_policy` in the request body; there is no separate reviewers endpoint to POST to). Configuring production protection does not authorize a production deploy | `gh api repos/wojtekpiskorz/kiero/environments` lists both; `alpha-production` shows the required reviewer and the restricted branch policy | owner |
| R8 | staging env var + secrets | `gh secret set STAGING_CONVEX_DEPLOYMENT -e staging` (value: `wojtek-piskorz-jr:kiero-dev-core:staging`), `STAGING_CONVEX_DEPLOY_KEY`, `STAGING_CLOUDFLARE_API_TOKEN`, `STAGING_CLOUDFLARE_ACCOUNT_ID` from R3/R5 credentials; `gh variable set STAGING_CONVEX_URL -e staging` (value: the staging deployment URL); add `STAGING_<NAME>` runtime secrets as provisioning proceeds (names in candidate.json) | `gh secret list -e staging` and `gh variable list -e staging` show the names | owner |
| R9 | Convex runtime env vars | per name: `npx --yes convex@1.45.0 env set <NAME> --deployment wojtek-piskorz-jr:kiero-dev-core:staging` (values typed interactively / injected by CI); the proof/fixture flags stay unset on staging; do not use `convex env default set` for staging names, because project-level defaults apply per deployment TYPE (staging is prod-type) and would silently inject into the staging deployment | `npx --yes convex@1.45.0 env list --names-only --deployment wojtek-piskorz-jr:kiero-dev-core:staging` shows exactly the intended names and `npx --yes convex@1.45.0 env default list --names-only --type prod` is empty | owner |
| R10 | Fill pinned URLs | set staging `CONVEX_SITE_URL` vars in `apps/*/wrangler.jsonc` staging blocks to the deployment URL; set executor URL vars from the staging worker routes | `wrangler deploy --env staging --dry-run` reflects the vars | coordinator (I8 follow-up commit or release PR) |
| R11 | First real staging release | after R1-R10 and green Checks on the merged revision: dispatch the Release workflow with target `staging` | workflow run: rehearse PASS, verify-target PASS, checks-gate PASS, every component `deployed` with remote identities in `release-evidence-staging` artifact; append run id + identifiers to candidate.json; the Convex deployment slug/URL the run reports must match the recorded reference `wojtek-piskorz-jr:kiero-dev-core:staging` (the deploy key is the authoritative target, so a mismatch is a FAIL, not a release) | owner |

Secret-leak inspection after R11 (verification case): inspect the deployed
client bundle and worker logs for the recorded secret names' values; the
build receives only `VITE_CONVEX_URL` (a URL, not a credential). Any secret
value found in client assets is a FAIL.

## 6. BLOCKED records (issue closure conditions)

| Case | Status | Responsible actor | Next action | Resumption trigger |
| --- | --- | --- | --- | --- |
| Real staging Release run + deployment identifiers | BLOCKED | owner/coordinator | runbook R1-R11 | credentials provisioned; runbook R11 dispatched |
| GitHub `staging` environment + `alpha-production` protection (incl. explicit production approval) | BLOCKED | owner | runbook R7 | owner executes the gh api procedures |
| Convex staging deployment under kiero-dev-core | BLOCKED | owner | runbook R1-R2 | plan headroom verified; deployment created |
| `release.yml` `CONVEX_DEPLOY_KEY` mapping | BLOCKED (file outside I8 owned paths) | coordinator/R6 lane | runbook R4 | follow-up PR merged |
| R2 buckets, Pages project, runtime secret values | BLOCKED | owner | runbook R5/R6/R8/R9 | resources created; names present in stores |
| Wrong-target/revoked-credential/partial-deployment live probes | BLOCKED | owner | after R11, re-run the P3-P6 probe shapes against the live target plus a deliberately revoked token case | staging target exists |
| Smoke test of ordinary authenticated access + real service connectivity | BLOCKED | owner (B5/D7 lanes consume the lease) | sign-in + OpenRouter/email/push legs on staging after R11 | staging release proven |

No quota workaround was attempted or proposed; no Convex project was
created; no production activation occurred; no secret value was written to
any file, command or log in this work.
