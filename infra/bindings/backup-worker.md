# Backup worker bindings

Runtime: `apps/backup-worker`: the separate EU-jurisdiction Container run by
the scheduled backup job (every 15 minutes per the accepted architecture).
Configuration skeleton: [apps/backup-worker/wrangler.jsonc](../../apps/backup-worker/wrangler.jsonc).

## Non-secret vars

| Name | Purpose |
| --- | --- |
| `ENVIRONMENT` | Literal environment name for telemetry tagging |
| `R2_BACKUP_BUCKET` | Backup bucket name (`kiero-<env>-backup`): a DIFFERENT bucket from media, with its own credentials |
| `R2_BACKUP_ENDPOINT` | S3-compatibility endpoint used for backup writes |
| `CONVEX_SITE_URL` | Convex HTTP actions URL for recovery manifests / job state |

## Secrets (names only)

| Name | Purpose | Injected via | Status |
| --- | --- | --- | --- |
| `R2_BACKUP_ACCESS_KEY_ID` | Access key id of an R2 API token scoped to the BACKUP bucket only | dedicated per-bucket R2 API token from the Cloudflare dashboard; wrangler cannot manage R2 API tokens | PENDING (I5) |
| `R2_BACKUP_SECRET_ACCESS_KEY` | Secret access key paired with the id above | same token | PENDING (I5) |
| `CONVEX_BACKUP_ADMIN_KEY` | Credential for the documented Convex export step (candidate name; I5 finalizes mechanism: CLI export credentials or dashboard-issued key) | stored only in the backup runtime environment | PENDING (I5) |
| `AXIOM_API_TOKEN` | Redacted diagnostics ingestion | deploy flow | PENDING (I2) |

## Isolation rules

1. The backup credential set is separate from media/export: the media token
   cannot read the backup bucket and the backup token cannot read the media
   bucket. This is the feasibility verified in
   [docs/evidence/environment/preflight-2026-09.md](../../docs/evidence/environment/preflight-2026-09.md):
   per-bucket R2 API tokens are the supported mechanism.
2. Platform backups and auth secrets are never exported as firm data.
3. Retention (48h frequent sets, daily through day 14, 30-day expiry of
   deleted content) is configuration of the scheduler/executor, not of these
   bindings; owned by I5.
