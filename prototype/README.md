# Kiero UI prototype (throwaway)

Temporary interactive prototype for [Prototype: szybki wpis, rozmowa i podsumowanie projektu](https://github.com/wojtekpiskorz/kiero/issues/12). It explores **three structurally different UI directions** (A–C) and **D „Plac budowy”**, the owner-chosen direction that combines them (feed from A, memory sidebar from B, slim capture bar from C) with the full scenario walkthroughs. This is not production code and proves nothing about the backend, AI quality or durability (see the [proof matrix](../docs/mvp/architecture-proof-matrix.md)).

## Run

```bash
cd prototype
npm install
npm run dev
```

Open `http://localhost:5173/?variant=D` (also `A`, `B`, `C`; `D` is the default). The floating dark bar at the bottom cycles variants (arrow keys work, unless you are typing), resets the scenario and opens the state inspector (boss switch, AI-failure/offline/partial processing modes, interrupted recording, PWA update proposal). The bar and inspector are comparison chrome, deliberately louder than the product UI.

## The four variants

All share the same fixtures, the same interaction contract (default entry is the company conversation with a big mic, one tap to record, explicit send, Auto pill that resets after a company send, one immutable source with project projections) and the same visual token proposal: concrete neutrals, ink text, a single safety-orange accent reserved for capture/recording.

| Variant | Name | Structure | Hypothesis | Tradeoff |
| --- | --- | --- | --- | --- |
| A | **Taśma** | Linear messenger. Projects in a pill row above the composer; project conversations, summaries and "Co teraz" open as bottom sheets (right drawer on desktop). | Zero-friction capture; everything within one thumb's reach; familiar messenger feel. | Current agreements are one extra tap away; the undifferentiated stream is hard to scan. |
| B | **Warsztat** | Two-pane workbench. Left: conversation. Right: live memory panel following the pill (Auto → Co teraz + firm knowledge, project → pamięć projektu). Mobile: sticky memory strip + overlay. | Seeing current agreements beside the talk builds trust in the agent's memory; desktop-first productivity. | Split attention, more chrome; on a phone the memory is a second-class overlay. |
| C | **Dziennik budowy** | Work journal. Day sections, time-gutter rows, inline digest cards; slim capture bar that starts recording with one tap. | The stream itself becomes an auditable record of what happened and what Kiero made of it. | Denser than a messenger; text entry costs one extra tap. |
| D | **Plac budowy** (chosen) | Feed look from A + persistent memory sidebar from B + slim bottom capture bar from C. Pill switches the workspace; header icons open Search / Calendar / Notifications / Access / Scenarios panels. | The owner's combination: familiar feed, memory always beside it, calm one-tap capture. | Combines chrome of B with journal-lessness of A; details to be judged in later full design. |

## Scenario walkthroughs (variant D)

The „▶ Scenariusze” panel in D sets up each of the twelve ticket paths; the state inspector adds the simulation knobs. Verified in browser:

1. Immediate capture: one-tap record → stop → listen/discard → send; text + several photos in one source.
2. Mixed source (s2: Banan + Kaczmarek + firm note) with fragments, real author, one original.
3. Sending → saved → processing → results; **partial analysis** (image pending badge, finishable) and **AI failure** (accepted source survives, GM run recorded).
4. Interrupted recording keeps a reviewable partial draft; offline send waits, „Ponów” resumes without a duplicate; **PWA update waits** while recording/uploading and preserves the draft on activation.
5. Agent answers cite their source; an explicit correction („zmieniamy dostawę płytek na środę”) updates the finding with history; the contradictory blacharka stays an open question until answered — then resolves with history.
6. 18 000 zł without tax basis shows „podstawa podatku: nie podano”; answering „netto” resolves it.
7. Checklist task with independent parent completion (done with unchecked points / all checked but open); closed project **Omega** with an overdue task and no coordinator (reminders to all bosses).
8. „Co teraz” lists work + questions with navigation to project/task/source.
9. Boss switch: personal unread markers, shared per-source read state; conversation mute vs reminder mute vs personal snooze in the notifications panel.
10. Search over text, transcripts and photo OCR with project/author/day filters; results open the source with audio/photo inspection.
11. Google Calendar: connection-needs-attention → reconnect; scope toggles with pending sync; 5-minute markers; personal hide/restore; separate task/event copies.
12. Invitation + revoke, revoked-access screen, GM retry of a failed stage (audited, honest failure while AI-fail mode is on, does not touch read states or authorship).

Frozen scenario clock: Tuesday 2026-09-08, Europe/Warsaw. All records are fictional demo material.

## Simulated vs real

- Microphone, photos and uploads are **simulated** (timers, deterministic SVG placeholders). No STT, no network upload, no persistence: state is in-memory with a reset.
- Agent answers/corrections are keyword heuristics (płytki/dostawa, wiatrak, cena, blacharka; zmieniam*+weekday; netto/brutto replies).
- Calendar sync, PWA update, invitations and GM actions are local state machines.
- The demo firm MAR-PIT, its bosses and projects are fictional.

## Deliberately simplified (recorded for the later full UX/design pass)

Refined visual design, component library, dark mode, real accessibility audit, empty/error states beyond the demonstrated ones, i18n plumbing, and the complete secondary flows as top-level product navigation (these live as scenario panels here). The owner plans a separate full design + user-stories phase; this prototype only settles structure and interaction direction.

