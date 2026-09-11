/**
 * The source-detail feature (H3): "Źródło" — the full history surface of
 * ONE immutable "Wiadomość źródłowa".
 *
 * JSX-free on purpose (createElement only), like the conversation and
 * memory surfaces: the host feature registry chain stays importable by the
 * node test programs.
 *
 * - the dossier: `sources.read.views.sourceExposition` (the H3-flagged
 *   read) — immutable authored content, lifecycle WITH the withdrawal
 *   record (actor, time, reason), processing state, project links, every
 *   attachment with all retained/received representations, transcript
 *   segments with original-time anchors, OCR observations with pixel
 *   anchors, and every fragment anchor;
 * - the evidence chain: `sources.read.views.sourceEvidence` (the
 *   H3-flagged paginated read) — every witness link joined to the finding's
 *   CURRENT projection, so corrections and C5's recomputation markings are
 *   visible per finding ("Pokaż więcej" pages it; never one growing read);
 * - the withdrawal control: C5's audited `sources.withdrawSource` through
 *   the same sources dispatch the send path uses — with the explicit
 *   disclosure that withdrawal is NOT permanent deletion (CONTEXT.md
 *   "Źródło wycofane" keeps content and history);
 * - the reassignment control (E7's mount, issue #115): the certified
 *   `sources.reassignSource` over the same dispatch: the boss moves the
 *   message between projects or to company-general knowledge by declaring
 *   the complete new set; the links table stays the single source of truth
 *   and dependent findings re-assess through C5's recomputation;
 * - media anchors: audio playback and image display load EXCLUSIVELY
 *   through D3's authorized channel (fresh authenticated request per
 *   load; image highlights render over the EXACT representation whose
 *   pixel space the anchor's coordinates are in);
 * - read state: opening the original marks it read for this person in
 *   every view (F1's idempotent command, like the conversation surface).
 *
 * All routes enforce B3 access through the backend operations themselves;
 * this surface never reads around them.
 */

import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useAuthToken } from "@convex-dev/auth/react";
import { Schema } from "effect";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import type { MemberView } from "../../../../../convex/access/membership/functions";
import {
  SourceExpositionRow,
  SourceEvidencePage,
  type FragmentAnchor,
  type SourceEvidenceRow,
  type SourceExpositionRow as ExpositionRow,
} from "../../../../../convex/sources/read/exposition";
import { useAppServices } from "../../app/providers";
import { instantLabel } from "../conversation/state";
import {
  findingValueLabel,
  isSettledKnowledgeState,
  knowledgeStateLabel,
} from "../memory/state";
import {
  CompanyFeatureGate,
  SessionEnded,
  envelopeOf,
  type MemberOverview,
  type Notice,
  type SubmitEvent,
} from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import { PROJECT_PARAM, SOURCE_PARAM, searchParam } from "../company/route-params";
import { ReassignControl } from "./reassign";
import {
  attachmentMediaUrl,
  loadAuthorizedMedia,
  mediaTimestamp,
  probeAuthorizedRange,
  regionBoxStyle,
  representationMediaUrl,
  type MediaFetch,
} from "./media";
import {
  anchorLabel,
  failureHint,
  lifecycleLabels,
  processingStateLabels,
  representationRoleLabels,
  sourceDetailCopy as copy,
  textRangeExcerpt,
  transcriptStateLabels,
  visionStateLabels,
} from "./state";

/** How many evidence rows one page requests (the history stays paginated). */
const EVIDENCE_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Root: the shared company-feature gate around this surface
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at "/zrodlo" (source.detail). */
export function SourceDetailFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    member: (overview: MemberOverview) => createElement(SourceDetailMain, { overview }),
  });
}

function SourceDetailMain({
  overview,
}: {
  readonly overview: MemberOverview;
}): ReactNode {
  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  // The canonical deep-link key (the same ?zrodlo= the conversation route
  // owns): this surface is its full-history expansion. The optional
  // &fragment=<id> a search hit carries marks the matched anchor.
  const [sourceId, setSourceId] = useState<string | null>(() => searchParam(SOURCE_PARAM));
  const [fragmentId, setFragmentId] = useState<string | null>(() => searchParam("fragment"));
  useEffect(() => {
    const onPop = () => {
      setSourceId(searchParam(SOURCE_PARAM));
      setFragmentId(searchParam("fragment"));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const projectNames = new Map<string, string>(
    projects.status === "success"
      ? [...projects.data.active, ...projects.data.closed].map((project) => [
          project.projectId as string,
          project.displayName,
        ])
      : [],
  );
  const members = new Map<string, MemberView>(overview.members.map((m) => [m.userId, m]));

  if (sourceId === null) {
    return createElement(
      "section",
      null,
      createElement("h1", null, copy.title),
      createElement("p", null, copy.noSourceHint),
      createElement("p", null, createElement("a", { href: "/" }, copy.noSourceLink)),
    );
  }
  // key: a source switch (deep link, back, an evidence link) remounts the
  // body so the accumulated evidence pages and cursor reset with the row.
  return createElement(SourceDetailBody, {
    key: sourceId,
    sourceId,
    highlightedFragmentId: fragmentId,
    projectNames,
    members,
    clear: () => setSourceId(null),
  });
}

// ---------------------------------------------------------------------------
// The body: dossier + evidence + withdrawal + media
// ---------------------------------------------------------------------------

function SourceDetailBody({
  sourceId,
  highlightedFragmentId,
  projectNames,
  members,
  clear,
}: {
  readonly sourceId: string;
  readonly highlightedFragmentId: string | null;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly members: ReadonlyMap<string, MemberView>;
  readonly clear: () => void;
}): ReactNode {
  const exposition = useQueryState({
    query: api.sources.read.views.sourceExposition,
    args: { sourceId: asConvexId("sources", sourceId) },
  });
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceRows, setEvidenceRows] = useState<readonly SourceEvidenceRow[]>([]);
  const evidence = useQueryState({
    query: api.sources.read.views.sourceEvidence,
    args: {
      sourceId: asConvexId("sources", sourceId),
      // The tracked cursor pages forward: each click fetches ONE page past
      // the last, never re-reading the whole prefix.
      paginationOpts: { numItems: EVIDENCE_PAGE_SIZE, cursor: evidenceCursor },
    },
  });
  const markRead = useMutation(api.attention.read_state.commands.markSourceReadCommand);

  // One read marking per view-open of the original (F1, idempotent server
  // side): seeing the original changes this person's state everywhere.
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
    }).catch(() => {
      console.warn(copy.markReadFailure);
    });
  }, [sourceId, markRead]);

  if (exposition.status === "error") {
    return createElement(SessionEnded);
  }
  if (exposition.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingSession);
  }
  if (exposition.data._tag === "error") {
    return createElement(
      "section",
      null,
      createElement("h1", null, copy.title),
      createElement(
        "p",
        { role: "alert" },
        failureHint(exposition.data.error.code, exposition.data.error.message),
      ),
      createElement("p", null, createElement("a", { href: "/" }, copy.noSourceLink)),
      createElement("p", null, createElement("button", { type: "button", onClick: clear }, copy.noSourceLink)),
    );
  }
  const row = Schema.decodeUnknownSync(SourceExpositionRow)(exposition.data.value);
  const evidencePage =
    evidence.status === "success" && evidence.data._tag === "ok"
      ? Schema.decodeUnknownSync(SourceEvidencePage)(evidence.data.value)
      : null;
  // Pages accumulate: each fetch is ONE page past the cursor (the tracked
  // continueCursor), so paging N pages costs N page reads, not the O(N^2)
  // re-read of the whole prefix a growing numItems caused.
  useEffect(() => {
    if (evidencePage === null) {
      return;
    }
    setEvidenceRows((previous) => {
      const seen = new Set(previous.map((r) => `${r.findingId}:${r.citedRevisionId}:${r.fragmentId ?? "whole"}`));
      const appended = evidencePage.page.filter(
        (r) => !seen.has(`${r.findingId}:${r.citedRevisionId}:${r.fragmentId ?? "whole"}`),
      );
      return appended.length === 0 ? previous : [...previous, ...appended];
    });
  }, [evidencePage]);

  const canonicalUrl =
    typeof window === "undefined" ? null : `${window.location.origin}/?${SOURCE_PARAM}=${sourceId}`;
  const author = members.get(row.authorUserId);
  const authorLabel = author === undefined ? copy.unknownAuthorLabel : `${author.displayName} (${author.email})`;
  const withdrawerId = row.withdrawnByUserId;
  const withdrawer = withdrawerId === null ? undefined : members.get(withdrawerId);
  const withdrawerLabel =
    withdrawerId === null
      ? null
      : withdrawer === undefined
        ? withdrawerId
        : `${withdrawer.displayName} (${withdrawer.email})`;

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement("p", { role: "status" }, copy.readStateNotice),
    createElement(
      "section",
      { "aria-label": copy.identityHeading },
      createElement("h2", null, copy.identityHeading),
      createElement("p", null, `${copy.authorLabel}: ${authorLabel}`),
      createElement("p", null, `${copy.sentAtLabel}: ${instantLabel(row.sentAtMs)} (${row.sentAtTimezone})`),
      createElement("p", null, `${copy.stateLabel}: ${processingStateLabels[row.processingState]}`),
      createElement("p", { role: "status" }, lifecycleLabels[row.lifecycle]),
      createElement(
        "p",
        null,
        `${copy.projectsLabel}: ${
          row.projectIds.length === 0
            ? copy.noProjects
            : row.projectIds
                .map((id) => projectNames.get(id) ?? id)
                .join(", ")
        }`,
      ),
      createElement("p", { "data-testid": "source-author-text" }, createElement("strong", null, row.authorText)),
      createElement("p", null, createElement("strong", null, copy.canonicalLinkLabel)),
      createElement("p", null, createElement("code", null, canonicalUrl ?? `/?${SOURCE_PARAM}=${sourceId}`)),
      createElement(
        "p",
        null,
        createElement(
          "a",
          {
            href: `/?${SOURCE_PARAM}=${encodeURIComponent(sourceId)}${
              row.projectIds[0] === undefined ? "" : `&${PROJECT_PARAM}=${encodeURIComponent(row.projectIds[0])}`
            }`,
          },
          copy.openInConversation,
        ),
      ),
    ),
    row.lifecycle === "withdrawn"
      ? createElement(WithdrawnRecord, {
          withdrawnBy: withdrawerLabel,
          withdrawnAtMs: row.withdrawnAtMs,
          reason: row.withdrawnReason,
        })
      : row.lifecycle === "active"
        ? createElement(ReassignControl, {
            sourceId,
            projectNames,
            currentProjectIds: row.projectIds,
          })
        : null,
    row.lifecycle === "active"
      ? createElement(WithdrawControl, { sourceId })
      : null,
    createElement(MediaSection, { row }),
    createElement(TranscriptsSection, { row }),
    createElement(OcrSection, { row }),
    createElement(FragmentsSection, { row, highlightedFragmentId }),
    createElement(EvidenceSection, {
      rows: evidenceRows,
      loading: evidence.status !== "success" && evidence.status !== "error",
      sessionEnded: evidence.status === "error",
      isDone: evidencePage?.isDone ?? true,
      loadMore: () => setEvidenceCursor(evidencePage?.continueCursor ?? null),
      row,
    }),
  );
}

// ---------------------------------------------------------------------------
// Withdrawal: the honest record and C5's audited control
// ---------------------------------------------------------------------------

function WithdrawnRecord({
  withdrawnBy,
  withdrawnAtMs,
  reason,
}: {
  readonly withdrawnBy: string | null;
  readonly withdrawnAtMs: number | null;
  readonly reason: string | null;
}): ReactNode {
  return createElement(
    "section",
    { "aria-label": copy.withdrawnHeading },
    createElement("h2", null, copy.withdrawnHeading),
    createElement("p", null, copy.withdrawnDisclosedNote),
    createElement("p", null, `${copy.withdrawnByLabel}: ${withdrawnBy ?? "?"}`),
    createElement("p", null, `${copy.withdrawnAtLabel}: ${withdrawnAtMs === null ? "?" : instantLabel(withdrawnAtMs)}`),
    createElement("p", null, `${copy.withdrawnReasonLabel}: ${reason ?? "?"}`),
    createElement("p", null, copy.withdrawnReassignmentNote),
  );
}

function WithdrawControl({ sourceId }: { readonly sourceId: string }): ReactNode {
  const withdraw = useMutation(api.sources.accept.commands.acceptSourceCommand);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const trimmed = reason.trim();
    if (saving || trimmed.length === 0) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await withdraw({
        envelope: envelopeOf("sources.withdrawSource", {
          sourceId,
          reason: trimmed,
        }),
      });
      if (result._tag === "error") {
        setNotice({
          kind: "error",
          text: failureHint(result.error.code, result.error.message),
        });
        return;
      }
      setNotice({ kind: "ok", text: copy.withdrawDone });
      setReason("");
      setOpen(false);
    } catch {
      setNotice({ kind: "error", text: copy.networkUnavailable });
    } finally {
      setSaving(false);
    }
  }

  return createElement(
    "section",
    { "aria-label": copy.withdrawHeading },
    createElement("h2", null, copy.withdrawHeading),
    createElement("p", null, copy.withdrawIntro),
    open
      ? createElement(
          "form",
          { onSubmit: (event) => void submit(event) },
          createElement("label", { htmlFor: "withdraw-reason" }, copy.withdrawReasonLabel),
          createElement("input", {
            id: "withdraw-reason",
            type: "text",
            placeholder: copy.withdrawReasonPlaceholder,
            value: reason,
            onChange: (event: ChangeEvent<HTMLInputElement>) => setReason(event.target.value),
            required: true,
          }),
          createElement(
            "button",
            { type: "submit", disabled: saving || reason.trim().length === 0 },
            saving ? copy.withdrawSaving : copy.withdrawSubmit,
          ),
          " ",
          createElement("button", { type: "button", onClick: () => setOpen(false) }, copy.cancel),
        )
      : createElement(
          "p",
          null,
          createElement("button", { type: "button", onClick: () => setOpen(true) }, copy.withdrawButton),
        ),
    notice === null
      ? null
      : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
  );
}

// ---------------------------------------------------------------------------
// Media: authorized loads only (audio playback, anchored image display)
// ---------------------------------------------------------------------------

function MediaSection({ row }: { readonly row: ExpositionRow }): ReactNode {
  const { config } = useAppServices();
  const token = useAuthToken();
  const audioAttachments = row.attachments.filter((attachment) => attachment.kind === "audio");
  const imageAttachments = row.attachments.filter((attachment) => attachment.kind === "image");
  if (row.attachments.length === 0) {
    return createElement("section", null, createElement("h2", null, copy.mediaHeading), createElement("p", null, copy.noAttachments));
  }
  if (config.gateway.state !== "configured") {
    return createElement(
      "section",
      null,
      createElement("h2", null, copy.mediaHeading),
      createElement("p", { role: "status" }, copy.gatewayUnconfigured),
    );
  }
  const gatewayUrl = config.gateway.gatewayUrl;
  return createElement(
    "section",
    { "aria-label": copy.mediaHeading },
    createElement("h2", null, copy.mediaHeading),
    ...audioAttachments.map((attachment) =>
      createElement(AudioAttachmentPlayer, {
        key: attachment.attachmentId,
        attachmentId: attachment.attachmentId,
        gatewayUrl,
        token,
        durationMs: attachment.representations.find((r) => r.durationMs !== null)?.durationMs ?? null,
        representations: attachment.representations,
        row,
      }),
    ),
    ...imageAttachments.map((attachment) =>
      createElement(ImageAttachmentView, {
        key: attachment.attachmentId,
        attachmentId: attachment.attachmentId,
        gatewayUrl,
        token,
        row,
      }),
    ),
  );
}

/** The fetch binding the loaders run with (the browser global). */
const browserFetch: MediaFetch = (input, init) => fetch(input, init);

function AudioAttachmentPlayer({
  attachmentId,
  gatewayUrl,
  token,
  durationMs,
  representations,
  row,
}: {
  readonly attachmentId: string;
  readonly gatewayUrl: string;
  readonly token: string | null;
  readonly durationMs: number | null;
  readonly representations: ExpositionRow["attachments"][number]["representations"];
  readonly row: ExpositionRow;
}): ReactNode {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "denied" | "unavailable">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [seekTarget, setSeekTarget] = useState<number | null>(null);

  // A later seek target (from a fragment/segment anchor) drives the element
  // once the authorized bytes are attached.
  useEffect(() => {
    if (seekTarget === null || audioRef.current === null || objectUrl === null) {
      return;
    }
    audioRef.current.currentTime = seekTarget / 1000;
    void audioRef.current.play().catch(() => undefined);
    setSeekTarget(null);
  }, [seekTarget, objectUrl]);

  // The bytes leave with the view: revoke on unmount and on replacement.
  useEffect(() => {
    return () => {
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [objectUrl]);

  async function load(): Promise<void> {
    if (state === "loading") {
      return;
    }
    setState("loading");
    const outcome = await loadAuthorizedMedia(
      browserFetch,
      attachmentMediaUrl(gatewayUrl, attachmentId),
      token,
    );
    if (outcome.state === "loaded") {
      setObjectUrl((current) => {
        if (current !== null) {
          URL.revokeObjectURL(current);
        }
        return outcome.objectUrl;
      });
      setState("idle");
      return;
    }
    setState(outcome.state);
  }

  async function probeRange(): Promise<void> {
    const outcome = await probeAuthorizedRange(
      browserFetch,
      attachmentMediaUrl(gatewayUrl, attachmentId),
      token,
      "bytes=0-1",
    );
    if (outcome.state === "satisfied") {
      setState("idle");
      setRangeNotice(copy.rangeProbeSatisfied(outcome.contentRange ?? "bytes 0-1/*"));
      return;
    }
    setState(outcome.state);
    setRangeNotice(null);
  }

  const [rangeNotice, setRangeNotice] = useState<string | null>(null);

  return createElement(
    "article",
    { "data-testid": `audio-${attachmentId}` },
    createElement("h3", null, `Nagranie (${attachmentId})`),
    createElement(
      "p",
      null,
      createElement("button", { type: "button", onClick: () => void load() },
        state === "loading" ? copy.loadingMedia : copy.loadAudioButton),
      " ",
      createElement("button", { type: "button", onClick: () => void probeRange() }, copy.rangeProbeButton),
    ),
    rangeNotice === null ? null : createElement("p", { role: "status" }, rangeNotice),
    state === "denied" ? createElement("p", { role: "alert" }, copy.mediaDenied) : null,
    state === "unavailable" ? createElement("p", { role: "alert" }, copy.mediaUnavailable) : null,
    durationMs === null
      ? null
      : createElement("p", null, `Długość nagrania: ${mediaTimestamp(durationMs)}`),
    objectUrl === null
      ? null
      : createElement("audio", {
          ref: audioRef,
          controls: true,
          preload: "metadata",
          src: objectUrl,
          "data-testid": `audio-element-${attachmentId}`,
        }),
    createElement(RepresentationList, { representations }),
    createElement(SegmentSeekList, {
      row,
      enabled: objectUrl !== null,
      seek: (ms) => setSeekTarget(ms),
    }),
  );
}

/** The transcript segments with their original-time anchors (seekable). */
function SegmentSeekList({
  row,
  enabled,
  seek,
}: {
  readonly row: ExpositionRow;
  readonly enabled: boolean;
  readonly seek: (ms: number) => void;
}): ReactNode {
  if (row.transcripts.length === 0) {
    return null;
  }
  return createElement(
    "details",
    null,
    createElement("summary", null, copy.segmentsLabel),
    ...row.transcripts.map((transcript) =>
      createElement(
        "div",
        { key: transcript.transcriptId },
        createElement(
          "p",
          null,
          `${transcriptStateLabels[transcript.state]} — ${transcript.segments.length}/${transcript.segmentCount}`,
        ),
        createElement(
          "ol",
          null,
          ...transcript.segments.map((segment) =>
            createElement(
              "li",
              { key: `${transcript.transcriptId}:${segment.segmentIndex}` },
              createElement(
                "p",
                null,
                `[${mediaTimestamp(segment.startMs)}–${mediaTimestamp(segment.endMs)}] `,
                segment.text ?? (segment.state === "succeeded" ? "" : copy.segmentPending),
                segment.state === "failed" ? ` (${copy.segmentFailed})` : "",
                " ",
                enabled && segment.text !== null
                  ? createElement(
                      "button",
                      {
                        type: "button",
                        onClick: () => seek(segment.startMs),
                        "data-testid": `seek-${transcript.transcriptId}-${segment.segmentIndex}`,
                      },
                      copy.seekSegmentButton,
                    )
                  : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function ImageAttachmentView({
  attachmentId,
  gatewayUrl,
  token,
  row,
}: {
  readonly attachmentId: string;
  readonly gatewayUrl: string;
  readonly token: string | null;
  readonly row: ExpositionRow;
}): ReactNode {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "denied" | "unavailable">("idle");
  // The EXACT retained representation the OCR anchors are coordinates in
  // (D3's exact-version read); fall back to the attachment read when no
  // completed order pins one.
  // Per-attachment correlation: an order reads ONE attachment; without the
  // filter, every image view would load the first order's representation
  // and draw its OCR boxes over whichever image is displayed.
  const anchoredOrder =
    row.visionOrders.find(
      (order) => order.state === "complete" && order.attachmentId === attachmentId,
    ) ?? null;
  const representationId =
    anchoredOrder?.representationId ??
    row.attachments
      .find((attachment) => attachment.attachmentId === attachmentId)
      ?.representations.find((r) => r.role === "retained" && r.verifiedAtMs !== null)
      ?.representationId ??
    null;

  useEffect(() => {
    return () => {
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [objectUrl]);

  async function load(): Promise<void> {
    if (state === "loading" || representationId === null) {
      return;
    }
    setState("loading");
    const outcome = await loadAuthorizedMedia(
      browserFetch,
      representationMediaUrl(gatewayUrl, representationId),
      token,
    );
    if (outcome.state === "loaded") {
      setObjectUrl((current) => {
        if (current !== null) {
          URL.revokeObjectURL(current);
        }
        return outcome.objectUrl;
      });
      setState("idle");
      return;
    }
    setState(outcome.state);
  }

  const attachment = row.attachments.find((a) => a.attachmentId === attachmentId);
  return createElement(
    "article",
    { "data-testid": `image-${attachmentId}` },
    createElement("h3", null, `Zdjęcie (${attachmentId})`),
    createElement(
      "p",
      null,
      createElement("button", { type: "button", onClick: () => void load(), disabled: representationId === null },
        state === "loading" ? copy.loadingMedia : copy.showImageButton),
    ),
    state === "denied" ? createElement("p", { role: "alert" }, copy.mediaDenied) : null,
    state === "unavailable" ? createElement("p", { role: "alert" }, copy.mediaUnavailable) : null,
    attachment === undefined ? null : createElement(RepresentationList, { representations: attachment.representations }),
    objectUrl === null || anchoredOrder === null
      ? null
      : createElement(
          "div",
          {
            style: { position: "relative", display: "inline-block" },
            "data-testid": `image-canvas-${attachmentId}`,
          },
          createElement("img", {
            src: objectUrl,
            alt: "Zdjęcie źródłowe",
            style: { maxWidth: "100%", display: "block" },
          }),
          ...anchoredOrder.observations.map((observation, index) => {
            const box = regionBoxStyle(observation.region, {
              width: anchoredOrder.spaceWidth,
              height: anchoredOrder.spaceHeight,
            });
            return box === null
              ? null
              : createElement("div", {
                  key: index,
                  title: observation.text,
                  "data-testid": `image-highlight-${index}`,
                  "aria-label": `${copy.ocrHighlightLabel}: ${observation.text}`,
                  style: {
                    position: "absolute",
                    left: box.left,
                    top: box.top,
                    width: box.width,
                    height: box.height,
                    outline: "2px solid #d33",
                  },
                });
          }),
        ),
  );
}

function RepresentationList({
  representations,
}: {
  readonly representations: ExpositionRow["attachments"][number]["representations"];
}): ReactNode {
  if (representations.length === 0) {
    return null;
  }
  return createElement(
    "details",
    null,
    createElement("summary", null, copy.representationsLabel),
    createElement(
      "ul",
      null,
      ...representations.map((representation) =>
        createElement(
          "li",
          { key: representation.representationId },
          `${representationRoleLabels[representation.role]} (${representation.representationId}) — `,
          representation.verifiedAtMs === null
            ? copy.representationUnverified
            : copy.representationVerified,
          representation.removedAtMs !== null ? `; ${copy.representationRemoved}` : "",
          representation.exceptionKind !== null
            ? `; ${copy.representationException(representation.exceptionKind)}`
            : "",
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Transcripts and OCR: the retained representations' readable content
// ---------------------------------------------------------------------------

function TranscriptsSection({ row }: { readonly row: ExpositionRow }): ReactNode {
  return createElement(
    "section",
    { "aria-label": copy.transcriptsHeading },
    createElement("h2", null, copy.transcriptsHeading),
    row.transcripts.length === 0
      ? createElement("p", null, copy.noTranscripts)
      : createElement(
          "ul",
          null,
          ...row.transcripts.map((transcript) =>
            createElement(
              "li",
              { key: transcript.transcriptId },
              createElement("p", null, `${transcriptStateLabels[transcript.state]} (${transcript.pipelineVersion})`),
              createElement(
                "ol",
                null,
                ...transcript.segments.map((segment) =>
                  createElement(
                    "li",
                    { key: `${transcript.transcriptId}:${segment.segmentIndex}` },
                    `[${mediaTimestamp(segment.startMs)}–${mediaTimestamp(segment.endMs)}] ${
                      segment.text ?? (segment.state === "failed" ? copy.segmentFailed : copy.segmentPending)
                    }`,
                  ),
                ),
              ),
            ),
          ),
        ),
  );
}

function OcrSection({ row }: { readonly row: ExpositionRow }): ReactNode {
  return createElement(
    "section",
    { "aria-label": copy.ocrHeading },
    createElement("h2", null, copy.ocrHeading),
    row.visionOrders.length === 0
      ? createElement("p", null, copy.noOcr)
      : createElement(
          "ul",
          null,
          ...row.visionOrders.map((order) =>
            createElement(
              "li",
              { key: order.orderId },
              createElement("p", null, `${visionStateLabels[order.state]} (${order.pipelineVersion})`),
              order.spaceWidth === null || order.spaceHeight === null
                ? null
                : createElement(
                    "p",
                    null,
                    `${copy.ocrSpaceLabel}: ${Math.round(order.spaceWidth)}×${Math.round(order.spaceHeight)} px`,
                  ),
              createElement(
                "ul",
                null,
                ...order.observations.map((observation, index) =>
                  createElement(
                    "li",
                    { key: index, "data-testid": `ocr-observation-${index}` },
                    `„${observation.text}” — obszar (${Math.round(observation.region.x)}, ${Math.round(
                      observation.region.y,
                    )}, ${Math.round(observation.region.width)}×${Math.round(observation.region.height)} px)`,
                  ),
                ),
              ),
            ),
          ),
        ),
  );
}

function FragmentsSection({
  row,
  highlightedFragmentId,
}: {
  readonly row: ExpositionRow;
  readonly highlightedFragmentId: string | null;
}): ReactNode {
  return createElement(
    "section",
    { "aria-label": copy.fragmentsHeading },
    createElement("h2", null, copy.fragmentsHeading),
    row.fragments.length === 0
      ? createElement("p", null, copy.noFragments)
      : createElement(
          "ul",
          null,
          ...row.fragments.map((fragment) =>
            createElement(
              "li",
              {
                key: fragment.fragmentId,
                "data-testid": `fragment-${fragment.fragmentId}`,
                "data-highlighted":
                  highlightedFragmentId === fragment.fragmentId ? "true" : undefined,
              },
              highlightedFragmentId === fragment.fragmentId ? `[${copy.matchedFragmentBadge}] ` : "",
              `${anchorLabel(fragment.anchor)} — ${textRangeExcerpt(row.authorText, fragment.anchor) ?? ""}`,
            ),
          ),
        ),
  );
}

// ---------------------------------------------------------------------------
// The evidence chain: paginated witness links with current recomputation
// ---------------------------------------------------------------------------

function EvidenceSection({
  rows,
  loading,
  sessionEnded,
  isDone,
  loadMore,
  row,
}: {
  readonly rows: readonly SourceEvidenceRow[];
  readonly loading: boolean;
  readonly sessionEnded: boolean;
  readonly isDone: boolean;
  readonly loadMore: () => void;
  readonly row: ExpositionRow;
}): ReactNode {
  return createElement(
    "section",
    { "aria-label": copy.evidenceHeading },
    createElement("h2", null, copy.evidenceHeading),
    createElement("p", null, copy.evidenceIntro),
    sessionEnded
      ? createElement(SessionEnded)
      : loading
        ? createElement("p", { role: "status" }, copy.checkingSession)
        : rows.length === 0
          ? createElement("p", null, copy.noEvidence)
          : createElement(
              "ul",
              null,
              ...rows.map((entry) =>
                createElement(
                  "li",
                  { key: `${entry.findingId}:${entry.citedRevisionId}:${entry.fragmentId ?? "whole"}` },
                  createElement(EvidenceRowView, { entry, row }),
                ),
              ),
            ),
    !isDone
      ? createElement(
          "p",
          null,
          createElement("button", { type: "button", onClick: loadMore }, copy.loadMoreEvidence),
        )
      : null,
  );
}

function EvidenceRowView({
  entry,
  row,
}: {
  readonly entry: SourceEvidenceRow;
  readonly row: ExpositionRow;
}): ReactNode {
  const settled =
    entry.currentKnowledgeState !== null && isSettledKnowledgeState(entry.currentKnowledgeState);
  return createElement(
    "article",
    null,
    createElement("p", null, createElement("strong", null, entry.semanticKey), " — ", createElement("a", {
      href:
        entry.scope._tag === "project"
          ? `/pamiec?${PROJECT_PARAM}=${encodeURIComponent(entry.scope.projectId)}`
          : "/pamiec",
    }, copy.findingLinkLabel)),
    createElement("p", null, `${copy.citedRevisionLabel} #${entry.citedRevision}${entry.supersededByNewerRevision ? ` [${copy.supersededBadge}]` : ` [${copy.currentBadge}]`}`),
    entry.fragmentAnchor === null
      ? createElement("p", null, anchorLabel({ _tag: "whole_source" }))
      : createElement("p", null, anchorLabel(entry.fragmentAnchor)),
    entry.fragmentAnchor !== null && entry.fragmentAnchor._tag === "text_range"
      ? createElement("p", null, `„${textRangeExcerpt(row.authorText, entry.fragmentAnchor) ?? ""}”`)
      : null,
    entry.currentValue === null || entry.currentKnowledgeState === null
      ? null
      : createElement("p", null, `${findingValueLabel(entry.currentValue)} — ${knowledgeStateLabel(entry.currentKnowledgeState)}`),
    settled ? null : createElement("p", { role: "status" }, `[${copy.recomputationBadge}]`),
  );
}

// Re-exported for the surface test's typed vocabulary pin.
export type { FragmentAnchor };
