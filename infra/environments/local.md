# Environment: local development (`dev`)

Status: ACTIVE. Convex project provisioned and verified on 2026-09-08
(free plan, reversible); Cloudflare side is read-verified only, resources are
created by their owning tickets on first need. Evidence:
[docs/evidence/environment/preflight-2026-09.md](../../docs/evidence/environment/preflight-2026-09.md).

## Identity

| Aspect | Value |
| --- | --- |
| Environment name | `dev` (local development) |
| Convex team | `wojtek-piskorz-jr` |
| Convex project | `kiero-dev-core` (created, free plan) |
| Convex default dev deployment | reference `dev/main`, name `steady-basilisk-613`, region Europe (Ireland) / `eu-west-1` |
| Cloudflare account | the wrangler-login account (id recorded in the evidence doc, not in code) |
| Cloudflare resource prefix | `kiero-dev-` |

## Non-secret variable schema (names + purpose)

| Name | Scope | Purpose |
| --- | --- | --- |
| `CONVEX_DEPLOYMENT` | local `.env.local` (generated) | Dev deployment name written by `npx convex dev` / `deployment select`; targets all local Convex CLI commands |
| `CONVEX_URL` | local `.env.local` (generated) | Client websocket URL for the dev deployment |
| `CONVEX_SITE_URL` | local `.env.local` (generated) | HTTP actions URL of the dev deployment (consumed by the gateway worker) |
| `VITE_CONVEX_URL` | app client build | Public client URL; alias of `CONVEX_URL` for Vite exposure |
| `ENVIRONMENT` | worker vars | Literal `dev`; workers tag telemetry and logs with it |
| `R2_MEDIA_BUCKET` | worker vars | Literal bucket name (`kiero-dev-media`) the media binding points at |
| `R2_BACKUP_BUCKET` | worker vars | Literal bucket name (`kiero-dev-backup`) for the backup executor |

## Secret-name inventory (names only, values never in the repository)

| Name | Consumed by | Status |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Convex server actions (AI calls) | name present in local `.env` and as GitHub repo secret; Convex env injection PENDING (E2) |
| `AUTH_RESEND_KEY` | Convex Auth custom Email provider | PENDING (B1) |
| `AXIOM_API_TOKEN` | gateway/media/export/backup workers + Convex app events | PENDING (I2) |
| `R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY` | media/export containers (S3 API) | PENDING (D5/D6) |
| `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY` | backup container (S3 API, separate per-bucket token) | PENDING (I5) |
| `CONVEX_BACKUP_ADMIN_KEY` | backup container export step (candidate name, finalized by I5) | PENDING (I5) |
| Web Push VAPID key pair, Google OAuth client secret | gateway / Convex Auth | PENDING (G1/B1); names assigned by their tickets |

## Resource naming convention

`kiero-dev-<role>`: `kiero-dev-media` (R2, eu jurisdiction, weur location),
`kiero-dev-backup` (R2, eu jurisdiction, separate token), workers
`kiero-dev-gateway`, `kiero-dev-media-worker`, `kiero-dev-export-worker`,
`kiero-dev-backup-worker`. The Convex project itself is `kiero-dev-core`.

## EU requirements

- Convex dev deployment in region `eu`: VERIFIED (steady-basilisk-613,
  eu-west-1). All future `kiero-dev-core` deployments are created with
  `--region eu`.
- R2 buckets created with `--jurisdiction eu` and `--location weur`.
- Containers carry `constraints.jurisdiction: "eu"` once wrangler >= 4.130.0
  is pinned (see evidence); until then this stays a documented PENDING.
- Worker execution itself is globally routed; EU-only compute is provided by
  the Container placement, per the accepted architecture.

## Command aliases (wrong-environment guardrail)

Default commands in this repository target `dev` ONLY:

- `npx convex dev` uses root `convex.json` (`kiero-dev-core`); can never
  touch staging/alpha because they are different projects.
- `wrangler deploy` inside `apps/*` uses the top-level env block of each
  `wrangler.jsonc`, whose names all start with `kiero-dev-`.
- Any staging/alpha operation must spell the environment:
  `--env staging` / `--env alpha-production` for wrangler, and explicit
  `team:project:ref` (`wojtek-piskorz-jr:kiero-staging-core:...`) for Convex.
  There is no shared default that resolves to production.

Repository and CI command aliases must preserve this shape (for example
`dev:*`, `deploy:staging:*`, `deploy:alpha:*` with no un-suffixed deploy
alias).

## Prerequisites recorded for downstream tickets

- A3: usable isolated Convex dev access is READY (project + default EU dev
  deployment above; run `npx --yes convex@1.45.0 dev` once in the repo root to
  write `.env.local`).
- D2/D3: create `kiero-dev-media` (free reversible) before first upload proof:
  `wrangler r2 bucket create kiero-dev-media --jurisdiction eu --location weur`.
- I5: create `kiero-dev-backup` plus its dedicated R2 API token.
