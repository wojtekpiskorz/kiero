// In-memory scenario store with deterministic transitions and full reset.
// No persistence: the prototype checks interactions, not durability.
import { useSyncExternalStore } from "react";
import {
  ACTORS,
  ActorId,
  FeedbackItem,
  Fragment,
  ProjectId,
  SEED_READ_BY,
  SEED_SOURCES,
  SourceMessage,
  SourceStatus,
  frozenNow,
} from "../data/fixtures";

export type VariantKey = "A" | "B" | "C";
export type Pill = ProjectId | "auto";
export type ProcessingMode = "normal" | "ai-fail" | "offline";

export interface DraftAttachment {
  id: string;
  kind: "audio" | "photo";
  label: string;
  durationSec?: number;
  hue?: number;
  interrupted?: boolean;
}

export interface RecorderState {
  status: "idle" | "recording" | "review";
  elapsedSec: number;
  interrupted: boolean;
}

export interface ProtoState {
  variant: VariantKey;
  actorId: ActorId;
  pill: Pill;
  draftText: string;
  draftAttachments: DraftAttachment[];
  recorder: RecorderState;
  replyTo: string | null; // sourceId the composer is replying to
  sources: SourceMessage[];
  readBy: Record<string, ActorId[]>;
  processingMode: ProcessingMode;
  inspectorOpen: boolean;
  clockMinute: number; // frozen-clock minute counter for new sources
  nextSeq: number;
}

// Deterministic simulated links for newly sent sources (keyword heuristics).
function heuristictsFragments(text: string): Fragment[] {
  const lower = text.toLowerCase();
  const out: Fragment[] = [];
  const quote = (needle: string, pad = 18) => {
    const idx = lower.indexOf(needle);
    if (idx === -1) return text.slice(0, pad) + (text.length > pad ? "…" : "");
    const from = Math.max(0, idx - 6);
    const to = Math.min(text.length, idx + needle.length + 12);
    return text.slice(from, to).trim() + (to < text.length ? "…" : "");
  };
  if (lower.includes("kaczmark") || lower.includes("27") || lower.includes("wiatrak")) {
    out.push({
      id: `fr-new-${out.length}`,
      scope: "kaczmarek",
      quote: quote("wiatrak") !== "" ? quote(lower.includes("wiatrak") ? "wiatrak" : "kaczmark") : "cała wypowiedź",
      basis: "fragment tekstu",
    });
  }
  if (lower.includes("banan") || lower.includes("12") || lower.includes("płytk")) {
    out.push({ id: `fr-new-${out.length}`, scope: "banan", quote: quote("płytk"), basis: "fragment tekstu" });
  }
  if (out.length === 0) {
    out.push({ id: "fr-new-0", scope: "firma", quote: text.slice(0, 40) + (text.length > 40 ? "…" : ""), basis: "cała wypowiedź" });
  }
  return out;
}

function feedbackForFragments(fragments: Fragment[]): FeedbackItem[] {
  return fragments.map((f) => ({
    id: `fb-${f.id}`,
    scope: f.scope,
    text:
      f.scope === "firma"
        ? "Zapisano jako wiedzę firmy"
        : `Powiązano z projektem ${f.scope === "banan" ? "„Banan”" : "„Kaczmarek”"}`,
  }));
}

const timers = new Set<ReturnType<typeof setTimeout>>();

function schedule(ms: number, fn: () => void) {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
}

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

function initialState(variant: VariantKey): ProtoState {
  return {
    variant,
    actorId: "marek",
    pill: "auto",
    draftText: "",
    draftAttachments: [],
    recorder: { status: "idle", elapsedSec: 0, interrupted: false },
    replyTo: null,
    sources: SEED_SOURCES.map((s) => ({ ...s })),
    readBy: Object.fromEntries(Object.entries(SEED_READ_BY).map(([k, v]) => [k, [...v]])),
    processingMode: "normal",
    inspectorOpen: false,
    clockMinute: 0,
    nextSeq: 1,
  };
}

let state: ProtoState = initialState(readVariantFromUrl());
const listeners = new Set<() => void>();

function readVariantFromUrl(): VariantKey {
  const v = new URLSearchParams(window.location.search).get("variant");
  return v === "B" || v === "C" ? v : "A";
}

function set(next: Partial<ProtoState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function updateSource(id: string, patch: Partial<SourceMessage>) {
  set({ sources: state.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
}

export const store = {
  getState: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  setVariant(variant: VariantKey) {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", variant);
    window.history.replaceState(null, "", url);
    set({ variant });
  },

  reset() {
    clearTimers();
    const variant = state.variant;
    state = initialState(variant);
    for (const l of listeners) l();
  },

  setActor(actorId: ActorId) {
    set({ actorId });
  },

  setPill(pill: Pill) {
    set({ pill });
  },

  setDraftText(text: string) {
    set({ draftText: text });
  },

  setReplyTo(sourceId: string | null) {
    set({ replyTo: sourceId });
  },

  addPhoto() {
    const seq = state.nextSeq;
    const hues = [28, 210, 120, 340];
    set({
      nextSeq: seq + 1,
      draftAttachments: [
        ...state.draftAttachments,
        {
          id: `d-photo-${seq}`,
          kind: "photo",
          label: `IMG_44${70 + seq}.jpg`,
          hue: hues[seq % hues.length],
        },
      ],
    });
  },

  removeAttachment(id: string) {
    set({ draftAttachments: state.draftAttachments.filter((a) => a.id !== id) });
  },

  startRecording() {
    set({ recorder: { status: "recording", elapsedSec: 0, interrupted: false } });
    schedule(1000, function tick() {
      if (state.recorder.status !== "recording") return;
      set({ recorder: { ...state.recorder, elapsedSec: state.recorder.elapsedSec + 1 } });
      schedule(1000, tick);
    });
  },

  /** Simulation-only: stop abruptly; the partial fragment stays as a reviewable draft. */
  interruptRecording() {
    if (state.recorder.status !== "recording") return;
    const partial = Math.max(2, state.recorder.elapsedSec);
    set({ recorder: { status: "review", elapsedSec: partial, interrupted: true } });
  },

  stopRecording() {
    if (state.recorder.status !== "recording") return;
    const d = Math.max(1, state.recorder.elapsedSec);
    set({ recorder: { status: "review", elapsedSec: d, interrupted: false } });
  },

  discardRecording() {
    set({ recorder: { status: "idle", elapsedSec: 0, interrupted: false } });
  },

  setProcessingMode(processingMode: ProcessingMode) {
    set({ processingMode });
  },

  openInspector(open: boolean) {
    set({ inspectorOpen: open });
  },

  markRead(sourceId: string) {
    const who = state.actorId;
    const readers = state.readBy[sourceId] ?? [];
    if (readers.includes(who)) return;
    set({ readBy: { ...state.readBy, [sourceId]: [...readers, who] } });
  },

  /**
   * Send the current draft as one source. `from` is the conversation the
   * composer is in: after a send from the company conversation the pill
   * returns to Auto; inside a project the project pill stays selected.
   */
  send(from: "firma" | ProjectId) {
    const { draftText, draftAttachments, recorder, actorId, replyTo } = state;
    if (!draftText.trim() && draftAttachments.length === 0 && recorder.status !== "review") return;

    const seq = state.nextSeq;
    const id = `n${seq}`;
    // The reviewed recording joins text and photos as part of the same source.
    const withRecording =
      recorder.status === "review"
        ? [
            ...draftAttachments,
            {
              id: `d-audio-${seq}`,
              kind: "audio" as const,
              label: "Nagranie",
              durationSec: Math.max(1, recorder.elapsedSec),
              interrupted: recorder.interrupted,
            },
          ]
        : draftAttachments;
    const attachments = withRecording.map((a, i) =>
      a.kind === "audio"
        ? {
            id: `${id}-a${i}`,
            kind: "audio" as const,
            durationSec: a.durationSec ?? 8,
            transcript: "(symulacja — transkrypcja nagrania pojawi się po przetworzeniu)",
          }
        : {
            id: `${id}-p${i}`,
            kind: "photo" as const,
            label: a.label,
            caption: "zdjęcie z telefonu",
            hue: a.hue ?? 210,
            ocrText: null,
          }
    );

    const fragments = heuristictsFragments(draftText);
    const source: SourceMessage = {
      id,
      authorId: actorId,
      sentAt: frozenNow(state.clockMinute),
      text: draftText.trim(),
      attachments,
      status: "wysylanie",
      feedback: null,
      fragments,
      replyTo: replyTo
        ? {
            sourceId: replyTo,
            preview:
              state.sources.find((s) => s.id === replyTo)?.text.slice(0, 60).trim() + "…"
          }
        : null,
      waitingOffline: false,
    };

    set({
      nextSeq: seq + 1,
      clockMinute: state.clockMinute + 1,
      sources: [...state.sources, source],
      draftText: "",
      draftAttachments: [],
      recorder: { status: "idle", elapsedSec: 0, interrupted: false },
      replyTo: null,
      pill: from === "firma" ? "auto" : state.pill,
    });

    runSendPipeline(id);
  },

  /** Manual retry resumes the same source without creating a duplicate. */
  retry(id: string) {
    updateSource(id, { waitingOffline: false, status: "wysylanie" });
    runSendPipeline(id);
  },
};

function runSendPipeline(id: string) {
  const mode = () => state.processingMode;
  schedule(1400, () => {
    if (mode() === "offline") {
      updateSource(id, { status: "wysylanie", waitingOffline: true });
      return;
    }
    updateSource(id, { status: "zapisano" });
    schedule(2200, () => {
      const src = state.sources.find((s) => s.id === id);
      if (!src) return;
      if (mode() === "ai-fail") {
        // AI failure never removes the accepted source.
        updateSource(id, { status: "blad-przetwarzania" });
        return;
      }
      updateSource(id, {
        status: "opracowane",
        feedback: feedbackForFragments(src.fragments),
      });
    });
  });
}

export function useStore(): ProtoState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

export function statusLabel(status: SourceStatus, waitingOffline: boolean): string {
  if (status === "wysylanie") return waitingOffline ? "Czeka na połączenie — Ponów" : "Wysyłanie…";
  if (status === "zapisano") return "Zapisano · porządkowanie…";
  if (status === "porzadkowanie") return "Porządkowanie…";
  if (status === "opracowane") return "Zapisano";
  if (status === "blad-przetwarzania") return "Zapisano · przetwarzanie nieudane";
  return status;
}

export function actorName(id: ActorId): string {
  return ACTORS[id].short;
}
