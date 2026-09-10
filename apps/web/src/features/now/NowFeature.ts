/**
 * The "Co teraz" feature (H2): the per-user /co-teraz screen this lane
 * owns (G4's calendar copies deep-link into it through the parity-pinned
 * `?zadanie=<id>` / `?zdarzenie=<id>` params).
 *
 * JSX-free on purpose (createElement only), like the sibling surfaces.
 *
 * What the screen answers for the signed-in boss, honestly:
 *
 * - actionable open work (Do zrobienia, W toku, Czeka): the boss's own
 *   assignments, the shared unassigned queue, others' open work, and the
 *   remaining obligations of CLOSED projects, each linking to its
 *   authoritative record on /praca;
 * - events whose term elapsed without confirmation: still Planowane until
 *   someone explicitly marks Odbyło się or Anulowane (never by the clock);
 * - open questions ("Sprawy do wyjaśnienia") across firm memory and every
 *   project, answerable in place;
 * - the boss's own reminder state (F4): pending/delivered/suppressed
 *   intents and the personal snooze, which suspends only THIS boss's
 *   reminders about ONE task and never moves the task's deadline.
 *
 * State changes and snoozes ride the same checked operations the work
 * surface uses (through the one shared dispatch hook, each control with
 * its own command's hint map); every row shows the revision the command
 * will verify. The snooze input interprets the boss's wall time in the
 * COMPANY zone (CONTEXT.md "Strefa czasu firmy"), never the phone's.
 */

import { createElement, useEffect, useState, type ChangeEvent, type ReactNode } from "react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { parseTableId } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type { ProjectsOverview } from "../../../../../convex/projects/functions";
import type { EventView, TaskView } from "../../../../../convex/work/read";
import type { ClarificationWireRow } from "../../../../../convex/memory/findings/exposition";
import {
  CompanyFeatureGate,
  SessionEnded,
  type MemberOverview,
  type SubmitEvent,
} from "../company/CompanyGate";
import { useCheckedDispatch, NoticeArea } from "../company/dispatch";
import { SOURCE_PARAM } from "../company/route-params";
import { instantLabel } from "../conversation/state";
import { failureHint as memoryFailureHint } from "../memory/state";
import {
  boundTermLabel,
  checklistItemStateLabels,
  eventStateLabels,
  eventStateOrder,
  failureHint as workFailureHint,
  taskStateLabels,
  taskStateOrder,
  workCopy,
} from "../work/state";
import { projectJoinOf, type ProjectJoin } from "../work/WorkFeature";
import {
  closedProjectObligations,
  eventsAwaitingConfirmation,
  eventRecordLink,
  failureHint as nowFailureHint,
  myOpenTasks,
  nowCopy as copy,
  othersOpenTasks,
  searchParam,
  snoozeUntilMs,
  taskRecordLink,
  unassignedOpenTasks,
  EVENT_PARAM,
  TASK_PARAM,
} from "./state";

/** The feature root: mounted by the host entry at "/co-teraz" (attention.now). */
export function NowFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    member: (overview: MemberOverview) => createElement(NowMain, { overview }),
  });
}

// ---------------------------------------------------------------------------
// The personal reminder projection (F4's myTaskReminders, envelope-decoded)
// ---------------------------------------------------------------------------

interface ReminderIntentRow {
  readonly intentId: string;
  readonly taskId: string | null;
  readonly state: string;
  readonly dueAtMs: number;
  readonly suppressedReason: string | null;
  readonly deliveredAtMs: number | null;
}

interface ReminderSnoozeRow {
  readonly taskId: string;
  readonly untilMs: number;
}

/** The decoded shape of `myTaskReminders`' ok value (typed at the boundary). */
interface MyTaskReminders {
  readonly intents: readonly ReminderIntentRow[];
  readonly snoozes: readonly ReminderSnoozeRow[];
}

const EMPTY_REMINDERS: MyTaskReminders = { intents: [], snoozes: [] };

/**
 * The personal projection's availability: `ok` with the rows, or
 * `unavailable` when the read refuses (an erroring or refused projection
 * must render as unavailable, NEVER as "no reminders").
 */
type RemindersState = { readonly state: "ok"; readonly data: MyTaskReminders } | { readonly state: "unavailable" };

function useMyTaskReminders(): RemindersState {
  const reminders = useQueryState({ query: api.attention.reminders.queries.myTaskReminders, args: {} });
  if (reminders.status === "error") {
    return { state: "unavailable" };
  }
  if (reminders.status !== "success") {
    return { state: "ok", data: EMPTY_REMINDERS };
  }
  if (reminders.data._tag !== "ok") {
    return { state: "unavailable" };
  }
  const value = reminders.data.value as MyTaskReminders;
  return { state: "ok", data: value };
}

/** The reminder-state line of one task (personal, from F4's projection). */
function reminderLine(taskId: string, reminders: RemindersState): string {
  if (reminders.state === "unavailable") {
    return copy.remindersUnavailable;
  }
  const { intents, snoozes } = reminders.data;
  const snooze = snoozes.find((row) => row.taskId === taskId);
  if (snooze !== undefined && snooze.untilMs > Date.now()) {
    return copy.snoozedUntil(instantLabel(snooze.untilMs));
  }
  const pending = intents.find((row) => row.taskId === taskId && row.state === "pending");
  if (pending !== undefined) {
    return copy.pendingReminderAt(instantLabel(pending.dueAtMs));
  }
  const delivered = intents.find((row) => row.taskId === taskId && row.state === "delivered");
  if (delivered !== undefined) {
    return copy.deliveredReminder;
  }
  const suppressed = intents.find((row) => row.taskId === taskId && row.state === "suppressed");
  if (suppressed !== undefined) {
    return copy.suppressedReminder(suppressed.suppressedReason ?? "");
  }
  return copy.noReminder;
}

// ---------------------------------------------------------------------------
// Root sections
// ---------------------------------------------------------------------------

function NowMain({ overview }: { readonly overview: MemberOverview }): ReactNode {
  const work = useQueryState({ query: api.work.functions.workOverview, args: {} });
  const catalog = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  const reminders = useMyTaskReminders();
  const [focusedTask, setFocusedTask] = useState<string | null>(() => searchParam(TASK_PARAM));
  const [focusedEvent, setFocusedEvent] = useState<string | null>(() => searchParam(EVENT_PARAM));
  useEffect(() => {
    const onPop = () => {
      setFocusedTask(searchParam(TASK_PARAM));
      setFocusedEvent(searchParam(EVENT_PARAM));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (work.status === "error" || catalog.status === "error") {
    return createElement(SessionEnded);
  }
  if (work.status !== "success" || catalog.status !== "success") {
    return createElement("p", { role: "status" }, "Sprawdzamy Twoją sesję…");
  }
  const projects = projectJoinOf(catalog.data);
  const myMembershipId = overview.members.find((member) => member.isSelf)?.membershipId ?? "";
  // The company zone the snooze input interprets wall time against
  // (CONTEXT.md "Strefa czasu firmy"); the work overview already carries it.
  const companyTimezone = work.data.companyTimezone;

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    focusedTask === null
      ? null
      : createElement(FocusedTask, {
          task: work.data.tasks.find((task) => task.taskId === focusedTask) ?? null,
          focusedId: focusedTask,
        }),
    focusedEvent === null
      ? null
      : createElement(FocusedEvent, {
          event: work.data.events.find((event) => event.eventId === focusedEvent) ?? null,
        }),
    createElement(TaskSection, {
      heading: copy.mineHeading,
      intro: copy.mineIntro,
      empty: copy.noMine,
      tasks: myOpenTasks(work.data.tasks, myMembershipId),
      projects,
      reminders,
      snoozable: true,
      companyTimezone,
    }),
    createElement(TaskSection, {
      heading: copy.sharedHeading,
      intro: copy.sharedIntro,
      empty: copy.noShared,
      tasks: unassignedOpenTasks(work.data.tasks),
      projects,
      reminders,
      snoozable: true,
      companyTimezone,
    }),
    createElement(TaskSection, {
      heading: copy.othersHeading,
      intro: copy.othersIntro,
      empty: copy.noOthers,
      tasks: othersOpenTasks(work.data.tasks, myMembershipId),
      projects,
      reminders,
      snoozable: false,
      companyTimezone,
    }),
    createElement(TaskSection, {
      heading: copy.closedHeading,
      intro: copy.closedIntro,
      empty: copy.noClosed,
      tasks: closedProjectObligations(work.data.tasks, projects),
      projects,
      reminders,
      snoozable: true,
      companyTimezone,
    }),
    createElement(EventsSection, { events: eventsAwaitingConfirmation(work.data.events), projects }),
    createElement(QuestionsSection, { catalog: catalog.data }),
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function TaskRowLine({
  task,
  project,
}: {
  readonly task: TaskView;
  readonly project: ProjectJoin | null;
}): ReactNode {
  return createElement(
    "p",
    null,
    `${task.stateLabel} · ${workCopy.duenessLabel(task.dueness)} · ${workCopy.executorLabel(task.executorName)} · ${workCopy.coordinatorLabel(
      task.effectiveCoordinatorMembershipId !== null,
      task.coordinatorMembershipId !== null && task.effectiveCoordinatorMembershipId === null,
    )}` +
      (project === null ? "" : ` · ${workCopy.projectLabel(project.name, project.closed)}`),
    task.dueness.kind === "overdue" ? ` · [${copy.overdueMark}]` : "",
  );
}

function FocusedTask({
  task,
  focusedId,
}: {
  readonly task: TaskView | null;
  readonly focusedId: string;
}): ReactNode {
  if (task === null) {
    return createElement(
      "p",
      { role: "alert" },
      copy.focusedTaskNotice,
      " Nie znaleziono zadania o wskazanym identyfikatorze.",
    );
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, `${copy.mineHeading} [${copy.focusedMark}]`),
    createElement("p", null, copy.focusedTaskNotice),
    createElement(
      "ul",
      null,
      createElement(
        "li",
        { id: `zadanie-${task.taskId}` },
        createElement("p", null, createElement("strong", null, task.title)),
        createElement(TaskRowLine, { task, project: null }),
        task.waitingReason === null
          ? null
          : createElement("p", null, `${workCopy.waitingReasonLabel}: ${task.waitingReason}`),
        task.deadline === null
          ? null
          : createElement("p", null, workCopy.deadlineLabel(boundTermLabel(task.deadline))),
        createElement(
          "p",
          null,
          workCopy.checklistProgressLabel(task.checklistProgress.checked, task.checklistProgress.total),
        ),
        task.checklist.length === 0
          ? null
          : createElement("ul", null, ...task.checklist.map((item) =>
              createElement(
                "li",
                { key: item.itemId },
                `${checklistItemStateLabels[item.state]}: ${item.description}` +
                  (item.promotedToTaskId !== null ? ` (${workCopy.promotedMark})` : ""),
              ),
            )),
      ),
    ),
    createElement("p", null, createElement("a", { href: taskRecordLink(task.taskId) }, copy.recordLinkTask)),
    createElement("p", null, `(${copy.focusedTaskIdLabel(focusedId)})`),
  );
}

function FocusedEvent({ event }: { readonly event: EventView | null }): ReactNode {
  if (event === null) {
    return createElement(
      "p",
      { role: "alert" },
      copy.focusedEventNotice,
      " Nie znaleziono zdarzenia o wskazanym identyfikatorze.",
    );
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, `${copy.eventsHeading} [${copy.focusedMark}]`),
    createElement("p", null, copy.focusedEventNotice),
    createElement(
      "ul",
      null,
      createElement(
        "li",
        { id: `zdarzenie-${event.eventId}` },
        createElement("p", null, createElement("strong", null, event.title)),
        createElement("p", null, `${event.stateLabel} · ${workCopy.timingLabel(event.timing)}`),
        event.time === null ? null : createElement("p", null, workCopy.timeLabel(boundTermLabel(event.time))),
      ),
    ),
    createElement("p", null, createElement("a", { href: eventRecordLink(event.eventId) }, copy.recordLinkEvent)),
  );
}

// ---------------------------------------------------------------------------
// Task sections with the actionable controls (state change + snooze)
// ---------------------------------------------------------------------------

function TaskSection({
  heading,
  intro,
  empty,
  tasks,
  projects,
  reminders,
  snoozable,
  companyTimezone,
}: {
  readonly heading: string;
  readonly intro: string;
  readonly empty: string;
  readonly tasks: readonly TaskView[];
  readonly projects: Map<string, ProjectJoin>;
  readonly reminders: RemindersState;
  readonly snoozable: boolean;
  readonly companyTimezone: string;
}): ReactNode {
  return createElement(
    "section",
    null,
    createElement("h2", null, heading),
    createElement("p", null, intro),
    tasks.length === 0
      ? createElement("p", null, empty)
      : createElement(
          "ul",
          null,
          ...tasks.map((task) =>
            createElement(
              "li",
              { key: task.taskId },
              createElement("p", null, createElement("strong", null, task.title)),
              createElement(TaskRowLine, { task, project: projects.get(task.projectId) ?? null }),
              task.waitingReason === null
                ? null
                : createElement("p", null, `${workCopy.waitingReasonLabel}: ${task.waitingReason}`),
              task.deadline === null
                ? null
                : createElement("p", null, workCopy.deadlineLabel(boundTermLabel(task.deadline))),
              createElement(
                "p",
                null,
                workCopy.checklistProgressLabel(task.checklistProgress.checked, task.checklistProgress.total),
                ` · ${reminderLine(task.taskId, reminders)}`,
              ),
              createElement(
                "p",
                null,
                createElement("a", { href: taskRecordLink(task.taskId) }, copy.recordLinkTask),
              ),
              createElement(TaskStateControl, { task }),
              snoozable
                ? createElement(SnoozeControl, { task, companyTimezone })
                : null,
            ),
          ),
        ),
  );
}

/** The per-task state change (one explicit decision, revision-checked). */
function TaskStateControl({ task }: { readonly task: TaskView }): ReactNode {
  const work = useCheckedDispatch(useMutation(api.work.functions.dispatchWork), workFailureHint);
  const [state, setState] = useState<(typeof taskStateOrder)[number]>(task.state === "waiting" ? "waiting" : "todo");
  const [waitingReason, setWaitingReason] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await work.run(
      "work.changeTaskState",
      {
        taskId: task.taskId,
        expectedRevision: task.revisionCounter,
        state,
        ...(state === "waiting" ? { waitingReason: waitingReason.trim() } : {}),
      },
      copy.stateChanged,
    );
  }

  return createElement(
    "form", { onSubmit: (event) => void submit(event) },
    createElement("label", { htmlFor: `now-state-${task.taskId}` }, copy.stateSelectLabel(task.title)),
    createElement(
      "select",
      {
        id: `now-state-${task.taskId}`,
        value: state,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          setState(event.target.value as (typeof taskStateOrder)[number]),
      },
      ...taskStateOrder.map((token) =>
        createElement("option", { key: token, value: token }, taskStateLabels[token])),
    ),
    state === "waiting"
      ? createElement("label", { htmlFor: `now-reason-${task.taskId}` }, copy.stateWaitingReasonLabel)
      : null,
    state === "waiting"
      ? createElement("input", {
          id: `now-reason-${task.taskId}`,
          type: "text",
          placeholder: copy.stateWaitingReasonPlaceholder,
          value: waitingReason,
          onChange: (event: ChangeEvent<HTMLInputElement>) => setWaitingReason(event.target.value),
          required: true,
        })
      : null,
    createElement("button", { type: "submit", disabled: work.busy }, copy.stateChangeLabel),
    createElement(NoticeArea, { notice: work.notice }),
  );
}

/** The per-task personal snooze (F4: one task, one boss, one chosen moment). */
function SnoozeControl({
  task,
  companyTimezone,
}: {
  readonly task: TaskView;
  readonly companyTimezone: string;
}): ReactNode {
  // The attention command's own hint map: snooze refusals must never be
  // mapped through the work surface's codes.
  const snooze = useCheckedDispatch(
    useMutation(api.attention.reminders.commands.snoozeTaskRemindersCommand),
    nowFailureHint,
  );
  const [until, setUntil] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // The boss's wall time means the COMPANY's wall time (CONTEXT.md
    // "Strefa czasu firmy"): the parser builds the instant in that zone,
    // never in the phone's.
    const untilMsValue = snoozeUntilMs(until, companyTimezone);
    if (untilMsValue === null) {
      snooze.setNotice({ kind: "error", text: copy.snoozeInvalid });
      return;
    }
    await snooze.run(
      "attention.snoozeTaskReminders",
      { taskId: task.taskId, untilMs: untilMsValue },
      copy.snoozed,
    );
  }

  return createElement(
    "form", { onSubmit: (event) => void submit(event) },
    createElement("label", { htmlFor: `now-snooze-${task.taskId}` }, copy.snoozeUntilLabel(task.title, companyTimezone)),
    createElement("input", {
      id: `now-snooze-${task.taskId}`,
      type: "datetime-local",
      value: until,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setUntil(event.target.value),
      required: true,
    }),
    createElement("p", null, copy.snoozeScopeNote),
    createElement("button", { type: "submit", disabled: snooze.busy || until === "" }, copy.snoozeSubmit),
    createElement(NoticeArea, { notice: snooze.notice }),
  );
}

// ---------------------------------------------------------------------------
// Events awaiting explicit confirmation
// ---------------------------------------------------------------------------

function EventsSection({
  events,
  projects,
}: {
  readonly events: readonly EventView[];
  readonly projects: Map<string, ProjectJoin>;
}): ReactNode {
  const work = useCheckedDispatch(useMutation(api.work.functions.dispatchWork), workFailureHint);
  const [state, setState] = useState<Record<string, "occurred" | "cancelled">>({});

  async function confirm(eventId: string, event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const chosen = state[eventId] ?? "occurred";
    const record = events.find((candidate) => candidate.eventId === eventId);
    if (record === undefined) {
      return;
    }
    await work.run(
      "work.changeEventState",
      { eventId, expectedRevision: record.revisionCounter, state: chosen },
      copy.eventConfirmed,
    );
  }

  return createElement(
    "section",
    null,
    createElement("h2", null, copy.eventsHeading),
    createElement("p", null, copy.eventsIntro),
    createElement(NoticeArea, { notice: work.notice }),
    events.length === 0
      ? createElement("p", null, copy.noEvents)
      : createElement(
          "ul",
          null,
          ...events.map((event) =>
            createElement(
              "li",
              { key: event.eventId },
              createElement("p", null, createElement("strong", null, event.title)),
              createElement("p", null, `${event.stateLabel} · ${workCopy.timingLabel(event.timing)}`),
              createElement("p", null, workCopy.projectLabel(projects.get(event.projectId)?.name ?? "?", projects.get(event.projectId)?.closed === true)),
              event.time === null ? null : createElement("p", null, workCopy.timeLabel(boundTermLabel(event.time))),
              createElement("p", null, createElement("a", { href: eventRecordLink(event.eventId) }, copy.recordLinkEvent)),
              createElement(
                "form",
                { onSubmit: (submitEvent) => void confirm(event.eventId, submitEvent) },
                createElement("label", { htmlFor: `now-event-${event.eventId}` }, copy.eventConfirmLabel(event.title)),
                createElement(
                  "select",
                  {
                    id: `now-event-${event.eventId}`,
                    value: state[event.eventId] ?? "occurred",
                    onChange: (change: ChangeEvent<HTMLSelectElement>) =>
                      setState({ ...state, [event.eventId]: change.target.value as "occurred" | "cancelled" }),
                  },
                  createElement("option", { value: "occurred" }, eventStateLabels.occurred),
                  createElement("option", { value: "cancelled" }, eventStateLabels.cancelled),
                ),
                createElement("button", { type: "submit", disabled: work.busy }, copy.eventConfirmSubmit),
              ),
            ),
          ),
        ),
  );
}

// ---------------------------------------------------------------------------
// Questions across firm memory and every project
// ---------------------------------------------------------------------------

function QuestionsSection({ catalog }: { readonly catalog: ProjectsOverview }): ReactNode {
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.questionsHeading),
    createElement("p", null, copy.questionsIntro),
    createElement(ScopeQuestions, { label: copy.companyScopeLabel, args: { scope: { _tag: "company" } } }),
    ...[...catalog.active, ...catalog.closed].map((project) =>
      createElement(ScopeQuestions, {
        key: project.projectId,
        label: copy.projectScopeLabel(project.displayName),
        args: { scope: { _tag: "project", projectId: project.projectId } },
      }),
    ),
  );
}

function ScopeQuestions({
  label,
  args,
}: {
  readonly label: string;
  readonly args: { readonly scope: { readonly _tag: "company" } | { readonly _tag: "project"; readonly projectId: string } };
}): ReactNode {
  // parseTableId brands the project id for the query args' contract type;
  // the company scope never carries one, so only that branch needs it.
  const branded =
    args.scope._tag === "company"
      ? args
      : { scope: { _tag: "project" as const, projectId: parseTableId("projects", args.scope.projectId) } };
  const clarifications = useQueryState({
    query: api.memory.findings.functions.readClarifications,
    args:
      branded.scope._tag === "project" && branded.scope.projectId === null
        ? "skip"
        : branded,
  });

  if (clarifications.status === "error") {
    return createElement(SessionEnded);
  }
  if (clarifications.status !== "success") {
    return createElement("p", { role: "status" }, "Sprawdzamy Twoją sesję…");
  }
  const open = (clarifications.data as readonly ClarificationWireRow[]).filter((row) => row.state === "open");
  if (open.length === 0) {
    return null;
  }
  return createElement(
    "section", null,
    createElement("h3", null, label),
    createElement(
      "ul",
      null,
      ...open.map((row) => createElement(OpenQuestionRow, { key: row.clarificationId, row })),
    ),
  );
}

function OpenQuestionRow({ row }: { readonly row: ClarificationWireRow }): ReactNode {
  // The memory command's own hint map: clarification refusals must never
  // be mapped through the work surface's codes.
  const memory = useCheckedDispatch(
    useMutation(api.memory.findings.functions.dispatchMemoryCommandEntry),
    memoryFailureHint,
  );
  const [answer, setAnswer] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const trimmed = answer.trim();
    if (trimmed === "") {
      return;
    }
    // The ok notice confirms the resolve (copy.answered); the answer field
    // clears only on a confirmed resolution.
    const value = await memory.run(
      "memory.resolveClarification",
      { clarificationId: row.clarificationId, resolutionNote: trimmed },
      copy.answered,
    );
    if (value !== null) {
      setAnswer("");
    }
  }

  return createElement(
    "li", null,
    createElement("p", null, createElement("strong", null, row.question)),
    row.conflictingEvidence.length === 0
      ? null
      : createElement(
          "p", null,
          copy.questionsEvidenceLabel,
          createElement(
            "ul", null,
            ...row.conflictingEvidence.map((witness) =>
              createElement(
                "li", { key: witness.fragmentId },
                createElement("a", { href: `/?${SOURCE_PARAM}=${encodeURIComponent(witness.sourceId)}` }, copy.questionsSourceLink),
              ),
            ),
          ),
        ),
    createElement(
      "form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: `now-answer-${row.clarificationId}` }, copy.answerLabel),
      createElement("textarea", {
        id: `now-answer-${row.clarificationId}`,
        rows: 2,
        placeholder: copy.answerPlaceholder,
        value: answer,
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setAnswer(event.target.value),
        required: true,
      }),
      createElement("button", { type: "submit", disabled: memory.busy || answer.trim().length === 0 }, copy.answerSubmit),
      createElement(NoticeArea, { notice: memory.notice }),
    ),
  );
}

// Re-exported labels keep the work vocabulary single-sourced for consumers.
export { eventStateOrder, taskStateOrder };
