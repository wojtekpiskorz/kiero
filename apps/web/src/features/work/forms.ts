/**
 * Work feature forms (H2): the checked-command controls of the /praca
 * surface. JSX-free (createElement only), node-importable like the rest.
 *
 * Every form rides the one shared `useCheckedDispatch` hook
 * (`../company/dispatch`), parameterized by the work mutation and the
 * work hint map: the command goes through C4's checked dispatch with the
 * revision the boss actually sees (`expectedRevision` from the loaded
 * overview), so a concurrent change refuses honestly instead of
 * overwriting. Term bindings come from the current findings of the chosen
 * scope (company memory plus the project's own), filtered by the pure
 * binding rules; the server re-checks every rule anyway.
 */

import { createElement, useState, type ChangeEvent, type ReactNode } from "react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { parseTableId } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type {
  ChecklistItemView,
  EventView,
  TaskView,
} from "../../../../../convex/work/read";
import type { ContactView } from "../../../../../convex/projects/functions";
import { type MemberOverview, type SubmitEvent } from "../company/CompanyGate";
import { useCheckedDispatch, NoticeArea } from "../company/dispatch";
import {
  bindableDeadline,
  bindableEventTime,
  checklistItemStateLabels,
  eventStateLabels,
  eventStateOrder,
  failureHint,
  findingTermOptionLabel,
  taskStateLabels,
  taskStateOrder,
  workCopy as copy,
  type FindingWireRow,
} from "./state";
import type { ProjectJoin } from "./WorkFeature";

// ---------------------------------------------------------------------------
// The shared dispatch hook
// ---------------------------------------------------------------------------

/** The work forms' checked dispatch (the work mutation plus hint map). */
function useWorkDispatch() {
  return useCheckedDispatch(useMutation(api.work.functions.dispatchWork), failureHint);
}

// ---------------------------------------------------------------------------
// Term-binding options (current findings of one scope, filtered)
// ---------------------------------------------------------------------------

/**
 * The bindable term options of one scope pair: firm memory plus the chosen
 * project's memory (a finding of either may bind, exactly as the operation
 * accepts). `deadline` picks the binding filter (deadlines exclude actual
 * dates; event times accept every role).
 */
function TermOptions({
  projectId,
  deadline,
}: {
  readonly projectId: string | null;
  readonly deadline: boolean;
}): ReactNode {
  const companyFindings = useQueryState({
    query: api.memory.findings.functions.readCurrentFindings,
    args: { scope: { _tag: "company" } },
  });
  // parseTableId brands the selected id for the query args' contract type;
  // an unbrandable value means corrupted UI state, so the read stays skipped
  // instead of sending a malformed scope.
  const scopeProjectId = projectId === null ? null : parseTableId("projects", projectId);
  const projectFindings = useQueryState({
    query: api.memory.findings.functions.readCurrentFindings,
    args:
      scopeProjectId === null
        ? "skip"
        : { scope: { _tag: "project", projectId: scopeProjectId } },
  });
  if (companyFindings.status === "error" || projectFindings.status === "error") {
    return createElement("option", { value: "" }, "ustalenia niedostępne (sesja wygasła)");
  }
  if (companyFindings.status !== "success") {
    return createElement("option", { value: "" }, "wczytywanie ustaleń…");
  }
  const acceptable = deadline ? bindableDeadline : bindableEventTime;
  const rows: FindingWireRow[] = companyFindings.data.filter(acceptable);
  if (projectFindings.status === "success") {
    rows.push(...projectFindings.data.filter(acceptable));
  }
  if (rows.length === 0) {
    return createElement("option", { value: "" }, "brak ustaleń datowych w tym zakresie");
  }
  return rows.map((row) =>
    createElement("option", { key: row.findingId, value: row.findingId }, findingTermOptionLabel(row)),
  );
}

// ---------------------------------------------------------------------------
// Shared select builders
// ---------------------------------------------------------------------------

function selectOf(
  id: string,
  value: string,
  onChange: (value: string) => void,
  ...children: ReactNode[]
): ReactNode {
  return createElement(
    "select",
    {
      id,
      value,
      onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
    },
    ...children,
  );
}

function taskOptions(tasks: readonly TaskView[]): ReactNode {
  return tasks.map((task) =>
    createElement("option", { key: task.taskId, value: task.taskId }, task.title),
  );
}

function projectOptions(projects: Map<string, ProjectJoin>): ReactNode {
  return [...projects.entries()].map(([projectId, project]) =>
    createElement(
      "option",
      { key: projectId, value: projectId },
      project.closed ? `${project.name} (zamknięty)` : project.name,
    ),
  );
}

function contactOptions(contacts: readonly ContactView[]): ReactNode {
  return contacts.map((contact) =>
    createElement("option", { key: contact.contactId, value: contact.contactId }, contact.displayName),
  );
}

function memberOptions(members: readonly MemberOverview["members"][number][]): ReactNode {
  return members.map((member) =>
    createElement(
      "option",
      { key: member.membershipId, value: member.membershipId },
      `${member.displayName} (${member.email})`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Create/edit a task (identity, responsibility, deadline binding)
// ---------------------------------------------------------------------------

export function TaskEditForm({
  tasks,
  contacts,
  members,
  projects,
}: {
  readonly tasks: readonly TaskView[];
  readonly contacts: readonly ContactView[];
  readonly members: readonly MemberOverview["members"][number][];
  readonly projects: Map<string, ProjectJoin>;
}): ReactNode {
  const { run, notice, busy } = useWorkDispatch();
  const [taskId, setTaskId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [executor, setExecutor] = useState("");
  const [coordinator, setCoordinator] = useState("");
  const [deadline, setDeadline] = useState("");

  function pickTask(nextTaskId: string): void {
    setTaskId(nextTaskId);
    const task = tasks.find((candidate) => candidate.taskId === nextTaskId);
    if (task === undefined) {
      setTitle("");
      setExecutor("");
      setCoordinator("");
      setDeadline("");
      return;
    }
    setProjectId(task.projectId);
    setTitle(task.title);
    setExecutor(task.executorContactId ?? "");
    setCoordinator(task.coordinatorMembershipId ?? "");
    setDeadline(task.deadline === null ? "" : task.deadline.findingId);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.changeTask",
      {
        taskId: taskId === "" ? null : taskId,
        projectId,
        title,
        executorContactId: executor === "" ? null : executor,
        coordinatorMembershipId: coordinator === "" ? null : coordinator,
        deadlineFindingId: deadline === "" ? null : deadline,
        expectedRevision:
          taskId === ""
            ? 1
            : (tasks.find((task) => task.taskId === taskId)?.revisionCounter ?? 1),
      },
      taskId === "" ? copy.created : copy.changed,
    );
  }

  if (projects.size === 0) {
    return createElement("p", null, copy.createNeedsProject);
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.createHeading),
    createElement("p", null, copy.editIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "task-edit-task" }, `${copy.taskStateTaskLabel} (${copy.taskEditNote})`),
      selectOf("task-edit-task", taskId, pickTask,
        createElement("option", { value: "" }, "nowe zadanie"),
        taskOptions(tasks)),
      createElement("label", { htmlFor: "task-edit-project" }, copy.taskProjectLabel),
      selectOf("task-edit-project", projectId, setProjectId, projectOptions(projects)),
      createElement("label", { htmlFor: "task-edit-title" }, copy.taskTitleLabel),
      createElement("input", {
        id: "task-edit-title",
        type: "text",
        placeholder: copy.taskTitlePlaceholder,
        value: title,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "task-edit-executor" }, copy.executorSelectLabel),
      selectOf("task-edit-executor", executor, setExecutor,
        createElement("option", { value: "" }, copy.noneOption),
        contactOptions(contacts)),
      createElement("label", { htmlFor: "task-edit-coordinator" }, copy.coordinatorSelectLabel),
      selectOf("task-edit-coordinator", coordinator, setCoordinator,
        createElement("option", { value: "" }, copy.noneOption),
        memberOptions(members)),
      createElement("label", { htmlFor: "task-edit-deadline" }, copy.deadlineSelectLabel),
      selectOf("task-edit-deadline", deadline, setDeadline,
        createElement("option", { value: "" }, copy.noneOption),
        createElement(TermOptions, { projectId: projectId === "" ? null : projectId, deadline: true })),
      createElement("button", { type: "submit", disabled: busy || title.trim().length === 0 },
        taskId === "" ? copy.createSubmit : copy.editSubmit),
      createElement(NoticeArea, { notice }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Task state (the explicit parent decision)
// ---------------------------------------------------------------------------

export function TaskStateForm({ tasks }: { readonly tasks: readonly TaskView[] }): ReactNode {
  const { run, notice, busy } = useWorkDispatch();
  const [taskId, setTaskId] = useState(tasks[0]?.taskId ?? "");
  // The select preselects the CHOSEN task's own state (a waiting task must
  // not read as Do zrobienia); a task switch follows the new row.
  const [state, setState] = useState<(typeof taskStateOrder)[number]>(tasks[0]?.state ?? "todo");
  const [waitingReason, setWaitingReason] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.changeTaskState",
      {
        taskId,
        expectedRevision: tasks.find((task) => task.taskId === taskId)?.revisionCounter ?? 1,
        state,
        ...(state === "waiting" ? { waitingReason } : {}),
      },
      copy.taskStateChanged,
    );
  }

  if (tasks.length === 0) {
    return null;
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.taskStateHeading),
    createElement("p", null, copy.taskStateIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "task-state-task" }, copy.taskStateTaskLabel),
      selectOf("task-state-task", taskId, (next) => {
        setTaskId(next);
        const chosen = tasks.find((task) => task.taskId === next);
        if (chosen !== undefined) {
          setState(chosen.state);
        }
      }, taskOptions(tasks)),
      createElement("label", { htmlFor: "task-state-select" }, copy.taskStateSelectLabel),
      selectOf("task-state-select", state, (next) => setState(next as (typeof taskStateOrder)[number]),
        taskStateOrder.map((token) =>
          createElement("option", { key: token, value: token }, taskStateLabels[token]))),
      createElement("label", { htmlFor: "task-state-reason" }, copy.taskStateWaitingReasonLabel),
      createElement("input", {
        id: "task-state-reason",
        type: "text",
        placeholder: copy.taskStateWaitingReasonPlaceholder,
        value: waitingReason,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setWaitingReason(event.target.value),
        required: state === "waiting",
      }),
      createElement("button", { type: "submit", disabled: busy }, copy.taskStateChange),
      createElement(NoticeArea, { notice }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Checklist points (recorded progress, never parent completion)
// ---------------------------------------------------------------------------

export function TaskChecklistForm({ tasks }: { readonly tasks: readonly TaskView[] }): ReactNode {
  const { run, notice, busy } = useWorkDispatch();
  const [taskId, setTaskId] = useState(tasks[0]?.taskId ?? "");
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  const items: readonly ChecklistItemView[] = task?.checklist ?? [];
  const [itemId, setItemId] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState<"open" | "checked">("open");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.changeChecklistItem",
      {
        taskId,
        itemId: itemId === "" ? null : itemId,
        description,
        state,
        expectedRevision: task?.revisionCounter ?? 1,
      },
      copy.checklistChanged,
    );
  }

  if (tasks.length === 0) {
    return null;
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.checklistHeading),
    createElement("p", null, copy.checklistIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "checklist-task" }, copy.checklistTaskLabel),
      selectOf("checklist-task", taskId, setTaskId, taskOptions(tasks)),
      createElement("label", { htmlFor: "checklist-item" }, copy.checklistItemLabel),
      selectOf("checklist-item", itemId, (next) => {
        setItemId(next);
        const chosen = items.find((item) => item.itemId === next);
        if (chosen !== undefined) {
          setDescription(chosen.description);
          setState(chosen.state);
        }
      },
        createElement("option", { value: "" }, "nowy punkt"),
        items.map((item) =>
          createElement("option", { key: item.itemId, value: item.itemId }, item.description))),
      createElement("label", { htmlFor: "checklist-description" }, copy.checklistDescriptionLabel),
      createElement("input", {
        id: "checklist-description",
        type: "text",
        placeholder: copy.checklistDescriptionPlaceholder,
        value: description,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setDescription(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "checklist-state" }, copy.checklistStateLabel),
      selectOf("checklist-state", state, (next) => setState(next === "checked" ? "checked" : "open"),
        createElement("option", { value: "open" }, checklistItemStateLabels.open),
        createElement("option", { value: "checked" }, checklistItemStateLabels.checked)),
      createElement("button", { type: "submit", disabled: busy || description.trim().length === 0 },
        copy.checklistChange),
      createElement(NoticeArea, { notice }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Promotion: one point becomes its own linked task
// ---------------------------------------------------------------------------

export function TaskPromoteForm({
  tasks,
  contacts,
  members,
}: {
  readonly tasks: readonly TaskView[];
  readonly contacts: readonly ContactView[];
  readonly members: readonly MemberOverview["members"][number][];
}): ReactNode {
  const { run, notice, busy } = useWorkDispatch();
  const [taskId, setTaskId] = useState(tasks[0]?.taskId ?? "");
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  const promotable = (task?.checklist ?? []).filter((item) => item.promotedToTaskId === null);
  const [itemId, setItemId] = useState("");
  const [executor, setExecutor] = useState("");
  const [coordinator, setCoordinator] = useState("");
  const [deadline, setDeadline] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.promoteChecklistItem",
      {
        taskId,
        itemId,
        expectedRevision: task?.revisionCounter ?? 1,
        executorContactId: executor === "" ? null : executor,
        coordinatorMembershipId: coordinator === "" ? null : coordinator,
        deadlineFindingId: deadline === "" ? null : deadline,
      },
      copy.promoted,
    );
  }

  if (tasks.length === 0 || promotable.length === 0) {
    return null;
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.promoteHeading),
    createElement("p", null, copy.promoteIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "promote-task" }, copy.promoteTaskLabel),
      selectOf("promote-task", taskId, (next) => {
        setTaskId(next);
        setItemId("");
      }, taskOptions(tasks)),
      createElement("label", { htmlFor: "promote-item" }, copy.promoteItemLabel),
      selectOf("promote-item", itemId, setItemId,
        promotable.map((item) =>
          createElement("option", { key: item.itemId, value: item.itemId }, item.description))),
      createElement("label", { htmlFor: "promote-executor" }, copy.executorSelectLabel),
      selectOf("promote-executor", executor, setExecutor,
        createElement("option", { value: "" }, copy.noneOption),
        contactOptions(contacts)),
      createElement("label", { htmlFor: "promote-coordinator" }, copy.coordinatorSelectLabel),
      selectOf("promote-coordinator", coordinator, setCoordinator,
        createElement("option", { value: "" }, copy.noneOption),
        memberOptions(members)),
      createElement("label", { htmlFor: "promote-deadline" }, copy.deadlineSelectLabel),
      selectOf("promote-deadline", deadline, setDeadline,
        createElement("option", { value: "" }, copy.noneOption),
        createElement(TermOptions, { projectId: task?.projectId ?? null, deadline: true })),
      createElement("button", { type: "submit", disabled: busy || itemId === "" }, copy.promote),
      createElement(NoticeArea, { notice }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Event create/edit (dated course-of-work records)
// ---------------------------------------------------------------------------

export function EventEditForm({
  events,
  projects,
}: {
  readonly events: readonly EventView[];
  readonly projects: Map<string, ProjectJoin>;
}): ReactNode {
  const { run, notice, busy } = useWorkDispatch();
  const [eventId, setEventId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [timeFindingId, setTimeFindingId] = useState("");

  function pickEvent(nextEventId: string): void {
    setEventId(nextEventId);
    const event = events.find((candidate) => candidate.eventId === nextEventId);
    if (event === undefined) {
      setTitle("");
      setTimeFindingId("");
      return;
    }
    setProjectId(event.projectId);
    setTitle(event.title);
    setTimeFindingId(event.time === null ? "" : event.time.findingId);
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.changeEvent",
      {
        eventId: eventId === "" ? null : eventId,
        projectId,
        title,
        timeFindingId: timeFindingId === "" ? null : timeFindingId,
        expectedRevision:
          eventId === ""
            ? 1
            : (events.find((event) => event.eventId === eventId)?.revisionCounter ?? 1),
      },
      copy.eventChanged,
    );
  }

  if (projects.size === 0) {
    return null;
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.eventHeading),
    createElement("p", null, copy.eventIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "event-edit-event" }, `${copy.eventEventLabel} (${copy.eventEditNote})`),
      selectOf("event-edit-event", eventId, pickEvent,
        createElement("option", { value: "" }, "nowe zdarzenie"),
        events.map((event) =>
          createElement("option", { key: event.eventId, value: event.eventId }, event.title))),
      createElement("label", { htmlFor: "event-edit-project" }, copy.eventProjectLabel),
      selectOf("event-edit-project", projectId, setProjectId, projectOptions(projects)),
      createElement("label", { htmlFor: "event-edit-title" }, copy.eventTitleLabel),
      createElement("input", {
        id: "event-edit-title",
        type: "text",
        placeholder: copy.eventTitlePlaceholder,
        value: title,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setTitle(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "event-edit-time" }, copy.eventTimeSelectLabel),
      selectOf("event-edit-time", timeFindingId, setTimeFindingId,
        createElement("option", { value: "" }, copy.noneOption),
        createElement(TermOptions, { projectId: projectId === "" ? null : projectId, deadline: false })),
      createElement("button", { type: "submit", disabled: busy || title.trim().length === 0 },
        copy.eventSubmit),
      createElement(NoticeArea, { notice }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Event state (occurrence is only ever explicit)
// ---------------------------------------------------------------------------

export function EventStateForm({ events }: { readonly events: readonly EventView[] }): ReactNode {
  const { run, notice, busy } = useWorkDispatch();
  const [eventId, setEventId] = useState(events[0]?.eventId ?? "");
  const [state, setState] = useState<(typeof eventStateOrder)[number]>("occurred");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.changeEventState",
      {
        eventId,
        expectedRevision: events.find((event) => event.eventId === eventId)?.revisionCounter ?? 1,
        state,
      },
      copy.eventStateChanged,
    );
  }

  if (events.length === 0) {
    return null;
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.eventStateHeading),
    createElement("p", null, copy.eventStateIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "event-state-event" }, copy.eventStateEventLabel),
      selectOf("event-state-event", eventId, setEventId,
        events.map((event) =>
          createElement("option", { key: event.eventId, value: event.eventId }, event.title))),
      createElement("label", { htmlFor: "event-state-select" }, copy.eventStateSelectLabel),
      selectOf("event-state-select", state, (next) => setState(next as (typeof eventStateOrder)[number]),
        eventStateOrder.map((token) =>
          createElement("option", { key: token, value: token }, eventStateLabels[token]))),
      createElement("button", { type: "submit", disabled: busy }, copy.eventStateChange),
      createElement(NoticeArea, { notice }),
    ),
  );
}
