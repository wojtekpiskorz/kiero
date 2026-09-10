/**
 * The barebones core-text feature (J1): the first real text-to-memory loop
 * mounted behind app controls.
 *
 * JSX-free on purpose (createElement only), like the membership surface: the
 * host feature registry chain stays importable by the node test programs.
 *
 * One signed-in boss, the SAME checked operations the agent uses:
 *
 * - send: `sources.prepareUpload` (a text-only source still needs its durable
 *   upload row) then `sources.acceptSource` — the D1 acceptance path, one
 *   logical source per idempotency key (a lost response retried with the
 *   same key cannot create a second source);
 * - watch: the company conversation view (D1's derived processing state —
 *   accepted/processing/processed/failed — never a stored copy);
 * - read: `memory.readCurrentFindings` for the firm scope or one project
 *   (current memory without replaying the conversation);
 * - correct: a NEW source with the clear correction (CONTEXT.md: a
 *   correction is a new message; the original is never rewritten).
 *
 * No styling, semantic controls only (the UX/UI track owns presentation).
 * Clarification questions raised by the agent are not yet surfaced here —
 * the barebones state vocabulary stays honest about what is visible.
 */

import {
  createElement,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { Schema } from "effect";
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { Link } from "@tanstack/react-router";
import { parseTableId, sourcesOperations } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import type { MembershipOverview } from "../../../../../convex/access/membership/functions";
import { ConversationPage } from "../../../../../convex/sources/read/rows";
import type { SourceConversationRow } from "../../../../../convex/sources/read/rows";
import type { CurrentFindingWireRow } from "../../../../../convex/memory/findings/read";
import type { ReadCurrentFindingsInput } from "../../../../../convex/memory/findings/semantics";
import {
  coreTextCopy as copy,
  failureHint,
  findingValueLabel,
  knowledgeStateLabel,
  processingStateLabels,
  signInCopy,
} from "./state";

/** One command envelope (the checked dispatch input shape). */
function envelopeOf(operation: string, input: unknown, idempotencyKey?: string) {
  return {
    operation,
    input,
    expectedRevisions: [],
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
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

/**
 * A fresh idempotency key per logical message (regenerated after success).
 * The shape is the certified `idem_` + v4-uuid pattern the command
 * envelope's idempotency-key schema requires. The UUID always comes from
 * getRandomValues — the baseline CSPRNG API every crypto context provides
 * (randomUUID is the newer, narrower one) — so both branches of the old
 * fallback are gone and every emitted key passes the schema.
 */
function uuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function freshKey(): string {
  return `idem_${uuidV4()}`;
}

/** The typed result shapes of the two send commands (contract authority). */
const prepareUploadResult = sourcesOperations["sources.prepareUpload"].result;
const acceptSourceResult = sourcesOperations["sources.acceptSource"].result;

// ---------------------------------------------------------------------------
// Root: connection gate + auth provider
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at "/" (conversation.company). */
export function CoreTextFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state === "unconfigured") {
    return createElement("section", null, createElement("h1", null, copy.title), createElement("p", null, copy.connectionUnconfigured));
  }
  if (config.connection.state === "misconfigured") {
    return createElement("section", null, createElement("h1", null, copy.title), createElement("p", null, copy.connectionMisconfigured));
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(CoreTextGate),
  });
}

/** Authentication gate: B1's shared sign-in walk; members continue here. */
function CoreTextGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: () => createElement(CoreTextSurface) });
}

// ---------------------------------------------------------------------------
// The surface: membership gate, then the loop's controls
// ---------------------------------------------------------------------------

function CoreTextSurface(): ReactNode {
  const overview = useQueryState({
    query: api.access.membership.functions.membershipOverview,
    args: {},
  });
  const { signOut } = useAuthActions();

  if (overview.status === "error") {
    return createElement(
      "div",
      { role: "alert" },
      createElement("p", null, signInCopy.sessionEndedNotice),
      createElement(
        "button",
        { type: "button", onClick: () => void signOut() },
        signInCopy.signInAgain,
      ),
    );
  }
  if (overview.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  if (overview.data.state === "no_company") {
    return createElement(
      "section",
      null,
      createElement("h1", null, copy.title),
      createElement("h2", null, copy.noCompanyHeading),
      createElement("p", null, copy.noCompanyIntro),
      createElement("p", null, createElement(Link, { to: "/firma" }, copy.noCompanyLink)),
    );
  }
  return createElement(CoreTextMain, { overview: overview.data });
}

// ---------------------------------------------------------------------------
// The loop: send -> watch -> read (correction is a new send)
// ---------------------------------------------------------------------------

function CoreTextMain({
  overview,
}: {
  readonly overview: Extract<MembershipOverview, { state: "member" }>;
}): ReactNode {
  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  const conversation = useQueryState({
    query: api.sources.read.views.companyConversation,
    args: { paginationOpts: { numItems: 30, cursor: null } },
  });
  const prepareUpload = useMutation(api.sources.uploads.commands.prepareUploadCommand);
  const acceptSource = useMutation(api.sources.accept.commands.acceptSourceCommand);

  const [text, setText] = useState("");
  const [hintedProjects, setHintedProjects] = useState<readonly string[]>([]);
  const [idemKey, setIdemKey] = useState(freshKey);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sentSourceId, setSentSourceId] = useState<string | null>(null);
  const [memoryScope, setMemoryScope] = useState<string>("company");

  const timezone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "Europe/Warsaw";

  // The watch surface: the just-sent source's DERIVED processing state.
  // The page decodes through D1's own row schema at the untrusted boundary,
  // so a drift in the view's shape fails here instead of rendering undefined.
  const rows: readonly SourceConversationRow[] =
    conversation.status === "success" && conversation.data._tag === "ok"
      ? Schema.decodeUnknownSync(ConversationPage)(conversation.data.value).page
      : [];
  const sentRow = sentSourceId === null ? null : rows.find((row) => row.sourceId === sentSourceId) ?? null;

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const authorText = text.trim();
    if (authorText.length === 0 || sending) {
      return;
    }
    setSending(true);
    setNotice(null);
    try {
      const prepared = await prepareUpload({
        envelope: envelopeOf("sources.prepareUpload", {
          draftId: idemKey,
          parts: 1,
          mediaKinds: [],
        }),
      });
      if (prepared._tag === "error") {
        setNotice({ kind: "error", text: failureHint(prepared.error.code, prepared.error.message) });
        return;
      }
      const upload = Schema.decodeUnknownSync(prepareUploadResult)(prepared.value);
      const accepted = await acceptSource({
        envelope: envelopeOf(
          "sources.acceptSource",
          {
            uploadId: upload.uploadId,
            authorText,
            timezoneSnapshot: timezone,
            projectHints: [...hintedProjects],
          },
          idemKey,
        ),
      });
      if (accepted._tag === "error") {
        setNotice({ kind: "error", text: failureHint(accepted.error.code, accepted.error.message) });
        return;
      }
      const receipt = Schema.decodeUnknownSync(acceptSourceResult)(accepted.value);
      // Confirmed durable acceptance: the logical message is complete. A new
      // draft gets a new idempotency key; the watch state takes over below.
      setSentSourceId(receipt.sourceId);
      setNotice({ kind: "ok", text: copy.savedNotice });
      setText("");
      setHintedProjects([]);
      setIdemKey(freshKey());
    } catch {
      // Unknown response (network lost): the SAME key retries the SAME
      // logical source — never a duplicate.
      setNotice({ kind: "error", text: copy.lostResponseNotice });
    } finally {
      setSending(false);
    }
  }

  function toggleHint(projectId: string): void {
    setHintedProjects((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    );
  }

  const projectViews: readonly {
    projectId: string;
    displayName: string;
  }[] =
    projects.status === "success"
      ? [...projects.data.active, ...projects.data.closed].map((project) => ({
          projectId: project.projectId as string,
          displayName: project.displayName,
        }))
      : [];

  // The memory scope the read decodes server-side through the operation's
  // contract; parseTableId brands the selected id without a cast (the
  // select's options are the projects overview's real ids, so a null brand
  // would mean corrupted UI state — falling back to the company scope
  // keeps the read well-formed even then).
  const scopeProjectId = parseTableId("projects", memoryScope);
  const memoryArgs: ReadCurrentFindingsInput =
    memoryScope === "company" || scopeProjectId === null
      ? { scope: { _tag: "company" } }
      : { scope: { _tag: "project", projectId: scopeProjectId } };

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement(
      "p",
      null,
      `${overview.company.name} — zalogowano jako ${
        overview.members.find((member) => member.isSelf)?.email ?? overview.company.name
      }.`,
    ),
    createElement(SendForm, {
      text,
      setText: (value: string) => setText(value),
      projectViews,
      hintedProjects,
      toggleHint,
      sending,
      send,
    }),
    notice === null
      ? null
      : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
    sentRow === null
      ? null
      : createElement(
          "p",
          { role: "status" },
          sentRow.processingState === "accepted" || sentRow.processingState === "processing"
            ? copy.processingNotice
            : sentRow.processingState === "processed"
              ? copy.processedNotice
              : copy.failedNotice,
        ),
    createElement("h2", null, copy.conversationHeading),
    conversation.status === "error"
      ? createElement("p", { role: "alert" }, signInCopy.sessionEndedNotice)
      : conversation.status !== "success"
        ? createElement("p", { role: "status" }, copy.checkingSession)
        : conversation.data._tag === "error"
          ? createElement("p", { role: "alert" }, failureHint(conversation.data.error.code, conversation.data.error.message))
          : createElement(ConversationList, { rows }),
    createElement(MemorySection, {
      projectViews,
      memoryScope,
      setMemoryScope,
      memoryArgs,
    }),
  );
}

// ---------------------------------------------------------------------------
// Send form (semantic, unstyled)
// ---------------------------------------------------------------------------

function SendForm({
  text,
  setText,
  projectViews,
  hintedProjects,
  toggleHint,
  sending,
  send,
}: {
  readonly text: string;
  readonly setText: (value: string) => void;
  readonly projectViews: readonly { readonly projectId: string; readonly displayName: string }[];
  readonly hintedProjects: readonly string[];
  readonly toggleHint: (projectId: string) => void;
  readonly sending: boolean;
  readonly send: (event: SubmitEvent) => void;
}): ReactNode {
  return createElement(
    "form",
    { onSubmit: (event) => void send(event) },
    createElement("h2", null, copy.sendHeading),
    createElement("label", { htmlFor: "core-text-message" }, copy.sendTextLabel),
    createElement("textarea", {
      id: "core-text-message",
      rows: 4,
      placeholder: copy.sendTextPlaceholder,
      value: text,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value),
      required: true,
    }),
    createElement("p", null, copy.sendProjectsLabel),
    projectViews.length === 0
      ? null
      : createElement(
          "ul",
          null,
          ...projectViews.map((project) =>
            createElement(
              "li",
              { key: project.projectId },
              createElement("label", null,
                createElement("input", {
                  type: "checkbox",
                  checked: hintedProjects.includes(project.projectId),
                  onChange: () => toggleHint(project.projectId),
                }),
                ` ${project.displayName}`,
              ),
            ),
          ),
        ),
    createElement("button", { type: "submit", disabled: sending || text.trim().length === 0 },
      sending ? copy.sending : copy.sendButton),
    createElement("p", null, copy.correctionNote),
  );
}

// ---------------------------------------------------------------------------
// Conversation list (states derived from durable rows, never stored)
// ---------------------------------------------------------------------------

function ConversationList({ rows }: { readonly rows: readonly SourceConversationRow[] }): ReactNode {
  if (rows.length === 0) {
    return createElement("p", null, copy.noMessages);
  }
  return createElement(
    "ul",
    null,
    ...rows.map((row) =>
      createElement(
        "li",
        { key: row.sourceId },
        createElement("p", null, createElement("strong", null, copy.messageAuthorLabel), ` (${new Date(row.sentAtMs).toLocaleString("pl-PL")}):`),
        createElement("p", null, row.authorText),
        createElement(
          "p",
          { role: "status" },
          `${processingStateLabels[row.processingState]}${
            row.projectIds.length === 0 ? "" : ` — projekty: ${row.projectIds.length}`
          }${row.lifecycle === "active" ? "" : ` — ${row.lifecycle}`}`,
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Current memory (per scope)
// ---------------------------------------------------------------------------

function MemorySection({
  projectViews,
  memoryScope,
  setMemoryScope,
  memoryArgs,
}: {
  readonly projectViews: readonly { readonly projectId: string; readonly displayName: string }[];
  readonly memoryScope: string;
  readonly setMemoryScope: (scope: string) => void;
  readonly memoryArgs: ReadCurrentFindingsInput;
}): ReactNode {
  const findings = useQueryState({
    query: api.memory.findings.functions.readCurrentFindings,
    args: memoryArgs,
  });
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.memoryHeading),
    createElement("p", null, copy.memoryIntro),
    createElement("label", { htmlFor: "core-memory-scope" }, "Zakres pamięci"),
    createElement(
      "select",
      {
        id: "core-memory-scope",
        value: memoryScope,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => setMemoryScope(event.target.value),
      },
      createElement("option", { value: "company" }, copy.memoryScopeCompany),
      ...projectViews.map((project) =>
        createElement("option", { key: project.projectId, value: project.projectId }, project.displayName),
      ),
    ),
    findings.status === "error"
      ? createElement("p", { role: "alert" }, signInCopy.sessionEndedNotice)
      : findings.status !== "success"
        ? createElement("p", { role: "status" }, copy.checkingSession)
        : createElement(FindingsList, { rows: findings.data }),
  );
}

function FindingsList({ rows }: { readonly rows: readonly CurrentFindingWireRow[] }): ReactNode {
  if (rows.length === 0) {
    return createElement("p", null, copy.noFindings);
  }
  return createElement(
    "ul",
    null,
    ...rows.map((row) =>
      createElement(
        "li",
        { key: row.findingId },
        createElement("p", null, createElement("strong", null, row.semanticKey)),
        createElement("p", null, findingValueLabel(row.value)),
        createElement("p", null, knowledgeStateLabel(row.knowledgeState)),
      ),
    ),
  );
}
