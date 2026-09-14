# ADR: Defer the Google Calendar integration beyond the v1 core

- **Status**: Accepted (owner decision, 2026-09-14)
- **Deciders**: Kiero owner (Wojtek Piskorz), recorded by the implementation coordinator
- **Scope amendment**: execution charter, map #15 qualification graph, UX-CAL rows, P08 proof split

## Context

The accepted core includes an optional personal Google Calendar integration
("Kalendarz Kiero w Google"; the G-series lanes, merged and integrated with
their deterministic suites). Its qualification (J4's Calendar leg) carries the
heaviest external dependencies in the map:

- two real Google accounts with an uninterrupted observation of more than
  seven elapsed days;
- a Google client publishing decision, because External/Testing consent and
  refresh tokens expire after seven days and the observation cannot span that
  boundary without publishing (or deliberate renewal) plus any Branding or
  verification work Google actually requires;
- physical-device and multi-account testing whose value depends on a real
  userbase exercising the connection, which the barebones v1 does not have.

Meanwhile the v1 core value (conversation capture, memory, project work,
tasks with reminders and push) does not depend on the Google connection.

## Decision

Defer the **entire Google Calendar integration** beyond the v1 core:

1. The v1 PWA does not expose the Calendar entry. R16 #198 switches the
   calendar host entry to the registry's pending state; the composition's
   mounted filter excludes it from routes and navigation.
2. The G-series code base stays integrated and tested. Nothing is deleted:
   the deterministic calendar suites keep gating the build, the Convex
   functions and callback legs remain deployed, and the shared modules
   (resolver, renderer, environment labels) stay in their post-R10/R12/R13
   shape.
3. The Calendar qualification moves out of the v1 gates:
   - J4 #63 keeps devices, push (VAPID), PWA/browser modes, recording and
     media, read-state, membership and permission composition, and safe
     client updates. The two-Google-account journey, the >7-day observation
     and the publishing decision move to C6 #197.
   - J5 #64 still traces all 61 UX inventory entries; the nine UX-CAL rows
     trace to this ADR with owner C6 as a visible DEFERRED state, never an
     omitted row.
   - J6 #139 re-proves the joined core against the withheld v1 composition.
4. Push notifications are NOT deferred: they are core reminders delivery and
   stay in v1 with their VAPID and device qualification.
5. The CONTEXT.md glossary is unchanged. The Calendar terms remain the
   accepted domain language; deferral changes release scope, not meaning.

## Consequences

- The v1 release path loses its longest external clock (the >7-day Google
  observation) and the Google publishing dependency.
- C6 #197 (blocked by J5) owns the post-core release: the publishing
  decision, the two-account journey on the then-current candidate, re-enabling
  the host entry, and the elapsed-time evidence.
- Staging keeps the deployed calendar functions; no callback or OAuth
  consumer is removed, so the re-entry is a composition flip plus
  qualification, not a rebuild.
- P08 (notifications/Calendar) splits its v1 scope: push through J4; the
  Calendar journey through C6.

## Re-entry criteria

C6 starts after the core delivery handoff (J5) and requires: the owner's
publishing decision, two real Google accounts, real boss accounts and
devices, a released observation candidate with recorded identity, and more
than seven elapsed days of preserved evidence.
