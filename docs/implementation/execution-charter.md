# Core execution charter

## Destination

A real Kiero PWA implementing the accepted core for micro construction firms, usable through plain semantic controls to exercise every flow. The final result includes durable data, access control, source-linked AI memory, all accepted integrations and recovery evidence. It is handed to the independent full UX/UI track and alpha preparation with exact completed and outstanding work.

The [planning map](https://github.com/wojtekpiskorz/kiero/issues/1) remains the decision index. The core implementation map is its executable successor. The owner expressly authorized this implementation issue series and independent parallel lanes. Full design is no prerequisite for domain implementation. Closing the planning map does not close the open execution issues.

## Scope and quality

Keep the selected React/Vite/TanStack Router/Query, Convex, Effect 4 RC, TanStack AI, Cloudflare and OpenRouter architecture. Foundational tickets pin and prove published compatible versions. Do not silently replace a selected package or behavior after a failed proof; repair the integration or disclose a concrete decision needed from the owner.

Use typed, validated domain operations for both UI and agent changes. Persistent current fields, immutable revisions and provenance are published atomically. Provider output never authorizes arbitrary database access. Tenant and session authorization applies at every relevant command, query, subscription, file read, external intent and job execution.

The application starts in the company conversation. Voice is a record/stop/send message with optional playback. Text, retained audio and images belong to one immutable source. Project pills are optional context, not mandatory routing; projections preserve one author and original. Clear changes can update memory autonomously; actual ambiguity produces a question. Corrections remain source-backed and cannot be overwritten by an older job.

The unstyled UI uses semantic forms, buttons, lists and plain status/error text. It must support keyboard use, phone capture and responsive overflow without a design-system project. Feature-local controls expose actual operations and state. Final typography, visual language, polished navigation and complete design assets belong to the UX/UI package. Simulated fixtures are suitable for deterministic tests; runtime workflows must reach the real backend and selected providers.

## Initial module layout and ownership

The bootstrap and contract tickets establish these paths before parallel consumers edit them. Paths describe deployment and domain ownership, not a requirement for one class or wrapper per operation.

| Path | Responsibility |
| --- | --- |
| `packages/contracts/` | External commands/results, domain value schemas, operation/event names and version rules |
| `packages/domain/` | Pure semantic rules for findings, projects, work and Calendar projection |
| `packages/runtime/` | Effect execution, checked runtime interfaces, durable stage registration |
| `packages/providers/` | OpenRouter chat/STT/vision/embedding adapters and server-owned routing |
| `packages/agent/`, `packages/retrieval/` | Source-grounded planning/tools and evidence lookup |
| `convex/schema.ts`, `convex/schema/shared.ts` | Schema composition entry and shared value definitions |
| `convex/<domain>/schema.ts`, `convex/<domain>/` | Domain table/index fragments, canonical persistence, authorized functions and stage/event consumers |
| `apps/web/` | Barebones PWA shell and isolated features using the same operations as the agent |
| `apps/gateway/` | Cloudflare authorization gateway and streamed media/upload/OAuth routes |
| `apps/*-worker/` | Bounded media, export and backup Container executors |
| `infra/`, `tools/` | Environment declarations, migrations, recovery and operational scripts |
| `evals/`, `e2e/`, `docs/evidence/` | Independent expected results and repeatable real-system proof |

A2 defines candidate shared operations, table names/value semantics, domain event payloads, durable job envelopes and feature entry signatures. It creates the explicitly listed domain-local schema fragments and central imports. A3 proves the actual runtime conversion, makes any sequential amendments and certifies that baseline before consumers begin. Later domain tickets own their respective fragments through their declared domain paths; a change to shared meaning or composition requires coordinated prerequisite work. Contract placeholders reject unsupported operations honestly and cannot claim successful business work.

Each feature exports through the fixed interface chosen by the foundation. The first text join, full-flow join and final qualification own explicit cross-module composition. A feature cannot close merely because its internal unit tests pass: it must expose its registered entry and prove the producer/consumer seam stated in its issue. Joins verify the complete path, not discover missing ownership after all features are called done.

## Parallel execution rules

- Query GitHub's native blockers immediately before claiming. An issue is ready only when open, unassigned and every blocker is closed. Category letters and numbering are not execution order.
- One agent session owns one issue, one issue-specific worktree branch and one PR. Independent ready issues may run simultaneously. This supersedes any historical global single-ticket convention for this execution map.
- Preserve the issue's owned paths. Shared contract changes, root dependency/lockfile edits, generated clients, the schema composition, router, scheduler and release configuration require explicit ownership. Add a prerequisite for a new shared contract rather than editing it concurrently from two siblings.
- The bootstrap pins the selected toolchain and installs the dependencies used by these lanes. A later new dependency is a small coordinated shared change, never two concurrent lockfile updates. Regenerate Convex output from the integrated schema; generated files are derived output, not parallel handwritten authority.
- Worktrees isolate code, but not cloud resources. Use per-branch preview/dev resources where supported. Otherwise reserve a named shared deployment for one schema/runtime writer and test other lanes locally or against isolated fixtures. The integration environment has one coordinator. Never let parallel deploys replace another lane's schema or secrets.
- Compare current `main` before integration, reconcile through a normal merge, regenerate combined outputs and rerun the affected checks. Merge coordination serializes integration of PRs, not independent implementation work.
- Close an implementation issue only after its change is integrated through the repository's agreed merge flow and its required evidence is attached. Then reconcile newly unblocked work. Remove only the completed issue's worktree after preserving its result; synchronize the canonical checkout without discarding unrelated changes.

## Proofs and early progress

The selected runtime, authorization and durable source publication are proved before their consumers can be declared ready. Fixtures and pure-rule development can proceed independently where the graph allows it. The early real text checkpoint has no artificial dependency on multimodal capture, Calendar, final styling or full-system recovery qualification.

Every proof records exact revision, environment, versions, expected/observed outcomes and a repeatable command or physical-device procedure. Integration failures are not solved by weakening product promises. P01–P12 remain NOT RUN until real evidence changes their status. Tests that mirror helpers without crossing the real module interface cannot discharge an integration proof.

The full-core join combines all capture modes, search, typed extension/task tools and source-backed answers. Later qualification checks providers, physical devices, Calendar beyond one week, notifications, deleted data, exports, recovery and releases. The [readiness contract](../mvp/alpha-readiness.md) defines AI thresholds and tester entry. Core qualification reports any UX integration still outstanding and does not start the live alpha automatically.

## Boundary with the design track

The UX/UI team receives stable operation names, states, permission rules, source semantics, examples, the prototype and the barebones application as it becomes available. They may reorganize presentation and interaction details. If a design needs a new domain operation, different side effect, permission or lifecycle rule, record that change and update the affected schemas, stories, issues and evidence deliberately. Neither team silently changes the accepted meaning of a source, correction, reminder, checklist or calendar copy.

## Scope left for other work

Final visual design and its implementation, public billing, Telegram, live voice conversations, full offline operation, marketing publication, accounting, profitability ranking and additional end-user tiers remain outside this core charter. The ordinary v1 user belongs to one company; the model supports future multiple memberships. GM is explicit and audited. Formal privacy work deferred under Q195 remains deferred.
