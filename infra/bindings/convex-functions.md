# Convex functions bindings

Runtime: Convex server actions and jobs (`convex/` functions root, deployed
via `npx --yes convex@1.45.0 dev|deploy`). Convex actions perform the
OpenRouter AI calls (chat, vision, STT, embeddings) with server-owned
configuration, per the accepted architecture.

## Secrets (names only)

| Name | Purpose | Injected via | Status |
| --- | --- | --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter API authentication for all model calls from server actions | `npx --yes convex@1.45.0 env set OPENROUTER_API_KEY` per deployment (dev: locally; staging/alpha: CI from GitHub secret), or dashboard Settings > Environment Variables | name VERIFIED in local `.env` and GitHub secrets; Convex env injection PENDING (E2 first real call) |
| `AUTH_RESEND_KEY` | Resend credential for the Convex Auth custom Email provider (Polish OTP/invites) | same as above | PENDING (B1) |
| `CONVEX_BACKUP_ADMIN_KEY` | credential the backup executor uses for the documented export step (candidate name; I5 finalizes) | Convex dashboard-issued key stored in the backup runtime, not in Convex env | PENDING (I5) |

## Generated local variables (not secrets, not committed)

`CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SITE_URL` are written to gitignored
`.env.local` by `npx convex dev` / `npx convex deployment select` and address
the current deployment; see
[infra/environments/local.md](../environments/local.md).

## Notes

- Convex environment variables are per-deployment: setting `OPENROUTER_API_KEY`
  on the dev deployment does not affect staging/alpha: each deployment gets
  its own injection.
- Verification without values: `npx --yes convex@1.45.0 env list --names-only
  --deployment <team>:<project>:dev` (VERIFIED pattern).
