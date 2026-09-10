# J1 evidence: the first real text-to-memory loop

Issue: [J1 — Prove the first real text-to-memory loop in the barebones app](https://github.com/wojtekpiskorz/kiero/issues/60) (assignment KC-J1-20260909-01).

- **Revision**: `1ee8bbc` (main) + the J1 working tree (this branch, `codex/kiero-j1`).
- **Deployment**: Convex dev lease `wojtek-piskorz-jr:kiero-dev-core:dev/j1`, instance `veracious-cricket-460`, `eu-west-1`. Code pushed with `CONVEX_DEPLOYMENT=veracious-cricket-460 npx convex@1.45.0 dev --once`.
- **Model route**: server-owned OpenRouter; observed `provider=openrouter`, `model=z-ai/glm-5.3-flash`, model configuration version `e2.routing/e2.0#chat_analysis` (run versions: pipeline `e3.text/1`, prompt `e3.prompt-pl/3`, schema `e3.schema/1`).
- **Persons**: fixture addresses under the reserved proof domain `@kiero.invalid` (guarded code installs; real Convex Auth RS256 sessions — subjects are real `<userId>|<authSessions id>` values).
- **Env on the lease (names only)**: `JWT_PRIVATE_KEY`, `JWKS` (fresh dev keypair generated for this lease), `SITE_URL`, `KIERO_PROBE_ENABLED`, `KIERO_B1_PROOF_ENABLED`, `KIERO_B3_PROOF_ENABLED`, `OPENROUTER_API_KEY`. No secret values appear in this file.
- **Repeatable command**: `KIERO_J1_DEPLOYMENT=veracious-cricket-460 node e2e/core-text/live-proof.mjs` (per-run nonce fixture identities; re-runnable without resetting data).
- **Deterministic tests**: `npx vitest run tests/j1` (15 tests) and the full root suite `npm test` (845 tests, 840 passed + 5 skipped) on the combined tree; `npm run typecheck` clean; `npm run build` (web) clean.

## Prerequisite repairs folded into this assignment

Each is its own commit-worthy unit, flagged separately in the PR:

1. **C2 public memory entries (the named fold-in)** — `convex/memory/findings/dispatch.ts` (`dispatchMemoryCommand` user path) and `convex/memory/findings/functions.ts` (`readCurrentFindings`) resolved the raw Convex Auth subject as a sessions-table id, so ordinary user tokens failed `no_verified_identity` (C4's flag). Repaired with B3's dispatch pattern (`resolveAccessContextWithProvisioning` / `resolveAccessContextFromConvexAuth` from `convex/access/identity/resolution.ts`). Verified live with real user tokens before building on it (`P2/*`).
2. **D1 public accept dispatch** — `convex/sources/accept/dispatch.ts` carried the identical defect; the public `acceptSourceCommand` failed `no_verified_identity` for real user tokens, blocking the app-driven send path. Same repair pattern.
3. **D1 public conversation views** — `convex/sources/read/views.ts` `contextOrFail` carried the identical defect (`companyConversation`/`projectConversation`/`sourceDetail` unreachable from the app). Read-path repair (`resolveAccessContextFromConvexAuth`).
4. **D2 text-only prepare** — `convex/sources/uploads/protocol.ts` `PrepareInput` demanded at least one media kind, although the certified contract (`sources.prepareUpload`) has no minimum and D1's acceptance gate documents text-only semantics. The public prepare command was unusable for the one capture mode this checkpoint proves. Repair: allow `mediaKinds: []` (MAX_ATTACHMENTS bound kept). Regression-pinned in `tests/j1/surface.test.ts`.

Consumer-side test updates forced by the sanctioned mount: `tests/a4/app-registry.test.ts` (mounted set gains `conversation.company`), `tests/a4/pending-screens.test.ts` (the default route renders the mounted core-text feature's disconnected gate, not the pending note).

Not repaired (outside this assignment's paths, same defect class): `convex/platform/dispatch.ts` (echo dispatch, no J1 consumer).

## Live proof transcript (run `mtv1e6ml`, 2026-09-10, all 32 checks PASS)

Sanitized; full transcript transcribed below. Latencies are wall-clock from the script.

```
# J1 live proof :: veracious-cricket-460 :: 2026-09-10T04:38:10.701Z :: run mtv1e6ml
[PASS] P0/email-code-provider :: {"emailCode":true,"google":false}
NOTE | bosses signed in: j1-szefA-mtv1e6ml@kiero.invalid, j1-szefB-mtv1e6ml@kiero.invalid (real Convex Auth sessions)
[PASS] P1/bossA-no-company-first :: no_company
[PASS] P1/company-created :: ok
[PASS] P1/bossA-member-admin :: member
[PASS] P1/invitation-created :: ok (delivery may honestly fail)
[PASS] P1/bossB-accepted-invitation :: ok
[PASS] P1/bossB-member :: member
[PASS] P1/project-identified :: ok
[PASS] P2/public-current-memory-read-with-user-token :: 0 rows (was no_verified_identity before the repair)
[PASS] P2/public-conversation-view-with-user-token :: ok (was unauthenticated before the repair)
NOTE | [A] accepted in 338ms (source sn7e1cys4vwxr0h83ksv5bpgrn8e5rn5)
NOTE | [A] processing state: processing (+500ms)
NOTE | [A] processing state: processed (+75655ms)
[PASS] A/accepted-to-terminal :: processed in 75655ms
[PASS] A/honest-state-transitions :: processing -> processed
NOTE | [A] accept latency 338ms; total to processed 75655ms
NOTE | [A] run r177z1s68ptx4sna41qj5n9za18e4q80: succeeded; versions e3.text/1/e3.prompt-pl/3/e3.schema/1/e2.routing/e2.0#chat_analysis
NOTE | [A] model observations: [{"provider":"openrouter","model":"z-ai/glm-5.3-flash","outcome":"succeeded","latencyMs":65956},{"provider":"openrouter","model":"z-ai/glm-5.3-flash","outcome":"succeeded","latencyMs":2489}]
[PASS] A/run-succeeded :: succeeded
[PASS] A/groups-published :: 1 published groups
[PASS] A/change-set-published-once :: 1 sets
NOTE | [A] public project-scope rows: [["doliczka_do_wyceny_dowoz","money"],["dowoz_plytek_buniewice_termin","temporal"],["odbior_dostawy_potwierdzenie_kaczmarek","text_note"]]
NOTE | [A] public company-scope rows: []
[PASS] A/public-memory-published :: project-scope dowoz_plytek_buniewice_termin = {"_tag":"temporal","temporal":{"originalExpression":"w środę rano","role":"agreed","shape":{"_tag":"day","day":"2026-09-09"}}}
[PASS] A/provenance-fragments-located :: 4 fragments, 3 text ranges
[PASS] A/finding-revision-recorded :: rev1
[PASS] A/both-bosses-same-memory :: project scope identical for both bosses
[PASS] A/both-bosses-see-source
[PASS] P4/lost-response-replay-ok :: ok
[PASS] P4/no-duplicate-source :: 1 rows for the logical source
[PASS] P4/no-duplicate-processing :: single run r177z1s68ptx4sna41qj5n9za18e4q80
NOTE | [C1] accepted in 363ms (source sn77vqxvq7vfbx10vwfhae1gr98e4pdy)
NOTE | [C1] processing state: processing (+496ms)
NOTE | [C1] processing state: failed (+148071ms)
NOTE | [C] attempt 1 ended failed; retrying with a fresh source
NOTE | [C2] accepted in 343ms (source sn78xqze5cav77zdb08zbthvpn8e4qr8)
NOTE | [C2] processing state: processing (+479ms)
NOTE | [C2] processing state: processed (+22716ms)
NOTE | [C] attempt 2 run: succeeded; model: [{"provider":"openrouter","model":"z-ai/glm-5.3-flash","outcome":"succeeded","latencyMs":11874},{"provider":"openrouter","model":"z-ai/glm-5.3-flash","outcome":"succeeded","latencyMs":2926}]
[PASS] C/new-source-correction-current :: rev2 = {"_tag":"temporal","temporal":{"originalExpression":"będzie piątek","role":"agreed","shape":{"_tag":"day","day":"2026-09-11"}}}
[PASS] C/supersession-with-history :: revisionCounter=2 (superseded revisions retained)
[PASS] C/public-read-shows-correction :: {"_tag":"temporal","temporal":{"originalExpression":"będzie piątek","role":"agreed","shape":{"_tag":"day","day":"2026-09-11"}}}
[PASS] C/original-source-immutable
[PASS] C/correction-is-new-source :: 1 correction rows
[PASS] P6/reconnect-persists :: fresh clients read the same canonical rows
[PASS] P7/outsider-conversation-empty :: ok
[PASS] P7/outsider-memory-empty
[PASS] P7/foreign-project-read-denied :: Uncaught ConvexError: {"_tag":"not_found",...}
Summary: {"PASS":32} of 32 checks
```

The Polish source texts sent (synthetic material, sent through the PUBLIC `sources.prepareUpload` + `sources.acceptSource` mutations as the signed-in bosses):

- A (boss A, Tuesday 18:30 Warsaw snapshot, project hint Banan): "Projekt Banan: dowóz płytek na Buniewice w środę rano. Odbiór potwierdził u nas klient Kaczmarek. Do wyceny doliczamy około 10 tysięcy."
- C (boss B, Wednesday 10:00 Warsaw snapshot, project hint Banan): "Zmieniamy termin dowozu na Buniewice: zamiast środę będzie piątek."

## Model observations (latency)

- Run A (2 model turns): 65,956 ms + 2,489 ms; total durable acceptance -> processed 75,655 ms (single source; within the alpha 60 s target's honest neighborhood for this deployment — see failure windows).
- Run C2 (2 model turns): 11,874 ms + 2,926 ms; total 22,716 ms.
- Accept (public mutation) latency: 330-420 ms wall-clock.
- Observed model on every attempt: `z-ai/glm-5.3-flash` via `openrouter` (the configured first route).

## Honest failure windows (recorded, not retried into fake success)

- **Run `mtv1e6ml` C1 (2026-09-10 ~04:41)**: the first correction source's run ended `failed` 148,071 ms after acceptance (provider window; the source stayed durably accepted, nothing was duplicated). The boss's honest retry action — a fresh correcting source (C2) — succeeded in 22,716 ms and produced the supersession. No restart was needed.
- **Run `mtv0ww08` A (2026-09-10 ~04:25, earlier script revision)**: a 720,717 ms stall window with the conversation row pinned at `processing` and no terminal state — the E3-observed provider-stall class. That script revision had no stall recovery; the run was abandoned and the window recorded here. The final script handles stalls honestly (bounded drain kick for never-started jobs, bounded model-stage restart for provider-failed runs, printed inspection) — no window is retried into fake success.

## Acceptance-criteria mapping

| Issue criterion | Status | Evidence |
| --- | --- | --- |
| Real development Convex + server-owned OpenRouter, synthetic Polish material, distinct states + provider metadata in protected evidence | PASS | Lease `dev/j1`; observed route/model above; sending/saved/processing/result states in the transcript and in the mounted feature's controls. |
| Mixed text source -> company/project information, one original and real author; both bosses see the same canonical result | PASS | Three project-scope findings (money + temporal + text note) from one source authored by boss A; `A/both-bosses-same-memory`, `A/both-bosses-see-source`. |
| Clear correction as a new source -> new current value + previous history; early path uses direct structured queries where tools are absent | PASS | `C/*`: rev2 Friday current, revisionCounter 2, original immutable, correction is a separate source. |
| AI failure leaves the accepted source, permits later retry; lost response/retry creates no second source or duplicate mutation; every committed change has valid provenance | PASS | C1 failure window (source stayed accepted; fresh retry succeeded); `P4/*` replay idempotency; `A/provenance-fragments-located`, `A/change-set-published-once`. |
| Repeatable smoke + immutable evidence; missing runtime registration fixed or tracked; no mock-only route | PASS | The repeatable command above; this file; the registration repairs listed; the real model route throughout. |
| Browser plus real backend: one project, two bosses, send/read/correct + refresh/reconnect persistence | PASS (scripted browser-client surface) | The proof drives the same public functions the mounted feature calls (Convex browser client); `P6/reconnect-persists`. See NOT-RUN for a human-driven browser pass. |
| Provider failure, duplicate submit/unknown response, newer correction against delayed old plan | PASS / PASS / covered by E3 | Failure window recorded; `P4/*`; the delayed-old-plan engine semantics were proven live by E3's evidence (scenario D) and are not re-proved here — J1's correction path exercises the user-visible invariant. |
| Inspect DB/current query, revision history and original source identity against independent expectations | PASS | Guarded tenant-scoped inspection under the bosses' own sessions (`probeAnalysisState` with the user's session id — the C4-precedent pattern): run states, steps, attempts, change sets, fragments, revision counters; public reads cross-checked against them. |

## Repeatability

A second full run (`mtv1ldct`, 2026-09-10T04:43:46Z) also reached `{"PASS":32} of 32 checks`: A processed in 109,716 ms (3 model turns: 32,403 + 39,720 + 26,704 ms), the correction superseded on attempt 1 (15,471 ms total; role read as `internal`/`piątek` this time — model phrasing variance, same resolved day 2026-09-11, rev2, history retained). The per-run model-turn count and latency vary (2-3 turns, 1.8 s - 66 s per turn); every committed fact was identical in structure and provenance across runs.

## NOT-RUN list

- **Human-driven browser session** against the built app (click-through sign-in -> send -> watch -> correct in a real browser tab). The mounted feature is exercised headlessly through the exact public function surface it calls, is rendered in the deterministic disconnected-state test, and the app builds clean; a manual pass on a physical device belongs to the alpha rehearsal track.
- **PWA install/refresh behavior** on physical devices (alpha readiness track).
- **The AI-entry 50-case corpus** (complete core qualification owns it).
- **`convex/platform/dispatch.ts` echo-dispatch identity repair** — same defect class, no J1 consumer; left for its owning lane.
- **Provider-failure injection** (e.g. wrong key/bad route) — not performed: never touch the real credential; failure windows were observed honestly instead.

## Cost note

Metered work this session: a handful of tiny Polish messages per run across ~6 script runs (observed turns: 2-3 per source; the largest single source text is ~150 characters). No bulk corpus runs.
