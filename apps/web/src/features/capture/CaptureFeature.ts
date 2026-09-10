/**
 * The capture feature (D4): the mobile composer of one "wiadomość
 * źródłowa" (CONTEXT.md) — text, ONE tap-to-start/tap-to-stop recording
 * and several photos — with a stable, recoverable local draft over the
 * REAL D2 upload paths and D1 acceptance.
 *
 * This file is the root gate and the form composition only (split of
 * review round 1): the draft store, recorder and send wiring live in
 * use-capture-composer.ts (one hook this form consumes), the five
 * presentational views in views.ts. J2's join consumes the same contract.
 *
 * JSX-free on purpose (createElement only), like the conversation and
 * membership surfaces: the host feature registry chain stays importable
 * by the node test programs.
 *
 * What this surface guarantees (issue #32):
 *
 * - ONE stable draft per signed-in person, persisted incrementally in the
 *   browser's storage: recording chunks land as MediaRecorder emits them,
 *   so any interruption leaves the exact recoverable fragment;
 * - Explicit Send begins the upload; the draft id is the prepare draftId
 *   AND the acceptance idempotency key, so manual and automatic retries
 *   reuse the stable upload/source identity and never duplicate the
 *   message;
 * - interrupted sends reopen as the honest "przerwana wysyłka" panel:
 *   listen, discard, resume or replace — never a false saved state;
 * - the project pill renders the draft record's stored scope (ONE source
 *   of truth, no second React state); every fresh draft seeds its scope
 *   from the conversation's ?projekt= param, so plain /wpis starts Auto
 *   and a project view retains its project context;
 * - the post-send processing vocabulary (accepted/processing/partial/
 *   processed/failed) renders from D1's source row, identical to the
 *   conversation surface.
 *
 * No styling, semantic controls only (the UX/UI track owns presentation).
 */

import { createElement, type ChangeEvent, type ReactNode } from "react";
import { useQuery_experimental as useQueryState } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import {
  CompanyFeatureGate,
  type MemberOverview,
  type SubmitEvent,
} from "../company/CompanyGate";
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

/** The feature root: mounted by the host entry at "/wpis" (capture.composer). */
export function CaptureFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    member: (overview: MemberOverview) => createElement(CaptureMain, { overview }),
  });
}

// ---------------------------------------------------------------------------
// The composer form: renders the wiring's state through the views
// ---------------------------------------------------------------------------

function CaptureMain({ overview }: { readonly overview: MemberOverview }): ReactNode {
  const selfMember = overview.members.find((member) => member.isSelf);
  const userId = selfMember?.userId ?? "unknown-user";
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

  const interrupted =
    !sending && draft !== null && (draft.phase === "uploading" || draft.phase === "accepting");
  // The honest local-phase line: "uploading" covers an active send; a
  // persisted non-composing phase stays visible after interruption.
  const visiblePhase: DraftPhase | null =
    draft !== null && draft.phase !== "composing" ? draft.phase : sending ? "uploading" : null;

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement("p", null, `${overview.company.name} — ${selfMember?.email ?? ""}`),
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
          createElement("p", null, copy.textRequiredNote),
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
