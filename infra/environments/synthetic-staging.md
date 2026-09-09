# Environment: synthetic staging (`staging`)

Status: PENDING PROVISIONING. No staging Convex project, buckets or workers
exist yet; this descriptor is the contract GitHub Actions uses when it begins
deploying synthetic staging (per the accepted release flow). Nothing in this
file was executed against a provider.

## Identity

| Aspect | Value |
| --- | --- |
| Environment name | `staging` (synthetic staging, CI deploy target) |
| Convex team | `wojtek-piskorz-jr` |
| Convex project | `kiero-staging-core` (PENDING creation) |
| Convex deployments | prod-type deployment named `staging` inside that project, region `eu` (PENDING) |
| Cloudflare account | same account as dev (see evidence doc for the id) |
| Cloudflare resource prefix | `kiero-staging-` |

## Non-secret variable schema (names + purpose)

Same schema as [local](local.md) with staging values: `CONVEX_URL`,
`CONVEX_SITE_URL`, `VITE_CONVEX_URL`, `ENVIRONMENT=staging`,
`R2_MEDIA_BUCKET=kiero-staging-media`, `R2_BACKUP_BUCKET=kiero-staging-backup`.
`CONVEX_DEPLOYMENT` is not used locally here; CI passes the deployment
reference explicitly.

## Secret-name inventory (names only)

Identical NAME set to dev (per-environment VALUES, injected by CI from GitHub
Actions secrets, suffixless names in the runtimes):

`OPENROUTER_API_KEY`, `AUTH_RESEND_KEY`, `AXIOM_API_TOKEN`,
`R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY`,
`R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`,
`CONVEX_BACKUP_ADMIN_KEY` (candidate name, finalized by I5).

GitHub Actions secret names for staging follow `STAGING_<NAME>` (for example
`STAGING_OPENROUTER_API_KEY`); only unsuffixed names exist today.

## Resource naming convention

`kiero-staging-<role>`: `kiero-staging-media`, `kiero-staging-backup`,
`kiero-staging-gateway`, `kiero-staging-media-worker`,
`kiero-staging-export-worker`, `kiero-staging-backup-worker`,
Convex project `kiero-staging-core`.

## EU requirements

- Convex deployment created with `--region eu` (Europe, Ireland) — the only
  allowed region for any Kiero deployment.
- R2 buckets with `--jurisdiction eu --location weur`.
- Containers with `constraints.jurisdiction: "eu"` (requires wrangler >= 4.130
  pinned by A1).

## Command aliases (wrong-environment guardrail)

- Staging deploys are explicit: `wrangler deploy --env staging` inside `apps/*`
  (the `staging` env blocks point only at `kiero-staging-*` names) and
  `npx --yes convex@1.45.0 deploy --env-file <staging-env-file>` where that
  gitignored file sets `CONVEX_DEPLOYMENT` to the staging deployment name —
  never a bare `convex deploy` from the repo root, which is dev-only by
  `convex.json`. (Verified flag surface: `convex deploy` selects its target
  via `CONVEX_DEPLOYMENT`/`--env-file`, not via team/project flags.)
- CI never reuses dev secrets or dev resource names; the workflow defines
  `environment: staging` with its own secret set.

## Provisioning prerequisites (exact future commands)

```
npx --yes convex@1.45.0 project create kiero-staging-core
npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-staging-core:staging --type prod --region eu
wrangler r2 bucket create kiero-staging-media  --jurisdiction eu --location weur
wrangler r2 bucket create kiero-staging-backup --jurisdiction eu --location weur
```

Owner: the CI/deploy ticket that first wires GitHub Actions (A1 workflow +
first staging deploy), in coordination with I1-recorded facts. These stay
PENDING until that ticket runs them.
