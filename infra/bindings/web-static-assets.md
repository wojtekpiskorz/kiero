# Web static-assets worker bindings

Runtime: `apps/web` Cloudflare Worker (the qualification PWA host). Issue
owner decision 2026-09-14 selected Workers Static Assets over the
former Cloudflare Pages project. Configuration skeleton:
[apps/web/wrangler.jsonc](../../apps/web/wrangler.jsonc).

## What this Worker is (and is not)

- STATIC ASSETS ONLY: no `main`, no Containers, no R2/KV/D1 bindings, no
  runtime vars. It serves exactly the existing Vite output
  (`apps/web/dist`, produced by `npm run build --workspace @kiero/web`)
  through wrangler's assets binding. A static-only Worker therefore
  validates and deploys WITHOUT any Container.
- SPA fallback: `assets.not_found_handling = "single-page-application"`,
  so direct links to client routes (`/zrodlo`, `/praca`, `/co-teraz`)
  receive `index.html`, while real files (`/sw.js`, hashed assets) are
  served byte-for-byte and never fall through to the HTML shell.
- Names: `kiero-dev-web` (top-level default; the only target of a bare
  `wrangler deploy` in `apps/web`), `kiero-staging-web`
  (`--env staging`), `kiero-alpha-web` (`--env alpha-production`). The
  staging workers.dev origin is
  `https://kiero-staging-web.wojtek-524.workers.dev`, which is the one
  origin in the gateway's staging CORS allow-list.
- Ownership separation: this Worker owns no Convex deployment and no
  gateway resource. The Convex dev lease under `kiero-dev-core` (the
  recreated `dev/main`, `glorious-hawk-339`; the pre-teardown leases
  `steady-basilisk-613`, `flippant-lemur-146`, `nautical-loris-352` died
  with the 2026-09-22 re-provisioning) and
  the gateway Worker (`kiero-*-gateway`) stay exactly where they are; the
  web Worker only reads build-time URLs baked into the bundle.

## Build inputs (names only; both are public URLs, never secrets)

| Name | Kind | Purpose |
| --- | --- | --- |
| `VITE_CONVEX_URL` | build input (Vite env) | Public Convex deployment URL; baked into the bundle by `apps/web/src/app/config.ts`. The release adapter's `requiredConfig` refuses the web component without it |
| `VITE_GATEWAY_URL` | build input (Vite env) | Public media-gateway Worker base URL; baked into the bundle by the same seam. Required by `requiredConfig` : no transport starts on a half-wired bundle (capture/media surfaces would silently degrade) |

In the release workflow these arrive from the `staging` GitHub
environment as `VITE_CONVEX_URL: vars.STAGING_CONVEX_URL` and
`VITE_GATEWAY_URL: vars.STAGING_GATEWAY_URL` (values are URLs, so `vars`,
not `secrets`). Locally, `npm run dev` in `apps/web` reads the same names
from `.env.local` (gitignored).

## Secrets

None. Nothing in this Worker's config, assets or build inputs is a
credential; if a value looks secret it does not belong here. The
secret-leak heuristic in `infra/environments/shape-check.mjs` walks this
path like every other owned path.

## Notes

- The committed staging descriptor (`infra/release/targets/staging.json`)
  deploys this component through the checked `wrangler-deploy` transport
  (`cwd: apps/web`, `wranglerEnv: staging`, `workerName:
  kiero-staging-web`), preserving the artifact digest of `apps/web/dist`
  (the exact bytes wrangler uploads), the exact-SHA Checks gate and the
  explicit `--env` target selection.
- No Pages project exists or may be created for staging; the former
  `kiero-staging-web` Pages project name is retired with the Pages
  transport (still referenced by `infra/release/targets/production.json`
  until that descriptor's owner mirrors the change).
