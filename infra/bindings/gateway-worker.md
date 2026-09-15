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
| `ALLOWED_APP_ORIGINS` | worker var (`apps/gateway/src/index.ts`) | CORS origin allow-list; media routes authorize cross-origin calls only from the listed web origins (staging since R8: the `https://kiero-staging-web.wojtek-524.workers.dev` static-assets Worker origin) |
| `IMAGES` | Cloudflare Images binding (optional) | preferred photo-normalization path when bound; absent on staging until the owner provisions Images |
| `KIERO_NORMALIZER_URL` | worker var (`apps/gateway/src/images/normalizer.ts`) | fallback remote photo-normalizer endpoint used when the `IMAGES` binding is absent; per-environment executor URL |

## Secrets (names only)

| Name | Purpose | Injected via | Status |
| --- | --- | --- | --- |
| `KIERO_SERVICE_TOKEN` | Service bearer the verified Convex protocol routes require (`/platform/bridge`, `/operations/*`); the gateway bridge guards BOTH this and `CONVEX_SITE_URL` | release workflow injection step (`infra/release/inject-worker-secrets.mjs`, descriptor `runtimeSecrets`); matching value is the Convex deployment variable of the same name | INJECTED by the staging release (I8) |
| `AXIOM_API_TOKEN` | Axiom ingestion for redacted diagnostics and Cloudflare Worker telemetry | release workflow injection (`infra/release/inject-worker-secrets.mjs`; descriptor `runtimeSecrets`) | INJECTED by the staging release (I8; decided and provisioned 2026-09-15) |

## Notes

- The R2 binding carries `"jurisdiction": "eu"` in `wrangler.jsonc`; the bound
  bucket must have been created with `--jurisdiction eu` or binding requests
  will not see it (jurisdiction-scoped endpoints).
- Later push/web-push or download-signing secret names are added here by their
  owning tickets, never inline in the config.
