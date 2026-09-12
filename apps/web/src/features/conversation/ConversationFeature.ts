/**
 * The conversation feature (H1, joined by J2): the boss-facing surface of
 * the one shared conversation history — "Rozmowa firmy" (company) and
 * "Rozmowa projektowa" (project projection of the SAME entries,
 * CONTEXT.md).
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
 * - one source detail: `sources.read.views.sourceDetail` — the canonical
 *   source route is the dossier `/zrodlo` with its encoded `zrodlo` param
 *   (R5's shared serializer, ../source-detail/source-route); the legacy
 *   conversation-route deep link carrying the same param redirects there,
 *   because the inline detail renders only inside the feed's loaded rows
 *   and the feed's growth is capped;
 * - unread badges: `attention.read_state.queries.readStateForSources` (F1)
 *   over the page's canonical source ids — absence of a row means unread;
 *   opening the ORIGINAL (the detail view) marks it read everywhere for
 *   this person through `attention.markSourceRead` (one command per
 *   view-open; the server keeps the marking idempotent);
 * - honest processing states (D1's derived vocabulary, incl. `partial` and
 *   `failed` — a failed analysis never loses the source);
 * - correction-as-new-source ("Korekta ustalenia", CONTEXT.md): the Korekta
 *   button prefills the composer with a NEW message that references the
 *   old one; the earlier message is never rewritten.
 *
 * The J2 join (issue #61) folds ALL capture modes into this surface: the
 * embedded capture composer (text + one recording + photos, D4's
 * recoverable-draft engine with voice-only sends allowed) replaces J1's
 * text-only statement form, and the separate /wpis route retires. The
 * composer's project pill keeps D4's semantics (the DRAFT's stored scope,
 * seeded from this route's ?projekt= param); multi-project messages route
 * through the agent's project identification, not the pill.
 *
 * The agent-answer flow (E6 joined): "Zapytaj agenta" on one message runs
 * the real answer loop (`agent/loop:askAgent`, the question source's id)
 * and renders the structured result inline — the answer with per-statement
 * evidence bases, the raised Sprawa do wyjaśnienia, the executed task/event
 * changes, or the honest gave-up/provider-failure notice. Never a guess.
 *
 * No styling, semantic controls only (the UX/UI track owns presentation).
 */

import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Schema } from "effect";
import { useAction, useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { parseTableId } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type { MemberView } from "../../../../../convex/access/membership/functions";
import { ConversationPage, SourceConversationRow } from "../../../../../convex/sources/read/rows";
import type { SourceConversationRow as SourceConversationRowType } from "../../../../../convex/sources/read/rows";
import {
  CompanyFeatureGate,
  SessionEnded,
  envelopeOf,
  type MemberOverview,
} from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import { PROJECT_PARAM, searchParam, writeScopeParam } from "../company/route-params";
import {
  inspectSourceSearch,
  serializeSourceReference,
} from "../source-detail/source-route";
import { ComposerForm } from "../capture/CaptureFeature";
import {
  ReadStateProjection,
  AnswerRefusalWire,
  AnswerResultWire,
  answerCopy,
  answerOutcomeLabel,
  answerBasisLabel,
  conversationCopy as copy,
  correctionPrefill,
  failureHint,
  instantLabel,
  lifecycleLabels,
  processingStateLabels,
  type AnswerRunWire,
} from "./state";

/** How many rows one page of the conversation view requests. */
const PAGE_SIZE = 30;

/** The growth cap (four pages): the unread projection stays bounded. */
const MAX_PAGE_SIZE = 120;

/** One open agent-answer run: asking, decoded, or honestly refused. */
type AnswerState =
  | { readonly sourceId: string; readonly status: "asking" }
  | { readonly sourceId: string; readonly status: "done"; readonly run: AnswerRunWire }
  | { readonly sourceId: string; readonly status: "refused"; readonly message: string }
  | null;

/**
 * R5 (issue #130): the truthful refusal for a legacy source deep link
 * whose value cannot denote a source. Local to this file because the
 * shared conversation copy module is outside this issue's owned paths (the
 * R1 label precedent in MemoryFeature); a copy consolidation can move it
 * unchanged.
 */
const legacyDeepLinkMalformed =
  "Odnośnik do źródła jest nieprawidłowy — nie otwarto żadnej wiadomości.";

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

  // Deep links: ?projekt=<id> selects the project projection. The legacy
  // ?zrodlo=<id> no longer opens the inline detail (it renders only inside
  // the capped feed): R5 redirects it to the canonical dossier, whose read
  // is independent of this feed's pagination.
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(() => searchParam(PROJECT_PARAM));
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [legacyNotice, setLegacyNotice] = useState<string | null>(null);
  useEffect(() => {
    /** Redirects a legacy source deep link, or reports it honestly. */
    const followLegacySourceLink = (): void => {
      const inspection = inspectSourceSearch(window.location.search);
      if (inspection.kind === "reference") {
        window.location.replace(serializeSourceReference(inspection.reference));
        return;
      }
      setLegacyNotice(inspection.kind === "malformed" ? legacyDeepLinkMalformed : null);
    };
    followLegacySourceLink();
    const onPop = () => {
      setScopeProjectId(searchParam(PROJECT_PARAM));
      followLegacySourceLink();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  // The correction prefill for the composer (H1's flow, now writing into
  // the draft record through the composer's own seam): one outstanding
  // prefill at a time, dropped once applied.
  const [correctionPrefillText, setCorrectionPrefillText] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<SourceConversationRowType | null>(null);
  // The agent-answer flow (J2): one open answer at a time — asking, done
  // (decoded run) or refused (honest Polish failure).
  const [answer, setAnswer] = useState<AnswerState>(null);
  const askAgent = useAction(api.agent.loop.askAgent);

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

  function startCorrection(row: SourceConversationRowType): void {
    // "Korekta ustalenia": a NEW message referencing the old source. The
    // prefill quotes the original's own words; nothing is rewritten. The
    // composer applies it into the draft record (one outstanding prefill).
    setCorrecting(row);
    setCorrectionPrefillText(correctionPrefill(row.authorText, row.sentAtMs));
    window.scrollTo({ top: 0 });
  }

  function cancelCorrection(): void {
    setCorrecting(null);
    setCorrectionPrefillText(null);
  }

  /** Runs the real answer loop for one question source (J2's join). */
  async function runAnswer(sourceId: string): Promise<void> {
    if (answer !== null && answer.sourceId === sourceId && answer.status === "asking") {
      return;
    }
    setAnswer({ sourceId, status: "asking" });
    try {
      // ONE decode at the untrusted boundary: the run result or the honest
      // pre-loop refusal (the three outcome strings), never a hand-rolled
      // narrowing of raw data in front of the schema.
      const result = Schema.decodeUnknownSync(AnswerResultWire)(
        await askAgent({ sourceId: asConvexId("sources", sourceId) }),
      );
      if (Schema.is(AnswerRefusalWire)(result)) {
        setAnswer({
          sourceId,
          status: "refused",
          message:
            result.outcome === "missing" ? copy.answerMissingSource : copy.answerRefused,
        });
        return;
      }
      setAnswer({ sourceId, status: "done", run: result });
    } catch {
      // Transport failure (or wire drift throwing in the decode): the
      // honest unavailable notice. Nothing was rendered from a guess.
      setAnswer({ sourceId, status: "refused", message: copy.answerUnavailable });
    }
  }

  function selectScope(projectId: string | null): void {
    writeScopeParam(projectId);
    setScopeProjectId(projectId);
    setPageSize(PAGE_SIZE);
  }

  const members = new Map(overview.members.map((member) => [member.userId, member]));
  const selfMember = overview.members.find((member) => member.isSelf);
  const selfLabel = selfMember?.email ?? overview.company.name;

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
    correcting === null
      ? null
      : createElement(
          "p",
          { role: "status" },
          copy.correctionActiveNotice,
          " ",
          createElement("button", { type: "button", onClick: cancelCorrection }, copy.cancel),
        ),
    // The joined composer: ALL capture modes (text, recording, photos) over
    // D4's recoverable-draft engine; the correction prefill and the
    // accepted callback are this surface's seams into it.
    createElement(ComposerForm, {
      userId: selfMember?.userId ?? "unknown-user",
      prefill: correctionPrefillText,
      onPrefillApplied: () => setCorrectionPrefillText(null),
      onAccepted: () => setCorrecting(null),
    }),
    legacyNotice === null ? null : createElement("p", { role: "alert" }, legacyNotice),
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
              answer,
              runAnswer: (sourceId: string) => void runAnswer(sourceId),
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
// Message list: rows identical in both scopes, unread badges, detail,
// korekta and the agent-answer panel
// ---------------------------------------------------------------------------

function MessageList({
  rows,
  members,
  projectNames,
  readBySource,
  openSourceId,
  setOpenSourceId,
  startCorrection,
  answer,
  runAnswer,
}: {
  readonly rows: readonly SourceConversationRowType[];
  readonly members: ReadonlyMap<string, MemberView>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly readBySource: ReadonlyMap<string, boolean>;
  readonly openSourceId: string | null;
  readonly setOpenSourceId: (id: string | null) => void;
  readonly startCorrection: (row: SourceConversationRowType) => void;
  readonly answer: AnswerState;
  readonly runAnswer: (sourceId: string) => void;
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
          askDisabled: answer !== null && answer.status === "asking",
          ask: () => runAnswer(row.sourceId),
        }),
        openSourceId === row.sourceId
          ? createElement(SourceDetailPanel, { sourceId: row.sourceId, members })
          : null,
        answer !== null && answer.sourceId === row.sourceId
          ? createElement(AgentAnswerPanel, { answer })
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
  askDisabled,
  ask,
}: {
  readonly row: SourceConversationRowType;
  readonly members: ReadonlyMap<string, MemberView>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly read: boolean;
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly startCorrection: (row: SourceConversationRowType) => void;
  readonly askDisabled: boolean;
  readonly ask: () => void;
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
      // A withdrawn/purged original cannot ground a question; only an
      // active source may be asked about (the loop's own gate agrees).
      row.lifecycle === "active"
        ? createElement(
            "button",
            { type: "button", onClick: ask, disabled: askDisabled },
            answerCopy.askButton,
          )
        : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// The agent answer panel: E6's structured result, glossary-exact labels
// ---------------------------------------------------------------------------

/**
 * The agent-answer panel: E6's structured result, glossary-exact labels.
 * Exported for the deterministic surface tests (renderToString) — it owns
 * no subscriptions, like the memory surface's exported R1 basis view.
 */
export function AgentAnswerPanel({ answer }: { readonly answer: AnswerState }): ReactNode {
  if (answer === null) {
    return null;
  }
  if (answer.status === "asking") {
    return createElement(
      "section",
      { "aria-label": answerCopy.heading, role: "status" },
      createElement("p", null, answerCopy.asking),
    );
  }
  if (answer.status === "refused") {
    return createElement(
      "section",
      { "aria-label": answerCopy.heading },
      createElement("p", { role: "alert" }, answer.message),
    );
  }
  const { run } = answer;
  const evidenceById = new Map(run.evidence.map((entry) => [entry.evidenceId, entry]));
  return createElement(
    "section",
    { "aria-label": answerCopy.heading },
    createElement("h3", null, answerOutcomeLabel(run)),
    run.outcome === "clarified"
      ? createElement(
          "div",
          null,
          ...run.clarificationsRaised.map((raised) =>
            createElement("p", { key: raised.clarificationId }, createElement("strong", null, raised.question)),
          ),
          createElement("p", null, answerCopy.clarifiedNote),
        )
      : null,
    run.answer === null
      ? null
      : createElement(
          "div",
          null,
          createElement("p", null, createElement("strong", null, run.answer.answerText)),
          createElement(
            "ul",
            null,
            ...run.answer.statements.map((statement, index) =>
              createElement(
                "li",
                { key: `${index}-${statement.text.slice(0, 24)}` },
                `${statement.text} (${answerBasisLabel(statement.basis)})`,
                ...statement.evidenceIds.flatMap((handle) => {
                  const evidence = evidenceById.get(handle);
                  return evidence === undefined
                    ? []
                    : [
                        createElement(
                          "p",
                          { key: `${handle}-${evidence.sourceId}` },
                          // R5: the quote itself is the anchor into the
                          // canonical dossier route — the answer's basis
                          // stays one click from the original (the wire
                          // pins no fragment, so the whole source serves).
                          `${answerCopy.evidenceQuoteLabel} `,
                          createElement(
                            "a",
                            {
                              href: serializeSourceReference({
                                sourceId: evidence.sourceId,
                                fragmentId: null,
                                projectId: null,
                              }),
                            },
                            evidence.quote,
                          ),
                        ),
                      ];
                }),
              ),
            ),
          ),
          run.answer.disclosures.updatingFindingIds.length === 0 &&
            run.answer.disclosures.processingSourceIds.length === 0
            ? null
            : createElement(
                "div",
                null,
                createElement("p", null, createElement("strong", null, answerCopy.disclosuresHeading)),
                run.answer.disclosures.updatingFindingIds.length === 0
                  ? null
                  : createElement("p", null, answerCopy.disclosureUpdating(run.answer.disclosures.updatingFindingIds.length)),
                run.answer.disclosures.processingSourceIds.length === 0
                  ? null
                  : createElement("p", null, answerCopy.disclosureProcessing(run.answer.disclosures.processingSourceIds.length)),
              ),
        ),
    run.changes.length === 0
      ? null
      : createElement(
          "div",
          null,
          createElement("p", null, createElement("strong", null, answerCopy.changesHeading)),
          createElement(
            "ul",
            null,
            ...run.changes.map((change) =>
              createElement(
                "li",
                { key: `${change.operation}-${change.entityId}` },
                `${answerCopy.changeLabels[change.kind]}: ${change.operation} (rewizja ${change.revision})`,
              ),
            ),
          ),
        ),
    createElement(
      "p",
      null,
      answerCopy.modelsLine(run.observedModels, run.turns, run.refreshes),
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

  // R5: the canonical link this inline panel can offer is the dossier
  // route, serialized by the one shared authority.
  const canonicalUrl =
    typeof window === "undefined"
      ? null
      : `${window.location.origin}${serializeSourceReference({ sourceId, fragmentId: null, projectId: null })}`;

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
    createElement(
      "p",
      null,
      createElement(
        "code",
        null,
        canonicalUrl ?? serializeSourceReference({ sourceId, fragmentId: null, projectId: null }),
      ),
    ),
  );
}
