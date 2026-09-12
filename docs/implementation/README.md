# Kiero core implementation package

The application is implemented across 48 integrated historical issues. The 2026-09-12 review identified repairs and missing real-service qualification. The map now tracks 67 native children: 52 prior implementation issues, 14 new repair/proof issues and the M0 reconciliation task. Eighteen implementation and qualification issues remain after M0.

The target remains a complete accepted core behind an unstyled Polish PWA. Final design integration, production activation and the four-week live alpha remain separate work.

Start with the [live implementation map](https://github.com/wojtekpiskorz/kiero/issues/15) and [coordinator prompt](coordinator-start-prompt.md). Before selecting work, run `rtk proxy node docs/implementation/audit-map.mjs --remote` from a clean, current checkout. GitHub native blockers are readiness authority; this committed inventory is a dated cache.

## Read for the selected task

- [Inventory](inventory.md): all issues, integrated PRs, evidence limits and remaining owners.
- [Dependency graph](dependency-graph.md): repair order, parallel branches and every direct dependency.
- [Execution charter](execution-charter.md): accepted scope, ownership and completion conditions.
- [Proof ownership](proof-ownership.md): P01-P12 evidence boundaries, thresholds and responsible issues.
- [UX coverage](ux-coverage.md): all 61 accepted design-inventory operations and follow-up owners.
- [Full manifest](issues.json): canonical cached issue bodies, hashes, identities and native edges.
- [Review record](../evidence/map-review/2026-09-12.md): verified baseline, defects and test results.
- [Architecture proof cases](../mvp/architecture-proof-matrix.md), [alpha readiness](../mvp/alpha-readiness.md), [contracts](contracts/README.md) and [glossary](../../CONTEXT.md): accepted requirements.

## Next implementation work

After M0 closes, R1, R4, R6 and R7 have no open native blockers. Claim only an unassigned issue after a fresh dependency and ownership audit. Root order is a scheduling opportunity, not a promise of available accounts or cloud capacity.

R1-R3 repair clarification provenance, purge and push delivery. R4 protects source reassignment against stale editors. R5 fixes old-source links. R6 replaces the broken/placeholder release path with executable tooling. R7 removes the known Calendar test timing flake while preserving timeout assertions.

I8 establishes an isolated real qualification environment after R6. B5, D7 and I11 then prove actual identity, media and alert delivery. I9 proves export, I10 proves complete scheduled backups, I6 proves quarantined restore, and J6 rechecks the joined repaired application. J3 and J4 qualify AI and physical devices/Google. J5 audits complete core delivery.

## Resources and unresolved external work

The owner's later [Convex instruction](https://github.com/wojtekpiskorz/kiero/issues/15#issuecomment-5618841487) keeps proof refs under the existing `kiero-dev-core` project and forbids creating projects to escape quota. I8 must prove equivalent staging isolation within that constraint; I6 must prove quarantine isolation. If impossible, keep the owning issue OPEN/BLOCKED with the exact owner decision required.

Real credentials, two Google accounts, tester handsets plus iPhone/Android coverage, configured alert destinations and more than seven elapsed days are explicit task prerequisites. Credential presence is not runtime proof. Provision only within the task's authorized scope and use server-side secret stores. The implementation sequence cannot compress the required Google observation interval.

## Completion

Each implementation assignment owns one issue, one issue-specific `codex/` worktree branch and one PR. The coordinator owns Git lifecycle and shared integration. Required evidence belongs in the issue and linked artifacts before closure. A merged PR with outstanding mandatory proof leaves its issue open. Failed qualification creates a concrete prerequisite and native blocker; it does not reduce an accepted threshold.
