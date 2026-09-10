/**
 * The composer's wiring (D4): ONE hook that owns the draft store, the
 * recorder and the send engine, so the feature file only renders.
 *
 * Everything here is the review-round-1 state model, unchanged except
 * where noted:
 *
 * - the draft RECORD is the single source of truth for the project scope:
 *   the pill renders `draft.scopeProjectId`, selection only persists, and
 *   every fresh draft seeds its scope from the conversation route's
 *   ?projekt= param (`scopedFreshDraft` is the one seeding rule; the four
 *   creation sites no longer diverge);
 * - recording chunks land in the store as MediaRecorder emits them; text
 *   flushes on a short debounce and on pagehide;
 * - the send reads the record, mirrors the upload session into it, and on
 *   a confirmed receipt clears honestly and starts the next scoped draft.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Schema } from "effect";
import { useMutation } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { sourcesOperations } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type { Notice } from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import { PROJECT_PARAM, searchParam } from "../company/route-params";
import { useAppServices } from "../../app/providers";
import { MAX_ATTACHMENTS } from "./planner";
import { VoiceRecorder, browserMediaBoundary, type RecorderFailure } from "./recorder";
import {
  StepEnvelopeError,
  createGatewayUploadGateway,
  runSend,
  type AcceptPort,
  type SendProgress,
  type UploadGateway,
} from "./uploader";
import { captureCopy as copy, captureFailureHint, recorderFailureCopy } from "./state";
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

/** The typed result shape of the acceptance command (contract authority). */
const acceptSourceResult = sourcesOperations["sources.acceptSource"].result;

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
 * The ONE fresh-draft seeding rule (review round 1): a new draft's scope
 * comes from the conversation route's ?projekt= param: plain /wpis
 * starts Auto (company-wide), a project view retains its project. After
 * this, the stored record is the single authority the pill renders.
 */
export function scopedFreshDraft(userId: string, nowMs: number): DraftRecord {
  return {
    ...freshDraft(userId, freshDraftId(), nowMs),
    scopeProjectId: searchParam(PROJECT_PARAM),
  };
}

/** What the composer form renders and calls (the feature file consumes). */
export interface CaptureComposer {
  readonly draft: DraftRecord | null;
  readonly storeError: DraftStoreError | null;
  readonly notice: Notice | null;
  readonly progress: SendProgress | null;
  readonly sending: boolean;
  readonly recordingActive: boolean;
  readonly listenUrl: string | null;
  readonly sentSourceId: string | null;
  /** False when the app has no gateway URL: media sending is honestly off. */
  readonly mediaSendConfigured: boolean;
  /** The submit button's honest state (text present, gateway ready, idle). */
  readonly sendEnabled: boolean;
  editText(value: string): void;
  /** Persists the project-pill selection; the record re-renders the pill. */
  selectScope(projectId: string | null): void;
  startRecording(): void;
  stopRecording(): void;
  discardRecording(): void;
  addPhotos(files: readonly File[]): void;
  removePhoto(photoId: string): void;
  send(): void;
  discardDraft(): void;
}

/** The composer's full wiring over the signed-in person's user id. */
export function useCaptureComposer(userId: string): CaptureComposer {
  const { config } = useAppServices();
  const gatewayUrl = config.gatewayUrl;
  const token = useAuthToken();

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

  const timezone =
    typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "Europe/Warsaw";

  // --- draft store lifecycle ---------------------------------------------------

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
              const fresh = scopedFreshDraft(userId, Date.now());
              draftRef.current = fresh;
              setDraft(fresh);
              await opened
                .saveDraft(fresh)
                .catch((cause: unknown) => setStoreError(classifyStorageFailure(cause)));
              return;
            }
            if (existing.phase === "sent") {
              // A crash between receipt and cleanup: the message IS saved;
              // clear honestly and start the next draft (same scoped seed
              // as a confirmed send: the two paths no longer diverge).
              await opened.clearDraft(existing);
              const fresh = scopedFreshDraft(userId, Date.now());
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
        // The next draft's scope is re-seeded from the ?projekt= param: on
        // plain /wpis the pill honestly shows Auto again; a project view
        // retains its project. The pill renders this record (one source of
        // truth), so the reset is exactly what the boss sees.
        const next = scopedFreshDraft(userId, Date.now());
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
    const next = scopedFreshDraft(userId, Date.now());
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

  // The pill selection persists into the record; the record re-renders
  // the pill (no second React state to drift).
  function selectScope(projectId: string | null): void {
    const record = draftRef.current;
    if (record === null) {
      return;
    }
    void persist({ ...record, scopeProjectId: projectId });
  }

  const sendEnabled =
    !sending && draft !== null && draft.text.trim().length > 0 && gateway !== null && !recordingActive;

  return {
    draft,
    storeError,
    notice,
    progress,
    sending,
    recordingActive,
    listenUrl,
    sentSourceId,
    mediaSendConfigured: gatewayUrl !== null,
    sendEnabled,
    editText,
    selectScope,
    startRecording: () => void startRecording(),
    stopRecording,
    discardRecording: () => void discardRecording(),
    addPhotos: (files) => void addPhotos(files),
    removePhoto: (photoId) => void removePhoto(photoId),
    send: () => void send(),
    discardDraft: () => void discardDraft(),
  };
}

/** The failure's typed code for the persisted record. */
function failureCode(failure: Parameters<typeof failureMessage>[0]): string {
  return failure.kind === "network" ? "network" : failure.code;
}

function failureMessage(failure: { kind: "network"; detail: string } | { kind: "gateway" | "accept"; code: string; message: string }): string {
  return failure.kind === "network" ? failure.detail : failure.message;
}
