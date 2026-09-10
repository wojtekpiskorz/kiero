/**
 * The conversation feature (H1): the boss-facing surface of the one shared
 * conversation history — "Rozmowa firmy" (company) and "Rozmowa projektowa"
 * (project projection of the SAME entries, CONTEXT.md).
 *
 * JSX-free on purpose (createElement only), like the membership and sign-in
 * surfaces: the host feature registry chain stays importable by the node
 * test programs.
 *
 * One history, one source, one author everywhere:
 *
 * - company view: `sources.read.views.companyConversation` (D1, paginated);
 * - project view: `sources.read.views.projectConversation` — the ordered
 *   projection through source-project links; rows decode through the SAME
 *   `SourceConversationRow`, so source id, author, send snapshot, lifecycle
 *   and processing state are identical in either scope. No editable copy
 *   exists anywhere: the project filter only narrows which originals show;
 * - one source detail: `sources.read.views.sourceDetail` — the single
 *   canonical URL `/?zrodlo=<id>` works in every view (the deep link F3/G2
 *   and future UX work can target);
 * - unread badges: `attention.read_state.queries.readStateForSources` (F1)
 *   over the page's canonical source ids — absence of a row means unread;
 *   opening the ORIGINAL (the detail view) marks it read everywhere for
 *   this person through `attention.markSourceRead` (one command per
 *   view-open; the server keeps the marking idempotent);
 * - honest processing states (D1's derived vocabulary, incl. `partial` and
 *   `failed` — a failed analysis never loses the source);
 * - correction-as-new-source ("Korekta ustalenia", CONTEXT.md): the Korekta
 *   button prefills a NEW message that references the old one; the earlier
 *   message is never rewritten.
 *
 * The send path is J1's proved loop verbatim: `sources.prepareUpload` (the
 * text-only source's durable upload row) then `sources.acceptSource` with
 * one idempotency key per logical message (a lost response retried with the
 * same key cannot create a second source).
 *
 * No styling, semantic controls only (the UX/UI track owns presentation).
 */

import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { Schema } from "effect";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { parseTableId, sourcesOperations } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type { MemberView } from "../../../../../convex/access/membership/functions";
import { ConversationPage, SourceConversationRow } from "../../../../../convex/sources/read/rows";
import type { SourceConversationRow as SourceConversationRowType } from "../../../../../convex/sources/read/rows";
import {
  CompanyFeatureGate,
  SessionEnded,
  envelopeOf,
  type MemberOverview,
  type Notice,
  type SubmitEvent,
} from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import {
  PROJECT_PARAM,
  SOURCE_PARAM,
  searchParam,
  writeScopeParam,
} from "../company/route-params";
import {
  ReadStateProjection,
  conversationCopy as copy,
  correctionPrefill,
  failureHint,
  instantLabel,
  justSentNotice,
  lifecycleLabels,
  processingStateLabels,
} from "./state";

/** How many rows one page of the conversation view requests. */
const PAGE_SIZE = 30;

/** The growth cap (four pages): the unread projection stays bounded. */
const MAX_PAGE_SIZE = 120;

/**
 * A fresh idempotency key per logical message (regenerated after success).
 * The shape is the certified `idem_` + v4-uuid pattern the command
 * envelope's idempotency-key schema requires; the UUID always comes from
 * getRandomValues (the baseline CSPRNG API).
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
// Root: the shared company-feature gate around this surface
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at "/" (conversation.company). */
export function ConversationFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    member: (overview: MemberOverview) => createElement(ConversationMain, { overview }),
  });
}

// ---------------------------------------------------------------------------
// The conversation: scope switch, send form, paged history, unread, detail
// ---------------------------------------------------------------------------

function ConversationMain({
  overview,
}: {
  readonly overview: MemberOverview;
}): ReactNode {
  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });

  // Deep links: ?projekt=<id> selects the project projection; ?zrodlo=<id>
  // opens one source's detail (the canonical URL of that source).
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(() => searchParam(PROJECT_PARAM));
  const [openSourceId, setOpenSourceId] = useState<string | null>(() => searchParam(SOURCE_PARAM));
  useEffect(() => {
    const onPop = () => {
      setScopeProjectId(searchParam(PROJECT_PARAM));
      setOpenSourceId(searchParam(SOURCE_PARAM));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [text, setText] = useState("");
  const [hintedProjects, setHintedProjects] = useState<readonly string[]>([]);
  const [idemKey, setIdemKey] = useState(freshKey);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sentSourceId, setSentSourceId] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<SourceConversationRowType | null>(null);

  const prepareUpload = useMutation(api.sources.uploads.commands.prepareUploadCommand);
  const acceptSource = useMutation(api.sources.accept.commands.acceptSourceCommand);

  const timezone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "Europe/Warsaw";

  const projectViews: readonly {
    projectId: string;
    displayName: string;
  }[] =
    projects.status === "success"
      ? [...projects.data.active, ...projects.data.closed].map((project) => ({
          projectId: project.projectId,
          displayName: project.displayName,
        }))
      : [];
  const projectNames = new Map(projectViews.map((project) => [project.projectId, project.displayName]));
  const knownProject =
    scopeProjectId !== null && projectNames.has(scopeProjectId) ? scopeProjectId : null;

  // Two typed subscriptions, one active: the company history or the
  // project projection of the same entries ("skip" unsubscribes the idle
  // one). Both queries return the same wire shape, so the active one
  // decodes ONCE through D1's own page schema at the untrusted boundary —
  // a drift in the view's shape fails here instead of rendering undefined.
  const scopeBrand = knownProject === null ? null : parseTableId("projects", knownProject);
  const companyConversation = useQueryState({
    query: api.sources.read.views.companyConversation,
    args:
      scopeBrand === null
        ? { paginationOpts: { numItems: pageSize, cursor: null } }
        : "skip",
  });
  const projectConversation = useQueryState({
    query: api.sources.read.views.projectConversation,
    args:
      scopeBrand === null
        ? "skip"
        : {
            // parseTableId brands the contract's table-id form; the query
            // wants the generated Id form of the SAME value.
            projectId: asConvexId("projects", scopeBrand),
            paginationOpts: { numItems: pageSize, cursor: null },
          },
  });
  const conversation =
    scopeBrand === null ? companyConversation : projectConversation;

  const page =
    conversation.status === "success" && conversation.data._tag === "ok"
      ? Schema.decodeUnknownSync(ConversationPage)(conversation.data.value)
      : null;
  const rows: readonly SourceConversationRowType[] = page?.page ?? [];
  const isDone = page?.isDone ?? true;
  const sentRow = sentSourceId === null ? null : rows.find((row) => row.sourceId === sentSourceId) ?? null;
  // A deep-linked source below the loaded page stays invisible without this:
  // the notice names why "load older" matters (the canonical URL must open
  // the original, also when history grew past the first page).
  const deepLinkedBelowPage =
    openSourceId !== null && !rows.some((row) => row.sourceId === openSourceId);

  // The unread projection (F1) over this page's canonical source ids:
  // absence of a row means unread; one row per person + logical source, so
  // the same query answers every view of that person identically.
  const readState = useQueryState({
    query: api.attention.read_state.queries.readStateForSources,
    args: {
      // The row ids ARE sources-table ids (decoded from D1's own row
      // schema); asConvexId converts between the two brandings of one value.
      sourceIds: rows.map((row) => asConvexId("sources", row.sourceId)).slice(0, 256),
    },
  });
  const readBySource = new Map<string, boolean>();
  if (readState.status === "success" && readState.data._tag === "ok") {
    for (const entry of Schema.decodeUnknownSync(ReadStateProjection)(readState.data.value)
      .entries) {
      readBySource.set(entry.sourceId, entry.read);
    }
  }

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
        envelope: {
          operation: "sources.acceptSource",
          input: {
            uploadId: upload.uploadId,
            authorText,
            timezoneSnapshot: timezone,
            projectHints: [...hintedProjects],
          },
          expectedRevisions: [],
          idempotencyKey: idemKey,
        },
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
      setCorrecting(null);
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

  function startCorrection(row: SourceConversationRowType): void {
    // "Korekta ustalenia": a NEW message referencing the old source. The
    // prefill quotes the original's own words; nothing is rewritten.
    setCorrecting(row);
    setText(correctionPrefill(row.authorText, row.sentAtMs));
    window.scrollTo({ top: 0 });
  }

  function selectScope(projectId: string | null): void {
    writeScopeParam(projectId);
    setScopeProjectId(projectId);
    setPageSize(PAGE_SIZE);
  }

  const members = new Map(overview.members.map((member) => [member.userId, member]));
  const selfLabel =
    overview.members.find((member) => member.isSelf)?.email ?? overview.company.name;

  return createElement(
    "section",
    null,
    createElement("h1", null, knownProject === null ? copy.title : copy.projectTitle),
    createElement("p", null, copy.intro),
    createElement(
      "p",
      null,
      `${overview.company.name} — zalogowano jako ${selfLabel}.`,
    ),
    createElement(ScopeSwitcher, {
      projectViews,
      knownProject,
      selectScope,
    }),
    createElement(SendForm, {
      text,
      setText: (value: string) => setText(value),
      projectViews,
      hintedProjects,
      toggleHint,
      sending,
      send,
      correcting: correcting !== null,
      cancelCorrection: () => {
        setCorrecting(null);
        setText("");
      },
    }),
    notice === null
      ? null
      : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
    sentRow === null
      ? null
      : createElement("p", { role: "status" }, justSentNotice(sentRow.processingState)),
    createElement("h2", null, knownProject === null ? copy.conversationHeading : copy.projectConversationHeading),
    conversation.status === "error"
      ? createElement(SessionEnded)
      : conversation.status !== "success"
        ? createElement("p", { role: "status" }, copy.checkingSession)
        : conversation.data._tag === "error"
          ? createElement("p", { role: "alert" }, failureHint(conversation.data.error.code, conversation.data.error.message))
          : createElement(MessageList, {
              rows,
              members,
              projectNames,
              readBySource,
              openSourceId,
              setOpenSourceId: (id: string | null) => setOpenSourceId(id),
              startCorrection,
            }),
    rows.length === 0 || isDone || pageSize >= MAX_PAGE_SIZE
      ? null
      : createElement(
          "p",
          null,
          createElement(
            "button",
            { type: "button", onClick: () => setPageSize((size) => size + PAGE_SIZE) },
            copy.loadOlder,
          ),
        ),
    deepLinkedBelowPage && !isDone && pageSize < MAX_PAGE_SIZE
      ? createElement("p", { role: "status" }, copy.deepLinkNotOnPage)
      : null,
    createElement(
      "p",
      null,
      createElement(
        "a",
        {
          href:
            knownProject === null
              ? "/pamiec"
              : `/pamiec?${PROJECT_PARAM}=${encodeURIComponent(knownProject)}`,
        },
        knownProject === null ? "Zobacz pamięć firmy" : "Zobacz pamięć tego projektu",
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Scope switcher (company <-> one project's projection)
// ---------------------------------------------------------------------------

function ScopeSwitcher({
  projectViews,
  knownProject,
  selectScope,
}: {
  readonly projectViews: readonly { readonly projectId: string; readonly displayName: string }[];
  readonly knownProject: string | null;
  readonly selectScope: (projectId: string | null) => void;
}): ReactNode {
  return createElement(
    "nav",
    { "aria-label": "Zakres rozmowy" },
    createElement("p", null, copy.scopeSwitchHint),
    createElement(
      "ul",
      null,
      createElement(
        "li",
        { key: "company" },
        createElement(
          "button",
          {
            type: "button",
            disabled: knownProject === null,
            onClick: () => selectScope(null),
          },
          copy.scopeCompanyLabel,
        ),
      ),
      ...projectViews.map((project) =>
        createElement(
          "li",
          { key: project.projectId },
          createElement(
            "button",
            {
              type: "button",
              disabled: knownProject === project.projectId,
              onClick: () => selectScope(project.projectId),
            },
            `${copy.scopeProjectLabel}: ${project.displayName}`,
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Send form (semantic, unstyled; J1's proved loop, graduated)
// ---------------------------------------------------------------------------

function SendForm({
  text,
  setText,
  projectViews,
  hintedProjects,
  toggleHint,
  sending,
  send,
  correcting,
  cancelCorrection,
}: {
  readonly text: string;
  readonly setText: (value: string) => void;
  readonly projectViews: readonly { readonly projectId: string; readonly displayName: string }[];
  readonly hintedProjects: readonly string[];
  readonly toggleHint: (projectId: string) => void;
  readonly sending: boolean;
  readonly send: (event: SubmitEvent) => void;
  readonly correcting: boolean;
  readonly cancelCorrection: () => void;
}): ReactNode {
  return createElement(
    "form",
    { onSubmit: (event) => void send(event) },
    createElement("h2", null, copy.sendHeading),
    correcting
      ? createElement("p", { role: "status" }, copy.correctionActiveNotice)
      : null,
    createElement("label", { htmlFor: "conversation-message" }, copy.sendTextLabel),
    createElement("textarea", {
      id: "conversation-message",
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
              createElement(
                "label",
                null,
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
    correcting
      ? createElement(
          "button",
          { type: "button", onClick: cancelCorrection },
          copy.cancel,
        )
      : null,
    createElement("p", null, copy.correctionNote),
  );
}

// ---------------------------------------------------------------------------
// Message list: rows identical in both scopes, unread badges, detail, korekta
// ---------------------------------------------------------------------------

function MessageList({
  rows,
  members,
  projectNames,
  readBySource,
  openSourceId,
  setOpenSourceId,
  startCorrection,
}: {
  readonly rows: readonly SourceConversationRowType[];
  readonly members: ReadonlyMap<string, MemberView>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly readBySource: ReadonlyMap<string, boolean>;
  readonly openSourceId: string | null;
  readonly setOpenSourceId: (id: string | null) => void;
  readonly startCorrection: (row: SourceConversationRowType) => void;
}): ReactNode {
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
        createElement(SourceRow, {
          row,
          members,
          projectNames,
          read: readBySource.get(row.sourceId) === true,
          open: openSourceId === row.sourceId,
          setOpen: (open: boolean) => setOpenSourceId(open ? row.sourceId : null),
          startCorrection,
        }),
        openSourceId === row.sourceId
          ? createElement(SourceDetailPanel, { sourceId: row.sourceId, members })
          : null,
      ),
    ),
  );
}

function SourceRow({
  row,
  members,
  projectNames,
  read,
  open,
  setOpen,
  startCorrection,
}: {
  readonly row: SourceConversationRowType;
  readonly members: ReadonlyMap<string, MemberView>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly read: boolean;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly startCorrection: (row: SourceConversationRowType) => void;
}): ReactNode {
  const author = members.get(row.authorUserId);
  const authorLabel = author === undefined ? copy.unknownAuthorLabel : `${author.displayName} (${author.email})`;
  const lifecycleLabel = lifecycleLabels[row.lifecycle];
  return createElement(
    "article",
    null,
    createElement(
      "p",
      null,
      createElement("strong", null, copy.messageAuthorLabel),
      ` — ${authorLabel} (${instantLabel(row.sentAtMs)}):`,
      read ? null : ` [${copy.unreadBadge}]`,
    ),
    createElement("p", null, row.authorText),
    createElement(
      "p",
      { role: "status" },
      `${processingStateLabels[row.processingState]}${
        row.projectIds.length === 0 ? "" : ` — ${copy.projectCountSuffix}: ${row.projectIds
          .map((id) => projectNames.get(id) ?? id)
          .join(", ")}`
      }${lifecycleLabel === undefined ? "" : ` — ${lifecycleLabel}`}`,
    ),
    createElement(
      "p",
      null,
      createElement("button", { type: "button", onClick: () => setOpen(!open) }, copy.detailButton),
      " ",
      createElement("button", { type: "button", onClick: () => startCorrection(row) }, copy.correctionButton),
    ),
  );
}

// ---------------------------------------------------------------------------
// Source detail: the one original, its canonical URL, and the read marking
// ---------------------------------------------------------------------------

function SourceDetailPanel({
  sourceId,
  members,
}: {
  readonly sourceId: string;
  readonly members: ReadonlyMap<string, MemberView>;
}): ReactNode {
  const detail = useQueryState({
    query: api.sources.read.views.sourceDetail,
    args: {
      // The id comes from a decoded D1 row of the same table; asConvexId
      // converts between the two brandings of one value.
      sourceId: asConvexId("sources", sourceId),
    },
  });
  const markRead = useMutation(api.attention.read_state.commands.markSourceReadCommand);

  // One marking per view-open of the original (F1): seeing the original
  // changes this person's state in every view and device. The ref guards
  // re-renders; the server-side transition stays idempotent regardless.
  const markedFor = useRef<string | null>(null);
  useEffect(() => {
    if (markedFor.current === sourceId) {
      return;
    }
    markedFor.current = sourceId;
    void markRead({
      envelope: envelopeOf("attention.markSourceRead", {
        sourceId: asConvexId("sources", sourceId),
        read: true,
      }),
    })
      .then((result) => {
        if (result._tag === "error") {
          console.warn(copy.markReadFailure);
        }
      })
      .catch(() => {
        console.warn(copy.markReadFailure);
      });
  }, [sourceId, markRead]);

  const canonicalUrl =
    typeof window === "undefined" ? null : `${window.location.origin}/?${SOURCE_PARAM}=${sourceId}`;

  if (detail.status === "error") {
    return createElement(SessionEnded);
  }
  if (detail.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  if (detail.data._tag === "error") {
    return createElement(
      "p",
      { role: "alert" },
      failureHint(detail.data.error.code, detail.data.error.message),
    );
  }
  const row = Schema.decodeUnknownSync(SourceConversationRow)(detail.data.value);
  const author = members.get(row.authorUserId);
  const authorLabel = author === undefined ? copy.unknownAuthorLabel : `${author.displayName} (${author.email})`;
  return createElement(
    "section",
    { "aria-label": copy.detailHeading },
    createElement("h3", null, copy.detailHeading),
    createElement("p", null, `${copy.detailAuthor}: ${authorLabel}`),
    createElement("p", null, `${copy.detailSentAt}: ${instantLabel(row.sentAtMs)} (${row.sentAtTimezone})`),
    createElement("p", null, `${copy.detailState}: ${processingStateLabels[row.processingState]}`),
    createElement(
      "p",
      null,
      `${copy.detailProjects}: ${
        row.projectIds.length === 0
          ? copy.detailNoProjects
          : row.projectIds.join(", ")
      }`,
    ),
    createElement("p", null, createElement("strong", null, copy.detailLinkLabel)),
    createElement("p", null, createElement("code", null, canonicalUrl ?? `/?${SOURCE_PARAM}=${sourceId}`)),
  );
}
