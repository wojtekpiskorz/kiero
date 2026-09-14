# Calendar gateway callback return-origin evidence (R12 #181)

Status date: 2026-09-14. Worktree branch `codex/kiero-r12-gateway-return`
from `main` at `3304fdc` (uncommitted, per the coordinator-owned Git
lifecycle). Scope: the gateway Worker's Calendar callback
(`GET /platform/calendar/oauth/callback`,
`apps/gateway/src/calendar-oauth/routes.ts`) rendered "Wróć do Kiero"
with `href="/"`: on the Worker host that led back to the gateway, not
the PWA. R12 completes the repair on the gateway leg, mirroring what R10
(#171) did on the direct Convex callback. Deterministic coverage in
`tests/g1/gateway-callback-return.test.ts` (new; R10's
`tests/g1/callback-return.test.ts` is untouched and still green).

This session held no cloud credentials and deployed nothing. Everything
executable locally was executed and is recorded below. The two steps that
need the outside world are NOT RUN by design and named in section 4.

Follow-up (same day): PR #184's advisory review requested changes and the
coordinator ruled on the PR thread to apply all three findings in this
worktree as new uncommitted changes — the shared renderer hoist, the
named widened resolver input contract (collapsing the adapter to a
literal two-key mapping), and a stale single-source comment fix. Section
1 and section 5 record the outcome; section 3 carries the post-review
check tails.

## 1. Design: how the return target is resolved

- Source of truth: the Worker variable `KIERO_CALENDAR_APP_BASE_URL`
  (exported as `CALENDAR_APP_BASE_URL_ENV`), bound per environment in
  `apps/gateway/wrangler.jsonc` and read from the route handler's `env`
  at request time. Nothing caller-supplied (query, body, headers, or
  the request host) participates in the resolution. The request host is
  demonstrably irrelevant: two different gateway hosts render the same
  configured link (test: "ignores the request host entirely").
- ONE resolver, no second copy: the R10 function `calendarAppReturnHref`
  (strict validation + normalization; see R10's
  `docs/evidence/integrations/calendar-return/README.md` section 1 for
  the full rule list) is the single definition. Its input is the named
  contract `CalendarAppReturnEnv`, exported from the shared home the
  way `answers.ts` exports `CallbackAnswer` (review finding 2): both
  keys read `?: string | undefined` — honest under
  exactOptionalPropertyTypes because the resolver treats absent,
  undefined and empty identically, and the Convex side passes
  `process.env` (an index-signature record). The gateway route calls
  the resolver through a collapsed literal two-key mapping
  (`gatewayReturnHref` in routes.ts):
  - the PWA origin passes through under the same deployment variable
    name (`KIERO_CALENDAR_APP_BASE_URL`);
  - the Worker's `ENVIRONMENT` label (the same closed
    dev/staging/alpha-production set the gateway telemetry surface
    reads) stands in for the resolver's `KIERO_ENVIRONMENT`, so the
    plain-http-only-in-dev rule keeps its meaning on the Worker host
    (pinned by the "ENVIRONMENT label drives the http rule" tests).
    Both values may be undefined; the resolver itself owns what absent
    means — the adapter no longer re-implements its default.
- Shared home (FLAGGED out-of-ownership edit, see section 5): the
  resolver moved verbatim from `convex/calendar/connection/http.ts`
  into the new PURE module `convex/calendar/connection/return.ts` (the
  same shared-home ruling as `answers.ts`, which the gateway already
  imports cross-boundary). `http.ts` now imports it and re-exports
  `CALENDAR_APP_BASE_URL_ENV` + `calendarAppReturnHref`, so R10's public
  surface and tests are unchanged. Reason: importing `http.ts` from the
  gateway breaks the gateway workspace typecheck (preserved as failed
  attempt, section 3) because `http.ts` pulls the Convex server type
  graph (`convex/_generated/server` → `convex/server` → node-typed
  `.d.ts` references) into the gateway's isolated
  `@cloudflare/workers-types` project, corrupting global `fetch`,
  `BufferSource` and `Crypto` resolution for unrelated gateway files.
- Rendering — ONE renderer, no second copy (review finding 1): after
  the R12 footer change the gateway's `polishStatusPage` and the Convex
  one were character-identical mirrors carrying product copy, so the
  renderer moved into the new PURE module
  `convex/calendar/connection/render.ts` (one concern per file beside
  the resolver). Its only dependency is the canonical `escapeHtml`
  from convex/operations/exports/protocol.ts — an import-free module,
  safe for both isolated type graphs. `http.ts` imports it (the
  function was module-private there, so no re-export is needed and the
  public surface stays identical); routes.ts imports it from the pure
  home. The footer is either
  `<p><a href="{escaped target}">Wróć do Kiero</a></p>` or, when the
  resolver answers null, the honest Polish note `Powrót do Kiero jest
  niedostępny. Otwórz aplikację bezpośrednio.` with NO anchor, never
  `href="/"`, never a guessed origin. Every typed page (success, each
  failure, the incomplete-link page) keeps its copy and status.
  Precedent correction (from the PR-body record): the gateway's
  exports route imports convex/sources/media_access/protocol, NOT
  operations/exports/protocol — the calendar route (via the shared
  renderer) is the gateway's first import of operations/exports/protocol,
  and it typechecks cleanly in the isolated workers-types project
  because that module pulls no type-graph baggage.
- Env typing: `CalendarBridgeEnv` (apps/gateway/src/calendar-oauth/
  client.ts) gained `KIERO_CALENDAR_APP_BASE_URL?` and `ENVIRONMENT?`.
  The route reads the origin through the exported
  `CALENDAR_APP_BASE_URL_ENV` constant, so a name drift between the env
  type and the resolver's variable name cannot compile (pinned by the
  "carries the R12 variable names" test).
- Bindings in `apps/gateway/wrangler.jsonc` (variable only, no secrets):
  top-level dev block `""` (empty = not yet set; local dev fills the
  origin `kiero-dev-web` serves on; until then the callback honestly
  renders the no-link page), staging
  `https://kiero-staging-web.wojtek-524.workers.dev` (the same staging
  web Worker the CORS allow-list pins), alpha-production `""` (fill when
  the alpha web origin exists).

## 2. Behavior matrix (config × input → rendered footer)

Verified by `tests/g1/gateway-callback-return.test.ts` (27 tests).
"Link" means `<p><a href="{target}">Wróć do Kiero</a></p>`; "no link"
means no `<a>` element at all plus the unavailability note.

| Configuration state | Request input | Rendered footer |
| --- | --- | --- |
| `https://…` PWA origin (staging label) | state+code, backend answers `connected` | link → exact configured origin; bridge POST carried the service credential + exactly `{state, code}` |
| `https://…/` trailing slash | invalid state | link → origin, slash normalized away |
| `https://…/kiero` or `/kiero/` subpath | invalid state | link → `https://…/kiero` |
| valid `https://…`, other gateway host | invalid state | link → ONLY the configured origin (host never appears) |
| `http://localhost:5173`, `ENVIRONMENT` dev or absent | invalid state | link kept (dev http allowed, the adapter mapping) |
| `http://…`, `ENVIRONMENT` staging / alpha-production | invalid state | no link |
| absent / empty / blank | invalid state; also state-missing page | no link |
| not a URL (bare hostname) | invalid state | no link |
| `javascript:` / `data:` scheme | invalid state | no link |
| embedded userinfo (`user:pass@`) | invalid state | no link |
| query or fragment in the configured value | invalid state | no link |
| valid `https://…` | hostile `?return=…&redirect_uri=…&continue=javascript:…&next=//evil` + crafted `Referer` | link → ONLY the configured origin; no `evil`/`javascript:` substring anywhere in the HTML, no `href="/"`, bridge received exactly `{state}` |

Protocol pages under a valid configuration (regression, unchanged
behavior): state missing → 400 "Ten link jest niekompletny." with link
and zero bridge calls; typed codes (`invalid_state`, `scopes_missing`,
`creation_unknown`) render through the shared answer vocabulary with
their statuses (400/400/200) under the link; unknown code → the honest
generic 400 page; denial (`error=access_denied`) forwarded through the
service-credential leg as `{state, error}` and never echoed into the
page; missing `KIERO_SERVICE_TOKEN` or `CONVEX_SITE_URL` → the closed
sanitized 503 `calendar_backend_not_configured` JSON, zero backend
calls.

## 3. Commands and results

Fresh install (established convention), then the focused suites, the
typecheck and the full suite:

```
rtk npm ci                                                # exit 0
rtk npx vitest run tests/g1/gateway-callback-return.test.ts tests/g1/callback-return.test.ts
  # Test Files  2 passed (2)
  #      Tests  53 passed (53)   # 27 new gateway + 26 R10, untouched
rtk npx vitest run tests/g1
  # Test Files  8 passed (8)
  #      Tests  125 passed (125)
rtk npm run typecheck                                     # exit 0 (root + container + workspaces)
rtk npm test                                              # exit 0; tail below
```

Full-suite result (`rtk npm test`, exit 0):

```
 Test Files  172 passed | 1 skipped (173)
      Tests  2362 passed | 5 skipped (2367)
```

Baseline for the same command on clean `main` at `3304fdc` (changes
stashed): `171 passed | 1 skipped (172)` files, `2335 passed | 5
skipped (2340)` tests; the R12 delta is exactly +1 file and +27 tests
(this issue's new test file), with zero regressions. The 1 skipped
file / 5 skipped tests are the pre-existing skips on `main`, untouched
by R12.

Post-review re-run (all three advisory findings applied, uncommitted
on top):

```
rtk npm run typecheck                                     # exit 0 (root + container + workspaces)
rtk npx vitest run tests/g1
  # Test Files  8 passed (8)
  #      Tests  125 passed (125)
rtk npm test                                              # exit 0
  # Test Files  172 passed | 1 skipped (173)
  #      Tests  2362 passed | 5 skipped (2367)
```

Identical totals to the pre-review run: the renderer hoist, the named
contract type and the comment fix are behavior-preserving refactors
(R10's 26 tests still import from `http.ts` and pass through the
import/re-export; the 27 gateway tests assert the same exact HTML
through the now-shared renderer).

### Failed attempts (preserved)

1. The first implementation imported `calendarAppReturnHref` directly
   from `convex/calendar/connection/http.ts` (the literal reading of the
   issue's "importing across the boundary the way `answerOrNull`
   already crosses"). `rtk npm run typecheck` failed in the
   `@kiero/gateway` workspace with three errors in files R12 never
   touched:

   ```
   src/images/normalizer.ts(121,9): error TS2769: No overload matches this call. (Uint8Array<ArrayBufferLike> not assignable to BodyInit)
   src/images/r2.ts(24,52): error TS2345: Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable to parameter of type 'BufferSource'.
   src/uploads/r2.ts(92,35): error TS2339: Property 'DigestStream' does not exist on type 'Crypto'.
   ```

   Verified pre-existence-free by stash: with the R12 changes stashed,
   the same `npx tsc --noEmit -p tsconfig.json` in `apps/gateway` exits
   0 on clean `main` at `3304fdc`; a probe file importing ONLY
   `convex/calendar/connection/http` reproduces all three errors.
   Mechanism: the Convex server type graph entered the gateway's
   isolated `types: ["@cloudflare/workers-types"]` program and changed
   global `fetch`/`BufferSource`/`Crypto` resolution (`skipLibCheck`
   does not prevent declaration contribution). Conclusion: the direct
   import is unshippable behind a required gate; the resolver was
   hoisted to the pure shared home instead (section 1). No behavioral
   change resulted; R10's tests pass unchanged through the re-export.

2. No other failed runs: the hoisted implementation passed typecheck,
   `tests/g1`, and the full suite on the first attempt.

## 4. Explicitly NOT RUN (and who owns it)

- Deployment of this change (the gateway Worker with the new variable
  binding; the value on staging is the public PWA origin, on dev/alpha
  an owner-supplied local/empty placeholder); I8 owns deployment.
  Until the variable is deployed, the gateway callback honestly renders
  the no-link page; it does not regress to `href="/"`.
- The real Google Calendar journey (browser consent, redirect onto the
  Worker callback, click-through to the PWA); J4's ownership, exactly
  as recorded in R10's evidence.
- A live check of the deployed staging pair
  (`https://kiero-staging-gateway.wojtek-524.workers.dev/platform/calendar/oauth/callback`
  linking to `https://kiero-staging-web.wojtek-524.workers.dev`):
  needs the deployed code; the local tests use the same host shapes as
  fixtures.

## 5. Out-of-ownership edits and observations (flagged, not silently done)

- FLAGGED EDIT: `convex/calendar/connection/http.ts` (R10's merged lane,
  outside R12's listed ownership) was touched ONCE in the initial R12
  pass, mechanically: the resolver block moved verbatim into the new
  pure module `convex/calendar/connection/return.ts`; `http.ts` imports
  it and re-exports `CALENDAR_APP_BASE_URL_ENV` and
  `calendarAppReturnHref`, keeping the module's public surface identical
  (R10's `tests/g1/callback-return.test.ts` imports these names from
  `http.ts` and passes unchanged). The issue text itself sanctions the
  hoist ("hoist the resolver to a shared neutral home … never duplicate
  a second copy"); the coordinator note preferring the direct import
  assumed it was the minimal-risk path, which the typecheck evidence in
  section 3 disproves. The PR #184 advisory review then confirmed the
  shared-home direction and the coordinator's PR-thread ruling
  explicitly ordered the renderer hoist, so a second mechanical edit to
  the same file followed: `polishStatusPage` moved verbatim into the
  new pure module `convex/calendar/connection/render.ts` (module-private
  in `http.ts`, hence imported there with no re-export needed; the
  escapeHtml import moved with it). Both edits are covered by the
  coordinator's ruling; R10's owner should be notified of the two new
  shared homes (`return.ts`, `render.ts`).
- `convex/calendar/connection/operations.ts` still keeps an
  "Environment names consumed here" header inventory that does not
  mention `KIERO_CALENDAR_APP_BASE_URL` (same observation R10 recorded;
  the name is documented in `http.ts` and now `return.ts`, the modules
  that consume it). Left untouched, outside ownership.
- The gateway `wrangler.jsonc` dev block carries an EMPTY
  `KIERO_CALENDAR_APP_BASE_URL` placeholder. When the local dev journey
  matters, the owner should fill the origin the `kiero-dev-web` Worker
  serves on (e.g. `http://localhost:<port>`; no port is pinned anywhere
  in the repository today). The empty value is honest, not broken: the
  resolver renders the no-link page.
