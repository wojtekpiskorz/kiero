/**
 * The capture composer (D4, joined into the conversation by J2): the
 * mobile composer of one "wiadomość źródłowa" (CONTEXT.md): text, ONE
 * tap-to-start/tap-to-stop recording and several photos, with a stable,
 * recoverable local draft over the REAL D2 upload paths and D1 acceptance.
 *
 * This file is the form composition only (split of D4 review round 1): the
 * draft store, recorder and send wiring live in use-capture-composer.ts
 * (one hook this form consumes), the five presentational views in views.ts.
 *
 * J2 join (issue #61): the composer MOUNTS INSIDE the conversation surface
 * ("Rozmowa firmy"), replacing both earlier send forms (J1's text-only
 * statement form and D4's separate /wpis route. The /wpis route and its
 * nav entry retire with this join; this module exports the embedded
 * ComposerForm (plus its wiring seam props: a correction prefill and an
 * on-accepted callback) instead of a page root.
 *
 * JSX-free on purpose (createElement only), like the conversation and
 * membership surfaces: the host feature registry chain stays importable
 * by the node test programs.
 *
 * What this composer guarantees (issue #32, unchanged by the join):
 *
 * - ONE stable draft per signed-in person, persisted incrementally in the
 *   browser's storage: recording chunks land as MediaRecorder emits them,
 *   so any interruption leaves the exact recoverable fragment;
 * - Explicit Send begins the upload; the draft id is the prepare draftId
 *   AND the acceptance idempotency key, so manual and automatic retries
 *   reuse the stable upload/source identity and never duplicate the
 *   message;
 * - interrupted sends reopen as the honest "przerwana wysyłka" panel:
 *   listen, discard, resume or replace, never a false saved state;
 * - the project pill renders the draft record's stored scope (ONE source
 *   of truth, no second React state); every fresh draft seeds its scope
 *   from the conversation's ?projekt= param, so the plain company view
 *   starts Auto and a project view retains its project context;
 * - the post-send processing vocabulary (accepted/processing/partial/
 *   processed/failed) renders from D1's source row, identical to the
 *   conversation surface;
 * - voice-only and photo-only sends are real messages (the J2 ruling):
 *   words of text OR at least one retained medium is substance enough.
 *
 * No styling, semantic controls only (the UX/UI track owns presentation).
 */

import { createElement, type ChangeEvent, type ReactNode } from "react";
import { useEffect, useRef } from "react";
import { useQuery_experimental as useQueryState } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import type { SubmitEvent } from "../company/CompanyGate";
import { useCaptureComposer } from "./use-capture-composer";
import { captureCopy as copy, phaseLabels, storageErrorCopy } from "./state";
import type { DraftPhase } from "../../storage/drafts/store";
import {
  PhotoControls,
  ProjectPill,
  RecordingControls,
  RecoveryPanel,
  SentStatePanel,
} from "./views";

/** The wiring seam the conversation drives (both optional). */
export interface ComposerFormProps {
  /** The signed-in person's user id (the draft-store key). */
  readonly userId: string;
  /**
   * A correction prefill (H1's "Korekta ustalenia" flow): when non-null,
   * its text is written into the draft ONCE and `onPrefillApplied`
   * fires, so the conversation can drop the request. The draft record
   * stays the single source of truth afterwards.
   */
  readonly prefill: string | null;
  readonly onPrefillApplied: () => void;
  /** Fires once per confirmed acceptance with the new source id. */
  readonly onAccepted: (sourceId: string) => void;
}

// ---------------------------------------------------------------------------
// The composer form: renders the wiring's state through the views
// ---------------------------------------------------------------------------

export function ComposerForm({
  userId,
  prefill,
  onPrefillApplied,
  onAccepted,
}: ComposerFormProps): ReactNode {
  const composer = useCaptureComposer(userId);
  const {
    draft,
    storeError,
    notice,
    progress,
    sending,
    recordingActive,
    listenUrl,
    sentSourceId,
    mediaSendConfigured,
    sendEnabled,
  } = composer;

  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  const projectViews: readonly { projectId: string; displayName: string }[] =
    projects.status === "success"
      ? [...projects.data.active, ...projects.data.closed].map((project) => ({
          projectId: project.projectId,
          displayName: project.displayName,
        }))
      : [];

  // The correction prefill lands in the draft ONCE per request: the ref
  // remembers which request was applied, so re-renders never rewrite text
  // the boss may already have edited.
  const appliedPrefill = useRef<string | null>(null);
  useEffect(() => {
    if (prefill !== null && appliedPrefill.current !== prefill) {
      appliedPrefill.current = prefill;
      composer.editText(prefill);
      onPrefillApplied();
    }
  }, [prefill, composer, onPrefillApplied]);

  // The accepted callback fires once per confirmed send (the composer's
  // own sentSourceId state remains the rendered truth).
  const lastReportedSent = useRef<string | null>(null);
  useEffect(() => {
    if (sentSourceId !== null && lastReportedSent.current !== sentSourceId) {
      lastReportedSent.current = sentSourceId;
      onAccepted(sentSourceId);
    }
  }, [sentSourceId, onAccepted]);

  const interrupted =
    !sending && draft !== null && (draft.phase === "uploading" || draft.phase === "accepting");
  // The honest local-phase line: "uploading" covers an active send; a
  // persisted non-composing phase stays visible after interruption.
  const visiblePhase: DraftPhase | null =
    draft !== null && draft.phase !== "composing" ? draft.phase : sending ? "uploading" : null;

  return createElement(
    "section",
    { "aria-label": copy.title },
    !mediaSendConfigured
      ? createElement("p", { role: "alert" }, copy.gatewayUnconfigured)
      : null,
    storeError === null
      ? null
      : createElement("p", { role: "alert" }, storageErrorCopy[storeError.kind]),
    storeError !== null && draft !== null
      ? createElement("p", null, createElement("button", { type: "button", onClick: () => composer.discardDraft() }, copy.discardDraftButton))
      : null,
    draft === null
      ? createElement("p", { role: "status" }, copy.draftLoading)
      : createElement(
          "form",
          { onSubmit: (event: SubmitEvent) => {
            event.preventDefault();
            composer.send();
          } },
          interrupted
            ? createElement(RecoveryPanel, {
                draft,
                listenUrl,
                resume: () => composer.send(),
                discard: () => composer.discardDraft(),
              })
            : null,
          createElement(ProjectPill, {
            projectViews,
            scopeProjectId: draft.scopeProjectId,
            disabled: sending || interrupted,
            select: composer.selectScope,
          }),
          createElement("label", { htmlFor: "capture-text" }, copy.textLabel),
          createElement("textarea", {
            id: "capture-text",
            rows: 4,
            placeholder: copy.textPlaceholder,
            value: draft.text,
            onChange: (event: ChangeEvent<HTMLTextAreaElement>) => composer.editText(event.target.value),
            disabled: sending,
          }),
          createElement("p", null, copy.textOptionalNote),
          createElement(RecordingControls, {
            recordingActive,
            recording: draft.recording,
            listenUrl,
            storageDegraded: draft.storageDegraded,
            disabled: sending || interrupted,
            start: composer.startRecording,
            stop: composer.stopRecording,
            discard: composer.discardRecording,
          }),
          createElement(PhotoControls, {
            photos: draft.photos,
            disabled: sending || interrupted,
            add: composer.addPhotos,
            remove: composer.removePhoto,
          }),
          sending && progress !== null && progress.phase === "uploading"
            ? createElement("p", { role: "status" }, copy.uploadingProgress(progress.doneParts, progress.totalParts, progress.attachmentIndex, progress.attachmentTotal))
            : null,
          visiblePhase === null
            ? null
            : createElement("p", { role: "status" }, `${copy.draftStateLabel}: ${phaseLabels[visiblePhase]}`),
          createElement(
            "p",
            null,
            createElement(
              "button",
              { type: "submit", disabled: !sendEnabled },
              sending ? copy.sending : copy.sendButton,
            ),
            " ",
            interrupted
              ? createElement("button", { type: "button", onClick: () => composer.discardDraft() }, copy.discardDraftButton)
              : null,
          ),
        ),
    notice === null
      ? null
      : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
    sentSourceId === null ? null : createElement(SentStatePanel, { sourceId: sentSourceId }),
  );
}
