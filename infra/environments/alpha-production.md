# Environment: alpha production (`alpha-production`)

Status: PENDING, NOT PROVISIONED. This descriptor fixes the identity,
naming and EU contract the future alpha must follow. Nothing here has been
created; per the issue rules, purchases, OAuth consent screens, domains and
production services stay explicit pending actions. The R6 release adapter
consumes the same names through
`infra/release/targets/production.json` and records a BLOCKED outcome
(naming the missing configuration) until they exist; the workflow's
`environment: alpha-production` key is a NAME and is not evidence that
GitHub protection is configured (live repository state, owner/I8 action).

OWNER DECISION REQUIRED BEFORE PROVISIONING (I8 note, 2026-09-12): the
provisioning commands below still prescribe creating a NEW Convex project
`kiero-alpha-core`, while the owner's 2026-09 instruction ("no new Convex
projects, ever") was issued against quota escaping. Whether the real alpha
environment counts as a sanctioned exception (it is the product target, not
a quota workaround) or must reuse a deployment under `kiero-dev-core` is an
explicit owner decision at alpha provisioning time; I8 changed only the
staging topology and leaves this identity untouched.

## Identity

| Aspect | Value |
| --- | --- |
| Environment name | `alpha-production` |
| Convex team | `wojtek-piskorz-jr` |
| Convex project | `kiero-alpha-core` (PENDING creation) |
| Convex deployment | default production deployment, region `eu` (PENDING) |
| Cloudflare account | same account as dev unless the owner mandates separation before alpha; decide at provisioning |
| Cloudflare resource prefix | `kiero-alpha-` |

## Non-secret variable schema (names + purpose)

Same schema as [local](local.md) with production values:
`CONVEX_URL`, `CONVEX_SITE_URL`, `VITE_CONVEX_URL`,
`ENVIRONMENT=alpha-production`, `R2_MEDIA_BUCKET=kiero-alpha-media`,
`R2_BACKUP_BUCKET=kiero-alpha-backup`. Client and worker builds receive them
through CI environment variables, never through committed files.

## Secret-name inventory (names only)

Identical NAME set to dev/staging (values are production-only and live in
GitHub Actions `alpha-production` environment secrets); the reconciled
inventory is [infra/bindings/](../bindings/README.md), the single namespace
authority (I8): `OPENROUTER_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`,
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, `WEB_PUSH_VAPID_PUBLIC_KEY`/
`WEB_PUSH_VAPID_PRIVATE_KEY`/`WEB_PUSH_VAPID_SUBJECT`, `AXIOM_API_TOKEN`,
`R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY`,
`R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`,
`R2_MEDIA_READ_ACCESS_KEY_ID`, `R2_MEDIA_READ_SECRET_ACCESS_KEY`,
`KIERO_SERVICE_TOKEN`, `KIERO_MEDIA_WORKER_TOKEN`, `KIERO_CALENDAR_TOKEN_KEY`,
`CONVEX_BACKUP_ADMIN_KEY`. (The dead `AUTH_RESEND_KEY` name is removed; the
runtime reads `RESEND_API_KEY`/`RESEND_FROM`.)

## Resource naming convention

`kiero-alpha-<role>`: `kiero-alpha-media`, `kiero-alpha-backup`,
`kiero-alpha-gateway`, `kiero-alpha-media-worker`,
`kiero-alpha-export-worker`, `kiero-alpha-backup-worker`,
`kiero-alpha-web` (the Cloudflare Pages project serving the built PWA
bundle; named by the R6 release adapter's `wrangler-pages` transport),
Convex project `kiero-alpha-core`.

## EU requirements (hard constraints from the accepted architecture)

- Convex production deployment in region `eu` only.
- R2 media/export and the SEPARATE private backup bucket with
  `--jurisdiction eu --location weur`; the backup bucket's token must not
  grant access to the media bucket and vice versa.
- Media/export and backup Containers with `constraints.jurisdiction: "eu"`
  (wrangler >= 4.130 required; pin owned by A3, see the PENDING table in
  docs/evidence/environment/preflight-2026-09.md).
- Alpha data (database, files, backups) stays EU-placed; AI processing outside
  the EU is accepted per the architecture decision; Worker routing is global
  and is not claimed as EU-only compute.

## Command aliases (wrong-environment guardrail)

- Production deploys are triggered explicitly (a manual GitHub Actions
  production trigger per the accepted release flow) or by fully-spelled local
  commands: `wrangler deploy --env alpha-production` in `apps/*` and
  `npx --yes convex@1.45.0 deploy --env-file <alpha-env-file>` with
  `CONVEX_DEPLOYMENT` set to the alpha production deployment.
- No script, alias or CI job in this repository may deploy to alpha without
  naming `alpha-production`; bare commands are dev-only by construction.
- Production secrets are never copied into dev/staging and vice versa.

## Provisioning prerequisites (PENDING, exact future commands)

```
npx --yes convex@1.45.0 project create kiero-alpha-core
npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-alpha-core:main --type prod --region eu --default
wrangler r2 bucket create kiero-alpha-media  --jurisdiction eu --location weur
wrangler r2 bucket create kiero-alpha-backup  --jurisdiction eu --location weur
npx wrangler pages project create kiero-alpha-web --production-branch main
```

GitHub-side owner actions: create the `alpha-production` environment,
configure its protection (required reviewers, an owner action this YAML
cannot perform), set its variable `PRODUCTION_CONVEX_URL` and its secrets
`PRODUCTION_CONVEX_DEPLOYMENT`, `PRODUCTION_CLOUDFLARE_API_TOKEN`,
`PRODUCTION_CLOUDFLARE_ACCOUNT_ID` (plus the `PRODUCTION_<NAME>` runtime
credentials above as provisioning proceeds).

(The `team:project:ref --type ... --region eu --default` shape is the one
VERIFIED for the dev deployment in
[docs/evidence/environment/preflight-2026-09.md](../../docs/evidence/environment/preflight-2026-09.md);
the prod invocation itself is documented, not executed.)

Plus owner-level actions this ticket must not perform: Workers Paid enablement
(containers runtime), custom domain/DNS, Google OAuth consent, Resend domain
verification, Axiom dataset provisioning. Each stays PENDING with its owning
ticket.
