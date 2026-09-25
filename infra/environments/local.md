# Environment: local development (`dev`)

Status: ACTIVE. Convex project provisioned and verified on 2026-09-08
(free plan, reversible); RE-PROVISIONED 2026-09-22 after the owner deleted
the project during the billing incident (ADR
docs/adr/mvp-cost-envelope-2026-09.md) — evidence:
[docs/evidence/staging/reprovision-2026-09-22.md](../../docs/evidence/staging/reprovision-2026-09-22.md).
Cloudflare side is read-verified only, resources are
created by their owning tickets on first need. Earlier evidence:
[docs/evidence/environment/preflight-2026-09.md](../../docs/evidence/environment/preflight-2026-09.md).

## Identity

| Aspect | Value |
| --- | --- |
| Environment name | `dev` (local development) |
| Convex team | `wojtek-piskorz-jr` |
| Convex project | `kiero-dev-core` (created, free plan) |
| Convex dev deployment | reference `dev/main`, name `glorious-hawk-339`, region Europe (Ireland) / `eu-west-1`, non-default; local `.env.local` selects it via `deployment select` (recreated 2026-09-22) |
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
| `OPENROUTER_API_KEY` | Convex server actions (AI calls) | name present in local `.env` and as GitHub repo secret; Convex env injection PENDING |
| `DEEPSEEK_API_KEY` | Convex server actions (AI chat/vision calls: the e8.0 direct DeepSeek primary route) | name verified in the Convex `staging` deployment and the GitHub `staging` environment (live smoke, 2026-09-14; names only); local `.env` and dev-deployment injection PENDING (see infra/environments/provision-runtime.mjs) |
| `RESEND_API_KEY`, `RESEND_FROM` | Convex email integration (`convex/integrations/email/resend.ts`) | PENDING; replaces the dead `AUTH_RESEND_KEY` name |
| `AXIOM_API_TOKEN` | gateway/media/export/backup workers + Convex app events | PENDING |
| `R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY` | media/export containers (S3 API) | PENDING |
| `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY` | backup container (S3 API, separate per-bucket token) | PENDING |
| `CONVEX_BACKUP_ADMIN_KEY` | backup container export step (candidate name, finalized) | PENDING |
| `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, `WEB_PUSH_VAPID_PUBLIC_KEY`/`_PRIVATE_KEY`/`_SUBJECT` | Convex access + calendar connection; Convex push delivery | PENDING |

The per-runtime consumer table for every name (including service tokens and
executor URLs) is [infra/bindings/](../bindings/README.md), the single
namespace authority reconciled with the runtime reads; rows here are
the dev-environment subset only.

## Resource naming convention

`kiero-dev-<role>`: `kiero-dev-media` (R2, eu jurisdiction, weur location),
`kiero-dev-backup` (R2, eu jurisdiction, separate token), workers
`kiero-dev-gateway`, `kiero-dev-media-worker`, `kiero-dev-export-worker`,
`kiero-dev-backup-worker`, and the static-assets web Worker
`kiero-dev-web` (the local PWA host: Vite's `dist/` output with
single-page-application fallback, no main, no bindings, no Container).
The Convex project itself is `kiero-dev-core`.

Dev leases stay separate from the web Worker: the single Convex dev
deployment under `kiero-dev-core` is the recreated `dev/main`
(`glorious-hawk-339`; the pre-teardown leases `steady-basilisk-613`,
`flippant-lemur-146`, `nautical-loris-352` and the stray US
`first-gerbil-326` died with the 2026-09-22 project re-provisioning), and the web
static-assets Worker owns none of them and no gateway resource; it only
consumes the public URLs baked into the bundle at build time.

## EU requirements

- Convex dev deployment in region `eu`: VERIFIED (glorious-hawk-339,
  eu-west-1). All future `kiero-dev-core` deployments are created with
  `--region eu`.
- R2 buckets created with `--jurisdiction eu` and `--location weur`.
- Containers carry `constraints.jurisdiction: "eu"` once wrangler >= 4.130.0
  is pinned (see evidence); until then this stays a documented PENDING.
- Worker execution itself is globally routed; EU-only compute is provided by
  the Container placement, per the accepted architecture.

## Command aliases (wrong-environment guardrail)

Default commands in this repository target `dev` ONLY:

- `npx convex dev` uses root `convex.json` (`kiero-dev-core`) and resolves
  through the local `.env.local` `CONVEX_DEPLOYMENT` selection (written by
  `npx convex deployment select glorious-hawk-339`; since the 2026-09-22
  re-provisioning the project has NO default dev/production deployment —
  the CLI's personal-dev-alias slot is deliberately left vacant because the
  CLI auto-provisions it in a non-EU region). It can never touch staging,
  because
  staging is a named deployment created without `--default`
  (`wojtek-piskorz-jr:kiero-dev-core:staging`) inside the same project,
  reachable only through that explicit reference (staging reconciliation with the
  owner's no-new-projects instruction). A bare `npx convex deploy` likewise
  resolves to the project's default production deployment if one exists, a
  dev-scope resource, never the `staging` reference and never alpha.
- `wrangler deploy` inside `apps/*` uses the top-level env block of each
  `wrangler.jsonc`, whose names all start with `kiero-dev-`; in `apps/web`
  that bare command (and `wrangler dev`, which serves `dist/` with the
  single-page-application fallback on localhost) targets `kiero-dev-web`
  only, purely local.
- Any staging/alpha operation must spell the environment:
  `--env staging` / `--env alpha-production` for wrangler, and for Convex the
  explicit reference `wojtek-piskorz-jr:kiero-dev-core:staging` (staging) or
  the separate-project `team:project:ref` / `--prod` addressing that alpha
  provisioning will decide (see the owner-decision note in
  [alpha-production.md](alpha-production.md)).
  There is no shared default that resolves to staging or production.

Repository and CI command aliases must preserve this shape (for example
`dev:*`, `deploy:staging:*`, `deploy:alpha:*` with no un-suffixed deploy
alias).

## Prerequisites recorded for downstream tickets

- Convex dev access is READY (recreated 2026-09-22:
  project + `dev/main` above with functions pushed; in a fresh clone run
  `npx --yes convex@1.45.0 deployment select glorious-hawk-339` once to
  write `.env.local`, then `npm run convex:dev`).
- Media: create `kiero-dev-media` (free reversible) before first upload proof:
  `wrangler r2 bucket create kiero-dev-media --jurisdiction eu --location weur`.
- Backups: create `kiero-dev-backup` plus its dedicated R2 API token.
