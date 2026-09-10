/**
 * The work feature (H2): the /praca record surface for tasks, checklists
 * and events of the company's projects.
 *
 * JSX-free on purpose (createElement only), like the sibling surfaces: the
 * host feature registry chain stays importable by the node test programs.
 *
 * Every change rides C4's checked dispatch (`work/functions:dispatchWork`),
 * the SAME operation surface the agent uses: create/update tasks with
 * coordinator/executor/dates, explicit task states (Do zrobienia, W toku,
 * Czeka z powodem, Wykonane, Anulowane), one-level checklist points whose
 * completion never derives parent completion, promotion of a point into a
 * linked task, and events whose occurrence is only ever an explicit
 * command (a passed date proves nothing).
 *
 * The surface is honest about independence and time: dueness/timing are
 * derived claims about the present (the company timezone, the read-time
 * clock), an unknown or disputed bound term renders as such, and tasks of
 * CLOSED projects stay listed with their obligations. The record deep
 * links `?zadanie=<id>` / `?zdarzenie=<id>` reuse the same param keys the
 * Co teraz screen owns (G4's calendar-copy parity).
 */

import { createElement, useEffect, useState, type ReactNode } from "react";
import { useQuery_experimental as useQueryState } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import type { ProjectsOverview } from "../../../../../convex/projects/functions";
import type {
  ChecklistItemView,
  EventView,
  TaskView,
} from "../../../../../convex/work/read";
import type { WorkOverviewRead } from "../../../../../convex/work/functions";
import { CompanyFeatureGate, SessionEnded, type MemberOverview } from "../company/CompanyGate";
import { EVENT_PARAM, TASK_PARAM, searchParam } from "../now/state";
import {
  TaskChecklistForm,
  TaskEditForm,
  TaskPromoteForm,
  TaskStateForm,
  EventEditForm,
  EventStateForm,
} from "./forms";
import {
  boundTermLabel,
  checklistItemStateLabels,
  workCopy as copy,
} from "./state";

/** The feature root: mounted by the host entry at "/praca" (work.records). */
export function WorkFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    member: (overview: MemberOverview) => createElement(WorkMain, { overview }),
  });
}

/** The project catalog join every row needs (names, closure, contacts). */
export interface ProjectJoin {
  readonly name: string;
  readonly closed: boolean;
}

/** Builds the project join map from C1's catalog read (active + closed). */
export function projectJoinOf(catalog: ProjectsOverview): Map<string, ProjectJoin> {
  const join = new Map<string, ProjectJoin>();
  for (const project of [...catalog.active, ...catalog.closed]) {
    join.set(project.projectId, {
      name:
        project.activeCodename === null
          ? project.displayName
          : `${project.activeCodename}: ${project.displayName}`,
      closed: project.closedAtMs !== null,
    });
  }
  return join;
}

function WorkMain({ overview }: { readonly overview: MemberOverview }): ReactNode {
  const work = useQueryState({ query: api.work.functions.workOverview, args: {} });
  const catalog = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });

  if (work.status === "error" || catalog.status === "error") {
    return createElement(SessionEnded);
  }
  if (work.status !== "success" || catalog.status !== "success") {
    return createElement("p", { role: "status" }, "Sprawdzamy Twoją sesję…");
  }
  const projects = projectJoinOf(catalog.data);
  return createElement(WorkBody, {
    work: work.data,
    projects,
    contacts: catalog.data.contacts,
    members: overview.members,
  });
}

function WorkBody({
  work,
  projects,
  contacts,
  members,
}: {
  readonly work: WorkOverviewRead;
  readonly projects: Map<string, ProjectJoin>;
  readonly contacts: readonly ProjectsOverview["contacts"][number][];
  readonly members: readonly MemberOverview["members"][number][];
}): ReactNode {
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

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    focusedTask === null
      ? null
      : createElement("p", { role: "status" }, copy.focusedRecordNotice("zadanie")),
    focusedEvent === null
      ? null
      : createElement("p", { role: "status" }, copy.focusedRecordNotice("zdarzenie")),
    createElement("h2", null, copy.tasksHeading),
    createElement("p", null, copy.tasksNote),
    work.tasks.length === 0
      ? createElement("p", null, copy.noTasks)
      : createElement(
          "ul",
          null,
          ...work.tasks.map((task) =>
            createElement(
              "li",
              { key: task.taskId, id: `zadanie-${task.taskId}` },
              createElement(TaskRow, {
                task,
                project: projects.get(task.projectId) ?? null,
                focused: focusedTask === task.taskId,
              }),
            ),
          ),
        ),
    createElement("h2", null, copy.eventsHeading),
    createElement("p", null, copy.eventsNote),
    work.events.length === 0
      ? createElement("p", null, copy.noEvents)
      : createElement(
          "ul",
          null,
          ...work.events.map((event) =>
            createElement(
              "li",
              { key: event.eventId, id: `zdarzenie-${event.eventId}` },
              createElement(EventRow, {
                event,
                project: projects.get(event.projectId) ?? null,
                focused: focusedEvent === event.eventId,
              }),
            ),
          ),
        ),
    createElement(TaskEditForm, { tasks: work.tasks, contacts, members, projects }),
    createElement(TaskStateForm, { tasks: work.tasks }),
    createElement(TaskChecklistForm, { tasks: work.tasks }),
    createElement(TaskPromoteForm, { tasks: work.tasks, contacts, members }),
    createElement(EventEditForm, { events: work.events, projects }),
    createElement(EventStateForm, { events: work.events }),
  );
}

function ChecklistRow({ item }: { readonly item: ChecklistItemView }): ReactNode {
  return createElement(
    "li",
    null,
    `${checklistItemStateLabels[item.state]}: ${item.description}`,
    item.promotedToTaskId !== null ? ` (${copy.promotedMark})` : "",
  );
}

/** One task row (presentational; exported for the a11y smoke). */
export function TaskRow({
  task,
  project,
  focused,
}: {
  readonly task: TaskView;
  readonly project: ProjectJoin | null;
  readonly focused: boolean;
}): ReactNode {
  return createElement(
    "article",
    null,
    createElement("p", null, createElement("strong", null, task.title), focused ? ` [${copy.focusedMark}]` : ""),
    createElement(
      "p",
      null,
      `${task.stateLabel} · ${copy.duenessLabel(task.dueness)} · ${copy.executorLabel(task.executorName)} · ${copy.coordinatorLabel(
        task.effectiveCoordinatorMembershipId !== null,
        task.coordinatorMembershipId !== null && task.effectiveCoordinatorMembershipId === null,
      )}`,
    ),
    project === null
      ? null
      : createElement("p", null, copy.projectLabel(project.name, project.closed)),
    task.waitingReason !== null
      ? createElement("p", null, `${copy.waitingReasonLabel}: ${task.waitingReason}`)
      : null,
    task.deadline === null
      ? null
      : createElement("p", null, copy.deadlineLabel(boundTermLabel(task.deadline))),
    createElement(
      "p",
      null,
      `${copy.checklistProgressLabel(task.checklistProgress.checked, task.checklistProgress.total)}` +
        (task.linkedEventId !== null ? ` · ${copy.linkedEventLabel}` : "") +
        (task.parentTaskId !== null ? ` · ${copy.parentTaskLabel}` : "") +
        ` · ${copy.revisionLabel(task.revisionCounter)}`,
    ),
    task.checklist.length === 0
      ? null
      : createElement("ul", null, ...task.checklist.map((item) => createElement(ChecklistRow, { key: item.itemId, item }))),
  );
}

/** One event row (presentational; exported for the a11y smoke). */
export function EventRow({
  event,
  project,
  focused,
}: {
  readonly event: EventView;
  readonly project: ProjectJoin | null;
  readonly focused: boolean;
}): ReactNode {
  return createElement(
    "article",
    null,
    createElement("p", null, createElement("strong", null, event.title), focused ? ` [${copy.focusedMark}]` : ""),
    createElement("p", null, `${event.stateLabel} · ${copy.timingLabel(event.timing)}`),
    project === null
      ? null
      : createElement("p", null, copy.projectLabel(project.name, project.closed)),
    event.time === null ? null : createElement("p", null, copy.timeLabel(boundTermLabel(event.time))),
    createElement("p", null, copy.revisionLabel(event.revisionCounter)),
  );
}
