# AGENTS.md

Kiero is a shared office for a small construction firm: bosses relay information in conversation, and an agent organizes it into company and project knowledge. `CONTEXT.md` is the accepted glossary. Use its terms exactly and flag drift from them.

## Process rules

- Prefix shell commands with `rtk` (e.g. `rtk npm test`). If `rtk` garbles structured output, plain commands are acceptable.
- One issue = one PR. Each session owns exactly one issue, one issue-specific worktree branch and one reviewable PR. GitHub native `blocked_by` relations are readiness authority. Never start work whose blockers are open.
- Independent parallel lanes may run simultaneously when GitHub blockers allow it. Never edit another issue's owned paths; propose a prerequisite instead.
- Do not commit, push, open PRs or mutate issues unless the assignment explicitly makes you the owner of that Git lifecycle.

## Language

- English for code, comments, commit messages and technical docs.
- Polish for product text visible to users (UI copy, examples, product prose). The glossary in `CONTEXT.md` is Polish by nature; do not translate its domain meanings.

## Secrets

- Secrets stay server-side (repository Actions secrets). Never write credential values into files, prompts, comments, logs or evidence. Report only their names, presence and observed behavior.

## Scope

- Kiero's current target is a barebones unstyled PWA. Full UX/UI is a separate design track; do not add styling or UX polish beyond the barebones scope.

## Review

Every PR gets an advisory AI review (`.github/workflows/ai-review.yml`) applying the vendored thermo-nuclear and unslop skills (see `docs/operations/pr-review.md`). It never gates a merge; deterministic checks (once A1 adds `checks.yml`) own mechanical findings.
