# Environment: synthetic staging (`staging`)

Status: PENDING PROVISIONING. No staging Convex deployment, buckets, workers
or Pages project exist yet; this descriptor is the contract GitHub Actions
uses when it begins deploying synthetic staging (per the accepted release
flow). Nothing in this file was executed against a provider. The R6
release adapter consumes the same names through
`infra/release/targets/staging.json` and records a BLOCKED outcome (naming
the missing configuration) until they exist.

This file is the living CONTRACT for staging: it states what must hold
(topology, isolation prohibitions, secret naming) and avoids dated facts.
The dated snapshot of how those rules were checked, plus the release
runbook and the current release-workflow credential mapping status, live in
[docs/evidence/staging/README.md](../../docs/evidence/staging/README.md).

Topology reconciliation (I8, 2026-09-12): an earlier revision of this file
prescribed a new Convex project `kiero-staging-core`. The owner's binding
resource instruction ([#15 checkpoint,
2026-09-12](https://github.com/wojtekpiskorz/kiero/issues/15#issuecomment-5618841487))
forbids creating Convex projects to escape limits and requires every proof
ref to stay under the existing `kiero-dev-core` project. Staging isolation
is therefore achieved with a named deployment inside `kiero-dev-core`, not
a separate project.

## Identity

| Aspect | Value |
| --- | --- |
| Environment name | `staging` (synthetic staging, CI deploy target) |
| Convex team | `wojtek-piskorz-jr` |
| Convex project | `kiero-dev-core` (existing; shared with dev by owner instruction, and no new project may be created) |
| Convex deployment | prod-type deployment with reference `staging`, full selector `wojtek-piskorz-jr:kiero-dev-core:staging`, region `eu`, created without `--default` (PENDING creation) |
| Cloudflare account | same account as dev (see evidence doc for the id) |
| Cloudflare resource prefix | `kiero-staging-` |

The reference `staging` is a valid custom deployment reference (the pinned
CLI's own canonical example is `npx convex deployment create staging --type
prod`); the reserved aliases `dev`, `prod` and `local` must not be reused
(verified in the CLI's new-deployment reference validation). Because the
deployment is created without `--default`, bare `npx convex dev` / `npx
convex deploy` resolve to the project's default dev/production deployments
and cannot address staging implicitly.

## Isolation mechanism (named deployment under `kiero-dev-core`)

Every Convex deployment, whatever its type, is an independently isolated
runtime. Within the single sanctioned project, the `staging` deployment
provides:

| Boundary | Rule |
| --- | --- |
| Data | separate per-deployment database (documents, indexes, schema state) |
| Credentials | separate per-deployment environment variables and auth keys; Convex Auth JWT key material is deployment configuration, and `convex env set` on one deployment never touches another |
| Scheduler | separate per-deployment cron/scheduler queue and durable workflow state |
| Storage | separate per-deployment file storage namespace |
| Project-level env defaults | prohibited: `convex env default` values apply per deployment TYPE, and staging is prod-type, so any prod-type default would silently inject variables into the staging deployment; every staging variable is set per-deployment only, and the prod-type default list must stay empty (runbook R9 success check) |
| Web origin | the staging PWA is served only from `kiero-staging-web.pages.dev`; OAuth redirect URIs are pinned to that origin (see candidate.json) |
| Environment labels | `ENVIRONMENT=staging` / `KIERO_ENVIRONMENT=staging` stamped by workers and functions |
| Fixture authorization | proof/fixture flags and proof override variables must stay unset on the staging deployment; the exact enumerated list is maintained in [infra/bindings/convex-functions.md](../bindings/convex-functions.md), and the qualification user path may not be authorized through fixtures or probes (issue #133 acceptance) |

Contract rules for addressing and authorizing staging:

1. CI deploys to the staging deployment authenticate with a
   deployment-scoped `CONVEX_DEPLOY_KEY`; that key is the authoritative
   target (a deployment deploy key resolves to its own deployment only).
   `CONVEX_DEPLOYMENT` carries the reference
   `wojtek-piskorz-jr:kiero-dev-core:staging`, which the release transport
   records as the staging identity; a run is accepted only when the
   deployment URL/slug it reports matches that reference (runbook R11
   success check).
2. Staging is addressed only through the explicit reference. The deployment
   carries no `--default` flag, so bare `convex dev` / `convex deploy`
   resolve to the project defaults and never to staging.
3. Staging shares the `kiero-dev-core` project plan and usage quota. This
   is the sanctioned alternative to escaping it (owner instruction), not a
   defect. If quota blocks qualification, that is an owner decision; no
   workaround (new project, plan tricks) is permitted.

Dated verification of these rules (CLI source reading, probe commands and
outputs) and the release-workflow credential mapping status with its
follow-up are recorded once in the evidence snapshot
([docs/evidence/staging/README.md](../../docs/evidence/staging/README.md),
runbook R4); this contract links there instead of restating them.

Fallback if the plan refuses a second prod-type deployment: record BLOCKED
with the exact dashboard error. A dev-type lease (`--type dev`, optionally
`--expiration none`) is the documented owner-decision alternative, accepted
only if the owner judges a dev deployment representative enough for
qualification (different operational characteristics: function-log limits
and expiry semantics). It is not substituted silently.

## Non-secret variable schema (names + purpose)

Same schema as [local](local.md) with staging values: `CONVEX_URL`,
`CONVEX_SITE_URL`, `VITE_CONVEX_URL`, `ENVIRONMENT=staging`,
`R2_MEDIA_BUCKET=kiero-staging-media`, `R2_BACKUP_BUCKET=kiero-staging-backup`.
`CONVEX_DEPLOYMENT` is not used locally here; CI passes the deployment
reference explicitly (`wojtek-piskorz-jr:kiero-dev-core:staging`).

## Secret-name inventory (names only)

Per-environment VALUES, injected by CI from GitHub Actions secrets;
suffixless names in the runtimes (reconciled with the actual runtime reads,
see [infra/bindings/](../bindings/README.md)):

`OPENROUTER_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `WEB_PUSH_VAPID_PUBLIC_KEY`,
`WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT`, `AXIOM_API_TOKEN`,
`R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY`,
`R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`,
`R2_MEDIA_READ_ACCESS_KEY_ID`, `R2_MEDIA_READ_SECRET_ACCESS_KEY`,
`KIERO_SERVICE_TOKEN`, `KIERO_MEDIA_WORKER_TOKEN`,
`KIERO_CALENDAR_TOKEN_KEY`, `CONVEX_BACKUP_ADMIN_KEY`.

(`AUTH_RESEND_KEY` from the earlier revision never existed at runtime:
`convex/integrations/email/resend.ts` reads `RESEND_API_KEY` and
`RESEND_FROM`; the inventory now matches the code.)

GitHub Actions secret names for staging follow `STAGING_<NAME>` (for example
`STAGING_OPENROUTER_API_KEY`); only unsuffixed names exist today. The R6
release workflow also references `STAGING_CONVEX_DEPLOYMENT` (the staging
deployment reference, consumed as `CONVEX_DEPLOYMENT`),
`STAGING_CLOUDFLARE_API_TOKEN` and `STAGING_CLOUDFLARE_ACCOUNT_ID` (wrangler
deploy credentials for the Pages web host and the four workers, consumed
under wrangler's own names), and `STAGING_CONVEX_DEPLOY_KEY`
(deployment-scoped Convex deploy key, consumed as `CONVEX_DEPLOY_KEY`; see
the evidence snapshot's runbook R4 for the workflow mapping status). The
non-secret `VITE_CONVEX_URL` build input is mapped from the `staging`
GitHub environment variable `STAGING_CONVEX_URL` (`vars` context), created
at provisioning time.

## Resource naming convention

`kiero-staging-<role>`: `kiero-staging-media`, `kiero-staging-backup`,
`kiero-staging-gateway`, `kiero-staging-media-worker`,
`kiero-staging-export-worker`, `kiero-staging-backup-worker`,
`kiero-staging-web` (the Cloudflare Pages project serving the built PWA
bundle; named by the R6 release adapter's `wrangler-pages` transport),
Convex deployment reference `staging` inside project `kiero-dev-core`.

Workers static assets remain the recorded advisory-review alternative to
Pages for the web host; the descriptor keeps the Pages default until the
owner decides otherwise.

## EU requirements

- Convex deployment created with `--region eu` (Europe, Ireland): the only
  allowed region for any Kiero deployment.
- R2 buckets with `--jurisdiction eu --location weur`.
- Containers with `constraints.jurisdiction: "eu"` (requires wrangler >= 4.130
  pending; owner A3, see docs/evidence/environment/preflight-2026-09.md).

## Command aliases (wrong-environment guardrail)

- Staging deploys are explicit: `wrangler deploy --env staging` inside `apps/*`
  (the `staging` env blocks point only at `kiero-staging-*` names) and
  Convex pushes addressed by the explicit reference
  `wojtek-piskorz-jr:kiero-dev-core:staging`, in CI via the R6 transport
  (`CONVEX_DEPLOYMENT` from `STAGING_CONVEX_DEPLOYMENT` plus
  `CONVEX_DEPLOY_KEY`), locally via
  `npx --yes convex@1.45.0 deploy --env-file <staging-env-file>` where that
  gitignored file sets `CONVEX_DEPLOYMENT` to the staging reference.
  (Verified flag surface: `convex deploy` selects its target via
  `CONVEX_DEPLOYMENT`/`CONVEX_DEPLOY_KEY`/`--env-file`, not via team/project
  flags.) Because staging is inside the project pinned by the root
  `convex.json`, the guard is the reference itself: bare commands resolve to
  the project's default dev/production deployments and never to `staging`;
  do not rely on a bare `convex dev`/`convex deploy` from the repository root.
- CI never reuses dev secrets or dev resource names; the workflow defines
  `environment: staging` with its own secret set.

## Provisioning prerequisites (exact future commands)

No `project create` step: creating Convex projects is prohibited by the
owner instruction. Verify first (owner, dashboard/CLI): existing deployments
under `kiero-dev-core` and their owners, plan headroom for an additional
prod-type deployment, and month-quota state. Inventory stale dev deployments
before any deletion request (owners + evidence first).

```
npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:staging --type prod --region eu
wrangler r2 bucket create kiero-staging-media  --jurisdiction eu --location weur
wrangler r2 bucket create kiero-staging-backup  --jurisdiction eu --location weur
npx wrangler pages project create kiero-staging-web --production-branch main
```

Record the generated deployment slug and `<slug>.eu-west-1.convex.cloud` URL
in the staging evidence. GitHub-side owner actions (exact procedure in
[docs/evidence/staging/README.md](../../docs/evidence/staging/README.md)):
create the `staging` environment, set its variable `STAGING_CONVEX_URL` and
its secrets `STAGING_CONVEX_DEPLOYMENT`, `STAGING_CONVEX_DEPLOY_KEY`,
`STAGING_CLOUDFLARE_API_TOKEN`, `STAGING_CLOUDFLARE_ACCOUNT_ID` (plus the
`STAGING_<NAME>` runtime credentials above as provisioning proceeds).

Owner: I8 #133 (this ticket) defines the contract; the owner/coordinator
executes the authenticated provisioning and the first real staging release
following the recorded runbook. These stay PENDING until then.
