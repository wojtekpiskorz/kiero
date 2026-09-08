# Kiero core implementation package

Build the complete accepted core behind an unstyled, functional PWA. The owner wants real data and real processing early, while full UX/UI is developed separately from the [UX/UI package](../handoffs/ux-ui/README.md). This package is an execution plan; no application implementation or provider proof has run during chartering.

Live tracker: [Implementation map: Kiero core MVP and barebones PWA](https://github.com/wojtekpiskorz/kiero/issues/15). Its 50 native sub-issues contain the full implementation scopes; native blockers determine which work can start.

Read in this order:

1. [Execution charter](execution-charter.md) for scope, module ownership, parallel work and completion.
2. [Dependency graph](dependency-graph.md) for the initial lanes, early checkpoint and final joins. Re-query native GitHub dependencies before claiming work; the generated graph is a snapshot.
3. [Issue manifest](issues.json) for complete ticket content and direct prerequisites. The live linked issue is the execution record.
4. [Architecture](../mvp/architecture-design.md), [proof matrix](../mvp/architecture-proof-matrix.md), [alpha readiness](../mvp/alpha-readiness.md) and the resolutions named by the selected ticket.

[UX coverage](ux-coverage.md) maps all 61 design-inventory entries to core owners. [Proof ownership](proof-ownership.md) maps every P01–P12 proof to its implementation and qualification tickets.

## Start another agent

> Implement one currently unassigned, open, unblocked issue from the Kiero core implementation map. First read its complete body, the execution charter, its linked contracts and the live checkout. Claim only that issue, create an issue-specific `codex/` worktree branch, and preserve unrelated changes. Deliver the issue's real behavior through its declared module interface and barebones Polish controls where specified. Use the selected Convex/Effect/Cloudflare/OpenRouter architecture and prove the stated integration. Record failures honestly and keep secrets server-side. Before editing a shared contract or another issue's paths, resolve ownership and add the necessary prerequisite rather than silently widening the task. Open one reviewable PR with focused evidence. Independent ready issues may run in parallel; their merges and shared generated files are coordinated. Reconcile live blockers after integration. Do not implement final styling or substitute prototype simulations for real behavior.

## PR review before implementation

A0 installs the Astroix-style advisory thermo-nuclear and unslop review. It is the first ready issue; A1, E1 and I1 depend on it and can run concurrently once it is integrated and proved. The review uses the repository Actions secret `ZAI_API_KEY`, separately from the application OpenRouter key. Add it interactively with `rtk proxy gh secret set ZAI_API_KEY --repo wojtekpiskorz/kiero`. The issue specifies the reference files and live PR evidence required for activation.

## First useful checkpoint

The text lane reaches real sign-in and company access, durable source acceptance, OpenRouter analysis, typed memory publication, project/source views and correction before waiting for audio, photo, Calendar or final design. The [dependency graph](dependency-graph.md) identifies its join. Later tickets add all remaining core requirements and then qualify the assembled system.

## Existing local capabilities

At chartering, `/Users/woji/Dev/Kiero/.env` contained an `OPENROUTER_API_KEY` assignment and GitHub exposed a repository secret with that name. Only presence was inspected. Wrangler was on PATH; a global `convex` executable was not. The owner reports Convex CLI access. The environment-preparation ticket must resolve the actual pinned CLI invocation and verify project/account access without printing credentials.

Do not copy `.env` into commits, issue bodies, fixtures, browser bundles or logs. Worktree setup must use an explicit ignored development secret path or environment injection; it must not assume the root's untracked file follows a new worktree. The GitHub secret does not automatically configure Convex or Workers. Provision each runtime's server-side binding through the relevant ticket and keep development, staging and production separated.
