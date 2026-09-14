# Calendar withheld from the v1 composition evidence (R16 #198)

Status date: 2026-09-14. Worktree `r16-calendar-withheld` from `main` at
`607e1408f665cb6f26c0ea79e38ad44c7dd890bd` (uncommitted changes; the
coordinator owns the Git lifecycle). The owner deferred the Google Calendar
integration beyond v1 (ADR `docs/adr/calendar-deferral-2026-09.md`, written
in a parallel coordinator lane; referenced by path only). The original
dispatch assumed a mounted-output filter that did not exist on this base;
after R16 reported that premise failure, the coordinator extended R16's
ownership (recorded on #198) to `apps/web/src/composition/full.ts` and
`tests/g1/calendar-ui.test.ts`. This document records what changed, the
composition mechanism as implemented, and what was verified.

## 1. What changed

| File | Change |
| --- | --- |
| `apps/web/src/app/features/calendar/entry.ts` | The entry flips from `implementation: "mounted"` to `"pending"`: the `CalendarFeature` import and the `screen` field are dropped (nothing in the host mounts the screen; the CalendarFeature module itself is untouched for the lane that remounts it), and a Polish `pendingNote` states the deferral honestly. `featureId`, `routePath`, `navLabel`, `screenHeading` and the five `consumedOperations` are unchanged. A comment names the ADR path. |
| `apps/web/src/composition/full.ts` (extended ownership) | `calendar.connection` moves from `FULL_CORE_FEATURE_IDS` to the new `FULL_CORE_DEFERRED_FEATURE_IDS` (the recorded-deferral list). The drift check now accepts a listed id as mounted (core list) or pending (deferred list), while a silently missing id from either list stays `feature_missing` and a core id present but not mounted is named `feature_not_mounted` (the previously dead kind). `fullCoreAppFeatures` returns the composed list with the deferred pending entries withheld, so the router and navigation (both derived from the returned list) expose neither `/kalendarz` nor the "Kalendarz" label, with no router or shell edit. |
| `tests/g1/calendar-ui.test.ts` (extended ownership) | The mounted pin becomes the pending pin: the entry (read from the real entry module, since the host no longer composes it) validates as pending with the honest Polish note and the five certified operations intact. The screen assertions render `CalendarFeature` directly (the module stays intact for the remounting lane); every other assertion in the file is untouched. |
| `tests/g4/surface.test.ts`, `tests/g5/surface.test.ts` | Lookup re-points only: the registration pins read the entry module directly instead of `appFeatures.find` (the entry is no longer in the composed output); g4's mounted assertion becomes the pending assertion. Their ops assertions are unchanged and still hold. See section 3 for the ownership note. |
| `tests/a4/calendar-withheld.test.ts` (new) | The R16 proofs: the entry half pins the pending registry state (identity, Polish note, five operations, no placeholder screen); the composition half pins the withholding through the real composed list (no `/kalendarz` route path, no "Kalendarz" navigation label, loud validation still passing with the conversation default first). |
| `tests/a4/app-registry.test.ts` | The mounted-lanes pin drops `calendar.connection` from the expected mounted list, with a comment recording the R16 withholding and the ADR path. |

The `pendingNote` text (user-facing Polish, per CONTEXT.md terms):

> Kalendarz Kiero w Google nie jest dostępny w tej wersji: podłączanie
> kalendarza Google zostało odroczone na późniejszą wersję Kiero. Ustalenia
> z terminami pozostają w Kiero, a ta funkcja wróci po dokończeniu
> integracji.

## 2. The composition mechanism (premise finding, then the fix)

The original dispatch stated that `full.ts` "already filters
`.filter((entry) => entry.implementation === "mounted")` when building the
v1 composition". On `main` at `607e140` that was false: the only mounted
filter was inside the drift check, which REQUIRED `calendar.connection`
(listed in `FULL_CORE_FEATURE_IDS`) to be mounted and threw on the pending
entry at module scope of `app-features.ts` (host boot failure); the
composed output was unfiltered; and neither `router.tsx` nor
`app-shell.tsx` filtered by implementation state. With only the entry
flip applied, every suite importing `app-features` failed at import (14
files across 10 lanes), proven against a stashed green baseline
(`tests/a4 tests/g1` = 12 files, 151 tests green on the untouched base).

The coordinator's corrected design was implemented with two deviations,
both forced by green requirements the coordinator also stated, both inside
the extended ownership:

1. **Deferred ids moved to their own list instead of staying pending
   inside `FULL_CORE_FEATURE_IDS`.** The coordinator's design kept the id
   in `FULL_CORE_FEATURE_IDS` with a pending-tolerant check; but
   `tests/j2/composition.test.ts` line 105 (J2's path, not extended to
   R16) asserts the mounted join equals `FULL_CORE_FEATURE_IDS.join`, so a
   listed-but-pending id fails J2's untouched proof. The split
   (`FULL_CORE_FEATURE_IDS` = mounted core, `FULL_CORE_DEFERRED_FEATURE_IDS`
   = recorded deferrals) preserves the coordinator's semantics exactly
   (pending deferral legitimate and loudly recorded, silently missing id
   drift, quiet unship of a core surface named as `feature_not_mounted`)
   while keeping J2's pin true unchanged.
2. **The output filter withholds only the deferred pending entries, not
   every pending entry.** A blanket mounted-only return would also drop
   the pending `projects.context` placeholder (`/projekty`) from v1
   routes and navigation, which is outside R16's scope ("withhold the
   Calendar entry") and would break a4's own reachable-surface pins. The
   projects placeholder keeps composing exactly as before.

A third consequence required touching two G-lane test files beyond the
recorded extension: `tests/g4/surface.test.ts` and
`tests/g5/surface.test.ts` resolved their registration pins through
`appFeatures.find("calendar.connection")`, which returns undefined once
the entry is withheld, and g4 additionally pinned `mounted`. The
coordinator's requirement that the g4/g5 sweep be green is unachievable
without re-pointing those lookups at the entry module (the same class of
change as the granted g1 extension). The re-points are minimal and keep
every ops assertion intact; the coordinator should ratify them on #198
alongside the recorded extension.

## 3. What was checked (all commands executed 2026-09-14)

All commands ran in the worktree root with all changes applied. `rtk`
prefixes omitted for readability; the repo convention was followed.

| # | Check | Command | Observed | Status |
| --- | --- | --- | --- | --- |
| P1 | Dependencies | `npm ci` | `found 0 vulnerabilities` | PASS |
| P2 | Types | `npm run typecheck` | exit 0 (all five `tsc --noEmit` projects clean) | PASS |
| P3 | R16 focused suites | `npx vitest run tests/a4 tests/g1 tests/j2` | 17 files, 193 tests, all green (including the new `calendar-withheld.test.ts` contract, the flipped g1 pin, and J2's untouched composition proof) | PASS |
| P4 | Blast-radius sweep (every other `app-features` importer) | `npx vitest run tests/d4 tests/f3 tests/g4 tests/g5 tests/h1 tests/h2 tests/h3 tests/h4 tests/j1` | 28 files, 412 tests, all green | PASS |
| P5 | Calendar backend suites untouched | covered by P3/P6 | every g-series backend suite (g1 callback-return, cores, dispatch, exchange, gateway-callback-return, gateway-client, protocol; g2-g5 convex-side) runs green with no backend file edited; `live-proof.mjs` files run against a deployment, not vitest | PASS |
| P6 | Full suite | `npm test` | 180 files passed, 1 skipped; 2545 tests passed, 6 skipped (pre-existing skips) | PASS |
| P7 | `tests/g6` (from the original dispatch checks list) | `ls tests/g6` | no such directory on this base (g-series present: g1-g5); P3/P4 cover the calendar suites that exist | NOTED |

The G-series backend code (`convex/calendar/**`, the gateway calendar
routes, `apps/web/src/features/calendar/**`) is byte-identical to the
base; the calendar UI suites that previously composed through the host
entry now exercise the screen modules directly, which is the honest proof
that the integrated code stays intact while withheld from v1.
