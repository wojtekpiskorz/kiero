# Continue the Kiero UI prototype: owner acceptance and ticket closure

You are taking over [Prototype: szybki wpis, rozmowa i podsumowanie projektu](https://github.com/wojtekpiskorz/kiero/issues/12) — the final stretch. The previous agent session (2026-09-08, evening) built the prototype, demonstrated all scenarios and recorded the owner's chosen direction. What remains is the owner's acceptance of the demonstrated interactions (or his change requests), then the formal resolution and closure within [Wayfinder: specyfikacja i architektura Kiero MVP PWA](https://github.com/wojtekpiskorz/kiero/issues/1).

Work with the owner (Wojtek) as the product owner. Speak to him in Polish. Write code, identifiers and technical documentation in English. All product UI and simulated Kiero agent replies must be Polish.

## 1. Establish the current state

Local project: `/Users/woji/Dev/Kiero`. GitHub: `wojtekpiskorz/kiero`. Prefix shell commands with `rtk` (see `/Users/woji/.codex/RTK.md`); read `/Users/woji/.codex/AGENTS.md` for subagent conventions. `gh` is authenticated as `wojtekpiskorz`.

Recheck instead of trusting this snapshot (state at handoff, 2026-09-08 ~21:00):

- Ticket #12: OPEN, assigned `wojtekpiskorz`, all blockers closed, blocking #13. Two WIP comments summarize both deliveries: [first: variants A/B/C](https://github.com/wojtekpiskorz/kiero/issues/12#issuecomment-5591045877), [second: chosen direction D + full scenarios](https://github.com/wojtekpiskorz/kiero/issues/12#issuecomment-5591367954).
- Branch [`codex/kiero-ui-prototype`](https://github.com/wojtekpiskorz/kiero/tree/codex/kiero-ui-prototype) (pushed): `efc03fe` base → `32d24b9` variants A/B/C → `5e3dd7e` variant D + scenario walkthroughs. `main` untouched at `38b36ae`; root checkout keeps untracked `CONTEXT.md` and `docs/` — preserve them.
- Worktree: `/private/tmp/kiero-wayfinder.b6fPMC/prototype-worktree` (other wayfinder worktrees live in the same `/private/tmp/kiero-wayfinder.b6fPMC/` directory). If the tmp worktree is gone, recreate: `git worktree add /private/tmp/kiero-wayfinder.b6fPMC/prototype-worktree codex/kiero-ui-prototype`.
- The dev server from the previous session is gone. Run the prototype with:

  ```bash
  cd /private/tmp/kiero-wayfinder.b6fPMC/prototype-worktree/prototype
  npm install   # only first time
  npm run dev   # http://localhost:5173, default variant D; ?variant=A|B|C for comparisons
  ```

## 2. What the owner already decided

His words: "wszystkie są ok. może być C - dolny bar, B - sidebar, A wygląd feedu… ale to i tak jeszcze pełny design ux/ui user stories będziemy robić potem więc to chill."

Interpretation recorded on the ticket: **variant D „Plac budowy”** — feed look from A (messenger stream), persistent memory sidebar from B (desktop pane / mobile strip + overlay, pill switches the whole workspace), slim bottom capture bar from C (one-tap record). Refined visual design, component library and full secondary flows are deliberately deferred to a later, separate design + user-stories phase; this ticket settles structure and interaction direction only.

No numbered grilling questions were asked during the prototype sessions (the pre-imported grilling ended at Q211). If a genuinely new product question arises, number it from **Q212** and distinguish product questions from visual choices.

## 3. What exists and what was verified

The prototype (`prototype/` on the branch) is a throwaway Vite + React + TS app, single route with `?variant=` switcher, dark floating comparison bar (cycles variants, resets scenario, opens state inspector) and a scenario inspector (boss switch, AI-failure / offline / partial-processing modes, interrupted recording, PWA update proposal). Shared fixtures: fictional firm MAR-PIT, two bosses (Marek, Piotrek), projects Banan/Kaczmarek plus closed Omega, frozen clock Tuesday 2026-09-08 Europe/Warsaw, mixed source s2, conflicting blacharka s7/s8, OCR invoice photo s9.

All twelve ticket scenarios are implemented in D and were browser-verified (desktop 1280×800, mobile 390×844): agent answers citing sources; message corrections with finding history; clarification resolution (tax basis, date conflict); independent checklist completion; closed-project overdue task without coordinator; search over text/transcripts/OCR; Google Calendar (reconnect, scopes, 5-minute markers, personal hide/restore, failed/pending sync); mute vs reminder-mute vs snooze; invitations/revoked access; audited GM retry; partial image analysis; interrupted recording draft; offline retry without duplicates; PWA update waiting for a safe moment. Screenshots: `docs/prototype-screens/D-*.png` on the branch. Bugs found during verification were fixed (notably: review audio not sent, correction feedback overwritten by the pipeline, `replyTo` cleared before clarification resolution, sidebar not following the pill, missing send button for text-only drafts) — history is in the two commit messages.

The prototype is simulation-only: no STT, no uploads, no persistence (in-memory state with deterministic reset). It proves nothing about the backend; the [proof matrix](https://github.com/wojtekpiskorz/kiero/blob/efc03fecbc361d04260cf034d11aa3c3707bbda5/docs/mvp/architecture-proof-matrix.md) remains NOT RUN.

## 4. The remaining work on this ticket

1. Ask the owner to open variant D (give him the URL once the dev server runs) and walk the „▶ Scenariusze" panel. Collect either his acceptance or concrete change requests.
2. If he requests changes: iterate on the `codex/kiero-ui-prototype` branch (keep `main` clean), re-verify in browser, update the ticket comment. Do not silently change an accepted contract to make a variant easier — surface conflicts and let him decide.
3. When he accepts, close out per the Wayfinder contract:
   - Post the **resolution comment** on #12 covering: the question answered; the three structural variants and their tradeoffs (A/B/C); the owner's chosen combination (D) and why; the demonstrated interaction decisions; screenshots (immutable links to `docs/prototype-screens` at the final commit); the run command and scenario guide (also in `prototype/README.md`); what is simulated vs real; remaining implementation proofs NOT RUN; immutable artifact links (branch + final commit hash).
   - **Close** ticket #12.
   - Append the one-line decision entry to the map #1 „Decisions so far" index (gist + link to the resolution comment).
4. Then check the frontier: #13 ([Grilling: kryteria gotowości i przekazanie MVP do implementacji](https://github.com/wojtekpiskorz/kiero/issues/13)) was blocked only by #12 — report it to the owner as the likely next ticket, but **do not start it in the same session**: one HITL ticket per session.

If the owner instead says the direction changed materially, do not force closure; record his input on the ticket and iterate.

## 5. Authoritative context (read before changing interactions)

The map index and resolution comments are canonical; current owner decisions override historical research recommendations. Load on demand:

- [Capture and company/project conversations](https://github.com/wojtekpiskorz/kiero/issues/6#issuecomment-5574570627) — default conversation entry, recording gestures, project pill reset, reply behavior, processing feedback.
- [Memory contract](https://github.com/wojtekpiskorz/kiero/issues/8#issuecomment-5575265504) — findings, sources, corrections, unknown states, dates and amounts.
- [Architecture resolution](https://github.com/wojtekpiskorz/kiero/issues/11#issuecomment-5590547919) and [architecture design](https://github.com/wojtekpiskorz/kiero/blob/efc03fecbc361d04260cf034d11aa3c3707bbda5/docs/mvp/architecture-design.md).
- [Notification contract](https://github.com/wojtekpiskorz/kiero/issues/7#issuecomment-5574789474), [lifecycle contract](https://github.com/wojtekpiskorz/kiero/issues/9#issuecomment-5575553920), [Google Calendar contract](https://github.com/wojtekpiskorz/kiero/issues/14#issuecomment-5583090872), [access contract](https://github.com/wojtekpiskorz/kiero/issues/4#issuecomment-5574288760), [baseline](https://github.com/wojtekpiskorz/kiero/issues/2#issuecomment-5573021974), [alpha contract](https://github.com/wojtekpiskorz/kiero/issues/3#issuecomment-5573718534).
- [Glossary](https://github.com/wojtekpiskorz/kiero/blob/efc03fecbc361d04260cf034d11aa3c3707bbda5/CONTEXT.md) (identical to the untracked root copy).

Formal privacy work deferred under Q195 stays outside the prototype's user flow. Real cloud deployment, paid services, production changes and contacting other people remain out of scope.

## 6. Suggested skills

Call the Skill tool for:

- **wayfinder** — ticket claiming, resolution recording, map-index update rules.
- **prototype** (and its `UI.md`) — if any variant iteration is needed; the artifact lives on the throwaway branch, never promoted to production by this map.
- **frontend-design** — for any visual refinement requested before acceptance.
- **browser-use:control-browser** — for browser verification of anything you change (main agent only).
- **grilling** and **domain-modeling** — only if the session moves on to ticket #13 (separate session; ask the owner first).

## 7. Practical notes

- The in-app browser tab left open at `http://localhost:5173/?variant=D` belongs to the previous session; reopen the URL yourself after starting the dev server.
- `npm run build` (tsc + vite) is the available check; there is intentionally no test framework for this throwaway code.
- Keep the owner updated in Polish about what the artifact demonstrates, not a tool transcript. Proceed autonomously on reversible details; ask only when a design decision materially needs his judgment, showing concrete options first.
