/**
 * The capture feature (D4): the mobile composer of one "wiadomość
 * źródłowa" (CONTEXT.md) — text, ONE tap-to-start/tap-to-stop recording
 * and several photos — with a stable, recoverable local draft over the
 * REAL D2 upload paths and D1 acceptance.
 *
 * JSX-free on purpose (createElement only), like the conversation and
 * membership surfaces: the host feature registry chain stays importable
 * by the node test programs. Browser APIs that the node config cannot
 * type (MediaRecorder constructor, indexedDB) are reached through
 * structural globalThis probes — the same discipline as the PWA
 * composition module.
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
 * - after a confirmed receipt the company pill resets to Auto while a
 *   project view retains its project context (the conversation's scope
 *   param stays the deep-link authority);
 * - the post-send processing vocabulary (accepted/processing/partial/
 *   processed/failed) renders from D1's source row, identical to the
 *   conversation surface.
 *
 * No styling, semantic controls only (the UX/UI track owns presentation).
 */

import {
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { Schema } from "effect";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { sourcesOperations } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import { SourceConversationRow } from "../../../../../convex/sources/read/rows";
import {
  CompanyFeatureGate,
  SessionEnded,
  type MemberOverview,
  type Notice,
  type SubmitEvent,
} from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import { PROJECT_PARAM, searchParam } from "../company/route-params";
import { justSentNotice } from "../conversation/state";
import { useAppServices } from "../../app/providers";
import { MAX_ATTACHMENTS } from "./planner";
import {
  DraftsStore,
  classifyStorageFailure,
  freshDraft,
  isDraftStoreErrorLike,
  openBrowserDraftStore,
  type DraftRecord,
  type DraftStoreError,
  type IdbFactoryLike,
} from "../../storage/drafts/store";
import { VoiceRecorder, type MediaBoundary, type MediaRecorderLike, type MediaStreamLike, type RecorderFailure } from "./recorder";
import {
  StepEnvelopeError,
  createGatewayUploadGateway,
  runSend,
  type AcceptPort,
  type SendProgress,
  type UploadGateway,
} from "./uploader";
import {
  bytesLabel,
  captureCopy as copy,
  captureFailureHint,
  durationLabel,
  phaseLabels,
  recorderFailureCopy,
  storageErrorCopy,
} from "./state";

/** The typed result shape of the acceptance command (contract authority). */
const acceptSourceResult = sourcesOperations["sources.acceptSource"].result;

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** The certified `idem_` + v4-uuid idempotency-key shape (CSPRNG only). */
function uuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function freshDraftId(): string {
  return `idem_${uuidV4()}`;
}

/**
 * The browser media APIs as one MediaBoundary. Reached through structural
 * probes so this module typechecks in the node test configuration too;
 * at runtime (browser) the real APIs sit behind the exact same seam the
 * deterministic tests and the live proof mock.
 */
/** The real MediaRecorder constructor with its static support probe. */
type RecorderConstructor = (new (
  stream: MediaStreamLike,
  options: { readonly mimeType: string },
) => MediaRecorderLike) & { isTypeSupported(mimeType: string): boolean };

function browserMediaBoundary(): MediaBoundary | null {
  const recorderClass = (globalThis as unknown as { MediaRecorder?: RecorderConstructor }).MediaRecorder;
  const mediaDevices = (
    globalThis as {
      navigator?: { mediaDevices?: { getUserMedia(constraints: { readonly audio: true }): Promise<MediaStreamLike> } };
    }
  ).navigator?.mediaDevices;
  if (recorderClass === undefined || mediaDevices === undefined) {
    return null;
  }
  return {
    getUserMedia: (constraints) => mediaDevices.getUserMedia(constraints),
    isTypeSupported: (mimeType) => recorderClass.isTypeSupported(mimeType),
    createMediaRecorder: (stream, mimeType) => new recorderClass(stream, { mimeType }),
    now: () => Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Root: the shared company-feature gate
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at "/wpis" (capture.composer). */
export function CaptureFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    member: (overview: MemberOverview) => createElement(CaptureMain, { overview }),
  });
}

// ---------------------------------------------------------------------------
// The composer: draft lifecycle, capture controls, send, recovery
// ---------------------------------------------------------------------------

function CaptureMain({ overview }: { readonly overview: MemberOverview }): ReactNode {
  const { config } = useAppServices();
  const gatewayUrl = config.gatewayUrl;
  const token = useAuthToken();

  const selfMember = overview.members.find((member) => member.isSelf);
  const userId = selfMember?.userId ?? "unknown-user";

  const [draft, setDraft] = useState<DraftRecord | null>(null);
  const [storeError, setStoreError] = useState<DraftStoreError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [progress, setProgress] = useState<SendProgress | null>(null);
  const [sending, setSending] = useState(false);
  const [recordingActive, setRecordingActive] = useState(false);
  const [listenUrl, setListenUrl] = useState<string | null>(null);
  const [sentSourceId, setSentSourceId] = useState<string | null>(null);

  const storeRef = useRef<DraftsStore | null>(null);
  const draftRef = useRef<DraftRecord | null>(null);
  const sendingRef = useRef(false);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const textFlushRef = useRef<(() => void) | null>(null);

  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  const projectViews: readonly { projectId: string; displayName: string }[] =
    projects.status === "success"
      ? [...projects.data.active, ...projects.data.closed].map((project) => ({
          projectId: project.projectId,
          displayName: project.displayName,
        }))
      : [];

  // The project pill: the conversation's ?projekt= param seeds it (a
  // project view retains its context); Auto means company-wide knowledge.
  const [pillProjectId, setPillProjectId] = useState<string | null>(() => searchParam(PROJECT_PARAM));

  const timezone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "Europe/Warsaw";

  // --- draft store lifecycle -------------------------------------------------

  const persist = useMemo(
    () => (next: DraftRecord): Promise<void> => {
      draftRef.current = next;
      setDraft(next);
      const store = storeRef.current;
      if (store === null) {
        return Promise.resolve();
      }
      return store.saveDraft(next).catch((cause: unknown) => {
        const classified = classifyStorageFailure(cause);
        setStoreError(classified);
        draftRef.current = { ...next, storageDegraded: true };
        setDraft(draftRef.current);
        return Promise.resolve();
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const idb = (globalThis as { indexedDB?: IdbFactoryLike }).indexedDB;
    if (idb === undefined) {
      setStoreError({ kind: "unavailable" });
      return;
    }
    void openBrowserDraftStore(idb).then((opened) => {
      if (cancelled) {
        return;
      }
      if (opened instanceof DraftsStore) {
        storeRef.current = opened;
        void opened
          .loadDraft(userId)
          .then(async (existing) => {
            if (cancelled) {
              return;
            }
            if (existing === null) {
              const fresh = freshDraft(userId, freshDraftId(), Date.now());
              draftRef.current = fresh;
              setDraft(fresh);
              await opened.saveDraft(fresh).catch(() => setStoreError({ kind: "quota" }));
              return;
            }
            if (existing.phase === "sent") {
              // A crash between receipt and cleanup: the message IS saved;
              // clear honestly and start the next draft.
              await opened.clearDraft(existing);
              const fresh: DraftRecord = {
                ...freshDraft(userId, freshDraftId(), Date.now()),
                scopeProjectId: existing.scopeProjectId,
              };
              draftRef.current = fresh;
              setDraft(fresh);
              await opened.saveDraft(fresh);
              setSentSourceId(existing.sentSourceId);
              return;
            }
            draftRef.current = existing;
            setDraft(existing);
            if (existing.recording !== null && existing.recording.chunkCount > 0) {
              const blob = await opened.readRecording(existing).catch(() => null);
              if (blob !== null && !cancelled) {
                setListenUrl(URL.createObjectURL(blob));
              }
            }
          })
          .catch((cause: unknown) => {
            if (!cancelled) {
              setStoreError(classifyStorageFailure(cause));
            }
          });
        return;
      }
      setStoreError(opened);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // --- text editing: local state + debounced durable flush + pagehide flush ---

  function editText(value: string): void {
    const record = draftRef.current;
    if (record === null || sendingRef.current) {
      return; // During an active send the payload is already assembled.
    }
    const next = { ...record, text: value };
    draftRef.current = next;
    setDraft(next);
    if (textFlushRef.current !== null) {
      textFlushRef.current();
      textFlushRef.current = null;
    }
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      textFlushRef.current = null;
      const store = storeRef.current;
      const current = draftRef.current;
      if (store !== null && current !== null && current.text === value) {
        void store.saveDraft(current).catch((cause: unknown) => {
          setStoreError(classifyStorageFailure(cause));
        });
      }
    }, 400);
    textFlushRef.current = () => clearTimeout(timer);
  }

  // Preserve the draft before a safe PWA update / tab close: chunks and
  // records are already durable (incremental writes); the only lagging
  // piece is debounced text, which flushes now.
  useEffect(() => {
    const flush = () => {
      if (textFlushRef.current !== null) {
        textFlushRef.current();
        textFlushRef.current = null;
      }
      const store = storeRef.current;
      const current = draftRef.current;
      if (store !== null && current !== null) {
        void store.saveDraft(current).catch(() => undefined);
      }
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  // --- recording --------------------------------------------------------------

  async function startRecording(): Promise<void> {
    const record = draftRef.current;
    const store = storeRef.current;
    if (record === null || store === null || recordingActive) {
      return;
    }
    if (record.recording !== null) {
      // One recording per message: starting a new one drops the previous.
      await discardRecording();
    }
    const media = browserMediaBoundary();
    if (media === null) {
      setNotice({ kind: "error", text: recorderFailureCopy({ kind: "recorder_unsupported" }) });
      return;
    }
    const recorder = new VoiceRecorder(media, {
      onChunk: (seq, chunk) => {
        const current = draftRef.current;
        const currentStore = storeRef.current;
        if (current === null || currentStore === null) {
          return Promise.resolve();
        }
        return currentStore.appendRecordingChunk(current, seq, chunk).then((next) => {
          draftRef.current = next;
          setDraft(next);
        });
      },
      onRecordingStart: (mimeType, startedAtMs) => {
        const current = draftRef.current;
        if (current === null) {
          return;
        }
        const next: DraftRecord = {
          ...current,
          recording: { mimeType, chunkCount: 0, totalBytes: 0, startedAtMs, durationMs: 0 },
        };
        void persist(next);
      },
      onRecordingStop: (totalDurationMs) => {
        const current = draftRef.current;
        setRecordingActive(false);
        if (current === null || current.recording === null) {
          return;
        }
        void persist({ ...current, recording: { ...current.recording, durationMs: totalDurationMs } });
        const store2 = storeRef.current;
        if (store2 !== null && current.recording.chunkCount > 0) {
          void store2
            .readRecording(draftRef.current ?? current)
            .then((blob) => {
              if (blob !== null) {
                setListenUrl((old) => {
                  if (old !== null) {
                    URL.revokeObjectURL(old);
                  }
                  return URL.createObjectURL(blob);
                });
              }
            })
            .catch(() => setStoreError({ kind: "corrupt" }));
        }
      },
      onFailure: (failure: RecorderFailure) => {
        setNotice({ kind: "error", text: recorderFailureCopy(failure) });
        if (failure.kind === "storage_degraded") {
          const current = draftRef.current;
          if (current !== null) {
            void persist({ ...current, storageDegraded: true });
          }
        }
        if (failure.kind === "permission_denied" || failure.kind === "mic_unavailable" || failure.kind === "recorder_unsupported") {
          setRecordingActive(false);
        }
      },
    });
    recorderRef.current = recorder;
    setRecordingActive(true);
    await recorder.start();
    if (recorder.currentState !== "recording") {
      setRecordingActive(false);
      recorderRef.current = null;
    }
  }

  function stopRecording(): void {
    recorderRef.current?.stop();
  }

  async function discardRecording(): Promise<void> {
    const record = draftRef.current;
    const store = storeRef.current;
    recorderRef.current?.release();
    recorderRef.current = null;
    setRecordingActive(false);
    setListenUrl((old) => {
      if (old !== null) {
        URL.revokeObjectURL(old);
      }
      return null;
    });
    if (record === null || store === null || record.recording === null) {
      return;
    }
    try {
      const next = await store.discardRecording(record);
      draftRef.current = next;
      setDraft(next);
    } catch (cause) {
      setStoreError(classifyStorageFailure(cause));
    }
  }

  // --- photos -----------------------------------------------------------------

  async function addPhotos(files: readonly File[]): Promise<void> {
    const record = draftRef.current;
    const store = storeRef.current;
    if (record === null || store === null || files.length === 0) {
      return;
    }
    const attachmentCount = record.photos.length + (record.recording !== null ? 1 : 0);
    const room = MAX_ATTACHMENTS - attachmentCount;
    if (room <= 0) {
      setNotice({ kind: "error", text: copy.attachmentsTooMany });
      return;
    }
    if (files.length > room) {
      setNotice({ kind: "error", text: copy.attachmentsTooMany });
    }
    let current = record;
    try {
      for (const file of files.slice(0, room)) {
        current = await store.addPhoto(
          current,
          {
            photoId: `ph_${uuidV4()}`,
            name: file.name,
            mimeType: file.type === "" ? "application/octet-stream" : file.type,
            bytes: file.size,
          },
          file,
        );
      }
      draftRef.current = current;
      setDraft(current);
    } catch (cause) {
      setStoreError(classifyStorageFailure(cause));
    }
  }

  async function removePhoto(photoId: string): Promise<void> {
    const record = draftRef.current;
    const store = storeRef.current;
    if (record === null || store === null) {
      return;
    }
    try {
      const next = await store.removePhoto(record, photoId);
      draftRef.current = next;
      setDraft(next);
    } catch (cause) {
      setStoreError(classifyStorageFailure(cause));
    }
  }

  // --- send (explicit Send begins the upload) -----------------------------------

  const acceptSource = useMutation(api.sources.accept.commands.acceptSourceCommand);
  const acceptPort: AcceptPort = useMemo(
    () => ({
      accept: async (input, idempotencyKey) => {
        const result = await acceptSource({
          envelope: {
            operation: "sources.acceptSource",
            input: {
              uploadId: asConvexId("uploads", input.uploadId),
              authorText: input.authorText,
              ...(input.intendedSentAtIso === null ? {} : { intendedSentAtIso: input.intendedSentAtIso }),
              timezoneSnapshot: input.timezoneSnapshot,
              projectHints: input.projectHints.map((projectId) => asConvexId("projects", projectId)),
            },
            expectedRevisions: [],
            idempotencyKey,
          },
        });
        if (result._tag === "error") {
          throw new StepEnvelopeError(result.error.code, result.error.message);
        }
        const receipt = Schema.decodeUnknownSync(acceptSourceResult)(result.value);
        return { sourceId: receipt.sourceId };
      },
    }),
    [acceptSource],
  );

  const gateway: UploadGateway | null = useMemo(
    () =>
      gatewayUrl === null || token === null
        ? null
        : createGatewayUploadGateway(gatewayUrl, () => token),
    [gatewayUrl, token],
  );

  async function send(): Promise<void> {
    const record = draftRef.current;
    const store = storeRef.current;
    if (record === null || store === null || sendingRef.current) {
      return;
    }
    const authorText = record.text.trim();
    if (authorText.length === 0 || gateway === null) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setNotice(null);
    setSentSourceId(null);
    try {
      const audio =
        record.recording !== null && record.recording.chunkCount > 0
          ? await store.readRecording(record)
          : null;
      const photos: { blob: Blob }[] = [];
      for (const photo of record.photos) {
        const blob = await store.readPhoto(record, photo.photoId);
        if (blob === null) {
          throw new Error("photo blob missing");
        }
        photos.push({ blob });
      }
      const intendedSentAtIso = record.intendedSentAtIso ?? new Date().toISOString();
      await persist({ ...record, phase: "uploading", intendedSentAtIso, lastError: null });
      const outcome = await runSend(
        {
          draftId: record.draftId,
          authorText,
          intendedSentAtIso,
          timezoneSnapshot: timezone,
          projectHints: record.scopeProjectId === null ? [] : [record.scopeProjectId],
          audio,
          photos,
        },
        gateway,
        acceptPort,
        {
          onProgress: (update) => {
            setProgress(update);
            if (update.phase === "accepting") {
              const current = draftRef.current;
              if (current !== null) {
                void persist({ ...current, phase: "accepting" });
              }
            }
          },
          onSession: (session) => {
            const current = draftRef.current;
            if (current !== null) {
              void persist({
                ...current,
                session: {
                  uploadId: session.uploadId,
                  attachments: session.attachments.map((attachment) => ({
                    attachmentId: attachment.attachmentId,
                    kind: attachment.kind,
                    objectKey: attachment.objectKey,
                  })),
                },
              });
            }
          },
        },
      );
      if (outcome.ok) {
        const finished = draftRef.current ?? record;
        await store.clearDraft(finished).catch(() => undefined);
        // The company pill resets to Auto after success; a project view
        // retains its project context (the ?projekt= param decides which).
        const next: DraftRecord = {
          ...freshDraft(userId, freshDraftId(), Date.now()),
          scopeProjectId: searchParam(PROJECT_PARAM),
        };
        draftRef.current = next;
        setDraft(next);
        await store.saveDraft(next).catch(() => undefined);
        setListenUrl((old) => {
          if (old !== null) {
            URL.revokeObjectURL(old);
          }
          return null;
        });
        setSentSourceId(outcome.sourceId);
        setNotice({ kind: "ok", text: copy.savedNotice });
        return;
      }
      const current = draftRef.current ?? record;
      await persist({
        ...current,
        phase: current.phase === "accepting" ? "accepting" : "uploading",
        lastError: { code: failureCode(outcome.failure), message: failureMessage(outcome.failure) },
      });
      if (outcome.failure.kind === "network") {
        setNotice({
          kind: "error",
          text: current.phase === "accepting" ? copy.lostResponseNotice : copy.uploadNetworkNotice,
        });
      } else {
        setNotice({
          kind: "error",
          text: captureFailureHint(outcome.failure.code, outcome.failure.message),
        });
      }
    } catch (cause) {
      // Local material could not be read back (eviction, corruption): the
      // honest answer is an explicit error, never a half-sent message.
      if (isDraftStoreErrorLike(cause)) {
        setStoreError(cause);
      } else {
        setNotice({ kind: "error", text: copy.localMaterialUnreadable });
      }
      const current = draftRef.current;
      if (current !== null) {
        await persist({
          ...current,
          lastError: { code: "local_material_unreadable", message: "local material unreadable" },
        });
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      setProgress(null);
    }
  }

  async function discardDraft(): Promise<void> {
    const record = draftRef.current;
    const store = storeRef.current;
    if (record === null || store === null || sendingRef.current) {
      return;
    }
    await recorderRef.current?.release();
    try {
      await store.clearDraft(record);
    } catch (cause) {
      setStoreError(classifyStorageFailure(cause));
    }
    const next: DraftRecord = {
      ...freshDraft(userId, freshDraftId(), Date.now()),
      scopeProjectId: searchParam(PROJECT_PARAM),
    };
    draftRef.current = next;
    setDraft(next);
    await store.saveDraft(next).catch(() => undefined);
    setListenUrl((old) => {
      if (old !== null) {
        URL.revokeObjectURL(old);
      }
      return null;
    });
    setNotice(null);
    setSentSourceId(null);
  }

  const interrupted =
    !sending && draft !== null && (draft.phase === "uploading" || draft.phase === "accepting");
  const sendEnabled =
    !sending && draft !== null && draft.text.trim().length > 0 && gateway !== null && !recordingActive;
  // The honest local-phase line: "uploading" covers an active send; a
  // persisted non-composing phase stays visible after interruption.
  const visiblePhase: DraftRecord["phase"] | null =
    draft !== null && draft.phase !== "composing" ? draft.phase : sending ? "uploading" : null;

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement("p", null, `${overview.company.name} — ${selfMember?.email ?? ""}`),
    gatewayUrl === null
      ? createElement("p", { role: "alert" }, copy.gatewayUnconfigured)
      : null,
    storeError === null
      ? null
      : createElement("p", { role: "alert" }, storageErrorCopy[storeError.kind]),
    storeError !== null && draft !== null
      ? createElement("p", null, createElement("button", { type: "button", onClick: () => void discardDraft() }, copy.discardDraftButton))
      : null,
    draft === null
      ? createElement("p", { role: "status" }, copy.draftLoading)
      : createElement(
          "form",
          { onSubmit: (event: SubmitEvent) => {
            event.preventDefault();
            void send();
          } },
          interrupted
            ? createElement(RecoveryPanel, {
                draft,
                listenUrl,
                resume: () => void send(),
                discard: () => void discardDraft(),
              })
            : null,
          createElement(ProjectPill, {
            projectViews,
            pillProjectId,
            disabled: sending || interrupted,
            select: (projectId) => {
              setPillProjectId(projectId);
              const record = draftRef.current;
              if (record !== null) {
                void persist({ ...record, scopeProjectId: projectId });
              }
            },
          }),
          createElement("label", { htmlFor: "capture-text" }, copy.textLabel),
          createElement("textarea", {
            id: "capture-text",
            rows: 4,
            placeholder: copy.textPlaceholder,
            value: draft.text,
            onChange: (event: ChangeEvent<HTMLTextAreaElement>) => editText(event.target.value),
            disabled: sending,
          }),
          createElement("p", null, copy.textRequiredNote),
          createElement(RecordingControls, {
            recordingActive,
            recording: draft.recording,
            listenUrl,
            storageDegraded: draft.storageDegraded,
            disabled: sending || interrupted,
            start: () => void startRecording(),
            stop: stopRecording,
            discard: () => void discardRecording(),
          }),
          createElement(PhotoControls, {
            photos: draft.photos,
            disabled: sending || interrupted,
            add: (files) => void addPhotos(files),
            remove: (photoId) => void removePhoto(photoId),
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
              ? createElement("button", { type: "button", onClick: () => void discardDraft() }, copy.discardDraftButton)
              : null,
          ),
        ),
    notice === null
      ? null
      : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
    sentSourceId === null ? null : createElement(SentStatePanel, { sourceId: sentSourceId }),
  );
}

/** The failure's typed code for the persisted record. */
function failureCode(failure: Parameters<typeof failureMessage>[0]): string {
  return failure.kind === "network" ? "network" : failure.code;
}

function failureMessage(failure: { kind: "network"; detail: string } | { kind: "gateway" | "accept"; code: string; message: string }): string {
  return failure.kind === "network" ? failure.detail : failure.message;
}

// ---------------------------------------------------------------------------
// Project pill: Auto or one project (the conversation's scope param seeds it)
// ---------------------------------------------------------------------------

function ProjectPill({
  projectViews,
  pillProjectId,
  disabled,
  select,
}: {
  readonly projectViews: readonly { readonly projectId: string; readonly displayName: string }[];
  readonly pillProjectId: string | null;
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
        checked: pillProjectId === null,
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
          checked: pillProjectId === project.projectId,
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

function RecordingControls({
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

function PhotoControls({
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

function RecoveryPanel({
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

function SentStatePanel({ sourceId }: { readonly sourceId: string }): ReactNode {
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
