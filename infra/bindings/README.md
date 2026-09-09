# Runtime bindings inventory (names only)

Owned by issue [I1 #53]. This directory defines which NAME each runtime
consumes and the documented injection method for it. It never contains
values. Environment-specific value sources are defined in
[infra/environments/](../environments/README.md).

| Binding file | Runtime | Consumes |
| --- | --- | --- |
| [convex-functions.md](convex-functions.md) | Convex functions (server actions) | `OPENROUTER_API_KEY`, later auth/email/push keys |
| [gateway-worker.md](gateway-worker.md) | `apps/gateway` Cloudflare Worker | R2 binding (non-secret), `CONVEX_SITE_URL` var, telemetry secret |
| [media-export-workers.md](media-export-workers.md) | `apps/media-worker`, `apps/export-worker` EU Containers | media-bucket S3 credentials, telemetry secret |
| [backup-worker.md](backup-worker.md) | `apps/backup-worker` EU Container | backup-bucket-only S3 credentials, Convex export key |

## Injection methods (verified or documented)

| Destination | Method | Status |
| --- | --- | --- |
| Convex functions env | `npx --yes convex@1.45.0 env set <NAME>` (values typed interactively or passed by CI from a GitHub secret; `env list --names-only` verifies presence without values), or the Convex dashboard Settings > Environment Variables | CLI VERIFIED read-only (`env list --names-only`); `env set` not executed by I1 |
| Cloudflare Worker secret | `wrangler secret put <NAME> --config apps/<app>/wrangler.jsonc [--env <env>]` from an interactive shell, or `wrangler secret bulk` in CI; presence check: `wrangler secret list` (names only) | wrangler 4.27.0 installed and authenticated; `secret put` not executed by I1 |
| Cloudflare Worker var (non-secret) | `vars` block in the app's `wrangler.jsonc` (committed, names + non-secret values only) | skeleton files committed by I1 |
| R2 API credentials for Containers | dedicated per-bucket R2 API token created in the Cloudflare dashboard (R2 > Manage API Tokens); wrangler cannot create R2 API tokens | documented, PENDING creation by resource-owning tickets |
| GitHub Actions | repository/environment secrets (`gh secret set <NAME> --repo wojtekpiskorz/kiero`); presence by name via `gh secret list` | `gh secret list` VERIFIED (names only) |
| Local development | gitignored `.env` / `.env.local` at the repo root; Convex CLI writes `CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SITE_URL` there automatically | name-presence VERIFIED; `.gitignore` already excludes these files |

## Rules

1. A pull request that introduces a new runtime variable or secret must update
   the matching binding file here and the environment descriptors; a name
   that appears in code but not here is a defect.
2. Values move only through the methods above. They are never committed,
   logged, echoed into evidence, or pasted into issues.
3. Per-environment VALUE isolation (dev/staging/alpha) is mandatory; NAME reuse
   across environments is intentional and this inventory is the single
   namespace authority.
4. `infra/environments/preflight.mjs` hard-codes the two secret names that
   exist today (`OPENROUTER_API_KEY`, `ZAI_API_KEY`); when this inventory
   grows, the preflight must derive its name lists from this README instead of
   extending the hard-coded set.
