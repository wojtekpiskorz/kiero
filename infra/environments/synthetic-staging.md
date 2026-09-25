# Environment: synthetic staging (`staging`)

Status: PARTIALLY PROVISIONED (re-created 2026-09-22). The staging Convex
deployment
exists: `outgoing-marlin-429` (prod-type, reference `staging`, region
`eu-west-1`, non-default; recreated after the owner deleted the project in
the billing incident — the previous `fiery-raven-417` is gone; see
[docs/evidence/staging/reprovision-2026-09-22.md](../../docs/evidence/staging/reprovision-2026-09-22.md)).
The R2 buckets, workers and the GitHub-side `staging` environment
variables/secrets remain PENDING owner actions. The release adapter
consumes the same names through `infra/release/targets/staging.json` and
records a BLOCKED outcome (naming the missing configuration) until they
exist; the descriptor also pins the deployment's identity, and the
adapter refuses to run any Convex deploy whose credential does not resolve
exactly that identity.

This file is the living CONTRACT for staging: it states what must hold
(topology, isolation prohibitions, secret naming) and avoids dated facts.
The dated snapshot of how those rules were checked, plus the release
runbook and the current release-workflow credential mapping status, live in
[docs/evidence/staging/README.md](../../docs/evidence/staging/README.md).

Topology reconciliation (2026-09-12): an earlier revision of this file
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
| Convex deployment | `outgoing-marlin-429`: prod-type, reference `staging`, full selector `wojtek-piskorz-jr:kiero-dev-core:staging`, URL `https://outgoing-marlin-429.eu-west-1.convex.cloud` (region `eu-west-1`), non-default (created without `--default`; the staging descriptor pins it; recreated 2026-09-22 in the same shape) |
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
| Project-level env defaults | prohibited: `convex env default` values apply per deployment TYPE, and staging is prod-type, so any prod-type default would silently inject variables into the staging deployment; every staging variable is set per-deployment only, and the prod-type default list must stay empty (runbook success check) |
| Web origin | the staging PWA is served only from the Workers Static Assets Worker `kiero-staging-web` at `https://kiero-staging-web.wojtek-524.workers.dev` (owner decision 2026-09-14; no Pages project exists); OAuth redirect URIs are pinned to that origin (see candidate.json) |
| Environment labels | `ENVIRONMENT=staging` / `KIERO_ENVIRONMENT=staging` stamped by workers and functions |
| Fixture authorization | proof/fixture flags and proof override variables must stay unset on the staging deployment; the exact enumerated list is maintained in [infra/bindings/convex-functions.md](../bindings/convex-functions.md), and the qualification user path may not be authorized through fixtures or probes |

Contract rules for addressing and authorizing staging:

1. CI deploys to the staging deployment authenticate with a
   deployment-scoped `CONVEX_DEPLOY_KEY`; that key is the authoritative
   target AND identity (a deployment deploy key resolves to its own
   deployment only, and the pinned CLI ignores `CONVEX_DEPLOYMENT`
   entirely when such a key is set). `CONVEX_DEPLOYMENT` carries the
   reference `wojtek-piskorz-jr:kiero-dev-core:staging` as declared intent
   only, never as evidence. The release transport resolves the
   credential-selected deployment through a read-only probe BEFORE any
   mutating command and accepts the run only when the provider-observed
   type/team/project/reference/slug/URL/default-ness match the identity
   pinned in `infra/release/targets/staging.json` (the runbook success
   check, enforced pre-mutation instead of glanced at post-hoc).
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
runbook); this contract links there instead of restating them.

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
`STAGING_OPENROUTER_API_KEY`); only unsuffixed names exist today. The release
workflow also references `STAGING_CONVEX_DEPLOYMENT` (the staging
deployment reference, consumed as `CONVEX_DEPLOYMENT`),
`STAGING_CLOUDFLARE_API_TOKEN` and `STAGING_CLOUDFLARE_ACCOUNT_ID` (wrangler
deploy credentials for the static-assets web Worker and the four workers,
consumed under wrangler's own names), and `STAGING_CONVEX_DEPLOY_KEY`
(deployment-scoped Convex deploy key, consumed as `CONVEX_DEPLOY_KEY`; see
the evidence snapshot's runbook for the workflow mapping status). The
non-secret build inputs are mapped from `staging` GitHub environment
variables (`vars` context), created at provisioning time: `VITE_CONVEX_URL`
from `STAGING_CONVEX_URL` (the deployment URL) and, 
`VITE_GATEWAY_URL` from `STAGING_GATEWAY_URL` (the staging gateway Worker's
public URL). Both are required by name in the descriptor's `requiredConfig`
before any web transport starts; neither is a credential.

## Resource naming convention

`kiero-staging-<role>`: `kiero-staging-media`, `kiero-staging-backup`,
`kiero-staging-gateway`, `kiero-staging-media-worker`,
`kiero-staging-export-worker`, `kiero-staging-backup-worker`,
`kiero-staging-web` (the Workers Static Assets Worker serving the built
PWA bundle with single-page-application fallback; declared by
`apps/web/wrangler.jsonc` `--env staging` and deployed by the release
adapter's `wrangler-deploy` transport; workers.dev origin
`https://kiero-staging-web.wojtek-524.workers.dev`), Convex deployment
reference `staging` inside project `kiero-dev-core`.

Workers static assets replaced the former Pages web host by the owner's
decision of 2026-09-14 ; the Pages project is not created
and no Pages provisioning step remains for staging.

## EU requirements

- Convex deployment created with `--region eu` (Europe, Ireland): the only
  allowed region for any Kiero deployment.
- R2 buckets with `--jurisdiction eu --location weur`.
- Containers with `constraints.jurisdiction: "eu"` (requires wrangler >= 4.130
  pending; see docs/evidence/environment/preflight-2026-09.md).

## Command aliases (wrong-environment guardrail)

- Staging deploys are explicit: `wrangler deploy --env staging` inside `apps/*`
  (the `staging` env blocks point only at `kiero-staging-*` names) and
  Convex pushes authorized by the deployment-scoped staging deploy key, in
  CI via the release transport (`CONVEX_DEPLOY_KEY` from
  `STAGING_CONVEX_DEPLOY_KEY`, plus the `CONVEX_DEPLOYMENT` intent label).
  Actual pinned-CLI semantics (read-only probes, 2026-09-14; the earlier
  "deploy staging locally by reference" guidance here was wrong and is
  withdrawn):
  - `convex deploy` takes NO `--deployment` flag; its target selection is
    exactly: `CONVEX_DEPLOY_KEY`/`CONVEX_DEPLOYMENT_TOKEN` first, then
    `CONVEX_DEPLOYMENT` (or an `--env-file` setting it), then a
    build-environment error.
  - With a deployment-scoped deploy key the target is the key's own
    deployment and `CONVEX_DEPLOYMENT` is ignored completely.
  - With ONLY `CONVEX_DEPLOYMENT` set, `convex deploy` targets the
    project's DEFAULT PRODUCTION deployment regardless of the value: a
    full reference (`team:project:ref`) fails outright
    (`InvalidDeploymentName: Couldn't parse deployment name staging`), and
    a bare or type-prefixed slug resolves to the default production
    deployment (`wary-coyote-511`) while merely noting the value. A local
    "deploy staging by reference" run can therefore only ever reach the
    default production deployment, never staging.
  - Read-only commands that DO accept the full reference through their own
    `--deployment` flag are safe for local staging inspection:
    `npx --yes convex@1.45.0 env list --names-only --deployment
    wojtek-piskorz-jr:kiero-dev-core:staging` and
    `… function-spec --deployment …` (and `… logs --deployment …`, which
    never terminates on its own). Note `env list --names-only` prints
    variable names only: it authenticates the credential but observes no
    identity.
  - A local deploy of staging is possible ONLY by holding a
    deployment-scoped staging deploy key in the environment
    (`CONVEX_DEPLOY_KEY`); the sanctioned deploy path is the Release
    workflow, whose adapter verifies the key-resolved identity against the
    descriptor pin before any mutation. Because staging is inside the
    project pinned by the root `convex.json`, bare `convex dev`/`convex
    deploy` resolve to the project's default dev/production deployments
    and never to `staging`.
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
```

No web-host provisioning command exists: the `kiero-staging-web` Workers
Static Assets Worker is created by the first `wrangler deploy --env staging`
from `apps/web/wrangler.jsonc` (no Pages project, no dashboard step), and
its workers.dev origin is
`https://kiero-staging-web.wojtek-524.workers.dev`.

Record the generated deployment slug and `<slug>.eu-west-1.convex.cloud` URL
in the staging evidence. GitHub-side owner actions (exact procedure in
[docs/evidence/staging/README.md](../../docs/evidence/staging/README.md)):
create the `staging` environment, set its variables `STAGING_CONVEX_URL`
and `STAGING_GATEWAY_URL` and its secrets `STAGING_CONVEX_DEPLOYMENT`,
`STAGING_CONVEX_DEPLOY_KEY`, `STAGING_CLOUDFLARE_API_TOKEN`,
`STAGING_CLOUDFLARE_ACCOUNT_ID` (plus the `STAGING_<NAME>` runtime
credentials above as provisioning proceeds).

This file defines the contract. Generated runtime values come from
`infra/environments/provision-runtime.mjs`; provider credentials are the
owner's to set.
