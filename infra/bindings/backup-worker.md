# Backup worker bindings

Runtime: `apps/backup-worker`: the separate EU-jurisdiction Container run by
the scheduled backup job (every 15 minutes per the accepted architecture).
Configuration skeleton: [apps/backup-worker/wrangler.jsonc](../../apps/backup-worker/wrangler.jsonc).

I5 append (issue #57, flagged shared-file change): the executor is
implemented; the table below records the finalized mechanism names and the
dev proof state. Full configuration and owner actions:
[infra/backups/README.md](../backups/README.md).

## Non-secret vars

| Name | Purpose |
| --- | --- |
| `ENVIRONMENT` | Literal environment name for telemetry tagging |
| `R2_BACKUP_BUCKET` | Backup bucket name (`kiero-<env>-backup`): a DIFFERENT bucket from media, with its own credentials |
| `R2_BACKUP_ENDPOINT` | S3-compatibility endpoint used for backup writes |
| `R2_MEDIA_BUCKET` | Media bucket name (the read-only copy source) |
| `R2_MEDIA_ENDPOINT` | S3-compatibility endpoint used for media reads |
| `CONVEX_SITE_URL` | Convex HTTP actions URL for recovery manifests / job state |
| `CONVEX_EXPORT_DEPLOYMENT` | Deployment reference/name the pinned CLI export targets |

## Secrets (names only)

| Name | Purpose | Injected via | Status |
| --- | --- | --- | --- |
| `R2_BACKUP_ACCESS_KEY_ID` | Access key id of an R2 API token scoped to the BACKUP bucket only | dedicated per-bucket R2 API token from the Cloudflare dashboard; wrangler cannot manage R2 API tokens | PENDING (owner; name and usage finalized by I5) |
| `R2_BACKUP_SECRET_ACCESS_KEY` | Secret access key paired with the id above | same token | PENDING (owner) |
| `R2_MEDIA_READ_ACCESS_KEY_ID` | Access key id of a READ-ONLY media-bucket token held ONLY by the backup worker (the copy source; distinct from the media worker's token) | dashboard-issued per-bucket token | PENDING (owner; I5 addition) |
| `R2_MEDIA_READ_SECRET_ACCESS_KEY` | Secret access key paired with the id above | same token | PENDING (owner; I5 addition) |
| `CONVEX_BACKUP_ADMIN_KEY` | Mechanism FINALIZED by I5: a Convex access token driving the pinned documented export (`npx --yes convex@1.45.0 export`) headless; the executor writes it to the CLI's runtime config, never to the repo | stored only in the backup runtime environment | PENDING (owner) |
| `KIERO_SERVICE_TOKEN` | Shared service bearer for the verified Convex protocol routes (`/operations/backups/*`) | Convex deployment variable + worker secret | set on dev/i5 by the I5 proof; PENDING for staging/alpha |
| `AXIOM_API_TOKEN` | Redacted diagnostics ingestion | deploy flow | PENDING (I2) |

## Isolation rules

1. The backup credential set is separate from media/export: the media token
   cannot read the backup bucket and the backup token cannot read the media
   bucket. This is the feasibility verified in
   [docs/evidence/environment/preflight-2026-09.md](../../docs/evidence/environment/preflight-2026-09.md):
   per-bucket R2 API tokens are the supported mechanism.
   I5 refinement: the backup WORKER additionally holds a dedicated
   read-only media token (`R2_MEDIA_READ_*`) because copying retained media
   out is its job; that token can never write media, and no media/export
   worker holds any backup credential, so backups remain unreachable from
   the media/export paths in both directions.
2. Platform backups and auth secrets are never exported as firm data.
3. Retention (48h frequent sets, daily through day 14, 30-day expiry of
   deleted content) is configuration of the scheduler/executor, not of these
   bindings; owned by I5 ([infra/backups/retention.json](../backups/retention.json)).
