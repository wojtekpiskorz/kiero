# Resume the core map after VPS provisioning

This checkpoint records the owner decisions and observations from 2026-09-14. M2 #166 publishes the map update. Live issue bodies, native dependencies, active reservations and PR state determine what can run next.

## Implementation frontier

| Task | Deliverable | Execution constraint |
| --- | --- | --- |
| [R8 #167](https://github.com/wojtekpiskorz/kiero/issues/167) | Separate Workers Static Assets web deployment, SPA fallback, gateway build input and release checks | After M2; owns shared hosting/release configuration |
| [R9 #168](https://github.com/wojtekpiskorz/kiero/issues/168) | Verify credential-selected Convex identity before mutation | After R8; shares release files |
| [R11 #169](https://github.com/wojtekpiskorz/kiero/issues/169) | Resolve observed Auth.js advisories with pinned Convex Auth compatibility proof | After M2; owns the first dependency update |
| [E8 #170](https://github.com/wojtekpiskorz/kiero/issues/170) | Direct DeepSeek chat/vision, OpenRouter audio/embeddings | After R11 and M2; owner fallback decision remains required |
| [R10 #171](https://github.com/wojtekpiskorz/kiero/issues/171) | Calendar callback returns to the configured PWA | After M2; independently owned Calendar code |

I8 #133 resumes after R9/E8. B5 #134, D7 #135 and I11 #138 then provide auth, media and alert proof. J6 #139 also waits for R10. The remaining I9/I10/I6/J3/J4/J5 graph and acceptance thresholds are preserved. Provisioning progress has not closed I8.

## Accepted owner decisions

- Keep the existing Convex project `kiero-dev-core`. No new project to evade quotas.
- Host the frontend as a separate Workers Static Assets deployment alongside the gateway. Planned web origin: `https://kiero-staging-web.wojtek-524.workers.dev`. It is configured for OAuth returns but has not been deployed. Confirm any proposed hostname change with the owner and update every callback/origin consumer together.
- Use direct DeepSeek API, `deepseek-flash`, for chat, memory analysis and images. Documentation observed this alias as V4.1 Flash. Model aliases are mutable; record date and provider configuration in proof.
- Retain OpenRouter for STT and embeddings. Keep the existing MAI-Transcribe-2/Whisper backup and Qwen3-Embedding-8B 4096-dimensional contract pending actual availability checks. Do not replace them with Groq, Azure or DeepInfra based on earlier research alternatives.
- The owner selected `woji.dev` for Resend. The screenshot showed Verified, Ireland, sending enabled, DKIM and SPF verified. The requested sender is `Kiero <noreply@woji.dev>`; verify the configured nonsecret value before live delivery.
- Persistent Convex/Cloudflare CLI authentication on this VPS is approved. The coordinator owns the map Git lifecycle, cloud setup within the accepted scope, and issue-specific delegation. Production activation is separate.

## Provisioned resources and verified configuration

Convex staging is `wojtek-piskorz-jr:kiero-dev-core:staging`, slug `fiery-raven-417`, ID `5477316`, project ID `2960180`. The management API observed prod type, `aws-eu-west-1`, and `isDefault: false`.

- Client URL: `https://fiery-raven-417.eu-west-1.convex.cloud`
- HTTP Actions origin: `https://fiery-raven-417.eu-west-1.convex.site`
- Google sign-in callback: HTTP Actions origin plus `/api/auth/callback/google`
- Calendar callback: HTTP Actions origin plus `/calendar/oauth/callback`
- EU R2 buckets: `kiero-staging-media`, `kiero-staging-backup`
- Cloudflare account: `5242420e9ad911373b75cda3a416598e`
- EU R2 endpoint: `https://5242420e9ad911373b75cda3a416598e.eu.r2.cloudflarestorage.com`

The GitHub environment `staging` exists. A newly created deployment-scoped key was transferred directly into its secret store. A CLI read using only that credential resolved to `fiery-raven-417`. Prod-type project default variables were empty before creation.

Names-only reads after the owner completed setup confirmed these runtime names and matching `STAGING_` GitHub secrets:

```text
AUTH_GOOGLE_ID
AUTH_GOOGLE_SECRET
RESEND_API_KEY
RESEND_FROM
DEEPSEEK_API_KEY
OPENROUTER_API_KEY
JWT_PRIVATE_KEY
JWKS
KIERO_SERVICE_TOKEN
KIERO_MEDIA_WORKER_TOKEN
KIERO_CALENDAR_TOKEN_KEY
```

GitHub also contains `STAGING_CONVEX_DEPLOYMENT`, `STAGING_CONVEX_DEPLOY_KEY` and the public variable `STAGING_CONVEX_URL`. Convex has `SITE_URL`, `KIERO_CALENDAR_APP_BASE_URL`, `KIERO_CALENDAR_REDIRECT_URI`, `KIERO_ENVIRONMENT` and `KIERO_DEPLOYMENT_LABEL`. The session-signing pair passed an in-memory RS256 signing/verification check using the pinned Auth serialization. These checks establish storage and key format, not deployed auth behavior or successful external calls.

The owner completed Google setup in project `kiero-508611`, including Calendar API, scopes, a Web OAuth client and a test user. The client is External/Testing. The wizard wrote supplied values to both server stores through protected input. Do not ask for credentials in chat or print environment values.

## Preserved work and evidence

The original checkout is `/projects/kiero`, based on main `8c672ecce4ea5d1b431a3094b9b50992082f138a` when this work started. The I8 worktree is `/projects/kiero-worktrees/i8-vps`, branch `codex/kiero-i8-vps`. Its uncommitted files are:

- `docs/evidence/staging/README.md`
- `docs/evidence/staging/candidate.json`
- `docs/evidence/staging/vps-2026-09-14.md`
- `infra/bindings/convex-functions.md`

Those files predate the owner's final OpenRouter retention decision and completion of provider input. Reconcile their pending/provider wording in I8's own PR. They are not part of M2 and must not be discarded or overwritten during a rebase. Existing I8 issue comments record the resource reservation and creation actions:

- https://github.com/wojtekpiskorz/kiero/issues/133#issuecomment-5663379299
- https://github.com/wojtekpiskorz/kiero/issues/133#issuecomment-5663521175

The current M2 worktree is `/projects/kiero-worktrees/m2-vps-map`, branch `codex/kiero-m2-vps-map`. Check its PR state before starting. Resolve an open administration PR before treating its dependent tasks as ready.

Optional VPS scratch files, useful for reproductions but not the only handoff source:

- `/tmp/opencode/kiero-vps-prep-2026-09-14.md`
- `/tmp/opencode/kiero-staging-providers.sh`, completed owner procedure
- `/tmp/opencode/kiero-release-probe/verify-target-report.mjs`
- `/tmp/opencode/kiero-i8-prerequisites/`, earlier release-repair drafts

The [DeepSeek primary-source research](../research/deepseek-direct-api-facts.md) is now committed with the owner's final split-provider amendment. The earlier full-removal options are not selected. Generic OpenAI adapter compatibility and package peer compatibility are research findings, not compiled or live proof.

## Outstanding operator decisions and work

I8 must complete and verify runtime injection on both Convex and Workers. The release workflow currently omits several configured runtime bindings. Remaining names include VAPID and telemetry, plus Worker CI and bucket-scoped R2 credentials. Preserve already-generated service and auth keys; do not rotate them as a setup shortcut.

Cloudflare OAuth returned 403 for billing subscriptions and token management. Obtain an approved mechanism for those operations. A short-lived human-created bootstrap token was proposed, not approved. The final R2 setup needs media RW, backup RW and media RO for backup. A Worker token named staging still has account-level authority.

Confirm staging GM, owner alert recipient, alpha-production reviewer and allowed branches. Suggested identities in the earlier interview were not approvals. Correct the old GitHub branch-policy JSON to the supported `protected_branches` / `custom_branch_policies` fields and the deployment branch-policy endpoint. Configuring production protection does not authorize production deployment.

E8 needs an explicit chat/vision fallback policy. OpenRouter retention covers audio/embeddings only. Select thinking/protocol behavior with proof of tool-history replay, schema decoding and latency; do not silently weaken the fallback acceptance or treat aliases as independent providers.

J4 needs a second real Google account, actual tester phones and physical iPhone/Android coverage, VAPID and more than seven elapsed days. External/Testing Calendar consent expires after seven days, so obtain the owner publishing decision before the uninterrupted observation. Follow Google's actual Branding/verification requirements. Identity-only sign-in has different testing rules.

The accepted aggregate cost policy remains observational alerts at 400/500 PLN monthly. Convex's dated USD 4.50 spend and USD 10/20 warning/disable thresholds describe its existing account settings. Cloudflare billing is not yet verified. I11 and J5 must account for both AI suppliers and all infrastructure.

## Verification and resumption

Preparation at the base revision passed install, typecheck, build, environment/corpus checks and 2287 tests, with five live-provider tests skipped. CLI versions were Convex 1.45.0 and Wrangler 4.130.0; RTK 0.49.0 is installed. Do not rerun login or broad preparation without a reason. Run checks appropriate to every new change.

Start with the live graph and exact claims. Native blockers are the readiness authority:

```bash
rtk proxy git worktree list
rtk proxy gh pr list --state open
rtk proxy npx --no-install convex env list --names-only --deployment wojtek-piskorz-jr:kiero-dev-core:staging
rtk proxy gh secret list --repo wojtekpiskorz/kiero --env staging
```

The Convex command requires installed pinned dependencies and authenticated access. Do not run an unfiltered env list. Separate implementation worktrees do not isolate shared deployments: reserve exact resources, serialize staging schema/configuration/release writers and integrate PRs serially. Preserve existing dev leases `steady-basilisk-613`, `flippant-lemur-146` and `nautical-loris-352` until their ownership is resolved.

The first actual staging release, ordinary auth/mail/media/AI smoke, physical-device matrix and long Calendar qualification are still NOT RUN. Keep mandatory missing evidence open. A provider outage, credential name or synthetic success cannot qualify a later real candidate.
