/**
 * The barebones project catalog feature (C1): identify projects, assign
 * firm-unique codenames, change stages, set/clear pauses, and keep the
 * contact catalog with project roles — all through the checked dispatch
 * entry (convex/projects/functions.ts).
 *
 * JSX-free on purpose (createElement only), exactly like the membership
 * feature: the host feature registry chain stays importable by node test
 * programs, and this module is the surface the A4 host entry for
 * `/projekty` will mount (the entry flip is the host lane's edit, not
 * this lane's). The sign-in leg is B1's shared gate composed with this
 * surface as the authenticated continuation. No styling, semantic controls
 * only (the UX/UI track owns presentation).
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
  ContactRoleView,
  ContactView,
  ProjectView,
  ProjectsOverview,
} from "../../../../../convex/projects/functions";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import {
  catalogCopy,
  contactKindLabels,
  contactRoleLabels,
  failureHint,
  signInCopy,
  stageLabels,
  stageOrder,
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
export function ProjectCatalogFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state === "unconfigured") {
    return createElement("section", null, createElement("h1", null, catalogCopy.title), createElement("p", null, catalogCopy.connectionUnconfigured));
  }
  if (config.connection.state === "misconfigured") {
    return createElement("section", null, createElement("h1", null, catalogCopy.title), createElement("p", null, catalogCopy.connectionMisconfigured));
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(CatalogGate),
  });
}

/** Authentication gate: B1's shared sign-in surface; members continue here. */
function CatalogGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: CatalogSurface });
}

// ---------------------------------------------------------------------------
// The catalog surface (query-driven)
// ---------------------------------------------------------------------------

function CatalogSurface(): ReactNode {
  const overview = useQueryState({
    query: api.projects.functions.projectsOverview,
    args: {},
  });
  const { signOut } = useAuthActions();
  const [signingOut, setSigningOut] = useState(false);

  // The B1/B3 pattern: this query errors exactly when THIS session stopped
  // resolving or the actor has no active company. The honest fallback is the
  // session-ended state with a way back to sign-in, never a spinner.
  if (overview.status === "error") {
    return createElement(
      "div",
      { role: "alert" },
      createElement("p", null, catalogCopy.sessionEndedNotice),
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
        catalogCopy.signInAgain,
      ),
    );
  }
  if (overview.status !== "success") {
    return createElement("p", { role: "status" }, catalogCopy.checkingSession);
  }
  return createElement(CatalogBody, { overview: overview.data });
}

function projectHeading(project: ProjectView): ReactNode {
  return createElement(
    "strong",
    null,
    project.activeCodename === null
      ? project.displayName
      : `${project.activeCodename} — ${project.displayName}`,
  );
}

function projectRolesText(
  roles: readonly ContactRoleView[],
  contacts: readonly ContactView[],
  projectId: string,
): string {
  const names = new Map(contacts.map((contact) => [contact.contactId, contact.displayName] as const));
  return roles
    .filter((role) => role.projectId === projectId)
    .map((role) => `${names.get(role.contactId) ?? "?"} (${contactRoleLabels[role.role]})`)
    .join(", ");
}

function ProjectRow({
  project,
  overview,
}: {
  readonly project: ProjectView;
  readonly overview: ProjectsOverview;
}): ReactNode {
  return createElement(
    "li",
    null,
    createElement("p", null, projectHeading(project)),
    createElement(
      "p",
      null,
      `${stageLabels[project.stage]} · ${catalogCopy.revisionLabel} ${project.stageRevision} · ${project.paused === null ? "" : `${catalogCopy.pausedMark(project.paused.reason, project.paused.resumeOn)} · `}${catalogCopy.clientLabel}: ${project.clientName ?? catalogCopy.noClient}`,
    ),
    createElement(
      "p",
      null,
      project.activeCodename !== null && project.activeCodename.startsWith("#")
        ? `${catalogCopy.generatedCodenameNote} `
        : "",
      `${catalogCopy.retainedAliases(project.aliases.filter((alias) => !alias.active).length)} ${catalogCopy.sourceLinks(project.sourceLinkCount)}`,
    ),
    createElement("p", null, `${catalogCopy.roleHeading}: ${projectRolesText(overview.roles, overview.contacts, project.projectId) || "—"}`),
    project.closedAtMs !== null
      ? createElement("p", null, catalogCopy.closedAt(project.closedAtMs))
      : null,
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

interface FormState {
  notice: Notice | null;
  busy: boolean;
}

function CatalogBody({ overview }: { readonly overview: ProjectsOverview }): ReactNode {
  const dispatch = useMutation(api.projects.functions.dispatchProjects);
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

  const revisionOf = (projectId: string): number =>
    overview.active.find((project) => project.projectId === projectId)?.stageRevision ??
    overview.closed.find((project) => project.projectId === projectId)?.stageRevision ??
    1;

  return createElement(
    "section",
    null,
    createElement("h1", null, catalogCopy.title),
    createElement(NoticeArea, { notice: form.notice }),
    createElement("h2", null, catalogCopy.activeHeading),
    overview.active.length === 0
      ? createElement("p", null, catalogCopy.noActiveProjects)
      : createElement("ul", null, ...overview.active.map((project) =>
          createElement(ProjectRow, { key: project.projectId, project, overview }),
        )),
    createElement("h2", null, catalogCopy.closedHeading),
    createElement("p", null, catalogCopy.closedNote),
    overview.closed.length === 0
      ? createElement("p", null, catalogCopy.noClosedProjects)
      : createElement("ul", null, ...overview.closed.map((project) =>
          createElement(ProjectRow, { key: project.projectId, project, overview }),
        )),
    createElement(IdentifyForm, { overview, form, run }),
    createElement(CodenameForm, { overview, form, run }),
    createElement(StageForm, { overview, form, run, revisionOf }),
    createElement(PauseForm, { overview, form, run, revisionOf }),
    createElement(ContactsSection, { overview, form, run }),
  );
}

type RunFn = (operation: string, input: unknown, okText: string) => Promise<void>;
type FormProps = {
  readonly overview: ProjectsOverview;
  readonly form: FormState;
  readonly run: RunFn;
};

function projectSelect(
  id: string,
  value: string,
  projects: readonly ProjectView[],
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
    ...projects.map((project) =>
      createElement(
        "option",
        { key: project.projectId, value: project.projectId },
        project.activeCodename === null
          ? project.displayName
          : `${project.activeCodename} — ${project.displayName}`,
      ),
    ),
  );
}

function IdentifyForm({ overview, form, run }: FormProps): ReactNode {
  const [name, setName] = useState("");
  const [stage, setStage] = useState<(typeof stageOrder)[number]>("inquiry");
  const [clientId, setClientId] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "projects.identifyProject",
      {
        displayName: name,
        initialStage: stage,
        clientId: clientId === "" ? null : clientId,
      },
      catalogCopy.projectIdentified,
    );
  }

  return createElement(
    "div",
    null,
    createElement("h2", null, catalogCopy.identifyHeading),
    createElement("p", null, catalogCopy.identifyIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "identify-name" }, catalogCopy.projectNameLabel),
      createElement("input", {
        id: "identify-name",
        type: "text",
        placeholder: catalogCopy.projectNamePlaceholder,
        value: name,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "identify-stage" }, catalogCopy.initialStageLabel),
      createElement("select", {
        id: "identify-stage",
        value: stage,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          setStage(event.target.value as (typeof stageOrder)[number]),
      },
        ...stageOrder.map((token) =>
          createElement("option", { key: token, value: token }, stageLabels[token]),
        ),
      ),
      createElement("label", { htmlFor: "identify-client" }, catalogCopy.clientSelectLabel),
      createElement("select", {
        id: "identify-client",
        value: clientId,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => setClientId(event.target.value),
      },
        createElement("option", { value: "" }, catalogCopy.clientNone),
        ...overview.contacts.map((contact) =>
          createElement("option", { key: contact.contactId, value: contact.contactId }, contact.displayName),
        ),
      ),
      createElement("button", { type: "submit", disabled: form.busy }, catalogCopy.identify),
    ),
  );
}

function CodenameForm({ overview, form, run }: FormProps): ReactNode {
  const all = [...overview.active, ...overview.closed];
  const [projectId, setProjectId] = useState(all[0]?.projectId ?? "");
  const [codename, setCodename] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "projects.assignCodename",
      { projectId, codename },
      catalogCopy.codenameAssigned,
    );
  }

  if (all.length === 0) {
    return null;
  }
  return createElement(
    "div",
    null,
    createElement("h2", null, catalogCopy.codenameHeading),
    createElement("p", null, catalogCopy.codenameIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "codename-project" }, catalogCopy.codenameProjectLabel),
      projectSelect("codename-project", projectId, all, setProjectId),
      createElement("label", { htmlFor: "codename-input" }, catalogCopy.codenameInputLabel),
      createElement("input", {
        id: "codename-input",
        type: "text",
        placeholder: catalogCopy.codenamePlaceholder,
        value: codename,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setCodename(event.target.value),
        required: true,
      }),
      createElement("button", { type: "submit", disabled: form.busy }, catalogCopy.assignCodename),
    ),
  );
}

function StageForm({
  overview,
  form,
  run,
  revisionOf,
}: FormProps & { readonly revisionOf: (projectId: string) => number }): ReactNode {
  const [projectId, setProjectId] = useState(overview.active[0]?.projectId ?? "");
  const [stage, setStage] = useState<(typeof stageOrder)[number]>("agreed");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "projects.changeStage",
      { projectId, expectedRevision: revisionOf(projectId), stage },
      catalogCopy.stageChanged,
    );
  }

  if (overview.active.length === 0 && overview.closed.length === 0) {
    return null;
  }
  const all = [...overview.active, ...overview.closed];
  return createElement(
    "div",
    null,
    createElement("h2", null, catalogCopy.stageHeading),
    createElement("p", null, catalogCopy.stageIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "stage-project" }, catalogCopy.stageProjectLabel),
      projectSelect("stage-project", projectId, all, setProjectId),
      createElement("label", { htmlFor: "stage-select" }, catalogCopy.stageSelectLabel),
      createElement("select", {
        id: "stage-select",
        value: stage,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          setStage(event.target.value as (typeof stageOrder)[number]),
      },
        ...stageOrder.map((token) =>
          createElement("option", { key: token, value: token }, stageLabels[token]),
        ),
      ),
      createElement("button", { type: "submit", disabled: form.busy }, catalogCopy.changeStage),
    ),
  );
}

function PauseForm({
  overview,
  form,
  run,
  revisionOf,
}: FormProps & { readonly revisionOf: (projectId: string) => number }): ReactNode {
  const [projectId, setProjectId] = useState(overview.active[0]?.projectId ?? "");
  const [reason, setReason] = useState("");
  const [resumeOn, setResumeOn] = useState("");

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "projects.setPause",
      {
        projectId,
        expectedRevision: revisionOf(projectId),
        pause: { reason, resumeOn: resumeOn === "" ? null : resumeOn },
      },
      catalogCopy.pauseChangedSet,
    );
  }

  async function clear(): Promise<void> {
    await run(
      "projects.setPause",
      { projectId, expectedRevision: revisionOf(projectId), pause: null },
      catalogCopy.pauseChangedClear,
    );
  }

  if (overview.active.length === 0) {
    return null;
  }
  return createElement(
    "div",
    null,
    createElement("h2", null, catalogCopy.pauseHeading),
    createElement("p", null, catalogCopy.pauseIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "pause-project" }, catalogCopy.pauseProjectLabel),
      projectSelect("pause-project", projectId, overview.active, setProjectId),
      createElement("label", { htmlFor: "pause-reason" }, catalogCopy.pauseReasonLabel),
      createElement("input", {
        id: "pause-reason",
        type: "text",
        placeholder: catalogCopy.pauseReasonPlaceholder,
        value: reason,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setReason(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "pause-resume" }, catalogCopy.pauseResumeLabel),
      createElement("input", {
        id: "pause-resume",
        type: "date",
        value: resumeOn,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setResumeOn(event.target.value),
      }),
      createElement("button", { type: "submit", disabled: form.busy }, catalogCopy.pauseSet),
    ),
    createElement("p", null,
      createElement("button", { type: "button", disabled: form.busy, onClick: () => void clear() }, catalogCopy.pauseClear),
    ),
  );
}

function ContactsSection({ overview, form, run }: FormProps): ReactNode {
  const [kind, setKind] = useState<"person" | "organization">("person");
  const [name, setName] = useState("");
  const [roleProjectId, setRoleProjectId] = useState(overview.active[0]?.projectId ?? "");
  const [roleContactId, setRoleContactId] = useState(overview.contacts[0]?.contactId ?? "");
  const [role, setRole] = useState<"client" | "executor" | "supplier">("client");

  async function addContact(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "projects.upsertContact",
      { contactId: null, kind, displayName: name },
      catalogCopy.contactAdded,
    );
  }

  async function assignRole(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "projects.assignContactRole",
      { projectId: roleProjectId, contactId: roleContactId, role },
      catalogCopy.roleAssigned,
    );
  }

  const allProjects = [...overview.active, ...overview.closed];
  return createElement(
    "div",
    null,
    createElement("h2", null, catalogCopy.contactsHeading),
    createElement("p", null, catalogCopy.contactsIntro),
    overview.contacts.length === 0
      ? createElement("p", null, catalogCopy.noContacts)
      : createElement("ul", null, ...overview.contacts.map((contact) =>
          createElement("li", { key: contact.contactId },
            `${contact.displayName} (${contactKindLabels[contact.kind]})`),
        )),
    createElement("form", { onSubmit: (event) => void addContact(event) },
      createElement("label", { htmlFor: "contact-kind" }, catalogCopy.contactKindLabel),
      createElement("select", {
        id: "contact-kind",
        value: kind,
        onChange: (event: ChangeEvent<HTMLSelectElement>) =>
          setKind(event.target.value === "organization" ? "organization" : "person"),
      },
        createElement("option", { value: "person" }, contactKindLabels.person),
        createElement("option", { value: "organization" }, contactKindLabels.organization),
      ),
      createElement("label", { htmlFor: "contact-name" }, catalogCopy.contactNameLabel),
      createElement("input", {
        id: "contact-name",
        type: "text",
        placeholder: catalogCopy.contactNamePlaceholder,
        value: name,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        required: true,
      }),
      createElement("button", { type: "submit", disabled: form.busy }, catalogCopy.addContact),
    ),
    allProjects.length > 0 && overview.contacts.length > 0
      ? createElement("div", null,
          createElement("h3", null, catalogCopy.roleHeading),
          createElement("form", { onSubmit: (event) => void assignRole(event) },
            createElement("label", { htmlFor: "role-project" }, catalogCopy.roleProjectLabel),
            projectSelect("role-project", roleProjectId, allProjects, setRoleProjectId),
            createElement("label", { htmlFor: "role-contact" }, catalogCopy.roleContactLabel),
            createElement("select", {
              id: "role-contact",
              value: roleContactId,
              onChange: (event: ChangeEvent<HTMLSelectElement>) => setRoleContactId(event.target.value),
            },
              ...overview.contacts.map((contact) =>
                createElement("option", { key: contact.contactId, value: contact.contactId }, contact.displayName),
              ),
            ),
            createElement("label", { htmlFor: "role-select" }, catalogCopy.roleSelectLabel),
            createElement("select", {
              id: "role-select",
              value: role,
              onChange: (event: ChangeEvent<HTMLSelectElement>) =>
                setRole(event.target.value as "client" | "executor" | "supplier"),
            },
              createElement("option", { value: "client" }, contactRoleLabels.client),
              createElement("option", { value: "executor" }, contactRoleLabels.executor),
              createElement("option", { value: "supplier" }, contactRoleLabels.supplier),
            ),
            createElement("button", { type: "submit", disabled: form.busy }, catalogCopy.assignRole),
          ),
        )
      : null,
  );
}
