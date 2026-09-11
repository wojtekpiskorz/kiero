# Complete-backup evidence (I5, issue #57)

Environment: leased Convex dev deployment `wojtek-piskorz-jr:kiero-dev-core:dev/i5`
(EU), EU R2 buckets `kiero-dev-backup` (backup) and `kiero-dev-media` (media,
D3's), backup Container `kiero-dev-backup-worker`. No secret value appears
here; credentials are present by NAME only.

## Status summary

| Area | Status |
| --- | --- |
| Decision model, protocol, sweep, freshness (convex/operations/backups) | IMPLEMENTED, 68 focused tests green (tests/i5) |
| EU backup Container executor (apps/backup-worker) | IMPLEMENTED, image builds (`wrangler deploy --dry-run`), typed not-configured refusals until owner tokens |
| EU backup bucket | CREATED: `kiero-dev-backup` (jurisdiction eu, free tier) |
| Live proofs on dev/i5 | **BLOCKED - NOT RUN** (Convex team deployment quota 40/40 reached; exact error below) |
| R2 S3 tokens + Convex export key | PENDING owner actions (names: infra/bindings/backup-worker.md) |

## BLOCKED: dev/i5 deployment creation (2026-09-11)

Command and sanitized transcript:

```
$ npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:dev/i5 --type dev --region eu
✖ Error fetching https://api.convex.dev/v1/projects/2960180/create_deployment
  400 Bad Request: DeploymentQuotaReached: Your team's deployment quota of
  40 has been reached. You can upgrade account limits at https://www.convex.dev/plans.
```

Owner action required (either): delete stale dev deployments of completed
lanes from the Convex dashboard, or raise the deployment quota. Then:

```
npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:dev/i5 --type dev --region eu
npx --yes convex@1.45.0 deployment select wojtek-piskorz-jr:kiero-dev-core:dev/i5
npx convex@1.45.0 dev --once          # push functions + crons, regenerate
npx convex@1.45.0 env set KIERO_PROBE_ENABLED 1
npx convex@1.45.0 env set KIERO_SERVICE_TOKEN <value>   # name only here
KIERO_I5_CONVEX=<deployment-name> node --experimental-strip-types tests/i5/live-proof.mjs
```

A re-run of the create during this session confirmed the quota is still
exhausted; no other team resource was touched (the shared dev/main
deployment was probed read-only and left unchanged).

## Verified without a deployment (2026-09-11, worktree codex/kiero-i5 at main 3e6b492 + I5 changes)

| Check | Command | Result |
| --- | --- | --- |
| Focused suite (decision matrix, lease/overlap, closure verification, interrupts, corruption, retention, freshness, mirrors) | `npx vitest run tests/i5` | PASS 68/68 |
| Full repository suite (baseline 130 files / 1743 passed / 5 skipped + tests/i5) | `npm test` | recorded in the session report |
| Typecheck (root + all workspaces incl. the container program) | `npm run typecheck` | clean after codegen |
| Convex codegen (generated api gains operations/backups) | `CONVEX_DEPLOYMENT=<ctx> npx convex@1.45.0 codegen` | `convex/_generated/api.d.ts` updated (verified it did NOT deploy functions to the shared context) |
| Backup bucket creation (EU) | `npx wrangler r2 bucket create kiero-dev-backup --jurisdiction eu` | created; `r2 bucket list --jurisdiction eu` shows kiero-dev-backup + kiero-dev-media |
| Container image + wrangler config | `npx wrangler deploy --dry-run --config apps/backup-worker/wrangler.jsonc` | image builds (docker export OK); EU jurisdiction constraints parse under the pinned wrangler 4.130.0 |
| Environment shape check | `npm run verify:environments` | passed |

## Proof rows (P10/P12) and their live status

| Row | What it proves | Live status |
| --- | --- | --- |
| L1 lease + overlap | One writer per 15-minute slot; overlapping attempts refused | NOT RUN (blocked); unit-proven (functions.test.ts) |
| L2 complete set | Real export + retained media into the EU bucket, manifest published last, server-verified closure | NOT RUN (blocked); unit-proven end-to-end with in-memory ports (pipeline.test.ts) |
| L3 interrupts | after_export/mid_media/before_manifest interrupts leave no manifest; takeover completes once | NOT RUN (blocked); full matrix unit-proven |
| L4 corruption + freshness | Tampered/omitted object fails typed; ops.backup.stale emitted from snapshot age | NOT RUN (blocked); unit-proven |
| L5 retention fixtures | 48h frequent / 14d daily collection, reference-aware (shared pool object protected by a surviving manifest) | NOT RUN (blocked); unit-proven (server + executor sides) |
| L6 deleted-source 30-day expiry | Purge drops exclude new sets; 14d retention bound keeps content inside 30 days (invariant) | NOT RUN (blocked); invariant asserted at runtime + in tests |
| L7 health/cost | backup.job heartbeats per attempt; measured backup cost entries in the 400/500 PLN accounting | NOT RUN (blocked); unit-proven via the I2 seam |

The repeatable procedure for every row above is `tests/i5/live-proof.mjs`.

## Observed costs and plan limits (P12)

Measured without live runs so far: the dev backup bucket is empty (0 bytes,
0 objects - free tier), the container build ran locally (no account
charge), and the Convex zip export performed during codegen/probe work is
within Free. Per-run measurement wiring is implemented: manifest rows carry
databaseBytes/mediaBytes/mediaObjectCount; complete records cost entries
(provider `backup`, categories export/storage/egress, observed amounts, 0
minor while inside free allowances); the state read compares pooled bytes
against the configured free allowance. R2 overage PLN conversion is an
explicit PENDING owner decision (no invented FX rate). The 15-minute
frequency is never silently reduced: a plan-limit breach is a loud typed
failure plus owner decision (asserted by the cadence-agreement test).

## Owner actions (exact names)

1. Free a Convex deployment slot (or raise the quota) so dev/i5 can be
   created - unblocks every NOT RUN row above.
2. `R2_BACKUP_ACCESS_KEY_ID` / `R2_BACKUP_SECRET_ACCESS_KEY` (backup-bucket
   token) and `R2_MEDIA_READ_ACCESS_KEY_ID` / `R2_MEDIA_READ_SECRET_ACCESS_KEY`
   (read-only media token): dashboard-issued; activate the production byte
   path (the CLI transport in the proof script is the temporary substitute).
3. `CONVEX_BACKUP_ADMIN_KEY`: a Convex access token driving the pinned
   export headless inside the container.
4. Production backup destination `kiero-alpha-backup` (EU) when
   alpha-production is provisioned.
