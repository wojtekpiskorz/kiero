# A0 activation evidence: advisory PR review

This is the procedure the coordinator executes and records after the owner adds `ZAI_API_KEY` as a repository Actions secret. File presence or a skipped job is not successful activation: only the observed live run and comment behavior below closes A0. Record every step's links, exact SHAs, timestamps and observed outcomes; record failures as failures.

Setup context: workflow `.github/workflows/ai-review.yml`, operations doc `docs/operations/pr-review.md`, reference `wojtekpiskorz/astroix@d4f1bc218261cf6c76984ca2c384df7f7b5bd80e`.

## 0. Preconditions

1. `ZAI_API_KEY` configured as a repository Actions secret (Settings > Secrets and variables > Actions). Verify presence by name only; never read or print the value.
2. The A0 integration PR exists on `main` (this setup merged through its own PR) or the proof runs on the A0 PR itself before merge. Record which.

## 1. Draft-to-ready handling

1. Open a test PR from a same-repo branch (not a fork).
2. Create it as a draft. Confirm no `AI review` run starts for the draft (opened/synchronize fire on drafts, but the job's `if` skips them. Expect either no run or a skipped job; record which GitHub shows.
3. Mark it ready for review. Confirm an `AI review` run starts from `ready_for_review` and completes.

## 2. Opened / synchronize / reopened triggers

1. Confirm the run from step 1 covers the opened→ready path.
2. Push an empty commit (`git commit --allow-empty -m "trigger: synchronize"`) to the PR branch. Confirm a new run starts (`synchronize`) for the new head SHA and the summary comment is edited in place, not duplicated.
3. Close and reopen the PR. Confirm a run starts (`reopened`).

Record for each: run URL, trigger event, PR head SHA (also check the "Record reviewed PR head SHA" step log and the SHA stated in the summary comment), run conclusion.

## 3. Rapid-push cancellation (publish-at-end)

1. Push commit A to the PR branch; while the run for A is still in progress, push commit B.
2. Confirm the run for A is canceled by the concurrency group (`ai-review-<PR number>`, cancel-in-progress).
3. Confirm the run for B completes and the summary comment reflects B's head SHA.
4. Inspect the comment's edit history and timestamps: the canceled run for A must not have replaced or updated the current summary. Cancellation is asynchronous, so a stale overwrite is possible only in a seconds-wide race at the posting instant; the head SHA recorded in each summary plus the edit history are the detection mechanism.

Record: both run URLs (one canceled, one completed), both head SHAs, comment edit history link.

## 4. Defect + slop fixture round

1. Replace `docs/evidence/pr-review/smoke-fixture.md` content into the PR (or add it as the PR's changed file) and push. This is the labeled intentional fixture: a TypeScript engineering defect (sequential awaits over independent items, an unchecked `as any` cast, a swallowed error) and heavily slopped English prose, plus one correct Polish product sentence.
2. Let the review complete. Confirm the summary flags the engineering defect via the thermo-nuclear standard and the slopped prose via unslop, and that the Polish sentence is not flagged as a problem.
3. Confirm exactly one advisory summary comment exists, stating the reviewed head SHA, with inline comments only for high-conviction findings.

## 5. Fix round

1. Apply the corrected content (prepared as `smoke-fixture.corrected.md` in the implementation worktree only, never committed: defect fixed, slop rewritten plainly, Polish sentence unchanged) and push.
2. Confirm the same summary comment is edited in place (no new thread), the corrected findings disappear, and any new high-conviction findings remain reportable.
3. If any finding is explicitly rejected/overruled in the thread, push once more and confirm the reviewer keeps that ruling closed.

## 6. Required checks and permissions inspection

1. Inspect the repository's branch protection / required status checks: confirm `AI review` is not a required check and cannot block a merge.
2. Confirm the workflow's permissions are `contents: read`, `pull-requests: write` and that the review job cannot write repository code. Document any GitHub Actions permission restriction as a concrete setup blocker if one appears.

## 7. Missing-secret diagnosis (isolated validation)

Only if a disposable environment is available (otherwise record as NOT RUN with reason): temporarily remove the secret (or validate in a scratch repo with the workflow only) and confirm the job fails with the `ZAI_API_KEY not configured` error message and never prints a value. Restore the secret afterwards. Redact all authentication data from any captured logs.

## 8. Record

Collect in this directory: run links for every scenario above, comment permalink and edit history, head SHAs per run, exact workflow configuration (commit of `.github/workflows/ai-review.yml` used), observed outcomes (including any provider/model failures: record them as operational failures, never as completed reviews), and any remaining setup blocker. `smoke-fixture.corrected.md` existed only in the local worktree and was never part of repository history; nothing to delete in the tree. Delete `smoke-fixture.md` before merge if the coordinator prefers a clean evidence tree. Record whichever choice was made.
