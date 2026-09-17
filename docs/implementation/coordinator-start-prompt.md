# Coordinator starter prompt

Use this prompt for the remaining core implementation map. It grants the
coordinator the Git lifecycle for the assigned map; implementation workers
own only their bounded issue slice. This revision (2026-09-16, session 8)
supersedes the M9+M11 wording: the media repair wave (R22-R24) is deployed
and the vision OCR lane completed live; B5 and I11 are executed to their
owner walls; the map hit GitHub's 100-sub-issue cap.

---

Act as the Kiero implementation coordinator and continue the map:
https://github.com/wojtekpiskorz/kiero/issues/240

You own the map's Git lifecycle: creating and updating tasks, delegating
to subagents, issue-specific worktrees, commits, pushes, PRs, review,
serial merges and closure once criteria hold. Work independent ready
tasks in parallel. Do not stop at a plan.

Start with:

1. AGENTS.md and CONTEXT.md.
2. docs/implementation/README.md.
3. This file (process rules) and docs/implementation/execution-charter.md.
4. The newest checkpoint on the archive #15 (through the 2026-09-16
   session) and on the continuation map #240 (after) (the 2026-09-16 session-8 record: the
   R22-R24 repair wave, B5/I11 at their owner walls, the cap warning).
5. `rtk proxy node docs/implementation/audit-map.mjs --remote`

Baseline at the 2026-09-16 session-8 handoff (verify, do not assume):

- Main carries the merged waves: R22 #224 / PR #226 (the media executor
  image byte op), R23 #225 / PR #227 (the secure-channel photo decoupled
  from OCR), R24 #229 / PR #231 (real dimensions + the typed failure
  status through the images drive), the B5 evidence PR #233 and the I11
  evidence PR #238. Audit remote PASS: 99
  entries, 218 core edges, 86 closed, 13 open.
- The D7 vision OCR lane is PROVEN live end to end for the first time
  (vision order `complete`, image_region fragments) over the
  retained-original fallback. Two anomalies stay: the Images binding's
  HTTP-ok output does not decode as WebP (conversion_failed, status
  absent), and ask-agent still reports output_rejected (R25 #230, the
  answer-loop durable rows, is the registered-open instrumentation).
- B5 #134 and I11 #138 are OPEN at their BLOCKED owner rows (B5: one
  tester Google login on the staged noVNC browser; I11: Axiom ingest
  verification, the three monitors, one delivered alert, metered costs,
  the fixture-window and gateway-cron decisions).
- **#15 holds exactly 100 sub-issues (GitHub's hard cap).** No new
  issue can join the map (sub-issue plus registration) until the owner
  decides: prune closed children (an audit-contract change through a
  bounded M-issue) or keep future repairs standalone. Issues #235, #236
  and #237 (the I11 defects) are standalone repairs awaiting that
  decision.

The ready frontier: D7 #135 (coordinator-claimed; the remaining proofs
below), R25 #230 and R26 #232 (unassigned, no open blockers), then
I9/I10 after D7, I6, J6 after B5+D7, J3/J4, J5, C6. Qualify strictly by
native blocked_by.

D7's remaining scope, in order:

1. The /zrodlo display proof: the feed has no direct /zrodlo links ;
   click „Szczegóły i źródło" first, then the permalink; the
   secure-channel control („Pokaż zdjęcie") must render the `<img>`
   (R23) with the OCR overlays once complete (R22+R24).
2. The voice lane's first-ever post-R19/R20 STT run (voice-leg driver;
   the media worker is healthy with live S3 credentials; allow ~4 min
   after any release for the container's sleep→wake image cycle before
   probing /image).
3. R25 lands → the ask-agent re-runs (photo first; its vision context
   now exists; then voice with a real transcript).
4. Edge fixtures (panorama/corrupt/oversized), interruption/replay,
   private reads/ranges/revocation, the evidence PR and closure per
   P03/P04/P05/P07.

Owner decisions, do not re-ask:

- Cloudflare Images: TRANSFORM-ONLY, no storage (binding env.IMAGES;
  media bytes stay in the project's EU R2). The binding's undecodable
  output anomaly is recorded on #135; the fallback path is fully usable.
- STT: a separate cheap model through OpenRouter (MAI-Transcribe-2,
  Whisper backup) → text transcript → DeepSeek reasons. output_rejected
  is an answer-loop problem (R25), not audio.
- Chat/vision: DeepSeek direct; chat fallback OpenRouter (glm-5.3-flash
  → gemini-3.8-flash) on #170; embeddings OpenRouter.
- Google Calendar: entirely beyond v1 (docs/adr/calendar-deferral-2026-09.md);
  C6 #197 behind J5; push STAYS in v1.
- GM staging and alert recipient: wojtek@honestly.design (KIERO_GM_EMAILS
  on staging; every qualification window widens then restores it).
- Telemetry: Axiom, dataset kiero-staging (EU); the ingest leg has
  never succeeded (#235 records why nobody could tell).
- VPS: Convex/Wrangler CLIs logged in; do NOT repeat provisioning
  (fiery-raven-417, R2 buckets, the GitHub staging environment, all
  STAGING_* secrets; the only deferred secret is
  STAGING_CONVEX_BACKUP_ADMIN_KEY; I10's decision).

Open positions to watch:

- **The 100-sub-issue cap** (the owner decision above).
- The funnel: tools/smoke/mailbox.mjs (mail.tm; latency varies 5-8+ min
  vs the 15-min OTP validity; fresh mailbox per run, patient polls to
  ~12 min, one re-request on timeout). The durable upgrade is the owned
  Email Worker on a subdomain (owner DNS decision). The B5 lane's
  e2e/access/lib/mail.mjs generalizes this with id-snapshot freshness.
- The cache-flip pattern: self-carried registration (R17-R24 precedent)
 ; the repair PR carries its own CLOSED entry + mergedPr + native
  relations before merge; OPEN registrations for unfixed defects ride
  the discovering lane's PR (R25/R26 precedent); after merge: the map
  tables, m1 fixtures and the remote audit. **Issue bodies are hashed:
  hash the raw API JSON, never `gh -q .body` output (it appends a
  newline; lesson #228).**
- The PWA update handshake CORS-blocked (honest „unavailable"); J4/J6.
- The shared routeUrl in @kiero/runtime for the four remaining inline
  appends; the descriptor-vs-config overlap check (R20's review); the
  access drivers' blind-wait conversion (deferred on PR #233); the
  third-recorder consolidation (e2e/helpers vs the lane libs).
- J4: physical iPhone+Android and VAPID runtime; alpha-production policy
  at J5.

Operational rules (expensive lessons):

- Exact-SHA Checks gate: wait for completed/success on main's SHA BEFORE
  dispatching Release.
- No "echo" string in release.yml (R6 guard); printf.
- After a squash-merge the branch conflicts; rebase the diff onto fresh
  main.
- Secrets: names/presence only. KIERO_MEDIA_WORKER_TOKEN is a plain
  Convex variable; never propagate its value.
- Cloudflare: a var and a secret share one namespace per Worker; a name
  collision is code 10053 (R20). A release's container image rolls on
  the sleep→wake boundary: wait ~4 idle minutes before probing.
- Restore staging mutations (KIERO_GM_EMAILS). Advisory reviews: read
  every round in full; apply before merge; an unavailable review is a
  recorded absence.
- GitHub Actions stalls happen: verify gh api repos/…/actions/runs?head_sha=<sha>;
  retrigger; never merge without real green Checks.
- `rtk` garbles stdin (wrangler secret bulk): plain npx then.
- Node/ESM drivers: save after EVERY fix (assert-then-crash loses the
  edit); no import side effects.

One task = one worktree and one PR. Serialize shared files, staging
changes and integrations. Continue until the map is complete or a
genuine owner-requiring block. Never lower the J3/J4/J5 thresholds.
Production, final design and the four-week alpha remain separate stages.
Leave a durable checkpoint on #15 before ending a session.
