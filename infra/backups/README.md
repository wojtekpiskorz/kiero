# Complete-backup configuration (I5)

Owned by issue [I5 #57]. Names, configuration and owner actions only - never
credential values. The decision model lives once in
`convex/operations/backups/slot.ts`; the files here are the mirrors that
`tests/i5` asserts cannot drift.

## Files

| File | What it defines |
| --- | --- |
| [retention.json](retention.json) | The 15-minute schedule, 48h/14d retention tiers, one-hour freshness limit, the 30-day deleted-content bound and orphan collection grace |
| [plan-limits.json](plan-limits.json) | R2/Convex/Containers free-plan hard limits, the measured-cost recording rules and the PENDING PLN-conversion owner decision |

## What is implemented (no owner action needed)

- The Convex-owned schedule (`convex/crons.ts` backup-schedule-tick), the
  single-run lease/verify/complete protocol and the reference-aware
  retention sweep (`convex/operations/backups/**`), with server-side
  closure verification so a partial set can never be labelled complete.
- The EU backup Container executor (`apps/backup-worker`): Worker cron
  trigger + Durable Object + container, the pinned documented export
  mechanism (`npx --yes convex@1.45.0 export`), pooled media copy with
  sha256 verification, deletion-ledger carriage and manifest-last publish.
- Health/cost events through the I2 machinery: `backup.job` heartbeats per
  attempt, measured `backup` provider cost entries (export/storage/egress)
  and the deduplicated `ops.backup.stale` freshness diagnostic.

## PENDING owner actions (exact steps, by name)

1. **Backup R2 bucket (per environment)** - created for dev by I5's proof
   (`wrangler r2 bucket create kiero-dev-backup --jurisdiction eu --location weur`,
   free tier); repeat for staging/alpha when those environments are
   provisioned. The alpha-production backup destination
   (`kiero-alpha-backup`, EU jurisdiction, separate credentials) is the
   production owner action.
2. **R2 API tokens (dashboard-only; wrangler cannot manage them)**:
   - `R2_BACKUP_ACCESS_KEY_ID` / `R2_BACKUP_SECRET_ACCESS_KEY`: token scoped
     to ONLY the backup bucket (object read/write + bucket read).
   - `R2_MEDIA_READ_ACCESS_KEY_ID` / `R2_MEDIA_READ_SECRET_ACCESS_KEY`:
     read-only token scoped to the media bucket, held ONLY by the backup
     worker (the isolation rule below explains why both are needed).
   Until injected, every byte operation answers the typed `not_configured`
   refusal - honest pending, never a fabricated copy.
3. **Convex export credential** - `CONVEX_BACKUP_ADMIN_KEY`: the mechanism
   I5 finalized is the pinned CLI export (`npx --yes convex@1.45.0 export`)
   driven headless by injecting a Convex access token; the executor writes
   it to the CLI's config file inside the container at runtime. Until the
   key exists, the export step answers `export_not_configured`.
4. **R2 overage PLN conversion** - recorded in plan-limits.json; needed only
   if measured usage ever exceeds a free allowance.

## Credential isolation rules (accepted architecture)

1. The backup worker holds TWO read paths and ONE write path: a read-only
   media-bucket token (to copy retained media OUT), and the backup-bucket
   token (the ONLY credential that can write/read/delete backup sets). The
   media/export workers hold NO backup-bucket credential: a compromised
   media or export worker cannot read, alter or delete any backup.
2. The backup-bucket token cannot touch the media bucket (per-bucket scope),
   so the backup path cannot corrupt live media either.
3. Platform backups and auth secrets are never exported as firm data (the
   Convex export is the documented table export of the application
   deployment; auth secret VALUES live only in deployment variables).

## Where the proof evidence lives

`docs/evidence/backups/README.md` (the lane's evidence register) and
`tests/i5/live-proof.mjs` (the repeatable procedure).
