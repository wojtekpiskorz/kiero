# Story and design workflow

Use this workflow after the decision map closes. It produces detailed user stories and full UX/UI without reopening settled product meaning by accident.

## 1. Establish the contract

Read the product brief, `CONTEXT.md`, the relevant UX IDs and their canonical resolution links. Write a short contract sheet for the slice:

- actors and authorization;
- user intent and entry points;
- domain objects and transitions;
- source, history and read-state effects;
- personal versus company-owned state;
- external side effects;
- applicable failure and recovery states;
- accepted exclusions.

Completion criterion: every state change in the proposed slice names its owner, durable meaning and source UX ID. Any discrepancy with a canonical resolution is recorded as a proposed domain change before design starts.

## 2. Map the end-to-end journey

Describe the journey in Polish user language while keeping the document itself in English. Include entry, decision points, recovery loops and exits. Connect neighboring slices instead of treating each screen as a separate product.

For each step record:

| Field | Required content |
| --- | --- |
| Trigger | What happened in the user's work or in the system |
| User view | What the user can observe now |
| Action | What the user can do |
| Domain result | What changes, who owns it and when it becomes durable |
| Evidence | Where the user can inspect source or history |
| Notification | Whether another person or device may be notified |
| Recovery | What happens after interruption, denial, retry or stale state |
| UX IDs | Exact inventory references |

Completion criterion: the journey reaches a stable outcome for success, abandonment, interruption, permission loss and applicable provider failure. Cross-device and cross-user effects are explicit.

## 3. Write stories by observable outcome

Use one primary intent per story. Keep implementation details out unless they are part of an accepted product constraint. Use this format:

```md
## STORY-CAP-001: Wyślij głosówkę z głównej rozmowy

As a boss,
I want to record and explicitly send a voice note immediately after opening Kiero,
so that I can capture a site update before I forget it.

UX IDs: UX-CAP-01, UX-CAP-02, UX-CAP-06
Actors: Boss
Preconditions: Active company membership; authenticated session

### Main path
1. ...

### Alternate and recovery paths
- ...

### Acceptance criteria
- [ ] Visible Polish copy is specified for each state.
- [ ] ...

### Evidence
- Canonical resolution link
- Screen, flow and component-state links

### Explicit exclusions
- Live voice conversation
```

Acceptance criteria must describe observable behavior. Include stable identifiers for stories, flows, screens and shared component states. A story is ready only when a developer and reviewer can decide pass or fail without reading the transcript.

## 4. Design stateful flows before polished screens

Create low-fidelity flows for all applicable states in the inventory. Resolve navigation, hierarchy, context retention and recovery first. Then define shared interaction patterns for:

- source and evidence access;
- autonomous agent change feedback;
- unknown and conflict states;
- saving, processing, partial and failed work;
- personal preferences versus company settings;
- irreversible administrator actions;
- role and access loss;
- external-copy status and reconciliation.

Completion criterion: every story acceptance criterion points to a flow frame or a named shared state pattern. No critical meaning depends on color alone, hover or desktop width.

## 5. Test the information architecture

Run task-based checks in Polish with realistic construction-company material. At minimum, test:

- capture a mixed voice, text and photo source without choosing a project;
- find what was promised to a client and inspect the evidence;
- correct a date, then resolve a true contradiction;
- separate a delivery event from the task to receive it;
- complete a task with an incomplete checklist;
- find an overdue obligation in a closed project;
- distinguish conversation mute, reminder mute and snooze;
- regain context after a failed upload, AI failure or PWA update;
- inspect retained audio and an optimized photo, including an original-photo fallback after conversion failure;
- remove access while another device is open;
- understand what Google Calendar does and does not control.

Record the participant, device, starting state, task wording, observed path, failure point and resulting change. Design changes remain tied to UX IDs.

Completion criterion: every critical task has evidence on target mobile and desktop form factors, and each observed failure has a design change, an explicit accepted limitation or a tracked question.

## 6. Build the visual system

After the flows stabilize, define typography, spacing, color, iconography, motion and reusable components. Polish construction vocabulary and outdoor mobile use should guide legibility and touch targets. The system needs explicit states for the full shared state checklist.

Completion criterion: components cover every referenced state and responsive mode, meet the selected accessibility target, and are used consistently in the approved screens. The owner has reviewed the visual direction separately from domain behavior.

## 7. Reconcile with barebones implementation

Barebones core implementation may run before or alongside this work. Treat its schema and behavior as another consumer of the accepted contracts, not as the source of product meaning.

For each design handoff:

1. Map fields and actions to existing domain commands and reads.
2. Record missing projections, commands or state detail as implementation work.
3. Separate a presentation-only request from a proposed domain change.
4. For a domain change, write the decision and review schema, history, permissions, notifications, Calendar, export, recovery and AI consumers before either track adopts it.
5. Update the UX inventory and affected stories after approval.

Completion criterion: every UI action has an authorized domain operation or a tracked implementation dependency. No screen writes directly around history, source or permission rules.

## 8. Produce the final UX/UI handoff

The handoff should contain:

- complete story index mapped to every UX ID;
- end-to-end journey maps and navigation model;
- responsive screens for mobile PWA, mobile browser and desktop;
- component library with interaction, loading, empty, error, permission and recovery states;
- Polish copy deck, including notification and external-integration copy;
- accessibility behavior and target-device notes;
- prototype links for critical flows;
- open decisions, explicit exclusions and usability findings;
- implementation mapping and acceptance test outline.

Completion criterion: the coverage audit in `README.md` passes, every artifact uses stable links and IDs, and an agent can implement one story without consulting the original conversation.

## Review gates

Use these questions during review:

- Does the design preserve one source and one author across every view?
- Can the user tell saved source from unfinished agent work?
- Does any UI turn uncertainty into a settled fact?
- Are dates, amounts, task state and event state still exact?
- Does a personal action accidentally change company data or another boss's preferences?
- Can source evidence and change history be inspected at the point of trust?
- Does losing permission stop both data access and future external delivery?
- Does retry converge without creating another source, notification or Calendar copy?
- Does GM activity stay explicit and outside boss metrics and read state?
- Can a user recover from each interruption without a false promise of preserved data?
