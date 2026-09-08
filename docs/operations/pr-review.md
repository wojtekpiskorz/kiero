# Advisory PR review

`.github/workflows/ai-review.yml` runs an advisory AI review on every eligible Kiero PR. It is the Kiero adaptation of the verified Astroix AI review (reference: `wojtekpiskorz/astroix` at `d4f1bc218261cf6c76984ca2c384df7f7b5bd80e`); the vendored skills and their provenance live under `.agents/skills/`.

## What triggers it

`pull_request` events: `opened`, `synchronize`, `reopened`, `ready_for_review`. The workflow uses `pull_request`, never `pull_request_target`: the job must not run with privileged secrets against untrusted PR code.

Skipped:

- Draft PRs (`opened`/`synchronize` still fire on drafts; `ready_for_review` re-triggers the review once the PR goes live).
- Fork PRs (GitHub withholds secrets and write permissions from them, so a run there can only fail and read like a broken gate).

Each PR has its own concurrency group (`ai-review-<PR number>`) with `cancel-in-progress: true`, so a rapid push cancels the superseded run and the quota follows the latest head. The job timeout is 30 minutes.

## What it reviews

The reviewer reads `.agents/skills/thermo-nuclear-code-quality-review/SKILL.md`, `.agents/skills/unslop/SKILL.md`, `AGENTS.md` and `CONTEXT.md` from the checkout first, then inspects the full PR diff plus the relevant surrounding files (via `gh pr diff`, `gh pr view` and file reads), not the diff in isolation.

- Engineering choices go through the thermo-nuclear standard: abstraction quality, spaghetti growth, missed code-judo simplifications. Its Output Expectations and Approval Bar govern findings.
- Prose goes through unslop: any prose the PR adds (docs, comments, titles) and the reviewer's own output. Polish product text is judged against `CONTEXT.md`, not against the English AI-tell list. Polish is the product language, not slop.
- Deterministic findings are not the reviewer's job. This pre-application repository has no deterministic checks yet; A1 will add `checks.yml` and own mechanical findings from then on.

Rounds are stateless. Each run recovers prior rounds from the PR thread (`gh pr view --json body,comments`; the default human-readable view also fetches the status-check rollup, which the job token cannot read, so use the JSON form): findings whose fixes landed are verified where the fix actually lives (current diff, branch, or `origin/main`) and dropped; findings explicitly rejected or overruled on the thread stay closed. The full diff is re-inspected every round regardless.

## What it posts

One advisory summary comment per PR, edited in place across pushes via `gh pr comment <PR> --edit-last --create-if-none --body-file -`. The summary states the reviewed PR head SHA. Inline comments (`mcp__github_inline_comment__create_inline_comment`) are reserved for high-conviction, actionable findings; if nothing is worth raising, the summary says that briefly instead of inventing nits.

The review is publish-at-end: the summary is posted as the final action of the session. A run canceled by a newer push posts nothing, so a superseded run almost never replaces the current summary. Cancellation is asynchronous: a run at its final posting instant races the cancel and could edit the newer summary, but that window is seconds against a minutes-long run, and the head SHA recorded in each summary plus the comment's edit history exist to catch exactly that.

## Advisory-only status

- The review is never added to required status checks. It cannot block a merge.
- Findings never fail deterministic CI; they are comments only.
- The reviewer does not edit code, push commits, merge, approve or request changes.

## Failure behavior

- Missing `ZAI_API_KEY`: a pre-flight step fails the job with a clear setup diagnosis (where to configure the repository secret) without printing the value. This is an operational failure, visible as a red job, never a completed review and never a silent skip.
- Authentication, provider (Z.AI endpoint) or runner failures surface as operational failures in the run log. They must be recorded as failures in evidence; they are not "reviews with zero findings".

## Security posture

- Same-repository PR contributors are treated as trusted for this credential-bearing job; draft/fork skipping and `contents: read` + `pull-requests: write` permissions keep the exposure bounded.
- `ZAI_API_KEY` is scoped to the review job's environment (`ANTHROPIC_AUTH_TOKEN` → `https://api.z.ai/api/anthropic`) and the action's `anthropic_api_key` input; it is never written to files, prompts, comments or evidence.
- The checkout step sets `persist-credentials: false`, so the checkout token does not linger as a write credential; posting uses the workflow's own `github.token` (comments appear as `github-actions[bot]`, no Claude GitHub App required).
- The claude-code-action is SHA-pinned (`62529b7c89dbb8cfaa838f2c87f2f8459b46fe68`, v1) because it is the one step holding a PR-write token and a paid API key; tag movement must not swap code under it silently. The reviewer's tools are constrained to an explicit allowlist: one inline-comment MCP tool plus `gh pr comment/diff/view`.

## Evidence

Activation evidence (live run, comment behavior, cancellation, fix round) is recorded under `docs/evidence/pr-review/`.
