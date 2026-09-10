/**
 * The memory feature (H1): "Pamięć projektu" and firm memory readable by a
 * boss without re-reading the conversation (CONTEXT.md).
 *
 * JSX-free on purpose (createElement only), like the conversation surface:
 * the host feature registry chain stays importable by the node programs.
 *
 * - current findings: `memory.readCurrentFindings` (C2) with the honest
 *   knowledge states — `conflicted` and `updating` (C5) are visibly NOT
 *   settled facts and say so in their labels;
 * - revisions and provenance: `memory.readFindingHistory` (the H1-flagged
 *   read) — every immutable revision with its origin (publication from a
 *   message, explicit correction, withdrawal marking), author, time,
 *   reason, what it supersedes, and its evidence witnesses linking back to
 *   the canonical source URL `/?zrodlo=<id>`;
 * - the correction flow: correction-as-new-source lives in the conversation
 *   feature (a new message referencing the old one); a DIRECT structured
 *   correction uses C2's audited command `memory.correctFinding` with the
 *   revision the boss actually saw as `expectedRevision` — a concurrent
 *   revision conflict refuses honestly instead of overwriting;
 * - clarifications ("Sprawa do wyjaśnienia"): `memory.readClarifications`
 *   (the H1-flagged read) shows E3's sourced questions with the
 *   conflicting evidence; answering runs `memory.resolveClarification`,
 *   which keeps the resolving author and note in history.
 *
 * All routes enforce B3 access through the backend operations themselves;
 * this surface never reads around them.
 */

import {
  createElement,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { parseTableId } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type { MemberView } from "../../../../../convex/access/membership/functions";
import type { CurrentFindingWireRow } from "../../../../../convex/memory/findings/read";
import type {
  ClarificationWireRow,
  FindingHistoryWireRow,
} from "../../../../../convex/memory/findings/exposition";
import type { ReadCurrentFindingsInput } from "../../../../../convex/memory/findings/semantics";
import { instantLabel } from "../conversation/state";
import {
  CompanyFeatureGate,
  SessionEnded,
  envelopeOf,
  type MemberOverview,
  type Notice,
  type SubmitEvent,
} from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import { PROJECT_PARAM, SOURCE_PARAM, searchParam, writeScopeParam } from "../company/route-params";
import {
  failureHint,
  findingValueLabel,
  isSettledKnowledgeState,
  knowledgeStateLabel,
  memoryCopy as copy,
  signInCopy,
} from "./state";

// ---------------------------------------------------------------------------
// Root: the shared company-feature gate around this surface
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at "/pamiec" (memory.project). */
export function MemoryFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    member: (overview: MemberOverview) => createElement(MemoryMain, { overview }),
  });
}

function MemoryMain({
  overview,
}: {
  readonly overview: MemberOverview;
}): ReactNode {
  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  const [memoryScope, setMemoryScope] = useState<string>(() => searchParam(PROJECT_PARAM) ?? "company");

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

  // The scope the read decodes server-side through the operation's
  // contract; parseTableId brands the selected id without a cast (a null
  // brand would mean corrupted UI state — falling back to the company scope
  // keeps the read well-formed even then).
  const scopeProjectId = parseTableId("projects", memoryScope);
  const memoryArgs: ReadCurrentFindingsInput =
    memoryScope === "company" || scopeProjectId === null
      ? { scope: { _tag: "company" } }
      : { scope: { _tag: "project", projectId: scopeProjectId } };

  const members = new Map(overview.members.map((member) => [member.userId, member]));
  const selfLabel = overview.members.find((member) => member.isSelf)?.email ?? overview.company.name;

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement("p", null, `${overview.company.name} — zalogowano jako ${selfLabel}.`),
    createElement("label", { htmlFor: "memory-scope" }, copy.scopeLabel),
    createElement(
      "select",
      {
        id: "memory-scope",
        value: memoryScope,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          // Keep the URL in step with the select (the conversation route's
          // selectScope discipline): a stale ?projekt= must not re-scope
          // the view on refresh.
          const next = event.target.value;
          writeScopeParam(next === "company" ? null : next);
          setMemoryScope(next);
        },
      },
      createElement("option", { value: "company" }, copy.scopeCompany),
      ...projectViews.map((project) =>
        createElement("option", { key: project.projectId, value: project.projectId }, project.displayName),
      ),
    ),
    createElement(FindingsSection, { memoryArgs, members }),
    createElement(ClarificationsSection, { memoryArgs, members }),
  );
}

// ---------------------------------------------------------------------------
// Current findings with per-finding history, provenance and direct correction
// ---------------------------------------------------------------------------

function FindingsSection({
  memoryArgs,
  members,
}: {
  readonly memoryArgs: ReadCurrentFindingsInput;
  readonly members: ReadonlyMap<string, MemberView>;
}): ReactNode {
  const findings = useQueryState({
    query: api.memory.findings.functions.readCurrentFindings,
    args: memoryArgs,
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  if (findings.status === "error") {
    return createElement(SessionEnded);
  }
  if (findings.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  if (findings.data.length === 0) {
    return createElement("p", null, copy.noFindings);
  }
  return createElement(
    "section",
    null,
    createElement("ul", null, ...findings.data.map((row) =>
      createElement(
        "li",
        { key: row.findingId },
        createElement(FindingRow, {
          row,
          members,
          expanded: expanded === row.findingId,
          toggle: () => setExpanded(expanded === row.findingId ? null : row.findingId),
        }),
      ),
    )),
  );
}

function FindingRow({
  row,
  members,
  expanded,
  toggle,
}: {
  readonly row: CurrentFindingWireRow;
  readonly members: ReadonlyMap<string, MemberView>;
  readonly expanded: boolean;
  readonly toggle: () => void;
}): ReactNode {
  const settled = isSettledKnowledgeState(row.knowledgeState);
  return createElement(
    "article",
    null,
    createElement("p", null, createElement("strong", null, row.semanticKey)),
    createElement("p", null, `${copy.findingValueLabel}: ${findingValueLabel(row.value)}`),
    // The honest state line: conflicted/updating rows say they are NOT
    // settled facts; they can never be presented as ones.
    createElement(
      "p",
      { role: "status" },
      settled ? null : createElement("strong", null, "[nie jest ustaloną wartością] "),
      knowledgeStateLabel(row.knowledgeState),
    ),
    createElement(
      "p",
      null,
      createElement("button", { type: "button", onClick: toggle },
        expanded ? copy.hideHistoryButton : copy.historyButton),
    ),
    expanded
      ? createElement(FindingHistoryPanel, { findingId: row.findingId, members })
      : null,
  );
}

function FindingHistoryPanel({
  findingId,
  members,
}: {
  readonly findingId: string;
  readonly members: ReadonlyMap<string, MemberView>;
}): ReactNode {
  const history = useQueryState({
    query: api.memory.findings.functions.readFindingHistory,
    args: {
      // The id comes from the current-findings read of the same table;
      // asConvexId converts between the two brandings of one value.
      findingId: asConvexId("findings", findingId),
    },
  });
  const [correcting, setCorrecting] = useState(false);

  if (history.status === "error") {
    return createElement(SessionEnded);
  }
  if (history.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  const row: FindingHistoryWireRow = history.data;
  return createElement(
    "section",
    null,
    createElement("h3", null, copy.historyHeading),
    createElement(
      "ol",
      null,
      ...row.revisions.map((revision) => {
        const actor = members.get(revision.recordedByUserId);
        const actorLabel = actor === undefined ? revision.recordedByUserId : `${actor.displayName} (${actor.email})`;
        const isCurrent = revision.revisionId === row.currentRevisionId;
        return createElement(
          "li",
          { key: revision.revisionId },
          createElement(
            "p",
            null,
            `#${revision.revision} — ${copy.originLabels[revision.origin]}`,
            isCurrent ? ` [${copy.currentRevisionBadge}]` : "",
          ),
          createElement("p", null, `${copy.findingValueLabel}: ${findingValueLabel(revision.value)}`),
          createElement("p", null, knowledgeStateLabel(revision.knowledgeState)),
          createElement(
            "p",
            null,
            `${copy.revisionAuthorLabel}: ${actorLabel} (${instantLabel(revision.recordedAtMs)})`,
          ),
          revision.reason === null
            ? null
            : createElement("p", null, `${copy.revisionReasonLabel}: ${revision.reason}`),
          revision.supersedesRevisionId === null
            ? null
            : createElement(
                "p",
                null,
                `${copy.revisionSupersedesLabel} #${revisionSupersedesNumber(row, revision.supersedesRevisionId)}`,
              ),
          revision.evidence.length === 0
            ? createElement("p", null, copy.noEvidence)
            : createElement(
                "p",
                null,
                copy.evidenceHeading,
                createElement(
                  "ul",
                  null,
                  ...revision.evidence.map((witness) =>
                    createElement(
                      "li",
                      { key: `${revision.revisionId}:${witness.sourceId}:${witness.fragmentId ?? "whole"}` },
                      `${copy.evidenceLabels[witness.supportKind]} — `,
                      createElement(
                        "a",
                        {
                          href: `/?${SOURCE_PARAM}=${encodeURIComponent(witness.sourceId)}`,
                        },
                        copy.sourceLinkLabel,
                      ),
                      witness.fragmentId === null ? ` (${copy.evidenceWholeSource})` : ` (fragment ${witness.fragmentId})`,
                    ),
                  ),
                ),
              ),
        );
      }),
    ),
    correcting
      ? createElement(DirectCorrectionForm, {
          findingId: row.findingId,
          expectedRevision: row.revisionCounter,
          cancel: () => setCorrecting(false),
        })
      : createElement(
          "p",
          null,
          createElement("button", { type: "button", onClick: () => setCorrecting(true) }, copy.correctButton),
        ),
  );
}

/** The revision number one supersedes (for the human-readable chain). */
function revisionSupersedesNumber(
  row: FindingHistoryWireRow,
  supersedesRevisionId: string,
): string {
  const superseded = row.revisions.find((revision) => revision.revisionId === supersedesRevisionId);
  return superseded === undefined ? "?" : String(superseded.revision);
}

// ---------------------------------------------------------------------------
// Direct structured correction (C2's audited command)
// ---------------------------------------------------------------------------

function DirectCorrectionForm({
  findingId,
  expectedRevision,
  cancel,
}: {
  readonly findingId: string;
  readonly expectedRevision: number;
  readonly cancel: () => void;
}): ReactNode {
  const correctFinding = useMutation(api.memory.findings.functions.dispatchMemoryCommandEntry);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const trimmedValue = value.trim();
    const trimmedReason = reason.trim();
    if (saving || trimmedValue.length === 0 || trimmedReason.length === 0) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await correctFinding({
        envelope: envelopeOf("memory.correctFinding", {
          findingId,
          expectedRevision,
          // The barebones direct correction writes a simple text value; the
          // command validates it through the same contract as any other.
          value: { _tag: "text_note", text: trimmedValue },
          knowledgeState: { _tag: "known" },
          reason: trimmedReason,
        }),
      });
      if (result._tag === "error") {
        setNotice({
          kind: "error",
          text: failureHint(result.error.code, result.error.message),
        });
        return;
      }
      setNotice({ kind: "ok", text: copy.correctDone });
      setValue("");
      setReason("");
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setSaving(false);
    }
  }

  return createElement(
    "form",
    { onSubmit: (event) => void submit(event) },
    createElement("h4", null, copy.correctHeading),
    createElement("p", null, copy.correctIntro),
    createElement("label", { htmlFor: `correct-value-${findingId}` }, copy.correctValueLabel),
    createElement("input", {
      id: `correct-value-${findingId}`,
      type: "text",
      placeholder: copy.correctValuePlaceholder,
      value,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
      required: true,
    }),
    createElement("label", { htmlFor: `correct-reason-${findingId}` }, copy.correctReasonLabel),
    createElement("input", {
      id: `correct-reason-${findingId}`,
      type: "text",
      placeholder: copy.correctReasonPlaceholder,
      value: reason,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setReason(event.target.value),
      required: true,
    }),
    createElement(
      "button",
      { type: "submit", disabled: saving || value.trim().length === 0 || reason.trim().length === 0 },
      saving ? copy.correctSaving : copy.correctSubmit,
    ),
    " ",
    createElement("button", { type: "button", onClick: cancel }, copy.cancel),
    notice === null
      ? null
      : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
  );
}

// ---------------------------------------------------------------------------
// Clarifications: E3's sourced questions, answered by a boss
// ---------------------------------------------------------------------------

function ClarificationsSection({
  memoryArgs,
  members,
}: {
  readonly memoryArgs: ReadCurrentFindingsInput;
  readonly members: ReadonlyMap<string, MemberView>;
}): ReactNode {
  const clarifications = useQueryState({
    query: api.memory.findings.functions.readClarifications,
    args: memoryArgs,
  });

  if (clarifications.status === "error") {
    return createElement(SessionEnded);
  }
  if (clarifications.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  const rows: readonly ClarificationWireRow[] = clarifications.data;
  const open = rows.filter((row) => row.state === "open");
  const resolved = rows.filter((row) => row.state === "resolved");
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.clarificationsHeading),
    createElement("p", null, copy.clarificationsIntro),
    rows.length === 0
      ? createElement("p", null, copy.noClarifications)
      : createElement(
          "ul",
          null,
          ...[...open, ...resolved].map((row) =>
            createElement(
              "li",
              { key: row.clarificationId },
              createElement(ClarificationRow, { row, members }),
            ),
          ),
        ),
  );
}

function ClarificationRow({
  row,
  members,
}: {
  readonly row: ClarificationWireRow;
  readonly members: ReadonlyMap<string, MemberView>;
}): ReactNode {
  const resolveClarification = useMutation(api.memory.findings.functions.dispatchMemoryCommandEntry);
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const trimmed = answer.trim();
    if (saving || trimmed.length === 0) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await resolveClarification({
        envelope: envelopeOf("memory.resolveClarification", {
          clarificationId: row.clarificationId,
          resolutionNote: trimmed,
        }),
      });
      if (result._tag === "error") {
        setNotice({
          kind: "error",
          text: failureHint(result.error.code, result.error.message),
        });
        return;
      }
      setAnswer("");
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setSaving(false);
    }
  }

  const resolver = row.resolvedByUserId === null ? null : members.get(row.resolvedByUserId);
  const resolverLabel =
    resolver === undefined || resolver === null
      ? copy.unknownResolverLabel
      : `${resolver.displayName} (${resolver.email})`;
  return createElement(
    "article",
    null,
    createElement(
      "p",
      null,
      createElement("strong", null, row.question),
      ` [${row.state === "open" ? copy.clarificationOpen : copy.clarificationResolved}]`,
    ),
    createElement("p", null, `${copy.clarificationRaisedAt}: ${instantLabel(row.raisedAtMs)}`),
    row.conflictingEvidence.length === 0
      ? null
      : createElement(
          "p",
          null,
          copy.clarificationConflicting,
          createElement(
            "ul",
            null,
            ...row.conflictingEvidence.map((witness) =>
              createElement(
                "li",
                { key: witness.fragmentId },
                createElement(
                  "a",
                  { href: `/?${SOURCE_PARAM}=${encodeURIComponent(witness.sourceId)}` },
                  copy.sourceLinkLabel,
                ),
                ` (fragment ${witness.fragmentId})`,
              ),
            ),
          ),
        ),
    row.state === "open"
      ? createElement(
          "form",
          { onSubmit: (event) => void submit(event) },
          createElement("label", { htmlFor: `answer-${row.clarificationId}` }, copy.clarificationAnswerLabel),
          createElement("textarea", {
            id: `answer-${row.clarificationId}`,
            rows: 2,
            placeholder: copy.clarificationAnswerPlaceholder,
            value: answer,
            onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setAnswer(event.target.value),
            required: true,
          }),
          createElement(
            "button",
            { type: "submit", disabled: saving || answer.trim().length === 0 },
            saving ? copy.clarificationAnswering : copy.clarificationSubmit,
          ),
          notice === null
            ? null
            : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
        )
      : createElement(
          "p",
          null,
          `${copy.clarificationResolvedBy}: ${resolverLabel}${
            row.resolvedAtMs === null ? "" : ` (${instantLabel(row.resolvedAtMs)})`
          }${row.resolutionNote === null ? "" : ` — ${row.resolutionNote}`}`,
        ),
  );
}
