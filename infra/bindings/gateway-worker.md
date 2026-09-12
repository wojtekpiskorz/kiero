# Gateway worker bindings

Runtime: `apps/gateway` Cloudflare Worker (authorization gateway; streamed
media upload/playback/export routes). Configuration skeleton:
[apps/gateway/wrangler.jsonc](../../apps/gateway/wrangler.jsonc).

## Non-secret bindings and vars

| Name | Kind | Purpose |
| --- | --- | --- |
| `MEDIA_BUCKET` | R2 bucket binding (jurisdiction `eu`) | Authorized read/write path to the environment's media bucket; binding name is fixed, bucket name varies per environment (`kiero-<env>-media`) |
| `ENVIRONMENT` | worker var | Literal environment name (`dev` / `staging` / `alpha-production`) for telemetry tagging |
| `CONVEX_SITE_URL` | worker var | Convex HTTP actions URL of the matching environment's deployment, used for current-access checks during uploads/reads |
| `ALLOWED_APP_ORIGINS` | worker var (`apps/gateway/src/index.ts`) | CORS origin allow-list; media routes authorize cross-origin calls only from the listed web origins (staging: the `kiero-staging-web.pages.dev` origin) |
| `IMAGES` | Cloudflare Images binding (optional) | preferred photo-normalization path when bound; absent on staging until the owner provisions Images |
| `KIERO_NORMALIZER_URL` | worker var (`apps/gateway/src/images/normalizer.ts`) | fallback remote photo-normalizer endpoint used when the `IMAGES` binding is absent; per-environment executor URL |

## Secrets (names only)

| Name | Purpose | Injected via | Status |
| --- | --- | --- | --- |
| `AXIOM_API_TOKEN` | Axiom ingestion for redacted diagnostics and Cloudflare Worker telemetry | `wrangler secret put AXIOM_API_TOKEN --config apps/gateway/wrangler.jsonc [--env <env>]` | PENDING owner account provisioning (I2 consumer implemented; without it the gateway falls back to the Convex ingest endpoint) |

## Notes

- The R2 binding carries `"jurisdiction": "eu"` in `wrangler.jsonc`; the bound
  bucket must have been created with `--jurisdiction eu` or binding requests
  will not see it (jurisdiction-scoped endpoints).
- Later push/web-push or download-signing secret names are added here by their
  owning tickets, never inline in the config.
