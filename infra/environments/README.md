# Kiero environments

Index of the checked-in environment descriptors owned by issue [I1 #53].
These files define NAMES and contracts only. They never contain values;
`docs/evidence/environment/preflight-2026-09.md` records what was actually
verified against the live accounts on 2026-09-08/09.

| File | Environment | Cloud/Convex identity |
| --- | --- | --- |
| [local.md](local.md) | local development | Convex project `kiero-dev-core` (team `wojtek-piskorz-jr`), Cloudflare resources `kiero-dev-*` |
| [synthetic-staging.md](synthetic-staging.md) | synthetic staging (CI deploy target) | Convex project `kiero-staging-core` (PENDING), Cloudflare resources `kiero-staging-*` (PENDING) |
| [alpha-production.md](alpha-production.md) | future alpha production | Convex project `kiero-alpha-core` (PENDING), Cloudflare resources `kiero-alpha-*` (PENDING) |

[preflight.mjs](preflight.mjs) is the one-command readiness probe:

```
node infra/environments/preflight.mjs [--no-secret-checks] [--env-file-path <path>]
```

Bindings (which runtime consumes which variable/secret NAME, and the injection
method for each) live in [infra/bindings/](../../infra/bindings/README.md).

## Note on `convex.json` (root)

`convex.json` is strict JSON — JSONC comments are not allowed there — so this
is the sibling note the file itself points to through its fields:

- `team` / `project` pin the LOCAL DEVELOPMENT project (`kiero-dev-core`).
  Plain `npx convex dev` in the repository root therefore can only ever target
  that project's dev deployments; staging and alpha production are separate
  projects addressed exclusively by explicit `team:project:ref` or `--prod`
  against their own `convex.<env>.json`-style configs created by their owning
  tickets.
- `functions` is `convex/`, the single functions root A2/A3 compose.
- The file must stay non-secret. Deployment URLs and admin keys live in
  gitignored `.env.local` (written by `npx convex dev` / `deployment select`),
  never here.

## Cross-environment guardrails (summary)

1. No command in this repository may target alpha production by default: the
   root `convex.json` names the dev project, and every `apps/*/wrangler.jsonc`
   keeps its top-level (default) environment block pointed at `kiero-dev-*`
   names. Staging and production exist only as named environments
   (`--env staging`, `--env alpha-production`) with their own
   `kiero-staging-*` / `kiero-alpha-*` resource names.
2. Environment selection is always by fully-named alias, never by shared
   positional defaults (see "Command aliases" in each descriptor).
3. Resource names embed the environment (`kiero-dev-*`, `kiero-staging-*`,
   `kiero-alpha-*`); a name without an environment suffix is a bug.
4. Secrets are injected only through the documented methods in
   [infra/bindings/README.md](../../infra/bindings/README.md); pull requests
   that add a secret name must update that inventory and never a value.
