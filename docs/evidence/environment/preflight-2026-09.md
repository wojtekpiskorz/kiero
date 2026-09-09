# Environment preflight evidence: 2026-09

Issue [I1 #53]. All outputs below were captured on 2026-09-08/09 from the
owner's machine, sanitized to names and identifiers only. No secret value, API
token or OAuth token was printed, read into evidence or committed. Account
email/id are recorded because wrangler reports them as identity, not as
credentials; redact them from any copy shared outside the repository owners if
needed.

## Tool versions (dated)

| Tool | Version | Resolved how |
| --- | --- | --- |
| node (interactive shell) | v22.22.3 | `node --version` in the user's login shell |
| node (clean `env -i` shell) | v25.8.1 | first `node` on `/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin` |
| npm (clean shell) | 11.11.0 | `npm --version` (login shell had 10.9.8) |
| wrangler | 4.27.0 | `/opt/homebrew/bin/wrangler --version`; global `wrangler` is NOT on the default PATH, the binary lives at `/opt/homebrew/bin/wrangler` |
| convex CLI | 1.45.0 (pinned) | `npx --yes convex@1.45.0 --version` -> `1.45.0`; no global `convex` executable exists on PATH, and `convex` was verified NOT resolvable without npx |
| gh | 2.98.0 (2026-08-20) | `gh --version`, authenticated |

The two node versions above are both real: the login shell resolves a
version-manager node (v22), the clean environment resolves `/opt/homebrew/bin`
node (v25). The preflight records whatever its own shell resolves; the
repository CI (A1, merged db1d6a5) pins Node 22.22.3, which supersedes both
for builds.

## Preflight runs

Command (clean shell, repo worktree root):

```
env -i PATH=/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin HOME=$HOME \
  node infra/environments/preflight.mjs --env-file-path /Users/woji/Dev/Kiero/.env
```

Result (exit 0): **13 probes: 12 VERIFIED, 0 UNAVAILABLE, 1 PENDING, 0 SKIPPED.**

CI-safe mode (`--no-secret-checks`, no local/GitHub secret-name probes) also
exits 0 with the same technical probes; `github-repo-secrets` and
`local-env-names` report `SKIPPED` with a rerun hint.

Full sanitized output of the full-mode run (refreshed 2026-09-09 after advisory review round 1, when the PENDING action gained its A3 ownership pointer; probe statuses are identical to the original 2026-09-09 run):

```
[VERIFIED] node-npm-versions
    node v25.8.1, npm 11.11.0

[VERIFIED] wrangler-cli
    resolved `wrangler --version` -> 4.27.0

[VERIFIED] wrangler-auth
    logged in as wojtek@honestly.design, account id 5242420e9ad911373b75cda3a416598e, token scope includes containers (write)

[VERIFIED] cloudflare-r2-visibility
    r2 bucket list (default jurisdiction): muzeum, sto-k-wro-emdash, stokwro-media

[VERIFIED] cloudflare-r2-eu-jurisdiction
    no eu jurisdiction buckets yet; CLI exposes `r2 bucket create <name> --jurisdiction eu --location weur` (verified via --help)

[VERIFIED] cloudflare-containers
    containers list ok ([]); Containers API reachable

[PENDING] cloudflare-containers-eu-jurisdiction
    installed wrangler 4.27 predates containers.constraints.jurisdiction (added by 4.130.0)
    ACTION: Pin wrangler >= 4.130.0 (root manifest; owner A3, see the PENDING table in docs/evidence/environment/preflight-2026-09.md) before relying on container jurisdiction fields.

[VERIFIED] convex-cli
    resolved invocation `npx --yes convex@1.45.0 <command>` -> --version 1.45.0

[VERIFIED] convex-auth
    /Users/woji/.convex/config.json contains an accessToken key (value never read); convex 1.45.0 exposes no whoami command, so auth is proven by the API call below

[VERIFIED] convex-project-access
    `env list --names-only --deployment wojtek-piskorz-jr:kiero-dev-core:dev` -> No environment variables set (on dev deployment steady-basilisk-613) (read-only; names only)

[VERIFIED] github-cli
    gh 2.98.0 (2026-08-20)

[VERIFIED] github-repo-secrets
    secret names present: OPENROUTER_API_KEY, ZAI_API_KEY (names only)

[VERIFIED] local-env-names
    /Users/woji/Dev/Kiero/.env: variable names present: OPENROUTER_API_KEY (names only, values never read)
```

## Capability matrix

| Capability | Status | One-line evidence |
| --- | --- | --- |
| Convex CLI invocation | VERIFIED | `npx --yes convex@1.45.0 --version` -> `1.45.0`; no global binary |
| Convex authentication | VERIFIED | `~/.convex/config.json` has an `accessToken` KEY (value never read) and an authenticated API call below succeeds; 1.45.0 has no `whoami` command |
| Convex read-only project access | VERIFIED | `convex env list --names-only --deployment wojtek-piskorz-jr:kiero-dev-core:dev` -> "No environment variables set (on dev deployment steady-basilisk-613)" |
| Convex EU placement | VERIFIED | dev deployment `steady-basilisk-613` created in "Europe (Ireland)": URL host `steady-basilisk-613.eu-west-1.convex.cloud`; available regions on this plan: `eu` (Ireland), `us` (N. Virginia) |
| Wrangler CLI | VERIFIED | 4.27.0 at `/opt/homebrew/bin/wrangler` |
| Wrangler auth/account | VERIFIED | OAuth login, wojtek@honestly.design, account id 5242420e9ad911373b75cda3a416598e, scopes include workers (write) and containers (write) |
| Existing R2 inventory | VERIFIED | default jurisdiction: `muzeum`, `sto-k-wro-emdash`, `stokwro-media`; pre-existing, unrelated to Kiero, NOT reused |
| R2 EU jurisdiction | VERIFIED | `wrangler r2 bucket list --jurisdiction eu` works (empty); `r2 bucket create` exposes `--jurisdiction` and `--location weur|eeur|apac|wnam|enam|oc` |
| Containers capability | VERIFIED | `wrangler containers list` -> `[]` (API reachable, zero containers) |
| Containers EU jurisdiction | PENDING | wrangler.jsonc `containers[].constraints.jurisdiction = "eu"` exists in wrangler 4.130.0's config schema but NOT in installed 4.27.0; the >= 4.130 pin is a root-manifest change owned by A3 (single ownership source: the PENDING table below) |
| Separate media/export vs backup credentials feasibility | VERIFIED (design), PENDING (creation) | R2 API tokens are per-bucket scopeable via dashboard/API (wrangler does not manage R2 API tokens); exact provisioning commands recorded as pending below |
| OPENROUTER_API_KEY local presence | VERIFIED | name `OPENROUTER_API_KEY` present in `/Users/woji/Dev/Kiero/.env` (the file contains exactly this one assignment; value never read) |
| OPENROUTER_API_KEY GitHub presence | VERIFIED | `gh secret list --repo wojtekpiskorz/kiero` shows `OPENROUTER_API_KEY` and `ZAI_API_KEY` by name |
| node/npm reproducibility | VERIFIED | see version table above |

## Resources created by this ticket (free, reversible, within authorized dev scope)

| Resource | Exact name | Notes |
| --- | --- | --- |
| Convex project | `kiero-dev-core` in team `wojtek-piskorz-jr` | free plan; dashboard `https://dashboard.convex.dev/t/wojtek-piskorz-jr/kiero-dev-core` |
| Convex default dev deployment | reference `dev/main`, deployment name `steady-basilisk-613`, region Europe (Ireland) / `eu-west-1` | created with `--default`, so `npx convex dev` for this project targets it; reversible via dashboard or CLI delete |

Exact commands used:

```
npx --yes convex@1.45.0 project create kiero-dev-core
# -> Created project kiero-dev-core in team wojtek-piskorz-jr
npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:dev/main --type dev --region eu --default
# -> Created new default dev deployment: steady-basilisk-613
#    https://steady-basilisk-613.eu-west-1.convex.cloud
```

Sanitized transcripts (only identity/names kept):

```
$ npx --yes convex@1.45.0 project create kiero-dev-core
- Creating project kiero-dev-core...
✔ Created project kiero-dev-core in team wojtek-piskorz-jr, manage it at
  https://dashboard.convex.dev/t/wojtek-piskorz-jr/kiero-dev-core

$ npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:dev/region-probe --type dev --region invalid-probe-region
✖ Invalid region "invalid-probe-region".
    Use `--region eu` for Europe (Ireland)
    Use `--region us` for US East (N. Virginia)
# ^ deliberately invalid region used as a read-only way to enumerate regions

$ npx --yes convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:dev/main --type dev --region eu --default
✔ Created new default dev deployment:
▌ [Development] wojtek-piskorz-jr:kiero-dev-core:dev/main (dev)
▌ └─ https://steady-basilisk-613.eu-west-1.convex.cloud

$ wrangler r2 bucket list            # muzeum, sto-k-wro-emdash, stokwro-media
$ wrangler r2 bucket list --jurisdiction eu   # (empty)
$ wrangler containers list           # []
```

## Convex CLI resolution facts (for A3)

- The repository-supported invocation is `npx --yes convex@1.45.0 <command>`;
  pin `1.45.0` (current `latest` on npm as of 2026-09-08). No `convex` global
  binary exists on PATH.
- 1.45.0 has NO `whoami` or `project list` command. Auth state is observed via
  `~/.convex/config.json` (key `accessToken`, value never read) plus a
  successful read-only API call (`env list --names-only`).
- The CLI requires a directory context shaped like a Convex app root:
  `package.json` with `convex` in dependencies and `convex.json` with
  `team`/`project`. Without them it errors with actionable messages
  ("Unable to read your package.json", "add `convex` to your package.json
  dependencies").
- Cross-project addressing `team:project:ref` works headless (stdin closed).
  References `dev` and `default` are reserved; `dev` resolves as a SELECTOR to
  the default dev deployment but cannot be used as a creation reference.
- With stdin not a TTY the CLI can fall back to "anonymous mode" for
  provisioning commands; always pass an explicit `team:project:ref` (as the
  preflight does) or run `npx convex dev`/`deployment select` interactively
  once, which writes `CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SITE_URL` into
  gitignored `.env.local` (variable names only; verified locally in a scratch
  directory, then deleted).

## Failure-path proofs (focused verification)

Each degradation yields an actionable UNAVAILABLE (exit 1) or PENDING rather
than a silent pass:

| Simulated failure | Probe result and action |
| --- | --- |
| wrangler missing (PATH stripped, fallback overridden) | `[UNAVAILABLE] wrangler-cli`: install guidance; run exits 1 |
| Wrong Cloudflare account (`KIERO_EXPECTED_CF_ACCOUNT_ID` mismatch) | `[UNAVAILABLE] wrangler-auth`: logout/login or fix the env var |
| Convex not logged in (fake `$HOME`) | `[UNAVAILABLE] convex-auth`: exact `npx --yes convex@1.45.0 login` action |
| `convex.json` missing team/project | `[UNAVAILABLE] convex-project-access`: pointer to set team/project |
| gh not authenticated (`GH_CONFIG_DIR` redirect) | `[UNAVAILABLE] github-repo-secrets`: `gh auth login` action |
| env file absent | `[UNAVAILABLE] local-env-names`: create the gitignored file with documented NAMES |
| env file without `OPENROUTER_API_KEY` | `[UNAVAILABLE] local-env-names`: lists the missing NAME only |
| Containers EU jurisdiction on old wrangler | `[PENDING]` with the exact pin action (>= 4.130.0) |

## Deliberately NOT done by this ticket (PENDING, exact future action)

| Item | Exact future action | Owner |
| --- | --- | --- |
| Kiero R2 buckets (media/export, backup) | `wrangler r2 bucket create kiero-<env>-media --jurisdiction eu --location weur` and `...-backup --jurisdiction eu --location weur` per environment by the resource-owning tickets (D2/D3 media, I5 backup); buckets are free-tier-safe but belong to their integration proofs | D2/D3, I5 |
| Workers Paid enablement | Dashboard action (billing): required for Containers runtime; no purchase made here | owner/I-lane when Containers first deploy |
| Containers EU jurisdiction fields | Pin wrangler `>= 4.130.0` (verified schema support; root manifest devDependency), then set `containers[].constraints.jurisdiction = "eu"` (+ optionally `constraints.regions: ["EEUR","WEUR"]`) in `apps/*-worker/wrangler.jsonc`. THIS ROW IS THE SINGLE OWNERSHIP SOURCE for the pin; the skeleton comments and the preflight PENDING action point here | A3 pin (root manifest), D6/I5 fields |
| Wire `infra/environments/shape-check.mjs` into CI | Add `node infra/environments/shape-check.mjs` to the deterministic checks (root `package.json` script and/or `.github/workflows/checks.yml`) | A3 (root manifest/checks wiring; those files are not owned by I1) |
| Dedicated backup R2 API token (separate permissions from media/export) | Cloudflare dashboard > R2 > Manage API Tokens > create token scoped to only the backup bucket (read/write object + bucket read); wrangler cannot manage R2 API tokens; store as `R2_BACKUP_*` names per `infra/bindings/README.md` | I5 |
| Convex production/staging deployments | `npx --yes convex@1.45.0 deployment create <team>:<project>:<ref> --type prod --region eu`; only when alpha-production provisioning is chartered, not executed | I-lane/alpha |
| OAuth consent screens, custom domains, Resend/Axiom provisioning | Out of scope by issue rules; recorded as PENDING in environment descriptors | later tickets |
| Application deploys (`convex dev`/`deploy`, `wrangler deploy`) | Prohibited in this ticket beyond read-only verification; A3 onwards own them | A3+ |

## Descriptor skeleton validation

- `node infra/environments/shape-check.mjs`: passed. convex.json is strict JSON
  with the dev project pinned; all four `apps/*/wrangler.jsonc` parse as JSONC,
  keep `kiero-dev-*` top-level names, `kiero-staging-*`/`kiero-alpha-*` env
  names, `jurisdiction: "eu"` on every R2 binding, required container fields
  (plus the durable invariant: any container `constraints` present must carry
  `jurisdiction: "eu"`), and commit no `account_id`; secret-leak heuristic
  clean over owned paths.
- `wrangler deploy --dry-run --config apps/gateway/wrangler.jsonc` (4.27.0):
  configuration parsed; wrangler itself warned that multiple environments are
  defined and an explicit `--env` is recommended (matching this repository's
  guardrail), then reported only the intentional missing entry point
  `src/index.ts` (observed 2026-09-09 before the A1 merge).
- Re-verified 2026-09-09 after the A1 merge (db1d6a5, app skeletons now
  present, still no wrangler pin in the root manifest): the gateway dry-run
  completes and bundles its entry point (Total Upload: 0.25 KiB); the three
  container workers parse cleanly and stop only at the expected missing
  `./Dockerfile` (owned by D5/D6/I5). No account or secret material was
  needed for any of these.

## Environment note

Probes ran on darwin 25.3.0 (arm64) from the issue worktree
`/private/tmp/kiero-core.0hIU2hSHAt/issue-i1` (branch `codex/kiero-i1`,
based on a328471 and later merged with main db1d6a5 for advisory review
round 1) and a scratch directory `/tmp/convex-probe` that was used only
to hold a minimal `package.json`/`convex.json` for CLI context tests.
