# Calendar callback return-origin evidence (R10 #171)

Status date: 2026-09-14. Worktree branch `codex/kiero-r10-calendar-return`
from `main` at `d257c1d` (uncommitted, per the coordinator-owned Git
lifecycle). Scope: the direct Convex Calendar callback
(`GET /calendar/oauth/callback`, `convex/calendar/connection/http.ts`)
rendered "Wróć do Kiero" with `href="/"` — on the Convex HTTP Actions
host that led back to the deployment, not the PWA. R10 completes the
return leg using the configured application origin, with deterministic
coverage in `tests/g1/callback-return.test.ts`.

This session held no cloud credentials and deployed nothing. Everything
executable locally was executed and is recorded below. The two steps that
need the outside world are NOT RUN by design and named in section 4.

## 1. Design: how the return target is resolved

- Source of truth: the deployment variable `KIERO_CALENDAR_APP_BASE_URL`
  (exported as `CALENDAR_APP_BASE_URL_ENV`), read from `process.env` at
  request time by `calendarAppReturnHref` inside the owned file
  `convex/calendar/connection/http.ts`. Nothing caller-supplied — query,
  body, headers, or the request origin — participates in the resolution.
  The request host is demonstrably irrelevant: two different Convex hosts
  render the same configured link (test: "ignores the request host
  entirely").
- Validation (all failures return `null`, never a guess):
  1. absent / empty / blank value → `null`;
  2. must parse as an absolute URL (`new URL`);
  3. scheme must be `https:`, or `http:` only when the deployment's
     `KIERO_ENVIRONMENT` self-describes as dev — read with the same closed
     label set `/^(dev|staging|alpha-production)$/` and the same
     absent-or-unknown-means-dev rule as the telemetry cron and the
     backups boundary (`javascript:`, `data:`, `ftp:` all fail here);
  4. no embedded userinfo (`user:pass@`), no query, no fragment, non-empty
     hostname.
- Normalization: the href is rebuilt from URL-parsed components as
  `origin + pathname` with trailing slashes stripped, so
  `https://host`, `https://host/`, `https://host/app` and
  `https://host/app/` all target the same application entry. The embedded
  value additionally passes through an HTML escape (`& < > " '`) before
  entering the attribute.
- Safe behavior on `null`: the page renders WITHOUT any anchor and with
  the Polish note `Powrót do Kiero jest niedostępny. Otwórz aplikację
  bezpośrednio.` — no `href="/"`, no fallback origin, no thrown error.
  Every existing typed page (success, denial, each failure) keeps its
  copy and status; only the footer changes.
- The POST bridge leg (`/calendar/oauth/callback/complete`) answers JSON
  and is untouched.

## 2. Behavior matrix (config × input → rendered footer)

Verified by `tests/g1/callback-return.test.ts` (26 tests) unless noted.
"Link" means `<p><a href="{target}">Wróć do Kiero</a></p>`; "no link"
means no `<a>` element at all plus the unavailability note.

| Configuration state | Request input | Rendered footer |
| --- | --- | --- |
| `https://…` PWA origin, no trailing slash | any state/code/error | link → exact configured origin |
| `https://…/` trailing slash | invalid state | link → origin, slash normalized away |
| `https://…/app` or `/app/` subpath | invalid state | link → `origin/app` |
| `https://…:8443/` explicit port | resolver-level | link → `https://…:8443` |
| `http://localhost:5173`, `KIERO_ENVIRONMENT` dev/absent/unknown | resolver-level | link kept (dev http allowed) |
| `http://…`, environment staging / alpha-production | invalid state | no link |
| absent / empty / blank | invalid state; also state-missing page | no link |
| not a URL (incl. bare hostname, `//host`) | resolver-level | no link |
| `javascript:` / `data:` / `ftp:` scheme | invalid state / resolver-level | no link |
| embedded userinfo (`user:pass@`, `user@`) | invalid state / resolver-level | no link |
| query or fragment in the configured value | invalid state / resolver-level | no link |
| valid `https://…` | hostile `?return=…&redirect_uri=…&continue=javascript:…&next=//evil` + crafted `Referer` | link → ONLY the configured origin; no `evil`/`javascript:` substring anywhere in the HTML, no `href="/"` |

Protocol pages under a valid configuration (regression, unchanged
behavior): state missing → 400 "Ten link jest niekompletny." with link;
replayed/unknown state → 400 "Nieprawidłowe połączenie." with link, state
consumed once with the request-origin-derived `redirect_uri`; denial
(`error=access_denied`) → 400 "Nie udostępniono kalendarza." with link and
zero Google legs; narrow granted scope → 400 "Brak wymaganych uprawnień."
with link, exchange ran, calendar create never ran; full grant → 200
"Kalendarz Kiero jest połączony." with link, PKCE verifier forwarded to
the exchange, dedicated calendar created once, terminal write carrying
`credentialStorage: "encrypted_aesgcm"` ciphertext (raw tokens appear in
neither the recorded arguments nor the HTML), `grantedScope` recorded.

## 3. Commands and results

Fresh install (established convention), then the focused suite, the
typecheck and the full suite:

```
rtk npm ci                                  # exit 0
rtk npx vitest run tests/g1/callback-return.test.ts
  # Test Files  1 passed (1)
  #      Tests  26 passed (26)
rtk npm run typecheck                       # exit 0 (root + 7 workspaces)
rtk npx vitest run tests/g1
  # Test Files  7 passed (7)
  #      Tests  98 passed (98)
rtk npm test
  # Test Files  170 passed | 1 skipped (171)
  #      Tests  2313 passed | 5 skipped (2318)
```

The 1 skipped file / 5 skipped tests are the pre-existing skips on
`main`, untouched by R10.

### Failed attempt (preserved)

The first `rtk npm run typecheck` run failed with three TypeScript errors
in the new test file, before any green run was recorded:

```
tests/g1/callback-return.test.ts(194,36): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'AnyFunctionReference'.   (x2, runQuery/runMutation stubs)
tests/g1/callback-return.test.ts(312,34): error TS2379: ... 'exactOptionalPropertyTypes: true' ... [CALENDAR_APP_BASE_URL_ENV]: undefined not assignable to string.
```

Fixes: the stub's function references are narrowed through
`getFunctionName(reference as Parameters<typeof getFunctionName>[0])`;
the explicit-`undefined` resolver case was dropped (the `{}` case already
exercises the same `typeof configured !== "string"` branch — with
`exactOptionalPropertyTypes` the literal `undefined` property is not a
value the env parameter type admits). No behavioral change resulted.

## 4. Explicitly NOT RUN (and who owns it)

- The real Google Calendar journey, including the two-account proof and
  the more-than-seven-elapsed-days External/Testing token expiry check —
  J4's ownership. Publishing the Google OAuth client (which lifts the
  seven-day consent expiry) is an explicit owner decision, per #171.
- Deployment of this change and setting `KIERO_CALENDAR_APP_BASE_URL` on
  the Convex deployment (name only; the value is an owner-supplied
  configuration fact, never recorded here) — I8 owns deployment. Until
  that variable is set, the deployed callback honestly renders the
  no-link page; it does not regress to `href="/"`.
- A live click-through against the real staging hosts
  (`https://fiery-raven-417.eu-west-1.convex.site/calendar/oauth/callback`
  and the web origin) — needs the deployed code; the local tests use the
  same host shapes as fixtures.

## 5. Observations outside R10's owned paths (proposed, not edited)

- `apps/gateway/src/calendar-oauth/routes.ts` renders its own callback
  page with the same `href="/"` pattern on the Worker host. R10's issue
  text scopes the fix to the direct Convex callback; a symmetric change
  on the gateway surface would be a separate focused issue reusing the
  same resolver (it could import `calendarAppReturnHref` from the Convex
  module the same way it imports `answerOrNull`).
- `convex/calendar/connection/operations.ts` keeps an "Environment names
  consumed here" header inventory that does not mention
  `KIERO_CALENDAR_APP_BASE_URL`; the name is documented in `http.ts`, the
  module that consumes it. A one-line doc addition there would keep the
  inventory complete, but the file is outside R10's ownership.
