# B5 access qualification evidence (issue #134) — the email identity leg

The accepted identity and company-access matrix executed against the LIVE
staging candidate with REAL delivered email codes (mail.tm throwaway
mailboxes receiving Resend deliveries end to end — no fixture codes, no
seeded sessions, no fake provider on any acceptance path this lane owns).

Deterministic boundary coverage stays where it was accepted: `tests/b1`
(identity/session), `tests/b2` (linking), `tests/b3` (membership), `tests/b4`
(GM). This directory records the LIVE evidence and the honest BLOCKED /
NOT RUN rows.

## Environment

- Candidate: `d43fc27` (main, "R21: bind the Images transformations executor
  on the staging gateway").
- Web origin: `https://kiero-staging-web.wojtek-524.workers.dev` (the PWA
  with live providers).
- Convex staging deployment: `wojtek-piskorz-jr:kiero-dev-core:staging`
  (`fiery-raven-417`, eu-west-1, prod type) —
  `https://fiery-raven-417.eu-west-1.convex.cloud`.
- Providers live on staging: email code (Resend, verified domain woji.dev)
  and Google (project kiero-508611, External/Testing). Presence observed
  through `providerAvailability` and the rendered sign-in card.
- Mailboxes: fresh mail.tm throwaway accounts per persona per run
  (addresses recorded in the run artifacts; passwords are throwaway test
  artifacts that never enter this tree). Codes are read from the real
  mailbox after real delivery.
- Browser: Playwright Chromium (headless) with persistent profiles per
  persona under `/tmp/kiero-smoke/b5/<run>/profiles/` — an independent
  profile is an independent device; pageerror events collected on every
  page (zero expected, recorded per leg).
- Synthetic tenants namespaced per run (`B5 <run-id>`); no tenant reuse.

## Repeatable commands

```sh
# The email identity matrix (delivery, wrong/expired/replayed code, issuance
# and verification limits, same-email resume, linking ceremony email legs,
# email change, session recovery/independent browsers/device revocation,
# calendar absence). Patient: includes a real 16-minute expiry wait.
node e2e/access/identity-email-leg.mjs --run <run-id> --candidate-sha d43fc27

# The company access matrix (targeted invitation + acceptance, revocation
# before acceptance, hostile acceptance, one-active-company, last-admin,
# transfer + race, removal with OLD-session denial, authorship, logout).
node e2e/access/company-access-leg.mjs --run <run-id> --candidate-sha d43fc27

# The GM leg. Refusal mode is LIVE and safe (no env mutation):
node e2e/access/gm-entry-leg.mjs --run <run-id> --mode refusal
# Entry mode (audited walk) is coordinator-pending; see the BLOCKED rows.
node e2e/access/gm-entry-leg.mjs --run <run-id> --mode entry \
  --operator-mailbox <mailbox.json> --company-id <k78...> [--boss-profile <dir>]

# The sign-in error-copy probe (defect evidence; needs an exhausted mailbox).
node e2e/access/limiter-copy-probe.mjs --mailbox <mailbox-m3.json>

# Merge leg results into the committed matrix + copy sanitized snapshots:
node e2e/access/collect-evidence.mjs --run <run1> --run <run2> ... --candidate-sha d43fc27
```

Artifacts land under `/tmp/kiero-smoke/b5/<run>/<leg>/` (screenshots PNG,
body texts, results.json, state.json); sanitized text artifacts and results
are copied into `runs/<run>/<leg>/` here. No credential values appear
anywhere in this tree; mailbox passwords exist only in the throwaway run
artifacts under `/tmp`.

## Result matrix

See `results.json` for every case with status, criterion mapping,
independently expected result, observed result, environment and the
repeatable command. Summary by acceptance criterion — final live runs
`b5-i4` (identity), `b5-c3` (company), `b5-gm1` (GM refusal); overall
34 PASS, 1 FAIL (defect D1's user-visible copy), 2 BLOCKED (Google
legs), 3 NOT RUN (real-time requirements + the coordinator-pending GM
walk):

- **AC1 email-code matrix + Google**: delivery PASS (real Resend ->
  mail.tm -> consumed in the real form); wrong code refused but with the
  WRONG Polish copy (see defect D1 — recorded FAIL for the copy
  expectation, fail-closed holds); one-time use + replay refused PASS;
  expiry refused after a real 16-minute wait PASS; per-address issuance
  limit (5 sends, 6th refused, all five really delivered) PASS;
  verification-failure limit PASS (behavioral: after eight wrong
  attempts even the CORRECT pending code is refused); Google button live
  PASS; Google completion BLOCKED (owner credentials).
- **AC2 same-email both directions, linking, changes, recovery**: the
  email direction resumed one account across devices PASS; the
  cross-method directions (email account + Google sign-in and the
  reverse) BLOCKED with the Google leg; concurrent ceremony begins
  serialize to exactly one PASS; ceremony email leg with real delivered
  proof code PASS (the google_oauth commit BLOCKED); self-merge refusal
  PASS; email change with a real code to the new address, wrong-code
  leaving everything untouched, old address detached (a fresh separate
  person) PASS; session recovery after reload and independent browsers
  PASS.
- **AC3 invitations, membership, last-admin, GM**: targeted invitation
  delivered + accepted as ordinary member PASS; revocation before
  acceptance + hostile acceptance (wrong user, wrong code, after
  revocation) PASS; second acceptance refused (one-active-company) PASS;
  last-administrator constraints (leave + self-demotion refused) PASS;
  administrator transfer PASS; transfer race (two parallel transfers,
  one committed + one typed-refused, >= 1 admin retained) PASS; 7-day
  invitation expiry NOT RUN (real-time; boundary pinned by tests/b3); GM
  entry refused for non-designated accounts PASS (live); the audited GM
  walk NOT RUN — coordinator-pending allow-list mutation.
- **AC4 revocation effects + inactivity**: membership removal denies the
  removed member's OLD open browser session immediately (the live
  conversation subscription surfaced the session-ended view without a
  reload; token reads denied after the durable fan-out) and preserves
  authorship PASS; media/file consumers recheck current authorization on
  every request, so with the member's sessions revoked no authorized
  media request is possible (no separate file-request surface exists for
  a removed member) — recorded in the case's observed text; device-session
  revocation denies only that device PASS; explicit logout ends the
  upstream session (old token dead) PASS; 30-day inactivity NOT RUN
  (real-time requirement; boundary pinned by tests/b1 fixtures and the
  pinned Convex Auth session config).
- **AC5 Calendar disconnect**: the v1 host exposes no Calendar entry
  (nav + route verified live) PASS — the integration is deferred beyond
  v1 per `docs/adr/calendar-deferral-2026-09.md`; the
  disconnect-keeps-sign-in journey is deferred with it (owner C6 #197),
  while reload/recovery prove sign-in usability on this candidate.
- **Cross**: zero pageerror events across every browser session of every
  leg (per-leg rows in results.json).

### Prior runs, preserved and superseded (corrective evidence linked)

- `b5-i1` (identity, /tmp/kiero-smoke/b5/b5-i1): crashed in the expiry
  phase — a mail.tm freshness-filter race (second-level mail timestamps
  vs a wall-clock `since`) made a delivered code invisible; fixed by
  id-snapshot freshness in `e2e/access/lib/mail.mjs`. Superseded by
  `b5-i2`/`b5-i4`.
- `b5-i2` (identity, /tmp/kiero-smoke/b5/b5-i2): completed but its
  linking/email-change rows asserted the typed rejection CODES in the
  API error text — unobservable on the prod-type deployment (defect D1);
  its `a6-wrong-code.txt` and `a3-issuance-limit.txt` snapshots are the
  defect evidence (copied to `runs/b5-i2/identity/`). Behavioral
  assertions were folded into the driver; superseded by `b5-i4`.
- `b5-c1`/`b5-c2` (company, /tmp/kiero-smoke/b5/b5-c1, b5-c2): driver
  bugs (a transient-notice assertion; a wrong button literal — the real
  copy is "Przekaż administrację"). Product behavior was correct
  throughout; superseded by `b5-c3`.
- Two focused retry passes between i2 and i4 (artifacts under
  /tmp/kiero-smoke/b5/b5-i2/identity-retry): established the behavioral
  assertion set and the correct-code limiter probe before the full
  re-run; superseded by `b5-i4`.

## Product defects found (NOT fixed by this lane — coordinator files the repair)

- **D1 — sign-in and identity-layer error classification is defeated by
  prod error sanitization** (fail-closed holds everywhere; the honest
  Polish copies and typed codes never reach the client on the prod-type
  deployment):
  - Minimal repro 1 (wrong code): request a code, submit a wrong 8-digit
    value in the real form. Expected `Kod jest nieprawidłowy lub
    wygasł. Poproś o nowy kod.` + the `Wyślij kod ponownie` affordance
    (features/sign-in/state.ts classification). Observed: `Coś nie
    zadziałało. Spróbuj ponownie.` and no resend control.
  - Minimal repro 2 (issuance limiter): request 6 codes rapidly on one
    address (budget 5). The 6th send is correctly REFUSED server-side,
    but the form shows `Coś nie zadziałało. Spróbuj ponownie.` instead of
    `Zbyt wiele prób. Odczekaj kilka minut i spróbuj ponownie.`
  - Scope: the classification keys on message text — Kiero's own markers
    (`[kiero:issuance_rate_limited]`, `[kiero:method_conflict]`,
    `[kiero:email_delivery_failed]`, thrown as plain `Error` in
    convex/access/identity/authEntry.ts; the linking layer's
    `[kiero:link_rejected][code]` strings, thrown as `ConvexError` with
    a plain string payload in convex/access/linking/functions.ts) and
    the library's `Could not verify code` / `Too many failed attempts`
    (plain `Error` in @convex-dev/auth signIn) — but on a prod-type
    Convex deployment those errors are sanitized to `Server Error`
    before the client sees them, so no classification branch can match.
    Dev deployments show the copies; staging/production cannot. The
    same sanitization hides the typed linking-rejection codes from any
    API client (every refusal in this run's linking and email-change
    cases surfaced as `Server Error` while the state machine behaved
    exactly as specified — the behavioral rows in results.json assert
    outcomes, not text).
  - Evidence: `runs/b5-i2/identity/a6-wrong-code.txt`,
    `runs/b5-i2/identity/a3-issuance-limit.txt`, the limiter probe
    (`e2e/access/limiter-copy-probe.mjs`, snapshot under
    /tmp/kiero-smoke/b5/limiter-copy-probe/), and the FAIL row
    `otp-wrong-code` in results.json.

## Honest limits

- mail.tm latency varied from ~5 s to 8+ min during the recorded runs;
  every wait used the committed patient poll (default 720 s). Freshness
  filtering keys on mail.tm message ids (second-level timestamps made a
  wall-clock `since` filter miss same-second deliveries; fixed in the
  committed `e2e/access/lib/mail.mjs`).
- The account feature UI (B2 linking/email-change/session panels) is not
  mounted in the v1 host (no `/konto` route), so its ceremonies were
  driven against the SAME deployed Convex functions with real session
  tokens; the browser drove every mounted surface (sign-in, /firma, /gm).
  Mounting the account surface is a product decision, not this lane's.
- The issuance limiter is per address: every sign-in run used a fresh
  mailbox; the limiter case used a dedicated one.
