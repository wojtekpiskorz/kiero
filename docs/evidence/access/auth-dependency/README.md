# Auth dependency advisory resolution evidence: 2026-09

Issue [R11 #169]. Recorded on **2026-09-14** in the `r11-auth-deps`
worktree. All advisory data below was read from the GitHub Advisory
Database on that date (source URLs per finding); no secret value was
printed, logged or committed — every credential in the new tests is a
self-generated fixture.

## 1. Dependency path and runtime usage (acceptance 1)

```
$ npm ls @auth/core
kiero@0.1.0 /projects/kiero-worktrees/r11-auth-deps
├── @auth/core@0.41.3
└─┬ @convex-dev/auth@0.0.95
  └── @auth/core@0.41.3 deduped
```

- The root `package.json` declares `@auth/core` as a **direct exact-pin
  dependency** (the B1 coordinated shared change: the peer is pinned at
  the root so the workspace graph resolves one copy). `@convex-dev/auth`
  0.0.95 declares it as `peerDependencies: { "@auth/core": "^0.41.1" }`
  and resolves to the root copy (deduped, single lockfile node).
- Runtime usage of `@auth/core` in Kiero (verified by reading the
  installed sources, not assumed):
  - **App direct**: `Google({ clientId, clientSecret, profile })` from
    `@auth/core/providers/google` in `convex/access/identity/authEntry.ts`
    (included only when the owner configured the client names).
  - **Via @convex-dev/auth 0.0.95** (runtime imports, package sources
    read): `Cookie` symbol from `@auth/core/lib/utils/cookie.js`
    (types/branding only), `setEnvDefaults` from `@auth/core`
    (`src/server/provider_utils.ts`), `customFetch` re-exported from
    `@auth/core` (`src/server/oauth/lib/utils/customFetch.ts`), and
    provider config types. **@convex-dev/auth does NOT run @auth/core's
    request handler, its OAuth checks module, its email token action or
    `getToken`** — it vendors adapted copies of the OAuth
    checks/callback/authorization-url modules (annotated in its sources
    as mapped from @auth/core commit `5af1f30a...`).

## 2. Official advisory ranges (acceptance 1)

Read 2026-09-14 via `gh api /advisories?ghsa_id=...` (GitHub Advisory
Database). No advisory affecting `@auth/core` other than these three
existed as of that date (query `/advisories?affects=@auth/core`), and
none is withdrawn.

| GHSA | CVE | Severity | Published / Updated | Affected `@auth/core` range (as published) | First patched |
| --- | --- | --- | --- | --- | --- |
| [GHSA-7rqj-j65f-68wh](https://github.com/advisories/GHSA-7rqj-j65f-68wh) | CVE-2026-73420 | critical | 2026-07-23 / 2026-08-12 | `>= 0.1.0, < 0.41.3` | **0.41.3** |
| [GHSA-xmf8-cvqr-rfgj](https://github.com/advisories/GHSA-xmf8-cvqr-rfgj) | CVE-2026-73418 | high | 2026-07-23 / 2026-08-13 | `>= 0.1.0, < 0.41.3` | **0.41.3** |
| [GHSA-x445-f3h2-j279](https://github.com/advisories/GHSA-x445-f3h2-j279) | CVE-2026-73419 | medium | 2026-07-23 / 2026-08-13 | `<= 0.41.2` | **0.41.3** |

What 0.41.3 changed (verified by diffing the published tarballs
`@auth/core@0.41.1` vs `@auth/core@0.41.3`; only these files differ,
plus `providers/github.ts` and `package.json`):

- `lib/actions/sign-token.ts` — email normalizer applies Unicode NFKC
  **before** validation (homoglyph `@`, e.g. U+FF20, is canonicalized to
  a real `@` and then rejected) — the GHSA-7rqj fix.
- `jwt.ts` — `getToken()` returns `null` when a Bearer header's
  percent-encoding is malformed instead of throwing — the GHSA-xmf8 fix.
- `lib/actions/callback/oauth/checks.ts` — the sealed state/nonce/PKCE
  cookie payload now records the creating provider's id and the callback
  rejects a check cookie created for a different provider — the
  GHSA-x445 fix.

**Reachability of each finding in Kiero, honestly classified** (the
upgrade resolves all three on the graph regardless):

- GHSA-x445: the executed Google flow uses @convex-dev/auth's vendored
  checks, whose cookie names are **provider-scoped** (`__Host-<provider>OAuth<pkce|state|nonce>`,
  `src/server/oauth/convexAuth.ts`) and whose check signature
  (codeVerifier/state/nonce) is stored server-side bound to the verifier
  row; @auth/core's own checks module is never executed here. Pinned in
  the new tests at the package boundary anyway (see §4).
- GHSA-xmf8: `getToken` is never called by the app or @convex-dev/auth
  (session verification is the Convex platform's job against the site
  JWKS). Unreachable, but present in the installed package pre-R11.
- GHSA-7rqj: the email-code flow uses @convex-dev/auth's own Email
  provider (exact-string `authorize` match, no @auth/core normalizer);
  Kiero's own `normalizeEmail` (`trim().toLowerCase()`) does not perform
  NFKC either, but no downstream address parser in Kiero splits
  recipients (the address travels as one JSON string to Resend). See
  §7 for the follow-up proposal.

## 3. Chosen version and rationale (acceptance 2)

**`@auth/core` 0.41.1 → 0.41.3. `@convex-dev/auth` stays pinned at 0.0.95.**

- 0.41.3 is the **first patched version for all three advisories** and
  the **smallest** compatible fix: the 0.41.x line ends at 0.41.3
  (`npm view @auth/core versions` → `0.41.0 … 0.41.3`; 0.41.3 is also
  the `latest` dist-tag, published 2026-07-20).
- 0.41.3 satisfies @convex-dev/auth 0.0.95's peer range `^0.41.1`
  (`>=0.41.1 <0.42.0` for 0.x). Anything above 0.41.x would violate the
  peer range and force bumping @convex-dev/auth itself — not required
  and out of the no-bulk-upgrade rule.
- @convex-dev/auth was NOT bumped: not needed for the advisories; the
  root change is the one coordinated lockfile move (charter: root deps
  are a shared change).
- npm's own suggestion agreed on the version but phrased it as
  "`npm audit fix --force` … outside the stated dependency range" —
  because the root pin was the exact string `0.41.1`. We changed the
  owned pin directly instead of forcing.
- No intermediate version was tried and discarded: 0.41.2 is inside the
  affected ranges of all three advisories (`< 0.41.3` / `<= 0.41.2`),
  so it was never a candidate. **No failed attempts to preserve beyond
  that.**
- Incidental metadata change carried by 0.41.3's package node in the
  lockfile: its `peerDependencies.nodemailer` declaration widened from
  `^7.0.7` to `^7.0.7 || ^8.0.5` (nodemailer is not installed; peer
  metadata only). No other lockfile node changed.

## 4. Boundary tests (acceptance 3)

New files (all under the owned `tests/b1/**`):

- `tests/b1/authBoundary.test.ts` — dependency pins (installed versions,
  exact root pins, peer-range satisfaction, single deduped lockfile
  node) and the **Google flow at the real package boundary**: the app's
  real `authEntry.ts` imported with fixture client names, driven through
  @convex-dev/auth's real signIn action, store mutations and HTTP routes
  on a real `httpRouter`, over the real @auth/core 0.41.3 Google
  provider and oauth4webapi's PKCE/OIDC validation. Covers the
  authorization redirect (S256 challenge, provider-scoped
  `__Host-googleOAuthpkce` cookie), the full callback with the app's
  real profile decode (identity keyed on Google `sub`, never the
  address) and real `createOrUpdateUser` policy, the session key/issuer
  surface (`/.well-known/openid-configuration` issuer bound to the site
  URL, `jwks.json` verbatim, RS256 token: issuer = site URL, audience
  `convex`, subject `userId|sessionId`), the library's
  `getAuthUserId`/`getAuthSessionId` split, the app's 30-day session
  rule, and the PKCE refusal when the callback arrives without the
  sign-in cookie.
- `tests/b1/authEmailBoundary.test.ts` — the email-code flow at the real
  boundary with Google names **absent**: issuance through the real
  policy (person row, `email_code` account, 15-minute hashed code row),
  delivery through the real render + Resend adapter (Polish copy, 8-digit
  code, fixture key name only), redemption with the **same** address,
  refusal of a different address (the provider's real `authorize` check)
  and of a wrong code (`Could not verify code`), the library-minted
  session token contract, and the **explicit refusal to link accounts
  sharing an address** — a Google person exists and an email-code
  sign-in (mixed-case variant of the same address) is rejected with the
  `[kiero:method_conflict]` marker and the accepted Polish copy, with no
  code row, no email and no second person row; plus the honest absence
  of the Google routes in the unconfigured construction.
- `tests/b1/helpers/authBoundaryHarness.ts` — the shared in-memory
  Convex store fake and platform ctx (the narrowed-surface idiom of
  `tests/b1/cores.test.ts`), fixture RSA generation and raw node:crypto
  JWT sign/verify. Real packages run unmocked; the platform store and
  the network (Google discovery/JWKS/token, Resend) are self-generated
  fixtures — the Google stub enforces client_secret_basic credentials,
  the exact redirect_uri and the S256 challenge, i.e. Google's own
  checks, so the PKCE-refusal test is a real end-to-end rejection.

## 5. Audit before/after (acceptance 4)

Before (installed `@auth/core@0.41.1`), `npm audit --omit=dev` = full
audit (identical output):

```
@auth/core  <=0.41.2
Severity: critical
Auth.js: Email normalizer validates the address before Unicode normalization, allowing a homoglyph @ bypass - GHSA-7rqj-j65f-68wh
Auth.js: getToken() throws an uncaught exception on malformed Bearer authorization headers - GHSA-xmf8-cvqr-rfgj
Auth.js: OAuth state, nonce, and PKCE check cookies are not bound to the provider that created them - GHSA-x445-f3h2-j279
fix available via `npm audit fix --force`
Will install @auth/core@0.41.3, which is outside the stated dependency range
node_modules/@auth/core
1 critical severity vulnerability
```

After (`@auth/core@0.41.3`): `npm audit --omit=dev` and `npm audit` both
report **`found 0 vulnerabilities`** (prod and dev graph). Remaining
install-time notices (not audit findings, unchanged by R11, owned by
future dependency work): deprecation warnings for `@oslojs/asn1@1.0.0`,
`@oslojs/binary@1.0.0`, `lucia@3.2.2`, `@oslojs/crypto@1.0.1` — all
transitive under the pinned `@convex-dev/auth` 0.0.95.

## 6. Check runs (2026-09-14, worktree root)

| Command | Result |
| --- | --- |
| `npm ci` (before the bump, baseline) | exit 0 |
| `npm install` (after editing the pin) | `changed 1 package` … `found 0 vulnerabilities` |
| `npx vitest run tests/b1` | **8 files / 111 tests passed** (23 new) |
| `npm run typecheck` | exit 0 (root + all workspaces) |
| `npm run build` | exit 0 (`vite … built in 655ms`; pre-existing >500 kB chunk warning) |
| `npm audit --omit=dev` / `npm audit` | `found 0 vulnerabilities` / `found 0 vulnerabilities` |
| `npm test` (full suite) | **171 files passed, 1 skipped; 2310 tests passed, 5 skipped** |
| `npm ci` (fresh, from the updated lockfile) | exit 0; `npm ls @auth/core` → single deduped `0.41.3`; b1 re-run green |

## 7. Not run / follow-ups

- **NOT RUN — live browser identity qualification**: belongs to B5 on
  the eventual candidate deployment. The new tests drive the real
  packages in-process, not a browser against a live Google/Resend.
- **NOT RUN — deployment push**: nothing was deployed; R11 owns the
  lockfile, and E8 follows this issue for the same reason.
- Proposed prerequisite (outside R11 ownership, recorded per the
  process rule): consider adding Unicode NFKC normalization to Kiero's
  own `normalizeEmail` in `convex/access/identity/userPolicy.ts`, mirroring
  the upstream 0.41.3 fix for defense in depth (Kiero's current
  trim+lowercase is not known to be exploitable through its flows, but
  the upstream lesson applies to the stored-address comparison). Owner:
  the identity/access lane (B-series), not R11.
