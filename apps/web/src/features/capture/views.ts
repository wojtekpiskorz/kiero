/**
 * The capture composer's presentational views (D4): five pure components
 * the feature form composes (split of review round 1). They render props
 * and the copy; every piece of wiring lives in use-capture-composer.ts.
 *
 * JSX-free on purpose (createElement only), like the conversation and
 * membership surfaces: the host feature registry chain stays importable
 * by the node test programs.
 */

import { createElement, useRef, type ChangeEvent, type ReactNode } from "react";
import { Schema } from "effect";
import { useQuery_experimental as useQueryState } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { SourceConversationRow } from "../../../../../convex/sources/read/rows";
import { SessionEnded } from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import { justSentNotice } from "../conversation/state";
import type { DraftRecord } from "../../storage/drafts/store";
import {
  bytesLabel,
  captureCopy as copy,
  captureFailureHint,
  durationLabel,
} from "./state";

// ---------------------------------------------------------------------------
// Project pill: Auto or one project; renders the draft's stored scope
// ---------------------------------------------------------------------------

export function ProjectPill({
  projectViews,
  scopeProjectId,
  disabled,
  select,
}: {
  readonly projectViews: readonly { readonly projectId: string; displayName: string }[];
  /** The draft record's stored scope: the single source of truth. */
  readonly scopeProjectId: string | null;
  readonly disabled: boolean;
  readonly select: (projectId: string | null) => void;
}): ReactNode {
  return createElement(
    "fieldset",
    null,
    createElement("legend", null, copy.projectPillLabel),
    createElement(
      "label",
      null,
      createElement("input", {
        type: "radio",
        name: "capture-scope",
        checked: scopeProjectId === null,
        disabled,
        onChange: () => select(null),
      }),
      ` ${copy.projectAutoLabel}`,
    ),
    ...projectViews.map((project) =>
      createElement(
        "label",
        { key: project.projectId },
        createElement("input", {
          type: "radio",
          name: "capture-scope",
          checked: scopeProjectId === project.projectId,
          disabled,
          onChange: () => select(project.projectId),
        }),
        ` ${copy.projectPrefixLabel}: ${project.displayName}`,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Recording controls: one tap to start (after permission), one tap to stop
// ---------------------------------------------------------------------------

export function RecordingControls({
  recordingActive,
  recording,
  listenUrl,
  storageDegraded,
  disabled,
  start,
  stop,
  discard,
}: {
  readonly recordingActive: boolean;
  readonly recording: DraftRecord["recording"];
  readonly listenUrl: string | null;
  readonly storageDegraded: boolean;
  readonly disabled: boolean;
  readonly start: () => void;
  readonly stop: () => void;
  readonly discard: () => void;
}): ReactNode {
  return createElement(
    "fieldset",
    null,
    createElement("legend", null, copy.recordingLegend),
    recordingActive
      ? createElement(
          "p",
          null,
          createElement("button", { type: "button", onClick: stop }, copy.stopButton),
          " ",
          createElement("span", { role: "status" }, copy.recordingActive),
        )
      : createElement("p", null, createElement("button", { type: "button", disabled, onClick: start }, copy.recordButton)),
    recording === null
      ? null
      : createElement(
          "p",
          { role: "status" },
          `${copy.recordingReady} ${durationLabel(recording.durationMs)} (${bytesLabel(recording.totalBytes)})`,
          storageDegraded ? ` — ${copy.storageDegradedNotice}` : "",
        ),
    listenUrl === null
      ? null
      : createElement("p", null, createElement("audio", { controls: true, src: listenUrl, "aria-label": copy.recordingListenLabel })),
    recording === null || recordingActive
      ? null
      : createElement("p", null, createElement("button", { type: "button", onClick: discard }, copy.recordingDiscardButton)),
  );
}

// ---------------------------------------------------------------------------
// Photos: add several, remove any before Send
// ---------------------------------------------------------------------------

export function PhotoControls({
  photos,
  disabled,
  add,
  remove,
}: {
  readonly photos: readonly DraftRecord["photos"][number][];
  readonly disabled: boolean;
  readonly add: (files: readonly File[]) => void;
  readonly remove: (photoId: string) => void;
}): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return createElement(
    "fieldset",
    null,
    createElement("legend", null, copy.photosLabel),
    createElement(
      "p",
      null,
      createElement("input", {
        ref: inputRef,
        type: "file",
        accept: "image/*",
        multiple: true,
        disabled,
        onChange: (event: ChangeEvent<HTMLInputElement>) => {
          add(Array.from(event.target.files ?? []));
          if (inputRef.current !== null) {
            inputRef.current.value = "";
          }
        },
      }),
    ),
    photos.length === 0
      ? createElement("p", null, copy.photosEmpty)
      : createElement(
          "ul",
          null,
          ...photos.map((photo) =>
            createElement(
              "li",
              { key: photo.photoId },
              `${photo.name} (${bytesLabel(photo.bytes)}) `,
              createElement(
                "button",
                { type: "button", disabled, onClick: () => remove(photo.photoId) },
                copy.photoRemoveButton,
              ),
            ),
          ),
        ),
  );
}

// ---------------------------------------------------------------------------
// The interrupted-send recovery panel (listen, discard, retry or replace)
// ---------------------------------------------------------------------------

export function RecoveryPanel({
  draft,
  listenUrl,
  resume,
  discard,
}: {
  readonly draft: DraftRecord;
  readonly listenUrl: string | null;
  readonly resume: () => void;
  readonly discard: () => void;
}): ReactNode {
  return createElement(
    "section",
    { "aria-label": copy.interruptedHeading },
    createElement("h2", null, copy.interruptedHeading),
    createElement("p", null, copy.interruptedIntro),
    createElement("p", null, createElement("strong", null, draft.text)),
    draft.recording === null
      ? null
      : createElement(
          "p",
          { role: "status" },
          `${copy.recordingReady} ${durationLabel(draft.recording.durationMs)} (${bytesLabel(draft.recording.totalBytes)})`,
        ),
    listenUrl === null
      ? null
      : createElement("p", null, createElement("audio", { controls: true, src: listenUrl, "aria-label": copy.recordingListenLabel })),
    draft.photos.length === 0
      ? null
      : createElement(
          "ul",
          null,
          ...draft.photos.map((photo) =>
            createElement("li", { key: photo.photoId }, `${photo.name} (${bytesLabel(photo.bytes)})`),
          ),
        ),
    createElement(
      "p",
      null,
      createElement("button", { type: "button", onClick: resume }, copy.retryButton),
      " ",
      createElement("button", { type: "button", onClick: discard }, copy.discardDraftButton),
    ),
  );
}

// ---------------------------------------------------------------------------
// The sent source's honest processing state (D1's row, same as conversation)
// ---------------------------------------------------------------------------

export function SentStatePanel({ sourceId }: { readonly sourceId: string }): ReactNode {
  const detail = useQueryState({
    query: api.sources.read.views.sourceDetail,
    args: { sourceId: asConvexId("sources", sourceId) },
  });
  if (detail.status === "error") {
    return createElement(SessionEnded);
  }
  if (detail.status !== "success") {
    return createElement("p", { role: "status" }, copy.checkingState);
  }
  if (detail.data._tag === "error") {
    return createElement("p", { role: "alert" }, captureFailureHint(detail.data.error.code, detail.data.error.message));
  }
  const row = Schema.decodeUnknownSync(SourceConversationRow)(detail.data.value);
  return createElement("p", { role: "status" }, justSentNotice(row.processingState));
}
