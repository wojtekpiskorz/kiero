/**
 * The search feature (H3): "Szukaj" — evidence search over E5's
 * tenant-safe versioned retrieval.
 *
 * JSX-free on purpose (createElement only), like the conversation and
 * memory surfaces: the host feature registry chain stays importable by the
 * node test programs.
 *
 * - the query: `search/commands:queryEvidence` (the PUBLIC action E5
 *   owns) through the checked envelope dispatch — text, transcript and
 *   OCR evidence plus current findings, with the optional Polish
 *   barebones filters (project, author, send-date range) and a cursor;
 * - the coverage disclosure: the E5 result's coverage literal is shown
 *   VERBATIM with its Polish explanation — `text_only` and `degraded`
 *   state plainly that a missing hit is retrieval coverage, never proof
 *   the fact does not exist;
 * - hydration before rendering: every source hit re-reads its canonical
 *   D1 row (`sources.read.views.sourceDetail`) so the result NEVER
 *   renders a snippet a stale vector row claims — the server already
 *   dropped what tenant checks, lifecycle or the current revision
 *   superseded (E5's keep rules), and the row the UI shows is the
 *   canonical record, not the index;
 * - the authoritative open: source hits deep-link through R5's one shared
 *   serializer (`../source-detail/source-route`) into the canonical
 *   dossier route with its encoded `zrodlo` param (the source URL's
 *   full-history expansion, with the matched fragment's anchor
 *   highlighted); finding hits expand to C2's `memory.readFindingHistory`
 *   (the current revision with provenance) and link their evidence
 *   through the same serializer;
 * - paging: `isDone`/cursor honored with a "Pokaż więcej" button — pages
 *   append, no unbounded reload.
 */

import {
  createElement,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { Schema } from "effect";
import { useAction, useQuery_experimental as useQueryState } from "convex/react";
import { searchOperations, parseTableId } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type { MemberView } from "../../../../../convex/access/membership/functions";
import {
  SourceConversationRow,
  type SourceConversationRow as SourceConversationRowType,
} from "../../../../../convex/sources/read/rows";
import { instantLabel, signInCopy } from "../conversation/state";
import { findingValueLabel, knowledgeStateLabel } from "../memory/state";
import {
  CompanyFeatureGate,
  SessionEnded,
  envelopeOf,
  type MemberOverview,
  type SubmitEvent,
} from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import { serializeSourceReference } from "../source-detail/source-route";
import {
  coverageLine,
  dayToEndMs,
  dayToMs,
  failureHint,
  isDegradedCoverage,
  searchCopy as copy,
  type CoverageLiteral,
} from "./state";

/** How many results one page requests. */
const RESULT_PAGE_SIZE = 10;

/** The typed result shape of `search.queryEvidence` (contract authority). */
const queryResult = searchOperations["search.queryEvidence"].result;
type QueryResult = Schema.Schema.Type<typeof queryResult>;

/** One decoded result entry (the contract's hydrated row). */
type ResultEntry = QueryResult["entries"][number];

// ---------------------------------------------------------------------------
// Root: the shared company-feature gate around this surface
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at "/szukaj" (search.evidence). */
export function SearchFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    member: (overview: MemberOverview) => createElement(SearchMain, { overview }),
  });
}

function SearchMain({ overview }: { readonly overview: MemberOverview }): ReactNode {
  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  const queryEvidence = useAction(api.search.commands.queryEvidence);

  const [query, setQuery] = useState("");
  const [projectScope, setProjectScope] = useState("any");
  const [authorScope, setAuthorScope] = useState("any");
  const [dayFrom, setDayFrom] = useState("");
  const [dayTo, setDayTo] = useState("");
  const [searching, setSearching] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  const projectViews: readonly { readonly projectId: string; readonly displayName: string }[] =
    projects.status === "success"
      ? [...projects.data.active, ...projects.data.closed].map((project) => ({
          projectId: project.projectId as string,
          displayName: project.displayName,
        }))
      : [];
  const members = new Map<string, MemberView>(overview.members.map((member) => [member.userId, member]));

  /** Builds the operation input from the form state (filters omitted when off). */
  function inputOf(nextCursor: string | undefined): Record<string, unknown> {
    const projectBrand = parseTableId("projects", projectScope);
    const authorBrand = parseTableId("users", authorScope);
    const from = dayToMs(dayFrom);
    const to = dayToEndMs(dayTo);
    return {
      query: query.trim(),
      limit: RESULT_PAGE_SIZE,
      ...(projectBrand === null ? {} : { projectId: projectBrand }),
      ...(authorBrand === null ? {} : { authorUserId: authorBrand }),
      ...(from === null ? {} : { sentFromMs: from }),
      ...(to === null ? {} : { sentToMs: to }),
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    };
  }

  async function run(event: SubmitEvent, nextCursor?: string): Promise<void> {
    event.preventDefault();
    if (query.trim().length === 0) {
      return;
    }
    setSearching(true);
    setErrorNotice(null);
    try {
      const response = await queryEvidence({
        envelope: envelopeOf("search.queryEvidence", inputOf(nextCursor)),
      });
      if (response._tag === "error") {
        setErrorNotice(failureHint(response.error.code, response.error.message));
        return;
      }
      // Decode through the contract's own result schema at the boundary: a
      // drift in the wire shape fails here instead of rendering undefined.
      const decoded = Schema.decodeUnknownSync(queryResult)(response.value);
      setResult((current) => {
        if (nextCursor === undefined || current === null) {
          return decoded;
        }
        // Appending page: keep the coverage of the LATEST answer (it is the
        // live disclosure for what the user currently sees).
        return { ...decoded, entries: [...current.entries, ...decoded.entries] };
      });
      // E5's cursor is the last served entry's id (the next page starts
      // strictly after it); isDone true means nothing follows.
      const lastId = decoded.entries.at(-1)?.searchEntryId;
      setCursor(decoded.isDone || lastId === undefined ? null : lastId);
    } catch {
      setErrorNotice(signInCopy.failures.network);
    } finally {
      setSearching(false);
    }
  }

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement(
      "form",
      { onSubmit: (event) => void run(event) },
      createElement("label", { htmlFor: "search-query" }, copy.queryLabel),
      createElement("input", {
        id: "search-query",
        type: "search",
        placeholder: copy.queryPlaceholder,
        value: query,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
        required: true,
      }),
      createElement("fieldset", null,
        createElement("legend", null, copy.filtersLegend),
        createElement("label", { htmlFor: "search-project" }, copy.projectFilterLabel),
        createElement(
          "select",
          {
            id: "search-project",
            value: projectScope,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => setProjectScope(event.target.value),
          },
          createElement("option", { value: "any" }, copy.projectFilterAny),
          ...projectViews.map((project) =>
            createElement("option", { key: project.projectId, value: project.projectId }, project.displayName),
          ),
        ),
        createElement("label", { htmlFor: "search-author" }, copy.authorFilterLabel),
        createElement(
          "select",
          {
            id: "search-author",
            value: authorScope,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => setAuthorScope(event.target.value),
          },
          createElement("option", { value: "any" }, copy.authorFilterAny),
          ...overview.members.map((member) =>
            createElement("option", { key: member.userId, value: member.userId },
              `${member.displayName} (${member.email})`),
          ),
        ),
        createElement("label", { htmlFor: "search-date-from" }, copy.dateFromLabel),
        createElement("input", {
          id: "search-date-from",
          type: "date",
          value: dayFrom,
          onChange: (event: ChangeEvent<HTMLInputElement>) => setDayFrom(event.target.value),
        }),
        createElement("label", { htmlFor: "search-date-to" }, copy.dateToLabel),
        createElement("input", {
          id: "search-date-to",
          type: "date",
          value: dayTo,
          onChange: (event: ChangeEvent<HTMLInputElement>) => setDayTo(event.target.value),
        }),
        createElement("p", null, copy.dateHint),
      ),
      createElement(
        "button",
        { type: "submit", disabled: searching || query.trim().length === 0 },
        searching ? copy.searching : copy.submitButton,
      ),
    ),
    errorNotice === null ? null : createElement("p", { role: "alert" }, errorNotice),
    result === null
      ? null
      : createElement(SearchResults, {
          result,
          members,
          more: cursor === null ? null : (event: SubmitEvent) => void run(event, cursor),
        }),
  );
}

// ---------------------------------------------------------------------------
// Results: coverage disclosure + hydrated rows + paging
// ---------------------------------------------------------------------------

function SearchResults({
  result,
  members,
  more,
}: {
  readonly result: QueryResult;
  readonly members: ReadonlyMap<string, MemberView>;
  readonly more: ((event: SubmitEvent) => void) | null;
}): ReactNode {
  return createElement(
    "section",
    { "aria-label": copy.resultsHeading },
    createElement("h2", null, copy.resultsHeading),
    createElement(
      "p",
      { role: isDegradedCoverage(result.coverage as CoverageLiteral) ? "alert" : "status", "data-testid": "search-coverage" },
      `${copy.coverageLabel}: ${coverageLine(result.coverage as CoverageLiteral)}`,
    ),
    result.entries.length === 0
      ? createElement("p", null, copy.noResults)
      : createElement(
          "ul",
          null,
          ...result.entries.map((entry) =>
            createElement(
              "li",
              { key: entry.searchEntryId },
              createElement(ResultEntryRow, { entry, members }),
            ),
          ),
        ),
    more === null
      ? null
      : createElement("p", null, createElement("button", { type: "button", onClick: (event) => more(event) }, copy.moreButton)),
  );
}

function ResultEntryRow({
  entry,
  members,
}: {
  readonly entry: ResultEntry;
  readonly members: ReadonlyMap<string, MemberView>;
}): ReactNode {
  return createElement(
    "article",
    { "data-testid": `search-entry-${entry.searchEntryId}` },
    createElement(
      "p",
      null,
      createElement("strong", null, copy.kindLabels[entry.kind]),
      ` — ${copy.matchedViaLabels[entry.matchedVia]} (${copy.scoreLabel}: ${entry.score.toFixed(3)})`,
    ),
    entry.kind === "source_fragment"
      ? createElement(SourceHit, { entry, members })
      : createElement(FindingHit, { entry }),
  );
}

/**
 * One source-backed hit, hydrated against the canonical D1 row BEFORE any
 * snippet renders: the UI shows what the source record says, never what a
 * stale index row claims.
 */
function SourceHit({
  entry,
  members,
}: {
  readonly entry: ResultEntry;
  readonly members: ReadonlyMap<string, MemberView>;
}): ReactNode {
  const sourceId = entry.sourceId ?? null;
  const detail = useQueryState({
    query: api.sources.read.views.sourceDetail,
    args: sourceId === null ? "skip" : { sourceId: asConvexId("sources", sourceId) },
  });
  if (sourceId === null) {
    return createElement("p", { role: "alert" }, copy.sourceHydrationUnavailable);
  }
  if (detail.status === "error") {
    return createElement(SessionEnded);
  }
  if (detail.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  if (detail.data._tag === "error") {
    // The canonical row refuses what the index claimed: hydration won.
    return createElement("p", { role: "alert" }, copy.sourceHydrationUnavailable);
  }
  const row: SourceConversationRowType = Schema.decodeUnknownSync(SourceConversationRow)(
    detail.data.value,
  );
  const author = members.get(row.authorUserId);
  const authorLabel = author === undefined ? "?" : `${author.displayName} (${author.email})`;
  const excerpt = row.authorText.length > 160 ? `${row.authorText.slice(0, 160)}…` : row.authorText;
  return createElement(
    "div",
    null,
    createElement("p", null, `„${excerpt}”`),
    createElement("p", null, `${authorLabel} — ${instantLabel(row.sentAtMs)}`),
    createElement(
      "p",
      null,
      createElement(
        "a",
        {
          // R5: the one canonical serializer builds the hit's link, with
          // the matched fragment's anchor when the entry pins one.
          href: serializeSourceReference({
            sourceId,
            fragmentId: entry.sourceFragmentId ?? null,
            projectId: null,
          }),
        },
        copy.sourceLinkLabel,
      ),
    ),
  );
}

/** One finding hit: expandable to C2's revision history read (current first). */
function FindingHit({ entry }: { readonly entry: ResultEntry }): ReactNode {
  const findingId = entry.findingId ?? null;
  const [expanded, setExpanded] = useState(false);
  return createElement(
    "div",
    null,
    createElement(
      "p",
      null,
      createElement("button", { type: "button", onClick: () => setExpanded(!expanded) },
        expanded ? copy.cancel : copy.findingDetailsButton),
    ),
    expanded && findingId !== null
      ? createElement(FindingDetails, { findingId })
      : null,
  );
}

function FindingDetails({ findingId }: { readonly findingId: string }): ReactNode {
  const history = useQueryState({
    query: api.memory.findings.functions.readFindingHistory,
    args: { findingId: asConvexId("findings", findingId) },
  });
  if (history.status === "error") {
    return createElement(SessionEnded);
  }
  if (history.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  const row = history.data;
  const current = row.revisions.find((revision) => revision.revisionId === row.currentRevisionId)
    ?? row.revisions.at(-1);
  return createElement(
    "div",
    null,
    createElement("p", null, `${copy.findingSemanticKeyLabel}: ${row.semanticKey}`),
    current === undefined
      ? null
      : createElement("p", null, `${copy.findingValueLabel}: ${findingValueLabel(current.value)} — ${knowledgeStateLabel(current.knowledgeState)}`),
    current !== undefined && current.evidence.length > 0
      ? createElement(
          "ul",
          null,
          ...current.evidence.map((witness) =>
            createElement(
              "li",
              { key: `${current.revisionId}:${witness.sourceId}:${witness.fragmentId ?? "whole"}` },
              `${copy.evidenceSourceLabel} `,
              createElement(
                "a",
                {
                  // R5: the one canonical serializer builds the evidence
                  // link (with the fragment's anchor).
                  href: serializeSourceReference({
                    sourceId: witness.sourceId,
                    fragmentId: witness.fragmentId,
                    projectId: null,
                  }),
                },
                copy.sourceLinkLabel,
              ),
            ),
          ),
        )
      : null,
    createElement("p", null, createElement("a", { href: "/pamiec" }, copy.findingHistoryNote)),
  );
}
