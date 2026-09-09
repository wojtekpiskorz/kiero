# Media and export worker bindings

Runtime: `apps/media-worker` and `apps/export-worker` — EU-jurisdiction
Cloudflare Containers (FFmpeg audio conversion/segmentation; background firm
export assembly). Configuration skeletons:
[apps/media-worker/wrangler.jsonc](../../apps/media-worker/wrangler.jsonc),
[apps/export-worker/wrangler.jsonc](../../apps/export-worker/wrangler.jsonc).

## Non-secret vars

| Name | Purpose |
| --- | --- |
| `ENVIRONMENT` | Literal environment name for telemetry tagging |
| `R2_MEDIA_BUCKET` | Media bucket name (`kiero-<env>-media`) for S3-path addressing and diagnostics |
| `R2_MEDIA_ENDPOINT` | S3-compatibility endpoint for the account/jurisdiction (`https://<account>.r2.cloudflarestorage.com`; jurisdiction-scoped where applicable) |
| `CONVEX_SITE_URL` | Convex HTTP actions URL for job state updates |

## Secrets (names only)

| Name | Purpose | Injected via | Status |
| --- | --- | --- | --- |
| `R2_MEDIA_ACCESS_KEY_ID` | Access key id of the R2 API token scoped to the MEDIA bucket only | per-bucket R2 API token from the Cloudflare dashboard (R2 > Manage API Tokens); value delivered to the Container runtime env by its owning deploy flow | PENDING (D5/D6) |
| `R2_MEDIA_SECRET_ACCESS_KEY` | Secret access key paired with the id above | same token, same delivery | PENDING (D5/D6) |
| `AXIOM_API_TOKEN` | Redacted diagnostics ingestion | worker/container deploy flow (same value family as gateway) | PENDING (I2) |

## Notes

- Media/export executors must NOT hold backup-bucket credentials; the
  media/export runtime keeps a deployment identity separate from the backup
  executor per the accepted architecture, even where build tooling is shared.
- Container EU placement: `containers[].constraints.jurisdiction = "eu"` in
  `wrangler.jsonc`, available from wrangler 4.130.0 (installed 4.27.0 predates
  it — A1 must pin the newer wrangler before these fields take effect).
