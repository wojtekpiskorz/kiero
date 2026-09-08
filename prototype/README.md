# Kiero UI prototype (throwaway)

Temporary interactive prototype for [Prototype: szybki wpis, rozmowa i podsumowanie projektu](https://github.com/wojtekpiskorz/kiero/issues/12). It explores **three structurally different UI directions** for the Kiero PWA. This is not production code and proves nothing about the backend, AI quality or durability (see the [proof matrix](../docs/mvp/architecture-proof-matrix.md)).

## Run

```bash
cd prototype
npm install
npm run dev
```

Open `http://localhost:5173/?variant=A` (also `B`, `C`). The floating dark bar at the bottom cycles variants (arrow keys work, unless you are typing), resets the scenario and opens the state inspector. The bar and inspector are comparison chrome, deliberately louder than the product UI.

## The three directions

All three share the same fixtures, the same interaction contract (default entry is the company conversation with a big mic, one tap to record, explicit send, Auto pill that resets after a company send, one immutable source with project projections) and the same visual token proposal: concrete neutrals, ink text, a single safety-orange accent reserved for capture/recording.

| Variant | Name | Structure | Hypothesis | Tradeoff |
| --- | --- | --- | --- | --- |
| A | **Taśma** | Linear messenger. Projects live in a pill row above the composer; project conversations, summaries and "Co teraz" open as bottom sheets (right drawer on desktop). | Zero-friction capture; everything within one thumb's reach; familiar messenger feel. | Current agreements are one extra tap away; the undifferentiated stream is hard to scan. |
| B | **Warsztat** | Two-pane workbench. Left: conversation. Right: live memory panel that follows the pill (Auto → Co teraz + firm knowledge, project → pamięć projektu). The pill switches the whole workspace. Mobile: sticky one-line memory strip + overlay. | Seeing current agreements beside the talk builds trust in the agent's memory; desktop-first productivity. | Split attention, more chrome; on a phone the memory is a second-class overlay. |
| C | **Dziennik budowy** | Work journal. Day sections, time-gutter rows, inline digest cards ("Kiero uporządkował") where the agent organized something; slim capture bar that starts recording with one tap and expands only when needed; project filters + karta projektu. | The stream itself becomes an auditable record of what happened and what Kiero made of it. | Denser than a messenger; text entry costs one extra tap. |

## Comparison slice (first delivery)

Each variant implements the same slice so they can be judged side by side:

1. Company conversation + composer (text, simulated voice note with listen/discard, simulated photos; one source can mix all three).
2. A mixed-project source (Marek's Monday message about Banan + Kaczmarek + a firm-wide note) with per-fragment links, and navigation to the one full source from a project view.
3. Access to a project's current summary (pamięć projektu) with sources, meanings (uzgodniony/propozycja), an explicit "nie podano" tax-basis gap and independent corroboration.

## Scenario controls (inspector → "Stan")

- **Kto jest zalogowany**: switch the simulated boss (Marek/Piotrek). Both see the same shared sources; read state is personal.
- **Tryb przetwarzania**: zwykły / Awaria AI (accepted source survives, processing marked failed) / Brak sieci (send waits, "Ponów" resumes the same source without a duplicate).
- **Przerwanie nagrywanie**: simulates an interrupted recording; the partial fragment stays as a reviewable draft, nothing is sent automatically.
- **Reset scenariusza**: deterministic reseed of the whole state.

Frozen scenario clock: Tuesday 2026-09-08, Europe/Warsaw (a message sent "jutro" means 2026-09-09, also after retries). All records are fictional demo material.

## Simulated vs real

- Microphone, photos and uploads are **simulated** (timers, deterministic SVG placeholders). No STT, no network upload, no persistence: state is in-memory with a reset.
- Agent replies and "Kiero uporządkował" cards are scripted fixtures; heuristic project linking only reacts to keywords (Banan/Kaczmarek/wiatrak/płytki).
- The demo firm MAR-PIT, its bosses and projects are fictional.

## Deliberately omitted from the first delivery (recorded for the next iteration)

Search (messages/transcripts/OCR), corrections vs ambiguous contradiction walkthrough, task checklist semantics, closed-project obligations, per-source read-state marking across devices, mute/quiet-hours/snooze, Google Calendar scenes, invitations/sign-in/GM scenes, PWA-update-waits-while-recording. These follow the owner's choice of direction, per ticket #12 scenario list.

## Layout notes

- Variants render inside `height: calc(100dvh - var(--proto-bar-h))` so the comparison bar never covers the composer.
- `?variant=` is preserved across reloads; variant state is shared, so you can flip mid-scenario without losing sent messages.
- Product-facing text is Polish; code, identifiers and this file are English per the repo contract.
