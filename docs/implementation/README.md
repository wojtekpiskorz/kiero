# Kiero core implementation package

The application is implemented across 48 integrated historical issues. The 2026-09-12 review identified repairs and missing real-service qualification. The map's native children on GitHub are the prior implementation issues and the registered repair and proof issues.

The target remains a complete accepted core behind an unstyled Polish PWA. Final design integration, production activation and the four-week live alpha remain separate work.

Start with the [live implementation map](https://github.com/wojtekpiskorz/kiero/issues/240) (continuing the closed [archive #15](https://github.com/wojtekpiskorz/kiero/issues/15)) and [coordinator prompt](coordinator-start-prompt.md). GitHub native blockers are readiness authority: query them before selecting work. The committed inventory is a dated snapshot, not a mirror to keep in sync.

The [2026-09-14 VPS resumption record](vps-resumption-2026-09-14.md) is
historical: it superseded the older cloud-setup assumptions, and the
2026-09-15 unblocking session then discharged the credential blockers and
released the full staging stack. Application release is no longer
outstanding; real-service qualification (B5/D7/I11 onward) is.

## Read for the selected task

- [Inventory](inventory.md): all issues, integrated PRs, evidence limits and remaining owners.
- [Dependency graph](dependency-graph.md): repair order, parallel branches and every direct dependency.
- [Execution charter](execution-charter.md): accepted scope, ownership and completion conditions.
- [Proof ownership](proof-ownership.md): P01-P12 evidence boundaries, thresholds and responsible issues.
- [UX coverage](ux-coverage.md): all 61 accepted design-inventory operations and follow-up owners.
- [Review record](../evidence/map-review/2026-09-12.md): verified baseline, defects and test results.
- [Architecture proof cases](../mvp/architecture-proof-matrix.md), [alpha readiness](../mvp/alpha-readiness.md), [contracts](contracts/README.md) and [glossary](../../CONTEXT.md): accepted requirements.

## Current state (2026-09-25)

- **Environments.** Convex runs on the Free plan (ADR
  [mvp-cost-envelope-2026-09](../adr/mvp-cost-envelope-2026-09.md)). `dev/main`
  is `glorious-hawk-339`, `staging` is `outgoing-marlin-429`; the full
  staging stack (web, gateway, media/export/backup workers, Convex
  functions) was released on 2026-09-25 and answers its health checks.
- **Pre-user cadences.** Background jobs run hourly at most and backups
  daily until the first real users exist (ADR amendment 2026-09-25;
  `tests/platform/crons.test.ts` caps the budget).
- **Runtime configuration.** `infra/environments/provision-runtime.mjs`
  sets every generated value. Provider credentials and `KIERO_GM_EMAILS`
  are owner actions (`bash infra/environments/owner-credentials.sh`):
  staging needs all eight; dev optionally takes DeepSeek, OpenRouter,
  Resend and the GM addresses; until they exist, AI analysis, email and Google sign-in fail
  honestly.
- **Tests.** `tests/integration` runs acceptance, the processing pipeline,
  memory corrections and access on an in-process Convex backend.
- **Deferred.** Google Calendar stays beyond v1 (ADR
  [calendar-deferral-2026-09](../adr/calendar-deferral-2026-09.md)).
- **Open work.** The children of [#240](https://github.com/wojtekpiskorz/kiero/issues/240):
  the real-service qualification legs (B5, D7, I9-I11, I6, J3-J6) and the
  telemetry repairs R29/R33. Query their native blockers before starting.

## Resources and unresolved external work

The owner's later [Convex instruction](https://github.com/wojtekpiskorz/kiero/issues/15#issuecomment-5618841487) keeps proof refs under the existing `kiero-dev-core` project and forbids creating projects to escape quota. I8 proved equivalent staging isolation within that constraint; I6 must prove quarantine isolation. If impossible, keep the owning issue OPEN/BLOCKED with the exact owner decision required.

Real credentials, two Google accounts, tester handsets plus iPhone/Android coverage, configured alert destinations and more than seven elapsed days are explicit task prerequisites. Credential presence is not runtime proof. Provision only within the task's authorized scope and use server-side secret stores. The implementation sequence cannot compress the required Google observation interval.

## Completion

Each implementation assignment owns one issue, one issue-specific `codex/` worktree branch and one PR. The coordinator owns Git lifecycle and shared integration. Required evidence belongs in the issue and linked artifacts before closure. A merged PR with outstanding mandatory proof leaves its issue open. Failed qualification creates a concrete prerequisite and native blocker; it does not reduce an accepted threshold.
