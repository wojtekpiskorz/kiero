/**
 * The barebones work-list feature (C4): the work half of "Co teraz" —
 * tasks with their checklists, derived dueness and effective coordination,
 * and events with derived timing — with explicit state commands through
 * the checked dispatch entry (convex/work/functions.ts).
 *
 * JSX-free on purpose (createElement only), exactly like the project
 * catalog feature: the host feature registry chain stays importable by
 * node test programs, and this module is the surface the A4 host entry
 * for `/co-teraz` will mount once the attention (reminders) half joins
 * (the entry flip is the host lane's edit, not this lane's). The sign-in
 * leg is B1's shared gate composed with this surface as the
 * authenticated continuation. No styling, semantic controls only (the
 * UX/UI track owns presentation).
 */

import {
  createElement,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import type { ResultEnvelope } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type {
  ChecklistItemView,
  EventView,
  TaskView,
  WorkOverview,
} from "../../../../../convex/work/read";
import type { WorkOverviewRead } from "../../../../../convex/work/functions";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import {
  checklistItemStateLabels,
  eventStateLabels,
  eventStateOrder,
  failureHint,
  signInCopy,
  taskStateLabels,
  taskStateOrder,
  workCopy,
} from "./state";

/** One command envelope (the checked dispatch input shape). */
function envelopeOf(operation: string, input: unknown) {
  return { operation, input, expectedRevisions: [] };
}

/** The submit-event surface the handlers consume (preventDefault only). */
interface SubmitEvent {
  preventDefault(): void;
}

/** The result notice every surface shows (server Polish copy or a hint). */
interface Notice {
  readonly kind: "ok" | "error";
  readonly text: string;
}

function describe(result: ResultEnvelope, okText: string): Notice {
  switch (result._tag) {
    case "error": {
      const hint = failureHint(result.error.code);
      return { kind: "error", text: hint ?? result.error.message };
    }
    case "ok":
      return { kind: "ok", text: okText };
  }
}

function NoticeArea({ notice }: { notice: Notice | null }): ReactNode {
  if (notice === null) {
    return null;
  }
  return createElement(
    "p",
    { role: notice.kind === "error" ? "alert" : "status" },
    notice.text,
  );
}

// ---------------------------------------------------------------------------
// Root: connection gate + auth provider
// ---------------------------------------------------------------------------

/** The feature root: mounted by a host entry (route pending). */
export function WorkListFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state === "unconfigured") {
    return createElement("section", null, createElement("h1", null, workCopy.title), createElement("p", null, workCopy.connectionUnconfigured));
  }
  if (config.connection.state === "misconfigured") {
    return createElement("section", null, createElement("h1", null, workCopy.title), createElement("p", null, workCopy.connectionMisconfigured));
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(WorkGate),
  });
}

/** Authentication gate: B1's shared sign-in surface; members continue here. */
function WorkGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: WorkSurface });
}

// ---------------------------------------------------------------------------
// The work surface (query-driven)
// ---------------------------------------------------------------------------

function WorkSurface(): ReactNode {
  const overview = useQueryState({
    query: api.work.functions.workOverview,
    args: {},
  });
  const { signOut } = useAuthActions();
  const [signingOut, setSigningOut] = useState(false);

  // The B1/B3/C1 pattern: this query errors exactly when THIS session
  // stopped resolving or the actor has no active company. The honest
  // fallback is the session-ended state with a way back to sign-in.
  if (overview.status === "error") {
    return createElement(
      "div",
      { role: "alert" },
      createElement("p", null, workCopy.sessionEndedNotice),
      createElement(
        "button",
        {
          type: "button",
          disabled: signingOut,
          onClick: () => {
            setSigningOut(true);
            void signOut().catch(() => {
              setSigningOut(false);
            });
          },
        },
        workCopy.signInAgain,
      ),
    );
  }
  if (overview.status !== "success") {
    return createElement("p", { role: "status" }, workCopy.checkingSession);
  }
  return createElement(WorkBody, { overview: overview.data });
}

function ChecklistRow({ item }: { readonly item: ChecklistItemView }): ReactNode {
  return createElement(
    "li",
    null,
    `${checklistItemStateLabels[item.state]} — ${item.description}`,
    item.promotedToTaskId !== null ? ` (${workCopy.promotedMark})` : "",
  );
}

function TaskRow({ task }: { readonly task: TaskView }): ReactNode {
  return createElement(
    "li",
    null,
    createElement("p", null, createElement("strong", null, task.title)),
    createElement(
      "p",
      null,
      `${task.stateLabel} · ${workCopy.duenessLabel(task.dueness)} · ${workCopy.executorLabel(task.executorName)} · ${workCopy.coordinatorLabel(task.effectiveCoordinatorMembershipId !== null)}`,
    ),
    task.waitingReason !== null
      ? createElement("p", null, `${workCopy.waitingReasonLabel}: ${task.waitingReason}`)
      : null,
    createElement(
      "p",
      null,
      `${workCopy.checklistProgressLabel(task.checklistProgress.checked, task.checklistProgress.total)}` +
        (task.linkedEventId !== null ? ` · ${workCopy.linkedEventLabel}` : "") +
        (task.parentTaskId !== null ? ` · ${workCopy.parentTaskLabel}` : ""),
    ),
    task.checklist.length === 0
      ? null
      : createElement("ul", null, ...task.checklist.map((item) =>
          createElement(ChecklistRow, { key: item.itemId, item }),
        )),
  );
}

function EventRow({ event }: { readonly event: EventView }): ReactNode {
  return createElement(
    "li",
    null,
    createElement("p", null, createElement("strong", null, event.title)),
    createElement("p", null, `${event.stateLabel} · ${workCopy.timingLabel(event.timing)}`),
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

interface FormState {
  notice: Notice | null;
  busy: boolean;
}

function WorkBody({ overview }: { readonly overview: WorkOverviewRead }): ReactNode {
  const dispatch = useMutation(api.work.functions.dispatchWork);
  const [form, setForm] = useState<FormState>({ notice: null, busy: false });

  async function run(operation: string, input: unknown, okText: string): Promise<void> {
    setForm({ notice: null, busy: true });
    try {
      const result = await dispatch({ envelope: envelopeOf(operation, input) });
      setForm({ notice: describe(result, okText), busy: false });
    } catch {
      setForm({ notice: { kind: "error", text: signInCopy.failures.network }, busy: false });
    }
  }

  const revisionOf = (taskId: string): number =>
    overview.tasks.find((task) => task.taskId === taskId)?.revisionCounter ?? 1;
  const eventRevisionOf = (eventId: string): number =>
    overview.events.find((event) => event.eventId === eventId)?.revisionCounter ?? 1;

  return createElement(
    "section",
    null,
    createElement("h1", null, workCopy.title),
    createElement(NoticeArea, { notice: form.notice }),
    createElement("h2", null, workCopy.tasksHeading),
    createElement("p", null, workCopy.tasksNote),
    overview.tasks.length === 0
      ? createElement("p", null, workCopy.noTasks)
      : createElement("ul", null, ...overview.tasks.map((task) =>
          createElement(TaskRow, { key: task.taskId, task }),
        )),
    createElement("h2", null, workCopy.eventsHeading),
    createElement("p", null, workCopy.eventsNote),
    overview.events.length === 0
      ? createElement("p", null, workCopy.noEvents)
      : createElement("ul", null, ...overview.events.map((event) =>
          createElement(EventRow, { key: event.eventId, event }),
        )),
    createElement(TaskStateForm, { overview, form, run, revisionOf }),
    createElement(ChecklistForm, { overview, form, run, revisionOf }),
    createElement(PromoteForm, { overview, form, run, revisionOf }),
    createElement(EventStateForm, { overview, form, run, eventRevisionOf }),
  );
}

type RunFn = (operation: string, input: unknown, okText: string) => Promise<void>;
type FormProps = {
  readonly overview: WorkOverview;
  readonly form: FormState;
  readonly run: RunFn;
};

function taskSelect(
  id: string,
  value: string,
  tasks: readonly TaskView[],
  onChange: (value: string) => void,
): ReactNode {
  return createElement(
    "select",
    {
      id,
      value,
      onChange: (event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
      required: true,
    },
    ...tasks.map((task) =>
      createElement("option", { key: task.taskId, value: task.taskId }, task.title),
    ),
  );
}

function TaskStateForm({
  overview,
  form,
  run,
  revisionOf,
}: FormProps & { readonly revisionOf: (taskId: string) => number }): ReactNode {
  const [taskId, setTaskId] = useState(overview.tasks[0]?.taskId ?? "");
  const [state, setState] = useState<(typeof taskStateOrder)[number]>("todo");
  const [waitingReason, setWaitingReason] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.changeTaskState",
      {
        taskId,
        expectedRevision: revisionOf(taskId),
        state,
        ...(state === "waiting" ? { waitingReason } : {}),
      },
      workCopy.taskStateChanged,
    );
  }

  if (overview.tasks.length === 0) {
    return null;
  }
  return createElement(
    "div",
    null,
    createElement("h2", null, workCopy.taskStateHeading),
    createElement("p", null, workCopy.taskStateIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "task-state-task" }, workCopy.taskStateTaskLabel),
      taskSelect("task-state-task", taskId, overview.tasks, setTaskId),
      createElement("label", { htmlFor: "task-state-select" }, workCopy.taskStateSelectLabel),
      createElement("select", {
        id: "task-state-select",
        value: state,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          setState(event.target.value as (typeof taskStateOrder)[number]),
      },
        ...taskStateOrder.map((token) =>
          createElement("option", { key: token, value: token }, taskStateLabels[token]),
        ),
      ),
      createElement("label", { htmlFor: "task-state-reason" }, workCopy.taskStateWaitingReasonLabel),
      createElement("input", {
        id: "task-state-reason",
        type: "text",
        placeholder: workCopy.taskStateWaitingReasonPlaceholder,
        value: waitingReason,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setWaitingReason(event.target.value),
        required: state === "waiting",
      }),
      createElement("button", { type: "submit", disabled: form.busy }, workCopy.taskStateChange),
    ),
  );
}

function ChecklistForm({
  overview,
  form,
  run,
  revisionOf,
}: FormProps & { readonly revisionOf: (taskId: string) => number }): ReactNode {
  const [taskId, setTaskId] = useState(overview.tasks[0]?.taskId ?? "");
  const task = overview.tasks.find((candidate) => candidate.taskId === taskId);
  const items = task?.checklist ?? [];
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
        expectedRevision: revisionOf(taskId),
      },
      workCopy.checklistChanged,
    );
  }

  if (overview.tasks.length === 0) {
    return null;
  }
  return createElement(
    "div",
    null,
    createElement("h2", null, workCopy.checklistHeading),
    createElement("p", null, workCopy.checklistIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "checklist-task" }, workCopy.checklistTaskLabel),
      taskSelect("checklist-task", taskId, overview.tasks, setTaskId),
      createElement("label", { htmlFor: "checklist-item" }, workCopy.checklistItemLabel),
      createElement("select", {
        id: "checklist-item",
        value: itemId,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          setItemId(event.target.value);
          const chosen = items.find((item) => item.itemId === event.target.value);
          if (chosen !== undefined) {
            setDescription(chosen.description);
            setState(chosen.state);
          }
        },
      },
        createElement("option", { value: "" }, "— nowy punkt —"),
        ...items.map((item) =>
          createElement("option", { key: item.itemId, value: item.itemId }, item.description),
        ),
      ),
      createElement("label", { htmlFor: "checklist-description" }, workCopy.checklistDescriptionLabel),
      createElement("input", {
        id: "checklist-description",
        type: "text",
        placeholder: workCopy.checklistDescriptionPlaceholder,
        value: description,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setDescription(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "checklist-state" }, workCopy.checklistStateLabel),
      createElement("select", {
        id: "checklist-state",
        value: state,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          setState(event.target.value === "checked" ? "checked" : "open"),
      },
        createElement("option", { value: "open" }, checklistItemStateLabels.open),
        createElement("option", { value: "checked" }, checklistItemStateLabels.checked),
      ),
      createElement("button", { type: "submit", disabled: form.busy }, workCopy.checklistChange),
    ),
  );
}

function PromoteForm({
  overview,
  form,
  run,
  revisionOf,
}: FormProps & { readonly revisionOf: (taskId: string) => number }): ReactNode {
  const [taskId, setTaskId] = useState(overview.tasks[0]?.taskId ?? "");
  const task = overview.tasks.find((candidate) => candidate.taskId === taskId);
  const promotable = (task?.checklist ?? []).filter((item) => item.promotedToTaskId === null);
  const [itemId, setItemId] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.promoteChecklistItem",
      {
        taskId,
        itemId,
        expectedRevision: revisionOf(taskId),
        executorContactId: null,
        coordinatorMembershipId: null,
        deadlineFindingId: null,
      },
      workCopy.promoted,
    );
  }

  if (overview.tasks.length === 0 || promotable.length === 0) {
    return null;
  }
  return createElement(
    "div",
    null,
    createElement("h2", null, workCopy.promoteHeading),
    createElement("p", null, workCopy.promoteIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "promote-task" }, workCopy.promoteTaskLabel),
      taskSelect("promote-task", taskId, overview.tasks, setTaskId),
      createElement("label", { htmlFor: "promote-item" }, workCopy.promoteItemLabel),
      createElement("select", {
        id: "promote-item",
        value: itemId,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => setItemId(event.target.value),
        required: true,
      },
        ...promotable.map((item) =>
          createElement("option", { key: item.itemId, value: item.itemId }, item.description),
        ),
      ),
      createElement("button", { type: "submit", disabled: form.busy }, workCopy.promote),
    ),
  );
}

function EventStateForm({
  overview,
  form,
  run,
  eventRevisionOf,
}: FormProps & { readonly eventRevisionOf: (eventId: string) => number }): ReactNode {
  const [eventId, setEventId] = useState(overview.events[0]?.eventId ?? "");
  const [state, setState] = useState<(typeof eventStateOrder)[number]>("occurred");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "work.changeEventState",
      {
        eventId,
        expectedRevision: eventRevisionOf(eventId),
        state,
      },
      workCopy.eventStateChanged,
    );
  }

  if (overview.events.length === 0) {
    return null;
  }
  return createElement(
    "div",
    null,
    createElement("h2", null, workCopy.eventStateHeading),
    createElement("p", null, workCopy.eventStateIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "event-state-event" }, workCopy.eventStateEventLabel),
      createElement("select", {
        id: "event-state-event",
        value: eventId,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => setEventId(event.target.value),
        required: true,
      },
        ...overview.events.map((event) =>
          createElement("option", { key: event.eventId, value: event.eventId }, event.title),
        ),
      ),
      createElement("label", { htmlFor: "event-state-select" }, workCopy.eventStateSelectLabel),
      createElement("select", {
        id: "event-state-select",
        value: state,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          setState(event.target.value as (typeof eventStateOrder)[number]),
      },
        ...eventStateOrder.map((token) =>
          createElement("option", { key: token, value: token }, eventStateLabels[token]),
        ),
      ),
      createElement("button", { type: "submit", disabled: form.busy }, workCopy.eventStateChange),
    ),
  );
}
