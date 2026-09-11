# J2 node live-proof transcripts (issue #61)

Sanitized: states, revision ids, latency windows and Polish product text only; no tokens, no secrets. Two complete runs of `node e2e/core-flow/live-proof.mjs` are recorded: run A (the first complete pass after the environment repairs) and run B (the final pass with the bounded-restart hardening). Ambient provider windows differ between the runs and both are recorded: never retried into fake success.

## Run A: 2026-09-11T11:08:07Z, nonce mtwuri3e, 42 PASS / 2 FAIL of 44

```text
[PASS] P0/email-code-provider :: {"emailCode":true,"google":false}
[PASS] P0/gateway-health-backend-reachable :: runtime a3.0
NOTE | bosses signed in (real Convex Auth sessions): j2-szefA-mtwuri3e@kiero.invalid, j2-szefB-mtwuri3e@kiero.invalid; outsider j2-obcy-mtwuri3e@kiero.invalid
[PASS] P1/company-created :: ok
[PASS] P1/invitation-created :: ok
[PASS] P1/bossB-accepted-invitation :: ok
[PASS] P1/project-banan :: ok
[PASS] P1/project-kaczmarek :: ok
[PASS] A/myTaskReminders-under-user-token :: ok (was unauthenticated before the repair)
[PASS] A/pushState-under-user-token :: vapidConfigured=false
[PASS] A/readStateForSources-under-user-token :: ok (was unauthenticated before the repair)
[PASS] B1/mixed-source-accepted :: tn7fcxacndp389rr6qzvfnnzas8e6vby
[PASS] B2/voice-only-accepted-empty-author-text :: tn726chvb2xkdp5se4mn7vjd0x8e7vra
[PASS] B3/empty-text-without-media-refuses-author_text_empty :: author_text_empty
NOTE | [mixed] processing state: processing (+528ms)
NOTE | [mixed] processing state: processed (+73468ms)
[PASS] B1/mixed-source-terminal-state :: processed
NOTE | [voice] processing state: processing (+157ms)
NOTE | [voice] processing state: processed (+420424ms)
[PASS] B2/voice-only-terminal-state :: processed
[PASS] B1/mixed-dossier-transcript-state-explicit :: transcripts planning (planning = explicit unresolved on this lease)
[PASS] B1/mixed-dossier-vision-never-claimed-without-retained :: visionOrders 0; retained=false (no vision work is claimed without a retained representation)
[PASS] B1/mixed-source-multi-project-links :: linked 1 project(s)
[PASS] B2/voice-only-dossier-has-transcript-no-text-claim :: transcripts planning; authorText empty
[PASS] B2/stash-channel-transcript-ordered :: ok
[PASS] B2/real-stt-transcribes-the-voice-only-source :: state complete; 3/3 segments with text (first: "Dzień dobry. Wycena dla projektu Banan 27 000.")
[PASS] C/acceptance-key-replay-returns-original-source :: replay -> tn726chvb2xkdp5se4mn7vjd0x8e7vra; rows 1 -> 1
[PASS] D/question-source-accepted :: tn7ckxzddpv6szfeggdyb8jmmx8e77j9
NOTE | D/grounded-question outcome=answered turns=1 models=["z-ai/glm-5.3-flash"] latency=27847ms
[PASS] D/grounded-question-answered-or-honestly-not :: outcome answered (27847ms)
[PASS] D/answered-statements-cite-evidence :: 2 statement(s), first basis direct
NOTE | [ambig-base] processing state: processed (+78028ms window; failed first, honest window)
NOTE | [ambig-conflict] processing state: processed (+118394ms)
NOTE | D/ambiguous-question outcome=answered
[PASS] D/ambiguous-question-clarified-or-answered :: outcome answered
[PASS] E/correction-source-accepted :: tn70271qz17y84xmkgrb7fx5z98e6y9a
NOTE | [correction] processing state: processed (+16321ms)
[PASS] E/correction-published-current-value :: {"_tag":"money","money":{"amount":{"_tag":"exact","value":"6000"},"certainty":"exact","currency":"PLN","currencyOrigin":"stated","role":"deposit_received","taxBasis":"not_specified"}}
[FAIL] E/correction-keeps-history :: 0 revision(s) retained   <- script bug (read the wrong field shape), fixed for run B
NOTE | [corroboration] processing state: processed (+125977ms)
[FAIL] F/search-finds-evidence-before-withdrawal :: 0 hit(s)  <- no index generation had been built yet, fixed for run B
[PASS] F/withdrawal-accepted :: ok
[PASS] F/withdrawn-source-lifecycle-explicit :: lifecycle withdrawn
[PASS] F/withdrawn-source-stays-in-history :: the original stays in the conversation
[PASS] F/independent-corroboration-survives-withdrawal :: state {"_tag":"unknown","reason":"source_withdrawn: ..."}
[PASS] F/search-runs-after-withdrawal :: query ok
[PASS] G/queued-source-from-bossB-accepted
[PASS] G/membership-revoked :: ok
[PASS] G/revoked-member-core-read-refuses-immediately :: conversation no_verified_identity, reminders no_verified_identity
[PASS] H/task-created :: ok
[PASS] H/checklist-item-added :: ok
[PASS] H/checklist-item-done :: ok
[PASS] H/checklist-independence-parent-untouched :: parent todo 1/1
[PASS] H/snooze-under-user-token :: ok
[PASS] H/co-teraz-read-after-join :: ok

Summary: {"PASS":42,"FAIL":2} of 44 checks
```

## Run B (final): 2026-09-11T12:19:57Z, nonce mtwxbw3a, 41 PASS / 4 FAIL of 45

```text
[PASS] P0/email-code-provider :: {"emailCode":true,"google":false}
[PASS] P0/gateway-health-backend-reachable :: runtime a3.0
[PASS] P1/company-created :: ok
[PASS] P1/invitation-created :: ok
[PASS] P1/bossB-accepted-invitation :: ok
[PASS] P1/project-banan :: ok
[PASS] P1/project-kaczmarek :: ok
[PASS] A/myTaskReminders-under-user-token :: ok (was unauthenticated before the repair)
[PASS] A/pushState-under-user-token :: vapidConfigured=false
[PASS] A/readStateForSources-under-user-token :: ok (was unauthenticated before the repair)
[PASS] B1/mixed-source-accepted :: tn75a8nkmay2ytj3czg2byhgfn8e7kd0
[PASS] B2/voice-only-accepted-empty-author-text :: tn70sd28mzqv40n9gy82mz2x0x8e6wjt
[PASS] B3/empty-text-without-media-refuses-author_text_empty :: author_text_empty
NOTE | [mixed] processing state: processed (+105303ms)
[PASS] B1/mixed-source-terminal-state :: processed
NOTE | [voice] processing state: processed (+129871ms)
[PASS] B2/voice-only-terminal-state :: processed
[PASS] B1/mixed-dossier-transcript-state-explicit :: transcripts planning
[PASS] B1/mixed-dossier-vision-never-claimed-without-retained :: visionOrders 0; retained=false
[PASS] B1/mixed-source-multi-project-links :: linked 1 project(s)
[PASS] B2/voice-only-dossier-has-transcript-no-text-claim :: transcripts planning; authorText empty
[PASS] B2/stash-channel-transcript-ordered :: ok
[PASS] B2/real-stt-transcribes-the-voice-only-source :: state complete; 3/3 segments with text (first: "Dzień dobry. Wycena dla projektu Banan 27 000.")
[PASS] C/acceptance-key-replay-returns-original-source :: replay -> tn70sd28mzqv40n9gy82mz2x0x8e6wjt; rows 1 -> 1
NOTE | D/grounded-question outcome=answered turns=1 models=["z-ai/glm-5.3-flash"] latency=16461ms
[PASS] D/grounded-question-answered-or-honestly-not :: outcome answered (16461ms)
[PASS] D/answered-statements-cite-evidence :: 2 statement(s), first basis direct
NOTE | [ambig-base] processed (+205293ms)
NOTE | [ambig-conflict] processed (+400034ms)
NOTE | D/ambiguous-question outcome=answered
[PASS] D/ambiguous-question-clarified-or-answered :: outcome answered
[PASS] E/correction-source-accepted :: tn70eyckmy7ez8qk4g4vk8v71s8e681d
NOTE | [correction] processing state: failed (+140103ms)
NOTE | [correction] HONEST FAILURE WINDOW: provider-failed run; one bounded model-stage restart
NOTE | [correction] restart: ok
NOTE | [correction-restart] processing state: failed (+128263ms)
[FAIL] E/correction-published-current-value :: value stayed 5000 (provider window persisted through the one restart; the same scenario PASSED in run A with 6000 published in 16s)
[FAIL] E/correction-keeps-history :: 1 revision(s) retained (the failed correction published no second revision; run A published the 6000 correction)
NOTE | [corroboration] processing state: processed (+30889ms)
[FAIL] F/index-generation-started :: generation_already_building  <- see README: an E5 build generation is stuck building on this lease and its GLOBAL one-at-a-time lock refuses every later generation
[FAIL] F/search-finds-evidence-before-withdrawal :: 0 hit(s) (no ACTIVE index generation; E5's honest coverage disclosure reads "degraded")
[PASS] F/withdrawal-accepted :: ok
[PASS] F/withdrawn-source-lifecycle-explicit :: lifecycle withdrawn
[PASS] F/withdrawn-source-stays-in-history :: the original stays in the conversation
[PASS] F/independent-corroboration-survives-withdrawal :: state {"_tag":"known"}
[PASS] F/search-runs-after-withdrawal :: query ok (0 current hits, coverage degraded)
[PASS] G/queued-source-from-bossB-accepted
[PASS] G/membership-revoked :: ok
[PASS] G/revoked-member-core-read-refuses-immediately :: conversation no_verified_identity, reminders no_verified_identity
[PASS] H/task-created :: ok
[PASS] H/checklist-item-added :: ok
[PASS] H/checklist-item-done :: ok
[PASS] H/checklist-independence-parent-untouched :: parent todo 1/1
[PASS] H/snooze-under-user-token :: ok
[PASS] H/co-teraz-read-after-join :: ok

Summary: {"PASS":41,"FAIL":4} of 45 checks
```

## Observed latencies (honest windows)

- Acceptance (prepare+accept): under 1 s in every run.
- Full text processing: 16 s to 400 s across runs and sources (2-3 model turns plus queue scheduling); the alpha 60 s target was met on fast runs and exceeded on slow ones, matching the J1/E4 evidence's observation range.
- Real STT (proof_inline channel, 3 segments): completed within the 6-minute watch window in both recorded runs.
- Answer loop (askAgent): 10-34 s when the provider answered; provider windows produced honest provider_failed runs and, in one browser-leg window, an action that did not resolve within the 200 s watch (recorded, not retried into success).
