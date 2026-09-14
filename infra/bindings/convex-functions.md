# Convex functions bindings

Runtime: Convex server actions and jobs (`convex/` functions root, deployed
via `npx --yes convex@1.45.0 dev|deploy`). Convex actions perform the
OpenRouter AI calls (chat, vision, STT, embeddings) with server-owned
configuration, per the accepted architecture.

I8 reconciliation (issue #133, 2026-09-12): every name below was re-checked
against the actual runtime reads (`grep process.env` over `convex/`).
`AUTH_RESEND_KEY` never existed at runtime and is removed in favor of the
real names `RESEND_API_KEY` / `RESEND_FROM`; the Google OAuth, Web Push
VAPID, service-token and calendar-key names that later lanes introduced are
now part of the inventory. Presence states live in
[docs/evidence/staging/README.md](../../docs/evidence/staging/README.md).

## Secrets (names only)

| Name | Consumer | Purpose | Injected via | Status |
| --- | --- | --- | --- | --- |
| `JWT_PRIVATE_KEY` | Convex Auth session issuance | Deployment-specific RS256 PKCS#8 signing key | `STAGING_JWT_PRIVATE_KEY` GitHub environment secret and per-deployment Convex variable, transferred through stdin | SET on staging 2026-09-14; in-memory signature verification passed; deployed auth proof pending |
| `JWKS` | Convex Auth verification endpoint | Public verification keys derived from the staging signing key | `STAGING_JWKS` GitHub environment secret and per-deployment Convex variable | SET on staging 2026-09-14; published endpoint proof pending |
| `DEEPSEEK_API_KEY` | Direct DeepSeek provider adapter (E8: chat, vision) | Owner-selected direct API access to `deepseek-flash`, observed as V4.1 Flash on 2026-09-14 | `STAGING_DEEPSEEK_API_KEY` GitHub environment secret and per-deployment Convex variable | name present in both staging stores (2026-09-14); E8 implements the direct client; first live call pending a successful release |
| `OPENROUTER_API_KEY` | AI actions (chat-vision fallback, STT, embeddings) | OpenRouter API authentication for model calls from server actions | `npx --yes convex@1.45.0 env set OPENROUTER_API_KEY` per deployment (dev: locally; staging/alpha: CI from GitHub secret), or dashboard Settings > Environment Variables | name present in GitHub staging + Convex staging (2026-09-14, names-only); first live call pending a successful release |
| `RESEND_API_KEY` | `convex/integrations/email/resend.ts` (exported `RESEND_API_KEY_NAME`) | Resend credential for transactional email (OTP/invites); runtime reads exactly this name, not `AUTH_RESEND_KEY` | same as above | name present in both staging stores (2026-09-14); domain woji.dev owner-verified; runtime send NOT RUN (no deployed functions) |
| `RESEND_FROM` | same module | verified sender identity for outgoing email | same as above | name present in both staging stores (2026-09-14); runtime send NOT RUN |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | `convex/access/identity/authEntry.ts`, `providerAvailability.ts`; reused by `convex/calendar/connection/*` | Google OAuth client for sign-in and Calendar connection (one client per environment; redirect URIs pinned in the staging evidence) | same as above | client created in project kiero-508611 (External/Testing, one test user); names present in both staging stores; runtime flow untested |
| `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY` / `WEB_PUSH_VAPID_SUBJECT` | `convex/attention/push/functions.ts`, `proofService.ts` | VAPID keypair for Web Push delivery and subscription proof verification | same as above | SET on staging 2026-09-14 (I8-generated fresh P-256 pair, RFC 8292 shapes verified in memory; subject = the public staging web origin; public key also reaches the PWA through the proof/subscription path, never a committed file); deployed push proof pending |
| `KIERO_SERVICE_TOKEN` | `convex/platform/http.ts`, `processing/images`, `operations/deletion`, `operations/exports`, `calendar/connection/http.ts` | shared service bearer for the verified Convex protocol routes (platform, executors, calendar callbacks) | Convex deployment variable + matching worker-side secret (`infra/bindings/backup-worker.md`, `media-export-workers.md`) | SET on dev by lane proofs; SET on staging 2026-09-14 (names-only verified in both stores); worker-side injection pending the first staging worker deploys |
| `KIERO_MEDIA_WORKER_TOKEN` | `convex/processing/multimodal/vision.ts`, `processing/audio/media.ts` | bearer Convex presents to the media executor's `/probe` and `/segment` routes (reader side of the media worker's `MEDIA_SEGMENT_TOKEN`) | Convex deployment variable | SET on dev (D6 live proof); SET on staging 2026-09-14 (names-only); worker-side `MEDIA_SEGMENT_TOKEN` injection pending |
| `KIERO_CALENDAR_TOKEN_KEY` | `convex/calendar/connection/credentialStore.ts` | key sealing stored Google Calendar credentials | Convex deployment variable | SET on staging 2026-09-14 (names-only in both stores); runtime seal/unseal untested |
| `CONVEX_BACKUP_ADMIN_KEY` | backup executor (not Convex env) | Convex access token driving the documented export (I5-finalized mechanism) | stored only in the backup runtime environment | PENDING (owner) |
| `AXIOM_API_TOKEN` | telemetry sink forwarder | Axiom ingest credential (redacted diagnostic events) | `npx --yes convex@1.45.0 env set AXIOM_API_TOKEN` per deployment | PENDING owner account provisioning (I2 consumer implemented) |

## Non-secret variables (names only)

| Name | Consumer | Purpose |
| --- | --- | --- |
| `SITE_URL` | Convex Auth OAuth return | Staging web origin used after Google sign-in; distinct from the provider callback on the Convex HTTP Actions origin |
| `AXIOM_DATASET` | telemetry forwarder | dataset name (`kiero-observability`) |
| `KIERO_ENVIRONMENT` | telemetry forwarder | environment tag (`dev` / `staging` / `alpha-production`) stamped on forwarded events |
| `KIERO_DEPLOYMENT_LABEL` | `convex/platform/http.ts`, `operations/telemetry/http.ts` | deployment identifier reported in diagnostics snapshots |
| `KIERO_GM_EMAILS` | `convex/access/gm/functions.ts` | GM operator allow-list (operator emails; per-deployment config, not a credential) |
| `KIERO_MEDIA_WORKER_URL` | `convex/processing/multimodal/vision.ts`, `processing/audio/media.ts` | media executor base URL (per-environment worker URL) |
| `KIERO_IMAGES_EXECUTOR_URL` | `convex/processing/images/executor.ts` | images executor URL (per-environment) |
| `KIERO_EXPORT_EXECUTOR_URL` | `convex/operations/exports/executor.ts`, `functions.ts` | export executor URL (per-environment) |
| `KIERO_BACKUP_WORKER_URL` | `convex/operations/backups/functions.ts` | backup worker URL (per-environment) |
| `KIERO_PURGE_EXECUTOR_URL` | `convex/operations/deletion/executor.ts` | media purge executor URL (per-environment) |
| `KIERO_CALENDAR_APP_BASE_URL` | `convex/calendar/projection/operations.ts` | base URL of the app the calendar copies link back to (per-environment web origin) |
| `KIERO_CALENDAR_REDIRECT_URI` | `convex/calendar/connection/operations.ts` | explicit OAuth redirect URI override (must equal a redirect URI registered on the environment's Google OAuth client) |

## Proof/fixture/diagnostic switches (must stay unset on qualification paths)

The exact flag set verified in the runtime (no other proof flags exist):

`KIERO_B1_PROOF_ENABLED`, `KIERO_B2_PROOF_ENABLED`, `KIERO_B3_PROOF_ENABLED`,
`KIERO_B4_PROOF_ENABLED`, `KIERO_C1_PROOF_ENABLED`, `KIERO_C4_PROOF_ENABLED`,
`KIERO_E5_PROOF_ENABLED`, `KIERO_F3_PROOF_ENABLED`, `KIERO_G1_PROOF_ENABLED`,
`KIERO_G2_PROOF_ENABLED`, `KIERO_G3_PROOF_ENABLED`, `KIERO_H3_PROOF_ENABLED`,
`KIERO_H4_PROOF_ENABLED`, `KIERO_PROBE_ENABLED` (memory/recompute/extensions
probes), `KIERO_ECHO_TARGET` (platform echo diagnostics) and the calendar
proof overrides `KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE`,
`KIERO_CALENDAR_TOKEN_ENDPOINT_OVERRIDE` gate fixture/probe authorization
and fake endpoints. Enabling any of them on a deployment opens non-user
authorization paths; issue #133 forbids them on the staging qualification
user path. They are set only on dedicated dev deployments by their owning
proof lanes.

## Generated local variables (not secrets, not committed)

`CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SITE_URL` are written to gitignored
`.env.local` by `npx convex dev` / `npx convex deployment select` and address
the current deployment; see
[infra/environments/local.md](../environments/local.md).

## Notes

- Convex environment variables are per-deployment: setting `OPENROUTER_API_KEY`
  on the dev deployment does not affect staging/alpha: each deployment gets
  its own injection. Staging is a named deployment inside `kiero-dev-core`
  (I8 reconciliation), so its variables are set with
  `npx --yes convex@1.45.0 env set <NAME> --deployment wojtek-piskorz-jr:kiero-dev-core:staging`-style
  addressing or the dashboard.
- Verification without values: `npx --yes convex@1.45.0 env list --names-only
  --deployment <team>:<project>:<ref>` (VERIFIED pattern).
