# Kiero product brief for UX/UI

## Product in one sentence

Kiero is the shared office of a micro construction company. Bosses send loose voice notes, text and photos into one company conversation, and an agent turns them into current, source-backed company and project memory.

## The job

Two people coordinating one to three construction jobs at once lose decisions across calls, voice notes, paper, photos and memory. Kiero should let either person answer "Co obiecaliśmy klientowi?", "Kto zamawia materiał?" or "Na kiedy jest dostawa?" without calling the other person, while still showing the original evidence.

The first alpha company has two bosses. The wider market includes owner-led general contractors, specialist crews and small partner firms. V1 starts with the boss tier and one active company per ordinary user. The underlying model supports future roles and multiple memberships.

## Product philosophy

### Capture first

An authenticated user lands in the company conversation and can start speaking or typing immediately. Choosing a project is optional. "Auto" lets the agent classify the message. A project pill supplies context when the user already knows it. The main conversation resets to Auto after send; capture inside a project keeps that project visible.

### One message, one source

A source message has one immutable original and one real author. It may combine text, audio and photos, and it may concern several projects plus company-wide knowledge. Project conversations are filtered views of that same source. Corrections arrive as new messages or explicit audited field changes. The product never creates editable copies that can drift apart.

### Current answers with inspectable history

The agent writes resolved information into structured memory, so each answer does not require replaying the whole conversation. Every finding keeps evidence and revision history. Users can inspect the relevant text, audio interval, image region or full source. Search covers message text, transcripts and OCR.

### Autonomous when clear, candid when unclear

The agent creates and updates projects, contacts, findings, tasks, events and clarification cases from clear evidence. It does not ask users to approve routine changes. A clear correction such as "Zmieniamy na piątek" replaces the current Wednesday value and retains Wednesday in history. A real contradiction becomes a concrete sourced question. The agent must not present a guess as settled knowledge.

### Deterministic business facts

Dates, amounts, assignments and states become typed values with preserved meaning. "Jutro" is anchored to the source send date and company timezone. A date does not gain an invented hour. Proposal, internal plan, agreement and actual occurrence stay distinct. Money keeps its business role, currency and tax basis. When netto or brutto was not stated, the visible state is "nie podano".

### Shared work, personal attention

Company data is shared among authorized bosses. Read state, conversation mute, reminder mute, reminder snooze, quiet hours, push permission and Google Calendar choices belong to the individual. Reading one source updates that user's state in every view and device. It does not mark the source read for another boss. GM inspection does not affect either boss's state or alpha activity metrics.

### Graceful failure

Source acceptance and AI processing are separate. A message becomes saved only after all required attachments are durable. An AI or Google failure cannot erase an accepted source or block other company work. The interface must name partial, pending, failed and retrying states without implying that unfinished media was understood.

## Actors

| Actor | Product role | Core needs |
| --- | --- | --- |
| Boss | Owner, partner or foreman with full company data access | Capture in seconds, see current work, answer or correct, trace evidence, manage personal attention |
| Company administrator | Boss with membership management rights | Invite and remove bosses, transfer administration, export and permanently delete with informed confirmation |
| External contact | Client, supplier or executor without a Kiero account | Appears in company and project records; receives no app access by implication |
| GM | Explicit global alpha operator | Inspect and retry processing, support accounts and data with a visible audited identity; activity does not count as boss use |
| Agent | Company assistant acting through checked domain operations | Interpret sources, update structured memory, ask focused questions and expose evidence |

## Main product loop

1. A boss opens Kiero and records, types or adds photos.
2. Kiero durably accepts one source and immediately gives a saved receipt.
3. The agent processes each medium, links relevant fragments and publishes independent information groups as they become valid.
4. A compact update says what changed. Full bubbles are reserved for answers, requests and clarification.
5. Both bosses see current project and company memory, tasks, events and open questions.
6. Either boss can inspect the source, answer, correct, withdraw or reassign the information.
7. Personal notifications and optional Google Calendar copies keep current obligations visible.

## Information model the design must communicate

- **Company conversation:** the continuous source history and default workspace.
- **Project conversation:** a view of company sources linked to one project.
- **Company memory:** rules and facts that apply across projects unless a project has a specific contrary agreement.
- **Project memory:** current structured knowledge, missing values, conflicts and history for one job.
- **Finding:** one source-backed piece of knowledge with a current revision.
- **Clarification:** a shared unresolved question with named source evidence.
- **Task:** an action with independent state, coordinator, possible external executor and one-level checklist.
- **Event:** something that happens, with state independent of a linked action.
- **Current work:** the company-wide "Co teraz" view of tasks and questions, including obligations from closed projects.

Use the exact Polish definitions in `CONTEXT.md` while writing copy and stories.

## Project and work semantics

Projects may start at any accepted stage: `Zapytanie`, `Przygotowanie oferty`, `Oczekiwanie na decyzję`, `Uzgodnione`, `W realizacji`, `Zakończone`, `Anulowane`. A project may be separately `Wstrzymany` with a reason and optional planned resume date. Silence, elapsed time or an empty task list never closes a project.

Project aliases identify similar jobs and remain reserved across retained history. When two jobs have confusing names, the agent asks for distinct aliases such as "Banan" and "Kaczmarek".

Task states are `Do zrobienia`, `W toku`, `Czeka`, `Wykonane`, `Anulowane`. `Czeka` needs a reason. The parent task completes independently from its checklist. A valid display may show `Wykonane, 2 z 3 punktów`. Checklist points inherit the parent coordinator and due date. A point needing its own assignment or date becomes a separate linked task.

An external executor and a Kiero coordinator are separate. Removing a coordinator's membership leaves open tasks unassigned unless an administrator chooses a successor. It does not cancel company obligations.

Event states are `Planowane`, `Odbyło się`, `Anulowane`. A past planned event remains unconfirmed until evidence says it happened or was canceled. One delivery event and one receiving task remain separate even when they share a time.

## Trust and safety of meaning

The interface must distinguish:

- known, unknown with a reason, conflicted and not applicable;
- extraction confidence from business certainty;
- source statement from agent inference;
- current value from previous revisions;
- saved source from processing result;
- archive or closure from withdrawal or permanent deletion;
- conversation read state from task completion;
- Kiero authority from a Google Calendar copy.

These distinctions are product behavior. Visual simplification may hide detail until needed, but it cannot merge the meanings.

## Alpha conditions that shape design

- No product limit on one voice note's duration. Long recordings process in the background and need honest progress.
- Ordinary-source target: 95 percent of text, one-photo or up-to-two-minute audio sources update memory within 60 seconds after durable acceptance. Two minutes is a measurement class, not a recording limit.
- Before alpha, the fixed evaluation set has about 50 representative Polish text, voice, image and mixed cases. The accepted threshold is at least 48 correct cases in each of three full runs, with zero critical mistakes in project, amount, date, commitment or source basis. A justified clarification counts as correct; an unnecessary clarification on clear evidence does not.
- Weekly live review uses ten source-backed questions, five per boss, with a target of at least 9 out of 10 correct.
- Critical mistakes in project, amount, date, commitment or evidence block wider testing until repaired and checked again.
- The last two alpha weeks require each boss to use Kiero independently on at least three workdays per week. GM repairs do not count.
- Full readiness later requires physical iPhone, Android and tester-device checks, plus desktop Chrome or Edge and Safari as applicable.
- The first company starts only after required proofs have a recorded result, code revision, environment and repeatable method. Loss of a saved source, cross-company access, rollback of a valid correction, a false settled amount or date, and failed data restoration are release blockers. An unrun proof remains unrun.

## Product boundaries

V1 is an online PWA. It supports saved local drafts and resumable retries while open, but makes no full offline promise. Voice means recorded voice notes, not live voice conversation. Telegram is outside v1. Google Calendar is optional and one-way from Kiero. Private calendar import, Google Tasks and two-way editing of Kiero facts are outside this integration.

Profitability calculations, staff scheduling, custom company project stages and full permission tiers beyond bosses remain outside the accepted v1. A formal privacy and retention review is deferred. Design must not claim that a consent checkbox settles legal compliance.

## Structural reference from the prototype

Variant D combines a familiar conversation feed, adjacent project memory and a thin capture bar with one-tap recording. Desktop uses a side panel. Mobile uses a strip that opens memory as an overlay. The project pill changes both conversation and memory context.

Keep the rationale, then redesign freely. The prototype uses fictional data, timers and heuristic AI. It proves no backend, model, microphone, upload, push, calendar or recovery behavior.
