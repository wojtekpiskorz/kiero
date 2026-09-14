# Workers Static Assets web host evidence (R8 #167)

Status date: 2026-09-14. Worktree `r8-static-assets` from `main` at
`d257c1d3c53f614f153a9f29252a62270a107b78` (uncommitted changes; the
coordinator owns the Git lifecycle). The owner selected a separate Workers
Static Assets frontend alongside the gateway on 2026-09-14; this document
records how that decision was implemented and verified, with every command
reproducible from a clean checkout (`rtk npm ci`, then the commands below).

Nothing was deployed and no credential value was read, printed or written
anywhere in this work. Commands that touch Cloudflare run only in
`--dry-run` or local `wrangler dev` mode; the logged-in wrangler state was
never used to mutate anything.

## 1. Design decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Web Worker names | `kiero-dev-web` (top-level default) / `kiero-staging-web` (`--env staging`) / `kiero-alpha-web` (`--env alpha-production`) in `apps/web/wrangler.jsonc` | Matches the `kiero-<env>-<role>` convention and the wrong-environment guardrail of every `apps/*` skeleton: a bare `wrangler deploy` in `apps/web` can only ever target the dev name |
| SPA fallback | `assets.not_found_handling: "single-page-application"` over the existing Vite output (`assets.directory: "./dist"`) | Direct links to client routes (`/zrodlo`, `/praca`, `/co-teraz`) receive `index.html` while real files (`/sw.js`, hashed assets) are served byte-for-byte; no routing code is added to the PWA |
| Static-only shape | No `main`, no bindings, no Containers, no vars | The web Worker must validate and deploy without a Container; backend wiring is entirely build-time |
| Release transport | The staging descriptor's `web` component now rides the EXISTING checked `wrangler-deploy` transport (`cwd: apps/web`, `wranglerEnv: staging`, `workerName: kiero-staging-web`) instead of `wrangler-pages` | The transport already enforces exactly what the issue requires: the exact-SHA Checks gate, the `KIERO_ENVIRONMENT` label check, configuration-name validation before any transport, and the deployed-output identity check (output must name the declared worker). No new transport module was needed and no file outside the owned paths changed |
| Build inputs | `VITE_CONVEX_URL` and `VITE_GATEWAY_URL` both in `requiredConfig`; the workflow injects them from the `staging` GitHub environment (`vars.STAGING_CONVEX_URL`, `vars.STAGING_GATEWAY_URL`) | Both are public URLs, so `vars` not `secrets`; a web build missing either endpoint is blocked before the build runs, so no half-wired bundle can reach a transport. No secret enters the web build by construction (the client seam reads only `VITE_*` names) |
| CORS | The gateway staging `ALLOWED_APP_ORIGINS` is repinned from `https://kiero-staging-web.pages.dev` to `https://kiero-staging-web.wojtek-524.workers.dev` | The staging candidate origin given by the owner; the gateway remains the sole owner of media authorization |
| Ownership separation | The web Worker owns no Convex deployment and no gateway resource; the `kiero-dev-core` dev leases (`steady-basilisk-613`, `flippant-lemur-146`, `nautical-loris-352`) are untouched | The web Worker only consumes the public URLs baked into the bundle at build time |

## 2. What was checked (all commands executed 2026-09-14)

All commands ran in the worktree root unless noted. `rtk` prefixes omitted
for readability; the repo convention was followed.

| # | Check | Command | Expected | Observed | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | Environment shape (incl. the new web skeleton) | `node infra/environments/shape-check.mjs` | exit 0 | `shape check passed` (all `ok:` rows) | PASS |
| P2 | Release guard accepts the rewritten staging job/descriptor | `KIERO_ENVIRONMENT=staging node infra/release/verify-target.mjs --target staging --workflow .github/workflows/release.yml --descriptor infra/release/targets/staging.json --checks-workflow .github/workflows/checks.yml` | exit 0 | `release target verified: staging (guards passed, no secret values read)` | PASS |
| P3 | Wrong-environment refusal (guard) | same with `KIERO_ENVIRONMENT=production` | exit 1 naming the label | `runtime environment label is "production" but the target is "staging"` | PASS |
| P4 | Missing-endpoint refusal at the release boundary (gateway URL alone missing) | fixture checks report via `verify-checks.mjs --fixture`, then `env -i PATH=$PATH KIERO_ENVIRONMENT=staging VITE_CONVEX_URL=https://fiery-raven-417.eu-west-1.convex.cloud CLOUDFLARE_API_TOKEN=<fixture> CLOUDFLARE_ACCOUNT_ID=<fixture> node infra/release/deploy-component.mjs --descriptor infra/release/targets/staging.json --revision 3333…33 --checks-report <report> --component web --ledger <tmp>/releases.jsonl --outcomes <tmp>/outcomes.json` | blocked `missing-configuration` naming `VITE_GATEWAY_URL`, exit 1, no build, no transport | `[blocked] web: missing-configuration names=[VITE_GATEWAY_URL]`, exit 1 | PASS |
| P5 | Static-only Worker validates without a Container (staging env) | `cd apps/web && npx wrangler deploy --dry-run --env staging --outdir <tmp>` (fixture dist of 3 files) | exit 0 | `Read 3 files from the assets directory`, `No bindings found`, `--dry-run: exiting now`, exit 0; outdir contains the generated `no-op-worker.js` (wrangler's own static-only marker), no container image requested | PASS |
| P6 | Bare dry-run validates the dev default | `cd apps/web && npx wrangler deploy --dry-run --outdir <tmp>` | exit 0 | exit 0 (top-level `kiero-dev-web` default; wrangler only warns to pass `--env` explicitly) | PASS |
| P7 | SPA fallback + `/sw.js` delivery on a local server (deterministic fixture bytes) | `tests/i7/workers-static-assets.test.ts` serving describe (local `npx wrangler dev --port <free> --ip 127.0.0.1` in `apps/web`) | `/`, `/zrodlo`, `/praca`, `/co-teraz` → 200 `text/html` with the shell; `/sw.js` → 200 `text/javascript` with the exact sw bytes; fixture asset byte-for-byte | all five route checks green; `/sw.js` served as itself, never the shell | PASS |
| P8 | SPA fallback + `/sw.js` delivery on the REAL built artifact | `npm run build` then local `npx wrangler dev` and `curl` of `/`, `/zrodlo`, `/praca`, `/co-teraz`, `/sw.js`, `/assets/index-BokYaM8V.js` | 200s; shell for routes; sw and hashed bundle as themselves | `/zrodlo` `/praca` `/co-teraz` → 200 `text/html` with the real `index.html`; `/sw.js` → 200 `text/javascript` 4370 bytes (the F3 push worker, not the shell); `/assets/index-BokYaM8V.js` → 200 `text/javascript` 808452 bytes | PASS |
| P9 | Focused deterministic suite | `npx vitest run tests/i7` | all green | 11 files, 150 tests passed (incl. the 22 new R8 tests) | PASS |
| P10 | Full repository suite | `npm test` | all green | 170 files passed, 1 skipped; 2309 tests passed, 5 skipped; vitest exit 0 | PASS |
| P11 | Typecheck (root + workspaces) | `npm run typecheck` | exit 0 | exit 0, no errors | PASS |
| P12 | Web build | `npm run build` | Vite output in `apps/web/dist` | `dist/index.html`, `dist/sw.js`, `dist/assets/index-BokYaM8V.js`, built in 1.27 s (chunk-size warning only) | PASS |

The R8 acceptance rows not reachable without credentials are recorded as
NOT RUN in section 5; the deterministic tests cover the same refusal and
serving shapes locally (P3-P8) exactly the way the I7 evidence did for the
Pages transport.

## 3. Artifact digest behavior

The deploy adapter digests `apps/web/dist` (the component's `artifact`)
with `digestArtifactPath` — a sorted manifest of per-file SHA-256 lines,
hashed again — and records it in the append-only ledger with the deployed
outcome. Because the `wrangler-deploy` transport uploads exactly that
directory (`assets.directory: "./dist"` in `apps/web/wrangler.jsonc`), the
recorded digest covers the exact bytes served. Observed on the real build:

- digest of `apps/web/dist` (3 files): `8b703c83d2d9a8bc…`, stable on
  re-digest;
- a FULL rebuild (`npm run build` again) reproduces the identical digest
  `8b703c83d2d9a8bc…` (deterministic Vite output, content-hashed asset
  name), so two releases of the same tree compare equal by digest;
- the digest-reacts-to-byte-changes property itself is covered by the
  existing adapter test (`digests a file tree deterministically and reacts
  to byte changes`).

## 4. Failed attempts (preserved)

1. **Full-suite failure caused by my own concurrent build.** The first
   `npm test` run was started in the background while I ran
   `npm run build` at the same time; the build replaced `apps/web/dist`
   mid-run, so the local-serving test's fixture asset vanished under it
   and `/r8-fixture-asset.txt` fell through to the SPA shell (the
   assertion diff showed the REAL `index.html` with the hashed asset
   script tag — the fallback working exactly as designed, on the wrong
   bytes). Re-run serialized with no concurrent writers: 170 files /
   2309 tests pass, exit 0 (P10). The test itself is correct; CI cannot
   hit this because the rehearsal job runs vitest with nothing else
   writing the workspace.
2. **Shape check failed on local wrangler state.** The first
   `verify:environments` run after the manual wrangler probes failed with
   `apps/web/.wrangler/cache/cf.json: token-like literal` — local,
   gitignored wrangler cache (never committed). Fixed in the check's own
   walk: `node_modules` and `.wrangler` are both skipped (both are
   gitignored machine state that can never be committed); the test suite
   also removes `apps/web/.wrangler` in its cleanup.
3. **Stale fixture file changed the dry-run file count.** The first
   focused-suite run expected `Read 3 files` but observed `Read 4 files`:
   a file left in `apps/web/dist` by my earlier manual probe. The suite
   now owns the output directory outright (removes it before writing the
   fixture), making the count deterministic.
4. **Test-file parse error.** The first version of the new test file had a
   block comment containing `*/` inside its own text, terminating the
   comment early (`PARSE_ERROR`). Reworded; trivial.

## 5. NOT RUN (owner/I8 actions, by design)

- **Actual staging deployment.** No `wrangler deploy` (without
  `--dry-run`) was run against any environment; no Cloudflare resource
  was created, modified or deleted. The first real staging release
  belongs to I8 #133 through the Release workflow.
- **The live workers.dev address.** `https://kiero-staging-web.wojtek-524.workers.dev`
  is the declared candidate origin (gateway CORS + docs); verifying the
  deployed address responds with the released digest is I8's success
  check for the actual release.
- **GitHub `staging` environment provisioning**: the new
  `STAGING_GATEWAY_URL` variable (public URL) must be created alongside
  `STAGING_CONVEX_URL` before the first release; without it the web
  component truthfully blocks `missing-configuration` (P4 proves the
  refusal by name).
- **Live CORS verification** (an origin check against the deployed
  gateway) and the secret-leak inspection of the deployed bundle — I8's
  post-release verification cases.
- **Production (alpha) descriptor**: `infra/release/targets/production.json`
  still deploys the web component through `wrangler-pages` (see section 6).

## 6. Prerequisites outside this issue's owned paths (proposals, not edited)

1. `infra/release/targets/production.json` (not owned): the `web`
   component still uses `wrangler-pages`/`kiero-alpha-web`. Proposal:
   mirror the staging change (`wrangler-deploy`, `cwd: apps/web`,
   `wranglerEnv: alpha-production`, `workerName: kiero-alpha-web`, add
   `VITE_GATEWAY_URL`) and add `VITE_GATEWAY_URL: ${{ vars.PRODUCTION_GATEWAY_URL }}`
   to the production job in `release.yml` when alpha provisions. Until
   then no Pages project may be created (the name now belongs to the
   Worker declared in `apps/web/wrangler.jsonc`).
2. `docs/evidence/staging/README.md` and `docs/evidence/staging/candidate.json`
   (I8-owned, not edited): still cite the Pages origin
   (`kiero-staging-web.pages.dev`) in the isolation table, runbook R6
   (`wrangler pages project create`) and the OAuth redirect pinning; they
   should be reconciled to the workers.dev origin when I8 cuts the first
   release.
3. `infra/release/README.md` (R6-owned, not edited): its transport
   inventory still describes `wrangler-pages` as "web build"; staging no
   longer uses it (production does until item 1 lands).

## 7. Changed/added files (all uncommitted, owned paths only)

Added: `apps/web/wrangler.jsonc`, `infra/bindings/web-static-assets.md`,
`tests/i7/workers-static-assets.test.ts`, this evidence directory.
Modified: `apps/gateway/wrangler.jsonc`,
`.github/workflows/release.yml`, `infra/release/targets/staging.json`,
`infra/environments/shape-check.mjs`, `infra/environments/local.md`,
`infra/environments/synthetic-staging.md`,
`infra/environments/alpha-production.md`,
`infra/bindings/gateway-worker.md`, `tests/i7/deploy-adapter.test.ts`,
`tests/i7/release-guards.test.ts`.

No secret value appears in any file, command output above or ledger
fixture (fixture Cloudflare names in P4 are dummy strings by name only).
