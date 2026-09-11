# J2 core-flow live evidence (issue #61)

The full-flow join's focused verification against the REAL leased dev deployment. Deterministic coverage lives in `tests/j2` (26 tests) plus the amended `tests/a4`, `tests/d4` and the full root suite; this directory records the LIVE evidence.

## Environment

- Convex lease: `wojtek-piskorz-jr:kiero-dev-core:dev/j2`, instance `zany-snail-540` (eu-west-1), created for this lane at base revision `2575c85` plus this branch's J2 worktree changes (pushed with `npx convex@1.45.0 dev --once`).
- Gateway Worker: `kiero-dev-gateway-j2` (per-lane dev worker; EU-jurisdiction R2 binding to the shared `kiero-dev-media` bucket; the Worker boot gate from `apps/gateway/src/composition/full.ts` passed on deploy).
- Env on the lease (names only): `OPENROUTER_API_KEY`, `KIERO_SERVICE_TOKEN`, `JWT_PRIVATE_KEY`, `JWKS`, `SITE_URL`, `KIERO_PROBE_ENABLED`, `KIERO_B1..H4_PROOF_ENABLED`. No values appear in this directory.
- Model route: server-owned OpenRouter; observed `z-ai/glm-5.3-flash` on every answered run; embeddings `qwen/qwen3-embedding-8b` (verified HTTP 200 from this network).
- Web app: vite dev server with `VITE_CONVEX_URL` + `VITE_GATEWAY_URL`; real Chromium (playwright-core `--no-save`) as the D4 evidence pattern; the ONLY mocked layer is the media boundary.
- Fixtures: `/tmp/e4-speech.wav` (REAL Polish speech, macOS `say -v Zosia`) and `/tmp/e4-invoice.jpg`: the E4 evidence's own reproducible fixtures.

## Repeatable commands

- Node proof: `node e2e/core-flow/live-proof.mjs` (per-run nonce identities; re-runnable without resetting data).
- Browser legs: with `npm run dev` (web) running, `node e2e/core-flow/browser-leg.mjs` (needs `npm install --no-save playwright-core`).
- Deterministic: `npx vitest run tests/j2`; full gate: `npm run typecheck && npm test` (observed 136 files / 1831 passed / 5 skipped).

## Verdicts (focused verification of issue #61)

| Area | Verdict | Evidence |
| --- | --- | --- |
| Attention identity repair under ordinary tokens (the H2-recorded gap; notification-click -> /co-teraz) | PASS | `A/*` checks in both recorded runs; browser W6 (reminders render, no unavailable note, snooze accepted) |
| Real multimodal flow (text + retained audio + image, mixed source) | PASS | `B1/*`: accepted through the real gateway, processed, dossier explicit, project links |
| Voice-only send (the J2 ruling) | PASS | `B2/*`: empty author text accepted, processed, transcript present, no text claim; real STT 3/3 segments; browser W3 |
| Honest refusal for empty text without media | PASS | `B3` (`author_text_empty`) |
| Partial-extraction explicitness (missing segments/images stay explicit; no vision claim without a retained representation) | PASS | `B1/mixed-dossier-*`, `B2/voice-only-dossier-*` |
| Repeated stage delivery (acceptance-key replay) | PASS | `C`: same source id, one row, unchanged durable footprint |
| Source-backed answer with evidence | PASS | `D/grounded-*` (answered, statements cite evidence, basis direct); browser W4 leg 1 (inline render with evidence quotes) |
| Ambiguous question handling | PASS (answered) | `D/ambiguous-*`: the correction text made the conflict resolvable, so the model ANSWERED; the clarification path is E6's own proved surface (its lane evidence) and the resolution dispatch is public (`memory.resolveClarification`) |
| Direct correction applies autonomously | PASS | Run A: 6000 PLN published as the current `deposit_received` value in 16 s. Run B: honest provider window persisted through one bounded restart (both recorded) |
| Correction keeps history | PASS (deterministic + run A value); live revision count seen only with a processed correction | `tests/a4`/`tests/h1` pin `readFindingHistory`; run A published the correction; run B's window left 1 revision (recorded) |
| Source withdrawal + recomputation + independent corroboration | PASS | `F/*`: withdrawn lifecycle explicit, history kept, corroborating source survives with its own basis, state honest |
| Retrieval/index over the joined data | BLOCKED (E5 defect on this lease) | See below |
| Revocation while work is queued -> immediate core denial | PASS | `G/*`: revoked member's conversation AND reminders refuse `no_verified_identity` at once |
| Checklist independence + Co teraz over ordinary tokens | PASS | `H/*` (parent `todo` with 1/1 checked; snooze accepted); browser W6 |
| Twelve-scenario prototype coverage on the real backend | Partially recorded here | Answers citing sources (D + W4), corrections with history (E + run A), clarification path (D), checklist (H), Co teraz/snooze (H + W6), revoked access (G), partial image/audio analysis (B1/B2), interrupted-recording draft + offline retry (D4's evidence, unchanged engine). Calendar, push, PWA-update, physical-device legs stay with J4 by scope |

## Findings and repairs this join made (each flagged in code)

1. **Attention identity seam** (`convex/attention/context.ts` + the F3 sibling `convex/attention/push/queries.ts`): ordinary user tokens now resolve through B1's live-session chain (`resolveAccessContextFromConvexAuth` on reads, `resolveAccessContextWithProvisioning` on dispatch). Before, every attention public read and command failed `unauthenticated` because the platform-generic subject (`<userId>|<authSessions id>`) is not a sessions-registry id: exactly the gap H2 recorded.
2. **The voice-only ruling** (`convex/sources/accept/acceptance.ts`): `validateSourceMaterial`: words of author text OR at least one VERIFIED attachment (the gate's ids, never the declaration). The text extraction row still seeds for every source (coverage and evidence anchoring stay coherent); `processing.extract_fragments` registers only when words exist, and a voice-only source's analysis arrives through the E4 join projection of `sources.sourceAccepted`. The composer (`apps/web/src/features/capture`) enables Send for recording/photos without text and says so in honest copy.
3. **Text-only gateway prepare repair** (`apps/gateway/src/uploads/routes.ts` + `apps/web/src/features/capture/uploader.ts`): a `mediaKinds: []` declaration no longer calls the begin step (whose contract requires at least one attachment), and the composer's engine skips parts/complete/finalize for attachment-less material. The joined composer is the first TEXT-ONLY consumer of the gateway route, and the real backend refused the finalize the old engine (and its fake-gateway deterministic test) assumed: the test was corrected to pin the honest behavior.
4. **Composition entries** (`apps/web/src/composition/full.ts`, `convex/composition/core.ts`, `apps/gateway/src/composition/full.ts` + the minimal app-features delegation and the Worker boot gate): the join's declared core validates loudly (feature ids and order, retired `/wpis`, every core job kind has an executor, operation/event seams exist, the gateway's five providers and fixed routes resolve).

## Honest environment limits and defects recorded (NOT hidden)

- **E5 stuck build generation (owner action: E5 lane)**: a `search.index_generation` build job's external pass never recorded an outcome on this lease, leaving its generation in `building` forever; the cutover's GLOBAL one-build-at-a-time lock then refuses every later generation (`conflict:generation_already_building`, reproduced for a fresh company). Consequence: `search.queryEvidence` honestly reports `coverage: "degraded"` with zero entries on this lease. Deterministic E5 coverage and E5's own dev-lease evidence stand; this join's retrieval-CONSUMING paths (the answer loop's evidence search) are proven live by the `D` checks. Owner action by exact name: inspect `durableJobs` rows of kind `search.index_generation` in state `running` on `dev/j2` (the first J2 run's company) and add the missing external-pass reconciliation to the E5 lane.
- **Ambient provider windows**: `z-ai/glm-5.3-flash` intermittently failed whole runs (three provider-failed analysis runs across the recorded passes; the correction in the final run failed twice including after the one bounded model-stage restart). Every window is recorded with timestamps; recovery used only the sanctioned model-stage restart.
- **Media-worker Container not deployed; Cloudflare Images binding is the D5-recorded owner BLOCKED**: audio transcripts stay in their explicit `planning` state and no vision orders exist without a retained representation. The REAL STT provider path is proven through the guarded proof_inline channel (E4's fixture pattern); production media channels remain owner-scoped resources.
- **Processing latency**: 16-400 s per source across runs (the alpha 60 s target met on fast runs, exceeded on slow): consistent with the J1/E4 evidence ranges; recorded, not retried into fake success.

## Transcripts

- `live-proof-transcript.md`: the two complete node runs (42/44 and 41/45, every failure annotated).
- `browser-leg-transcript.md`: the fully green leg 1 and the final leg (every W check green in at least one leg; the W4 provider window recorded).
