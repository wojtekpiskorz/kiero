# Start the Kiero UI prototype

You are taking over Kiero's next Wayfinder decision ticket. Work with me as the product owner to build and evaluate a temporary interactive UI prototype. Own the work through a concrete browser artifact, my feedback, iteration and the accepted decision recorded on GitHub.

Speak to me in Polish. Write code, identifiers and technical documentation in English. All product UI and simulated Kiero agent replies must be Polish.

## Objective and scope

Resolve [Prototype: szybki wpis, rozmowa i podsumowanie projektu](https://github.com/wojtekpiskorz/kiero/issues/12) within [Wayfinder: specyfikacja i architektura Kiero MVP PWA](https://github.com/wojtekpiskorz/kiero/issues/1).

The question is: how should mobile and desktop Kiero look and behave so a construction-company boss can immediately capture information and reliably find the current agreement and its source?

This is an interactive product/UI exploration with synthetic data. Backend implementation, real AI calls, cloud provisioning and production deployment belong to later work. Produce working interactions that let me judge the design. Keep the code deliberately temporary, easy to run and separate from application production code.

Kiero serves micro construction firms: one boss with subcontractors, small specialist crews and partnerships coordinating a few jobs. The first alpha firm has two equal bosses. Design for a busy person using a phone on a construction site, while providing a useful desktop workspace. The current tier is for bosses.

## 1. Establish the current state

The local project is `/Users/woji/Dev/Kiero`; GitHub is `wojtekpiskorz/kiero`. Read applicable `AGENTS.md` instructions and `/Users/woji/.codex/RTK.md` when available. On this host, prefix shell commands with `rtk`.

Use `wayfinder`, `prototype` and its `UI.md` branch. Use a frontend design skill for intentional visual design. Read `CONTEXT.md` for product vocabulary. Read `domain-modeling` if a genuinely new term needs to be recorded. The Wayfinder planning scope takes precedence over any generic prototype instruction to promote winning code into the real application.

Before editing, inspect the local branch/worktrees/dirty files and fetch the current map, target ticket, native children and blockers. At handoff preparation on 2026-09-08, the prototype ticket was open, unassigned and unblocked; architecture was closed. Recheck this instead of relying on the snapshot. If the ticket is available, claim it by assigning the map's driver, `wojtekpiskorz`. Respect an existing active claim and worktree rather than starting overlapping work.

The root checkout currently has planning documents and no production application. Preserve its untracked `CONTEXT.md` and `docs/`. Architecture assets were published on `codex/kiero-architecture-contract` at commit `efc03fecbc361d04260cf034d11aa3c3707bbda5`. If the repository is still in that state, use a separate worktree and new `codex/` prototype branch based on that verified artifact commit. If work has advanced, reconcile current state first. Keep `main` untouched.

Completion of this step means you know the actual claim, checkout, relevant contracts and where the temporary prototype will live. Continue into design; do not end the turn with a plan alone.

## 2. Load the authoritative context

Read these before choosing the interaction structure:

- [Capture and company/project conversations](https://github.com/wojtekpiskorz/kiero/issues/6#issuecomment-5574570627), especially the default conversation entry, recording gestures, project-pill reset, reply behavior and processing feedback.
- [Architecture resolution](https://github.com/wojtekpiskorz/kiero/issues/11#issuecomment-5590547919), including its explicit amendments to earlier decisions.
- [Architecture design and data dictionary](https://github.com/wojtekpiskorz/kiero/blob/efc03fecbc361d04260cf034d11aa3c3707bbda5/docs/mvp/architecture-design.md).
- [Glossary](https://github.com/wojtekpiskorz/kiero/blob/efc03fecbc361d04260cf034d11aa3c3707bbda5/CONTEXT.md).

Load the following when implementing the corresponding prototype interactions, before inventing their behavior:

- **Memory, amounts, dates, sources, corrections and dynamic information:** [memory contract](https://github.com/wojtekpiskorz/kiero/issues/8#issuecomment-5575265504).
- **Tasks, checklists, events and closed projects:** [lifecycle contract](https://github.com/wojtekpiskorz/kiero/issues/9#issuecomment-5575553920).
- **Unread state, push, mute, quiet hours and snooze:** [notification contract](https://github.com/wojtekpiskorz/kiero/issues/7#issuecomment-5574789474).
- **Calendar connection, personal hides, sync and reconnect:** [Google Calendar contract](https://github.com/wojtekpiskorz/kiero/issues/14#issuecomment-5583090872).
- **Invitations, sign-in, membership, revocation and GM:** [access contract](https://github.com/wojtekpiskorz/kiero/issues/4#issuecomment-5574288760).
- **Audience, scope and alpha evaluation:** [baseline](https://github.com/wojtekpiskorz/kiero/issues/2#issuecomment-5573021974), [alpha contract](https://github.com/wojtekpiskorz/kiero/issues/3#issuecomment-5573718534).
- **What a prototype does not prove:** [integration proof matrix](https://github.com/wojtekpiskorz/kiero/blob/efc03fecbc361d04260cf034d11aa3c3707bbda5/docs/mvp/architecture-proof-matrix.md).

Current owner decisions override historical research recommendations. The map is an index; full decisions live in resolution comments. These links let you work without the original chat or temporary files from another agent's session. If a required private source is inaccessible, identify the specific gap rather than inventing its contents.

## 3. Keep these product invariants visible

### Capture and conversation

The authenticated landing screen is immediately the shared company conversation with a large microphone affordance, text input and photo attachment. Starting a recording takes one tap after microphone permission. The user does not first select a project, create a chat or pass through a dashboard. “Co teraz” and projects are nearby destinations.

Voice means asynchronous voice messages. Tap to start, tap to stop, then explicitly send. Playback and discard are optional on the same screen; holding a finger or visiting a mandatory preview screen is unnecessary. One source can contain text, audio and several photos. There is no product duration cap.

Default project context is “Auto”. A project pill is optional. After a send from the main conversation, the selection returns to Auto. Inside a project, its pill remains visible and selected. Mixed-project content can still route individual fragments elsewhere.

There is one immutable logical source and real author. Project conversations show linked relevant information and a way to open the full source. They do not create separately editable copies. General company information may remain unassigned. Preserve reply-to previews within the shared stream rather than introducing a separate thread system.

“Wysyłanie” means the source is still being transferred. “Zapisano” means the complete source and attachments were accepted. AI processing is a subsequent state. Model failure cannot make an accepted message disappear. Ordinary updates receive concise expandable feedback near the source; full agent bubbles are for questions, requests and clarifications. A colleague-directed question should remain understandable as a question to that colleague.

### Memory and work

Show current typed facts together with their source, author and change history. Unknown or conflicted information must be recognizable; an estimate is not an agreed price, and an unspecified tax basis is not silently net or gross.

Clear corrections update the current agreement automatically with history retained. Genuine ambiguity produces a concrete follow-up question. Correcting a prior message means sending a new message. Direct correction of a structured field is a separate operation with its own audit history.

A task can contain a one-level checklist. Parent completion is independent: completing all points does not complete the parent, and a completed parent can retain unchecked points. Keep executor and coordinator distinct. Closed projects can still have open obligations. Passing a date does not prove an event occurred.

Similar projects can have distinguishing codenames, for example two jobs on Kraińskiego called “Banan” and “Kaczmarek”. Stable source/project links survive renaming. Read state belongs to each user and the logical source across all views. Conversation mute, reminder mute and personal snooze have different effects.

### Access, integrations and media

Ordinary v1 users have one firm. GM is an explicit separate alpha mode, with operator actions and read state distinguished from ordinary bosses. Show only the access/settings interactions needed to test the experience.

Google Calendar is optional and separate from sign-in. Simulate the accepted one-way Kiero-to-Google behavior, personal hide/restore and connection/sync states. Use the full Calendar resolution when building those scenes.

Audio remains playable in alpha. A source photo may be the retained readable optimized image; the received file stays as an exception if conversion fails or quality is uncertain. Source inspection must remain useful. Present information in product language, with model IDs, schema versions and job internals confined to prototype controls or GM diagnostics.

## 4. First delivery: three structural UI directions

Start with three variants that differ in layout, hierarchy, navigation and placement of the capture interaction. Colour swaps are not distinct directions. Every variant must preserve the same default conversation-first entry and product invariants.

Use the same realistic synthetic data and implement a compact comparison slice in each variant: company conversation and composer, a mixed-project source result, and access to a project's current summary. Make each understandable on mobile and desktop. Keep the first delivery focused enough to compare before building every secondary screen three times.

Name each variant, state its design hypothesis and explain the tradeoff in one or two sentences. You can explore different conversation layouts, project-navigation patterns and ways of placing current information beside the conversation. Treat these as proposals for me to judge, not choices already approved by the earlier grilling.

Use the prototype skill's single-route `?variant=` switcher with a clearly separate floating comparison bar and direct links to every variant. Ensure the comparison controls do not cover the mobile composer or intercept typing/navigation keys inside form fields. Provide a deterministic scenario reset and a separate way to inspect the relevant simulated state.

Prioritize readable Polish content, usable touch targets, visible recording/sending state, contrast, focus, responsive layout and source navigation. Avoid decoration that obscures current agreements. No brand palette, visual style or component library has been approved yet; propose a coherent direction rather than asking me to specify every token.

When useful, delegate independent visual variants to designer agents after fixing the shared fixture/interaction contract. Keep their edits separate. You own integration, product consistency, comparison and Git lifecycle.

This delivery is complete when I can open working browser URLs, compare the same flow in three genuinely different structures, and understand the tradeoffs. Show the artifact before asking me to choose a direction or combine parts. Wait for that design input before expanding the full secondary flows.

## 5. Iterate the selected direction through concrete scenarios

Use a fictional company with two bosses, a few populated projects, a closed project with unfinished work, realistic Polish messages, source-backed amounts and dates, a delivery event and a receiving task. Include general firm knowledge and a versioned structured extra such as material quantity/unit or a paint specification.

Freeze the scenario clock and company timezone. For example, a message sent on 2026-09-08 in Europe/Warsaw saying “jutro” refers to 2026-09-09, including after a simulated retry. Clearly label fictional records as demo material outside the ordinary product conversation.

Exercise and demonstrate these paths in the chosen direction:

1. Open the app and immediately record, stop, optionally listen and send; also type and attach several photos to one source.
2. Send one message about Banan and Kaczmarek plus a general firm note. Show relevant project entries, real authorship and navigation back to the one full source.
3. Move from sending to saved to processing to useful results. Simulate partial analysis and AI failure while preserving the accepted source.
4. Interrupt recording or sending. Show a recoverable unsent draft or an honest unrecoverable state. Retry without a duplicate. A proposed PWA update waits while recording/uploading and preserves the draft before activation.
5. Ask for the current delivery date. Open the answer's source. Send an explicit Wednesday-to-Friday correction, inspect history and distinguish it from an ambiguous contradiction requiring an answer.
6. Capture a price without “netto” or “brutto”. Show the unknown basis and a later clarification without inventing tax. Show proposed, agreed and actual temporal meanings where relevant.
7. Inspect a task with a checklist; complete the parent with a point unchecked. Also show all points checked while the parent remains open, an unassigned coordinator and an overdue task on a closed project.
8. Find work and clarification questions in “Co teraz”, then navigate to the source or responsible project with the context preserved.
9. Switch the simulated boss. Demonstrate independent unread state and shared per-source read state across company/project views. Distinguish mute, reminder mute and personal snooze.
10. Search messages, transcripts and text extracted from a photo; filter by project/author/date and navigate to the precise source with audio or image inspection.
11. Show Calendar connection and project scope, a date-only event, a five-minute marker for an hour without known duration, pending/failed sync, personal hide/restore and a connection requiring attention. Apply the exact accepted semantics rather than simulating a two-way editor.
12. Show the essential invitation/sign-in, revoked-access and explicit GM processing scenes. GM can inspect/retry a failed process in simulation without changing the bosses' read state or ordinary authorship.

Secondary scenarios can live in dedicated walkthroughs rather than becoming top-level navigation. Record any omitted scene and the unresolved design question it represents. Do not call the complete flow accepted based only on a static landing page.

## 6. Implementation and verification boundaries

Use React, TypeScript and Vite for a new isolated UI prototype if the current workspace still has no runnable frontend. Reuse existing conventions when present. In this greenfield case, a clearly named prototype directory with one documented start command is appropriate. Keep fixture state in memory with reset; simulate interruptions and recovery explicitly. A real local microphone path is optional if it helps judge gestures, but must stay local and must not trigger real STT or media upload.

Use coherent deterministic state transitions for source IDs, project links, read state, corrections and task completion. A second simulated boss should see the same shared information. Clearly distinguish prototype-only scenario controls from product controls.

The selected production stack remains Convex, Effect 4 RC, TanStack AI and Cloudflare, with OpenRouter and Resend. Convex starts on Free. This prototype does not need to provision or implement those services to validate UI. Actual capture durability, AI quality, access enforcement, push delivery, Calendar sync and recovery proofs remain NOT RUN unless separately performed and evidenced.

Use browser inspection for each variant and the chosen full flow. Check a narrow mobile viewport and desktop, overflow, composer reachability, keyboard/focus, long Polish labels, dense content, dialogs, error/pending/empty states and the walkthroughs. Capture screenshots and record what you actually exercised. Run the available build/type checks appropriate to the prototype. Avoid building a production-style test framework for temporary visual code.

## 7. Collaboration and completion

Proceed autonomously on reversible implementation details. Ask focused questions only when a design decision materially needs my judgment, and show the concrete options first. Keep me updated in Polish about what the artifact demonstrates, not a long tool transcript. If a new product question is unavoidable, distinguish it from a visual choice; the previous grilling ended at Q211, so new numbered questions begin at Q212.

Do not silently change an accepted contract to make a variant easier. Surface the specific scenario and source decision when a real conflict appears, then let me decide. Formal privacy work deferred under Q195 stays outside this prototype's user flow.

Preserve the variants and final selected prototype on a separate `codex/` branch. Keep production code and `main` unchanged. Link the reviewable branch/artifact from the prototype ticket as work in progress when useful, and use immutable commit links for the final evidence. Real cloud deployment, paid-service setup, production changes and contacting other people are outside this task.

Close the ticket only after I accept the direction and demonstrated interactions. Record the question answered, variants/tradeoffs, my choice, relevant interaction decisions, screenshots, run command, scenario guide, simulated parts, remaining implementation proofs and immutable artifact links in its resolution comment. Update the map's decision index and native dependencies as needed, then report [Grilling: kryteria gotowości i przekazanie MVP do implementacji](https://github.com/wojtekpiskorz/kiero/issues/13) if it is the next actual frontier. Resolve only this one HITL ticket.

Begin now with the fresh audit, context loading and three working comparison variants. Your first substantial delivery should be something I can open and try.
