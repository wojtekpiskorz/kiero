# Coordinator starter prompt

Use this prompt for the remaining core implementation map. It grants the
coordinator the Git lifecycle for the assigned map; implementation workers
own only their bounded issue slice. This revision supersedes the
2026-09-14 VPS-resumption wording: the staging stack is live and the map
funnels through one owner step.

---

Act as the Kiero implementation coordinator and continue the map:
https://github.com/wojtekpiskorz/kiero/issues/15

You own the map's Git lifecycle: creating and updating tasks, delegating
to subagents, issue-specific worktrees, commits, pushes, PRs, review,
serial merges and closure once criteria hold. Work independent ready
tasks in parallel. Do not stop at a plan.

Start with:

1. AGENTS.md and CONTEXT.md.
2. docs/implementation/README.md.
3. This file (process rules) and docs/implementation/execution-charter.md.
4. The newest checkpoint on #15 (the 2026-09-15 addenda: main session,
   Calendar deferral, and the unblocking session: the full staging stack
   LIVE).
5. `rtk proxy node docs/implementation/audit-map.mjs --remote`

Baseline at the 2026-09-15 post-smoke handoff (verify, do not assume):

- Main `13e26d4` plus the merged I8 evidence PR (smoke record +
  owner-credential BLOCK). Audit remote PASS: 88 map entries after the
  M9 and R17 registrations, 204 core edges, 74 closed before M9's own
  closure,
  13 open: I6 #58, J3 #62, J4 #63, J5 #64, I8 #133, B5 #134, D7 #135,
  I9 #136, I10 #137, I11 #138, J6 #139, C6 #197 and R17 #209 (the
  export executor URL convention repair found by the #206 review; a new
  ready root that blocks I9). One PR may be open for
  I8's evidence if the Actions outage delayed its merge.
- The whole staging stack is LIVE end-to-end: web PWA (SPA fallback,
  sw.js) on kiero-staging-web.wojtek-524.workers.dev, gateway with a
  working bridge (/platform/health → backendReachable: true, 15 durable
  executors), 644 Convex functions on fiery-raven-417, three container
  workers with runtime credentials. Release run 34966103795 + the
  descriptor-driven runtimeSecrets injector
  (infra/release/inject-worker-secrets.mjs).
- The ordinary smoke's unauthenticated legs PASSED (real Chromium from
  the VPS): PWA shell + service worker, provider availability
  (emailCode + google), a real Resend send through the ordinary
  email-code flow, the Google OAuth redirect (accounts.google.com
  accepted the pinned client and /api/auth/callback/google), and the
  client-asset secret-leak scan. Record: docs/evidence/staging/
  (vps-2026-09-14.md smoke section, candidate.json authenticatedSmoke).

First action, the OWNER STEP that gates everything: I8 #133 stays OPEN
on the authenticated smoke leg. Complete the tester Google login (the
allow-listed GM is wojtek@honestly.design): a persistent-profile
Chromium is staged at the sign-in card on the VPS desktop (Xvfb :99 via
noVNC, profile /tmp/kiero-smoke/profile; relaunch with
/tmp/kiero-smoke/launch-owner-browser.sh if the desktop restarted), or
relay a fresh email-code OTP from the owner mailbox. With the session
in the profile, finish the smoke: enterGmMode (the audited GM grant,
the staging initialization), an ordinary invite/notification send, and
one agent answer through the live providers. Then assess I8 for
closure per its own criteria (its release/isolation/configuration scope
is complete).

After I8 closes: B5 #134 / D7 #135 / I11 #138 in parallel (separate
reservations of tenants, accounts, buckets and notification
destinations before any live evidence), then I9/I10 → I6 → J6 →
J3/J4 → J5 → C6. Qualify strictly by native blocked_by.

Owner decisions, do not re-ask:

- Chat/vision fallback: OpenRouter (glm-5.3-flash → gemini-3.8-flash),
  recorded on #170; STT/embeddings OpenRouter; chat/vision DeepSeek
  direct.
- Google Calendar: the entire integration is deferred beyond v1 (ADR
  docs/adr/calendar-deferral-2026-09.md); C6 #197 sits behind J5; push
  STAYS in v1.
- Staging GM and alert recipient: wojtek@honestly.design
  (KIERO_GM_EMAILS set on Convex staging).
- Telemetry: Axiom, dataset kiero-staging (EU), injected.
- VPS: Convex/Wrangler CLIs are logged in; do NOT repeat provisioning
  (fiery-raven-417, R2 buckets, the GitHub staging environment, all
  STAGING_* secrets exist; the only deferred secret is
  STAGING_CONVEX_BACKUP_ADMIN_KEY. I10's decision).

Open positions to watch:

- CONVEX_BACKUP_ADMIN_KEY (I10, deferred in the descriptor; keep the
  flag).
- Executor URL assignments: the images name initially pointed at the
  media worker on a route-ownership assumption; the #206 advisory
  review caught it against the code (the gateway owns
  POST /images/normalize) and the live value was corrected to the
  gateway on 2026-09-15 (candidate.json executorUrlAssignments). D7
  still verifies loudly at the first real normalize run. The export
  name has a known consumer conflict (verbatim fetch vs appended route)
  owned by R17 #209, a native blocker of I9; the bare origin is set so
  cleanup works and the build drive 404s until R17 lands.
- J4: physical iPhone+Android devices and VAPID at runtime are real
  resources.
- Alpha-production policy (reviewer/branch policy): decide at J5.
- Cache-flip pattern: closures need a bounded M-issue (M2-M9 precedent);
  tests/m1 fixtures pin the graph counts (88 entries / 204 edges after
  M9 + R17).
- The PWA update handshake (client fetch of the Convex .site
  /platform/health) is CORS-blocked in the deployed topology (an honest
  "unavailable" degradation), recorded as a J4/J6 follow-up, not an I8
  blocker.

Operational rules (expensive lessons from prior sessions):

- Exact-SHA Checks gate: wait for completed/success on main's SHA
  BEFORE dispatching Release, or the run is refused.
- No "echo" string in release.yml (R6 guard); use printf.
- After a squash-merge the branch conflicts; rebase or move the diff
  onto fresh main.
- Issue bodies are hashed in the manifest: a live edit = re-cache in
  the same admin PR (raw JSON, no jq string pass-through: extra \n).
- Owner-data wizard: read -rs → stdin → gh secret set / convex env set;
  values never in conversation or files.
- Advisory AI review: read every round's full findings; apply before
  merge; an unavailable review is a recorded absence, not a clean
  verdict.
- GitHub Actions events stalled once (2026-09-15 ~12:00 UTC: pushes
  created no workflow runs while the API worked); if Checks refuse to
  start, verify with `gh api repos/…/actions/runs?head_sha=<sha>`,
  retrigger (synchronize push, PR close/reopen), and only merge once
  the deterministic Checks actually ran, never without them.

Read secrets only as names/presence. One task = one worktree and one
PR. Serialize shared files, staging changes and integrations. Continue
until the map is complete or a genuine owner-requiring block. Never
lower the J3/J4/J5 thresholds. Production, final design and the
four-week alpha remain separate stages. Leave a durable checkpoint on
#15 before ending a session.
