# Environment: alpha production (`alpha-production`)

Status: PENDING, NOT PROVISIONED. This descriptor fixes the identity,
naming and EU contract the future alpha must follow. Nothing here has been
created; per the issue rules, purchases, OAuth consent screens, domains and
production services stay explicit pending actions.

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
GitHub Actions `alpha-production` environment secrets): `OPENROUTER_API_KEY`,
`AUTH_RESEND_KEY`, `AXIOM_API_TOKEN`, `R2_MEDIA_ACCESS_KEY_ID`,
`R2_MEDIA_SECRET_ACCESS_KEY`, `R2_BACKUP_ACCESS_KEY_ID`,
`R2_BACKUP_SECRET_ACCESS_KEY`, `CONVEX_BACKUP_ADMIN_KEY` (candidate name,
finalized by I5). Google OAuth and Web Push secret names are added by B1/G4
when those integrations land.

## Resource naming convention

`kiero-alpha-<role>`: `kiero-alpha-media`, `kiero-alpha-backup`,
`kiero-alpha-gateway`, `kiero-alpha-media-worker`,
`kiero-alpha-export-worker`, `kiero-alpha-backup-worker`, Convex project
`kiero-alpha-core`.

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
wrangler r2 bucket create kiero-alpha-backup --jurisdiction eu --location weur
```

(The `team:project:ref --type ... --region eu --default` shape is the one
VERIFIED for the dev deployment in
[docs/evidence/environment/preflight-2026-09.md](../../docs/evidence/environment/preflight-2026-09.md);
the prod invocation itself is documented, not executed.)

Plus owner-level actions this ticket must not perform: Workers Paid enablement
(containers runtime), custom domain/DNS, Google OAuth consent, Resend domain
verification, Axiom dataset provisioning. Each stays PENDING with its owning
ticket.
