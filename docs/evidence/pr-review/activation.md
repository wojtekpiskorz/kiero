# A0 activation evidence record

Live activation record for the advisory AI review on PR #66 (the A0 setup PR itself), per the procedure in `README.md`. All times UTC. Coordinator: implementation-coordinator goal, assignment `KC-A0-20260909-01`.

## Configuration under test

- Workflow: `.github/workflows/ai-review.yml`, claude-code-action pinned `anthropics/claude-code-action@62529b7c89dbb8cfaa838f2c87f2f8459b46fe68` (v1).
- Models: reviewer `glm-5.3`, Opus/Sonnet map `glm-5.3`, Haiku map `glm-5.3-flash`; endpoint `https://api.z.ai/api/anthropic`; `API_TIMEOUT_MS=3000000`; effort max.
- Secret `ZAI_API_KEY`: present as a repository Actions secret (verified by name via `gh secret list`; value never read or printed).
- Repository: private, no branch protection on `main` (checked 2026-09-08 UTC via the branches/protection API: 404 not protected), so no required status checks exist; advisory review cannot block a merge.

## Setup diagnosis history (startup failure, found and fixed live)

- Push of `b9e6897` (first workflow version) produced two 0-second failed runs ([34287667843](https://github.com/wojtekpiskorz/kiero/actions/runs/34287667843), [34287931063](https://github.com/wojtekpiskorz/kiero/actions/runs/34287931063)): event `push`, zero jobs, no logs, no annotations. Signature of a workflow validation failure.
- Diagnosis by bisection on probe branches (draft PRs #67/#68, closed without merge, branches deleted):
  - #67 carried the exact Astroix reference workflow: run [34288001600](https://github.com/wojtekpiskorz/kiero/actions/runs/34288001600) was created and the job was skipped (draft), proving the file validates on this repository and the account can run Actions.
  - #68 removed only the `Diagnose missing ZAI_API_KEY` step: run [34288063657](https://github.com/wojtekpiskorz/kiero/actions/runs/34288063657) created and skipped, isolating the cause to that step's `if: ${{ secrets.ZAI_API_KEY == '' }}` (the `secrets` context is not accepted there by workflow validation).
- Fix in `6b86ccc`: the check resolves the secret into step `env` and tests emptiness in the shell. Identical runtime behavior and message; never prints the value.

## Draft skipping (procedure §1)

- Probe PRs #67/#68 were created as drafts: runs were created with the job skipped, proving the draft `if` guard (no review runs on WIP pushes).
- PR #66 was created as a draft while the workflow was still invalid (no run possible) and marked ready before the fix landed; the `ready_for_review` trigger is exercised on the valid workflow later in this record (see below).

## Round 1: defect and slop fixture (procedure §4)

- Trigger: `synchronize` on head `6b86ccc`. Run [34288166491](https://github.com/wojtekpiskorz/kiero/actions/runs/34288166491), event `pull_request`, completed success in 6m42s.
- Summary comment posted by `github-actions[bot]` ([comment permalink](https://github.com/wojtekpiskorz/kiero/pull/66#issuecomment-5593045545)), stating the reviewed head SHA.
- Observed findings, all as designed:
  - thermo-nuclear flagged the fixture's sequential-await loop over independent fetches with a swallowed catch, and the unchecked `as any` cast without a `res.ok` check.
  - unslop flagged the planted slop paragraph.
  - The correct Polish product sentence was checked against `CONTEXT.md` and not flagged.
- Operational finding by the reviewer (accepted, fixed in round 2): `gh pr view <PR> --comments` fails with the job token (`Resource not accessible by integration`, statusCheckRollup scope); prescribed `gh pr view --json body,comments` instead, verified live in round 2.
- Model routing confirmed from the job environment log: base URL `https://api.z.ai/api/anthropic`, token masked, model envs `glm-5.3`/`glm-5.3-flash` as configured.

## Round 2: fix round (procedure §5)

- Trigger: `synchronize` on head `3152e2c`. Run [34288896167](https://github.com/wojtekpiskorz/kiero/actions/runs/34288896167), completed success in 5m37s.
- The round-1 summary comment was edited in place (same comment ID, no duplicate thread); the body states round 2 and the new head SHA.
- All four round-1 findings verified fixed and dropped; the recovery command fix was confirmed live (the reviewer used the JSON form successfully this round).
- New round-2 findings (accepted, fixed in the next push): two em dashes in the workflow prompt line, em dashes in the PR description, and an evidence-trail gap about the never-committed `smoke-fixture.corrected.md`.
- Structural limitation recorded by the reviewer: byte-identity of vendored skills against the pinned Astroix commit cannot be verified from the review job (allowlist has no `gh api`); local verification: `cmp` of all five vendored/copied files against `/Users/woji/Dev/playground/Astroix` at `d4f1bc2` returned identical during A0 implementation.

## Cancellation, ready_for_review and reopened (procedure §1-§3)

Rapid-push cancellation:

- The pushes of `110ac9c` and `95a375e` landed seconds apart; GitHub created only one run, for the final head `95a375e` ([34289481159](https://github.com/wojtekpiskorz/kiero/actions/runs/34289481159)). No intermediate run existed to cancel, so cancellation was not exercised by this pair.
- While run 34289481159 was in flight, the empty trigger commit `e39c1e5` ("trigger: exercise rapid-push cancellation", sanctioned by README §2.2) was pushed. Run [34289481159](https://github.com/wojtekpiskorz/kiero/actions/runs/34289481159) (head `95a375e`) ended `completed/cancelled`, and run [34289580963](https://github.com/wojtekpiskorz/kiero/actions/runs/34289580963) (head `e39c1e5`) ran to `completed/success`.
- The canceled run posted nothing: the thread kept exactly one `github-actions` summary comment throughout, and its next edit came from the completed run 34289580963 (round 3), whose body names head `e39c1e5`. No stale overwrite of the round-2 summary was observed.

Draft cycle and ready_for_review on the valid workflow:

- PR #66 was converted back to draft between runs 34289580963 and 34290102826; no run was created for the conversion (`converted_to_draft` is not a subscribed event).
- Marking it ready fired `ready_for_review`: run [34290102826](https://github.com/wojtekpiskorz/kiero/actions/runs/34290102826) on head `e39c1e5`, `completed/success`, editing the same summary comment in place.
- Earlier draft-skip proof on valid files: probe PRs #67/#68 (draft) created runs with the job skipped (34288001600, 34288063657).

Reopened:

- PR #66 was closed and reopened; run [34290629218](https://github.com/wojtekpiskorz/kiero/actions/runs/34290629218) on head `e39c1e5` started from the `reopened` event, `completed/success`, same single summary comment edited in place.

Comment edit history: one summary comment ([permalink](https://github.com/wojtekpiskorz/kiero/pull/66#issuecomment-5593045545)) was created by round 1 and edited in place by every later round; each body states its reviewed head SHA. Round 5 (reopened run) correctly re-reported the two still-unpushed accuracy defects; the fixes land in this final evidence push and the next completed round verifies them dropped.

## Missing-secret diagnosis (procedure §7)

NOT RUN. No disposable environment was available: the live repository secret is in active use by this very workflow, and removing it to force the red path would disrupt the activation runs recorded above. The diagnosis step exists in the workflow (env-based emptiness check, `::error` annotation, `exit 1`), and the construct was exercised indirectly: the step originally used a step-level `secrets` if, which failed workflow validation outright (see the setup diagnosis history), proving the pre-flight step participates in every run. A future isolated validation in a scratch repo remains open if the owner wants it; it is not required for A0 closure per the README's own conditional ("only if a disposable environment is available").

## Vendoring provenance

Local byte-comparison (`cmp`) during implementation: all five files (both `SKILL.md`, both `LICENSE`, skills `README.md` provenance against the stated commit) verified against the Astroix checkout at `d4f1bc218261cf6c76984ca2c384df7f7b5bd80e`. The runner cannot repeat this (allowlisted tools only); the review records the limitation rather than claiming verification.

## §8 choices

`smoke-fixture.md` stays in the evidence tree after merge: it is the input half of the fixture-round record, and its body now carries the post-fix content with a pointer to the defect-round history.
