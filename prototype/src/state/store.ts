// In-memory scenario store with deterministic transitions and full reset.
// No persistence: the prototype checks interactions, not durability.
import { useSyncExternalStore } from "react";
import {
  ACTORS,
  ActorId,
  CalendarCopy,
  CalendarState,
  Clarification,
  FeedbackItem,
  Finding,
  Fragment,
  NotificationPrefs,
  ProjectId,
  SEED_CALENDAR,
  SEED_CLARIFICATIONS,
  SEED_EVENTS,
  SEED_FINDINGS,
  SEED_NOTIF,
  SEED_READ_BY,
  SEED_SOURCES,
  SEED_TASKS,
  SourceMessage,
  SourceStatus,
  Task,
  WorkEvent,
  frozenNow,
} from "../data/fixtures";

export type VariantKey = "A" | "B" | "C" | "D";
export type Pill = ProjectId | "auto";
export type ProcessingMode = "normal" | "ai-fail" | "offline" | "partial";

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

export interface GmRun {
  id: string;
  sourceId: string;
  stage: string;
  status: "failed" | "resolved";
  note: string;
}

export interface Invitation {
  id: string;
  email: string;
  status: "wysłane" | "cofnięte";
}

export type PwaStatus = "none" | "available" | "waiting" | "done";

export interface ProtoState {
  variant: VariantKey;
  actorId: ActorId;
  pill: Pill;
  draftText: string;
  draftAttachments: DraftAttachment[];
  recorder: RecorderState;
  replyTo: string | null;
  sources: SourceMessage[];
  readBy: Record<string, ActorId[]>;
  processingMode: ProcessingMode;
  inspectorOpen: boolean;
  clockMinute: number;
  nextSeq: number;
  findings: Record<ProjectId, Finding[]>;
  tasks: Task[];
  events: WorkEvent[];
  clarifications: Clarification[];
  calendar: CalendarState;
  notif: Record<ActorId, NotificationPrefs>;
  pwa: PwaStatus;
  gmRuns: GmRun[];
  invitations: Invitation[];
  accessRevoked: boolean;
}

// Frozen-clock weekday → concrete date mapping (2026-09-08 is a Tuesday).
const WEEKDAYS: [RegExp, string][] = [
  [/środ|srod/i, "środa 9.09.2026"],
  [/czwart/i, "czwartek 10.09.2026"],
  [/piąt|piat/i, "piątek 11.09.2026"],
  [/sobota/i, "sobota 12.09.2026"],
  [/niedziel/i, "niedziela 13.09.2026"],
  [/poniedział/i, "poniedziałek 14.09.2026"],
  [/wtor/i, "wtorek 15.09.2026"],
];

function detectWeekday(text: string): string | null {
  for (const [re, label] of WEEKDAYS) if (re.test(text)) return label;
  return null;
}

// Deterministic simulated links for newly sent sources (keyword heuristics).
function heuristictsFragments(text: string): Fragment[] {
  const lower = text.toLowerCase();
  const out: Fragment[] = [];
  const quote = (needle: string) => {
    const idx = lower.indexOf(needle);
    if (idx === -1) return text.slice(0, 18) + (text.length > 18 ? "…" : "");
    const from = Math.max(0, idx - 6);
    const to = Math.min(text.length, idx + needle.length + 12);
    return text.slice(from, to).trim() + (to < text.length ? "…" : "");
  };
  if (lower.includes("kaczmark") || lower.includes("27") || lower.includes("wiatrak") || lower.includes("blachark")) {
    out.push({ id: `fr-new-${out.length}`, scope: "kaczmarek", quote: quote("wiatrak"), basis: "fragment tekstu" });
  }
  if (lower.includes("banan") || lower.includes("płytk") || lower.includes("płytki")) {
    out.push({ id: `fr-new-${out.length}`, scope: "banan", quote: quote("płytk"), basis: "fragment tekstu" });
  }
  if (lower.includes("omega")) {
    out.push({ id: `fr-new-${out.length}`, scope: "omega", quote: quote("omega"), basis: "fragment tekstu" });
  }
  if (out.length === 0) {
    out.push({
      id: "fr-new-0",
      scope: "firma",
      quote: text.slice(0, 40) + (text.length > 40 ? "…" : ""),
      basis: "cała wypowiedź",
    });
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
        : `Powiązano z projektem ${f.scope === "banan" ? "„Banan”" : f.scope === "kaczmarek" ? "„Kaczmarek”" : "„Omega”"}`,
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
    findings: Object.fromEntries(
      Object.entries(SEED_FINDINGS).map(([k, v]) => [k, v.map((f) => ({ ...f, history: [...(f.history ?? [])] }))])
    ) as Record<ProjectId, Finding[]>,
    tasks: SEED_TASKS.map((t) => ({ ...t, checklistItems: t.checklistItems?.map((c) => ({ ...c })) })),
    events: SEED_EVENTS.map((e) => ({ ...e })),
    clarifications: SEED_CLARIFICATIONS.map((c) => ({ ...c })),
    calendar: {
      ...SEED_CALENDAR,
      copies: SEED_CALENDAR.copies.map((c) => ({ ...c, hiddenByActor: [...c.hiddenByActor] })),
    },
    notif: {
      marek: { ...SEED_NOTIF.marek },
      piotrek: { ...SEED_NOTIF.piotrek },
      kiero: { ...SEED_NOTIF.kiero },
    },
    pwa: "none",
    gmRuns: [],
    invitations: [{ id: "i1", email: "sekretariat@lex.pl", status: "wysłane" }],
    accessRevoked: false,
  };
}

let state: ProtoState = initialState(readVariantFromUrl());
const listeners = new Set<() => void>();

function readVariantFromUrl(): VariantKey {
  const v = new URLSearchParams(window.location.search).get("variant");
  return v === "A" || v === "B" || v === "C" ? v : "D";
}

function set(next: Partial<ProtoState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function updateSource(id: string, patch: Partial<SourceMessage>) {
  set({ sources: state.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
}

function updateFinding(projectId: ProjectId, findingId: string, patch: Partial<Finding>) {
  set({
    findings: {
      ...state.findings,
      [projectId]: state.findings[projectId].map((f) => (f.id === findingId ? { ...f, ...patch } : f)),
    },
  });
}

function appendFindingHistory(projectId: ProjectId, findingId: string, change: string, authorId: ActorId) {
  set({
    findings: {
      ...state.findings,
      [projectId]: state.findings[projectId].map((f) =>
        f.id === findingId
          ? {
              ...f,
              history: [...(f.history ?? []), { at: frozenNow(state.clockMinute), change, authorId }],
            }
          : f
      ),
    },
  });
}

function addAgentSource(text: string, replyTo: string | null, citesSourceIds?: string[]) {
  const seq = state.nextSeq;
  set({
    nextSeq: seq + 1,
    sources: [
      ...state.sources,
      {
        id: `k${seq}`,
        authorId: "kiero",
        sentAt: frozenNow(state.clockMinute),
        text,
        attachments: [],
        status: "opracowane",
        feedback: null,
        fragments: [],
        replyTo: replyTo
          ? { sourceId: replyTo, preview: (state.sources.find((s) => s.id === replyTo)?.text ?? "").slice(0, 60) + "…" }
          : null,
        citesSourceIds,
        waitingOffline: false,
      },
    ],
  });
}

function busy(): boolean {
  return state.recorder.status === "recording" || state.sources.some((s) => s.status === "wysylanie");
}

function checkPwaAfterSettle() {
  if (state.pwa === "waiting" && !busy()) set({ pwa: "available" });
}

/** Post an agent answer for question-like messages, citing the finding source. */
function maybeAnswerQuestion(id: string, text: string) {
  const t = text.toLowerCase();
  const isQuestion = /\?/.test(text) || /kiedy|o której|ile|czy /.test(t);
  if (!isQuestion) return;
  let answer: string | null = null;
  let cites: string[] | undefined;
  if (/płytk|dostaw/.test(t)) {
    const f = state.findings.banan.find((x) => x.id === "fd5")!;
    answer = `Dostawa płytek na Banana: ${f.value} (${f.meaning}).`;
    cites = ["s2"];
  } else if (/wiatrak|osłon/.test(t)) {
    const f = state.findings.kaczmarek.find((x) => x.id === "fd9")!;
    answer = `Montaż osłony przeciwwietrznej u Kaczmarka: ${f.value} (${f.meaning}), potwierdzony niezależnie przez Piotrka.`;
    cites = ["s2", "s4"];
  } else if (/cen|wycen|koszt|ile/.test(t)) {
    const f = state.findings.banan.find((x) => x.id === "fd4")!;
    answer = `Cena robocizny na Banana: ${f.value}${f.unknownNote ? " — podstawa podatku niepodana, zapytałem o to osobno" : ""}.`;
    cites = ["s3"];
  } else if (/blachark/.test(t)) {
    answer = "Termin dostawy blacharki jest sprzeczny (czwartek vs piątek) — potrzebuję odpowiedzi, zanim go zapiszę.";
    cites = ["s7", "s8"];
  }
  if (answer) schedule(2000, () => addAgentSource(answer, id, cites));
}

/** Explicit correction in a new message updates the current value, keeping history. */
function maybeApplyCorrection(id: string, text: string, scope: ProjectId | "auto") {
  if (!/zmieniam|zmieniamy|korekta|przesuwam|przesuwamy/i.test(text)) return null;
  const newDate = detectWeekday(text);
  if (!newDate) return null;
  const projectId: ProjectId =
    scope !== "auto" ? scope : /kaczmark|blachark|wiatrak/i.test(text) ? "kaczmarek" : "banan";
  const target =
    state.findings[projectId].find((f) => /płytk/i.test(text) && /dostaw/i.test(f.label)) ??
    state.findings[projectId].find((f) => /blachark/i.test(text) && /dostaw/i.test(f.label)) ??
    state.findings[projectId].find((f) => f.meaning === "uzgodniony" && /dostaw|termin|mont/i.test(f.label));
  if (!target) return null;
  const old = target.value;
  updateFinding(projectId, target.id, { value: newDate });
  appendFindingHistory(projectId, target.id, `${old} → ${newDate} (korekta w wiadomości)`, state.actorId);
  const extra: FeedbackItem = {
    id: `fb-corr-${id}`,
    scope: projectId,
    text: `Zmieniono ustalenie „${target.label}”: ${newDate} — historia zachowana`,
  };
  updateSource(id, {
    feedback: [...(state.sources.find((s) => s.id === id)?.feedback ?? []), extra],
  });
}

/** Replying to an agent clarification resolves it and updates memory. */
function maybeResolveClarification(id: string, text: string, replyTo: string | null) {
  const cl = state.clarifications.find((c) => c.status === "open" && c.questionSourceId === replyTo);
  if (!cl || !cl.projectId || !cl.findingId) return;
  const author = ACTORS[state.actorId].short;
  if (cl.kind === "tax") {
    const m = /netto|brutto/i.exec(text);
    if (!m) return;
    const basis = m[0].toLowerCase();
    const f = state.findings[cl.projectId].find((x) => x.id === cl.findingId)!;
    updateFinding(cl.projectId, cl.findingId, {
      value: `18 000 zł ${basis}`,
      unknownNote: null,
      sourceIds: [...f.sourceIds, id],
    });
    appendFindingHistory(cl.projectId, cl.findingId, `doprecyzowano podstawę: ${basis} (odpowiedź ${author})`, state.actorId);
    set({
      clarifications: state.clarifications.map((c) =>
        c.id === cl.id ? { ...c, status: "resolved", answer: basis, answeredBy: state.actorId } : c
      ),
    });
    schedule(1600, () =>
      addAgentSource(`Dziękuję — zapisano: cena robocizny na Banana to 18 000 zł ${basis}.`, id, ["s3"])
    );
  } else if (cl.kind === "date-conflict") {
    const d = detectWeekday(text);
    if (!d) return;
    const f = state.findings[cl.projectId].find((x) => x.id === cl.findingId)!;
    updateFinding(cl.projectId, cl.findingId, {
      value: d,
      meaning: "uzgodniony",
      unknownNote: null,
      sourceIds: [...f.sourceIds, id],
    });
    appendFindingHistory(cl.projectId, cl.findingId, `rozstrzygnięto sprzeczność: ${d} (odpowiedź ${author})`, state.actorId);
    set({
      clarifications: state.clarifications.map((c) =>
        c.id === cl.id ? { ...c, status: "resolved", answer: d, answeredBy: state.actorId } : c
      ),
    });
    schedule(1600, () =>
      addAgentSource(`Zapisano: blacharka dla Kaczmarka przyjeżdża ${d}. Przeliczam przypomnienia i kalendarz.`, id, ["s7", "s8"])
    );
  }
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
        { id: `d-photo-${seq}`, kind: "photo", label: `IMG_44${70 + seq}.jpg`, hue: hues[seq % hues.length] },
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
    checkPwaAfterSettle();
  },

  stopRecording() {
    if (state.recorder.status !== "recording") return;
    const d = Math.max(1, state.recorder.elapsedSec);
    set({ recorder: { status: "review", elapsedSec: d, interrupted: false } });
    checkPwaAfterSettle();
  },

  discardRecording() {
    set({ recorder: { status: "idle", elapsedSec: 0, interrupted: false } });
    checkPwaAfterSettle();
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

  /** Finish a pending image analysis after partial results were published. */
  finishImageAnalysis(sourceId: string) {
    const src = state.sources.find((s) => s.id === sourceId);
    if (!src) return;
    const kept = (src.feedback ?? []).filter((f) => f.id !== `fb-imgp-${sourceId}`);
    updateSource(sourceId, {
      imagePending: false,
      feedback: [
        ...kept,
        { id: `fb-img-${sourceId}`, scope: src.fragments[0]?.scope ?? "firma", text: "Dokończono analizę zdjęcia" },
      ],
    });
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
            preview: (state.sources.find((s) => s.id === replyTo)?.text ?? "").slice(0, 60).trim() + "…",
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

    maybeResolveClarification(id, draftText, replyTo);
    maybeApplyCorrection(id, draftText, from === "firma" ? "auto" : from);
    maybeAnswerQuestion(id, draftText);
    runSendPipeline(id);
  },

  /** Manual retry resumes the same source without creating a duplicate. */
  retry(id: string) {
    updateSource(id, { waitingOffline: false, status: "wysylanie" });
    runSendPipeline(id);
  },

  // ---------- tasks & checklist ----------

  toggleChecklistItem(taskId: string, itemId: string) {
    set({
      tasks: state.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              checklistItems: (t.checklistItems ?? []).map((c) =>
                c.id === itemId ? { ...c, done: !c.done } : c
              ),
            }
          : t
      ),
    });
  },

  /** Parent completion is independent of checklist completion. */
  completeTask(taskId: string) {
    set({
      tasks: state.tasks.map((t) =>
        t.id === taskId
          ? { ...t, state: t.state === "Wykonane" ? "Do zrobienia" : "Wykonane" }
          : t
      ),
    });
  },

  // ---------- memory: direct field edit (separate audited operation) ----------

  editFinding(projectId: ProjectId, findingId: string, newValue: string) {
    const f = state.findings[projectId].find((x) => x.id === findingId);
    if (!f || !newValue.trim() || newValue.trim() === f.value) return;
    updateFinding(projectId, findingId, { value: newValue.trim() });
    appendFindingHistory(projectId, findingId, `bezpośrednia poprawka: ${f.value} → ${newValue.trim()}`, state.actorId);
  },

  // ---------- notifications (personal) ----------

  setNotif(actorId: ActorId, patch: Partial<NotificationPrefs>) {
    set({ notif: { ...state.notif, [actorId]: { ...state.notif[actorId], ...patch } } });
  },

  // ---------- Google Calendar (one-way Kiero → Google) ----------

  calendarConnect() {
    set({ calendar: { ...state.calendar, connected: true, attention: false } });
  },

  calendarDisconnect() {
    set({ calendar: { ...state.calendar, connected: false } });
  },

  calendarReconnect() {
    set({ calendar: { ...state.calendar, attention: false } });
    const pend = state.calendar.copies.filter((c) => c.status === "blad" || c.status === "oczekuje");
    schedule(1200, () => {
      set({
        calendar: {
          ...state.calendar,
          copies: state.calendar.copies.map((c) =>
            pend.some((p) => p.id === c.id) ? { ...c, status: "zapisano" } : c
          ),
        },
      });
    });
  },

  calendarToggleScope(projectId: ProjectId) {
    const scopes = { ...state.calendar.scopes, [projectId]: !state.calendar.scopes[projectId] };
    set({
      calendar: {
        ...state.calendar,
        scopes,
        copies: state.calendar.copies.map((c) =>
          copyInScope(c, projectId) && c.status !== "blad" ? { ...c, status: "oczekuje" } : c
        ),
      },
    });
    schedule(1400, () => {
      set({
        calendar: {
          ...state.calendar,
          copies: state.calendar.copies.map((c) =>
            copyInScope(c, projectId) && c.status === "oczekuje" ? { ...c, status: "zapisano" } : c
          ),
        },
      });
    });
  },

  calendarHideCopy(copyId: string) {
    const who = state.actorId;
    set({
      calendar: {
        ...state.calendar,
        copies: state.calendar.copies.map((c) =>
          c.id === copyId && !c.hiddenByActor.includes(who) ? { ...c, hiddenByActor: [...c.hiddenByActor, who] } : c
        ),
      },
    });
  },

  calendarRestoreCopy(copyId: string) {
    const who = state.actorId;
    set({
      calendar: {
        ...state.calendar,
        copies: state.calendar.copies.map((c) =>
          c.id === copyId ? { ...c, hiddenByActor: c.hiddenByActor.filter((a) => a !== who) } : c
        ),
      },
    });
  },

  calendarRetryCopy(copyId: string) {
    set({
      calendar: {
        ...state.calendar,
        copies: state.calendar.copies.map((c) => (c.id === copyId ? { ...c, status: "oczekuje" } : c)),
      },
    });
    schedule(1300, () => {
      set({
        calendar: {
          ...state.calendar,
          copies: state.calendar.copies.map((c) => (c.id === copyId ? { ...c, status: "zapisano" } : c)),
        },
      });
    });
  },

  // ---------- PWA update (waits for a safe point) ----------

  requestPwaUpdate() {
    set({ pwa: busy() ? "waiting" : "available" });
  },

  activatePwaUpdate() {
    if (state.pwa !== "available") return;
    set({ pwa: "done" });
    schedule(2500, () => set({ pwa: "none" }));
  },

  // ---------- access & GM (audited alpha mode) ----------

  invite(email: string) {
    const seq = state.invitations.length + 1;
    set({ invitations: [...state.invitations, { id: `i${seq}`, email, status: "wysłane" }] });
  },

  revokeInvitation(id: string) {
    set({ invitations: state.invitations.map((i) => (i.id === id ? { ...i, status: "cofnięte" } : i)) });
  },

  simulateRevoked(on: boolean) {
    set({ accessRevoked: on });
  },

  gmRetry(runId: string) {
    const run = state.gmRuns.find((r) => r.id === runId);
    if (!run) return;
    if (state.processingMode === "ai-fail") {
      set({
        gmRuns: state.gmRuns.map((r) =>
          r.id === runId ? { ...r, note: `${r.note}; ponowna próba nieudana (tryb awarii wciąż aktywny)` } : r
        ),
      });
      return;
    }
    const src = state.sources.find((s) => s.id === run.sourceId);
    updateSource(run.sourceId, {
      status: "opracowane",
      feedback: src ? feedbackForFragments(src.fragments) : [],
    });
    set({
      gmRuns: state.gmRuns.map((r) =>
        r.id === runId ? { ...r, status: "resolved", note: `${r.note}; rozstrzygnięto ${frozenNow(state.clockMinute)} przez GM (audyt)` } : r
      ),
    });
  },
};

const PROJECT_LABEL: Record<ProjectId, string> = { banan: "Banan", kaczmarek: "Kaczmarek", omega: "Omega" };

function copyInScope(c: CalendarCopy, projectId: ProjectId): boolean {
  return c.title.includes(`— ${PROJECT_LABEL[projectId]}`);
}

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
        // AI failure never removes the accepted source; GM can retry the stage.
        updateSource(id, { status: "blad-przetwarzania" });
        set({
          gmRuns: [
            ...state.gmRuns,
            {
              id: `gm-${id}`,
              sourceId: id,
              stage: "analiza pamięci",
              status: "failed",
              note: `awaria ${frozenNow(state.clockMinute)}; autor: ${ACTORS[src.authorId].short}; odczyty szefów nietknięte`,
            },
          ],
        });
        return;
      }
      // Keep correction feedback that was appended before the pipeline finished.
      const correctionFeedback = (src.feedback ?? []).filter((f) => f.id.startsWith("fb-corr"));
      const feedback = [...feedbackForFragments(src.fragments), ...correctionFeedback];
      const hasPhotos = src.attachments.some((a) => a.kind === "photo");
      if (mode() === "partial" && hasPhotos) {
        updateSource(id, {
          status: "opracowane",
          imagePending: true,
          feedback: [
            ...feedback,
            { id: `fb-imgp-${id}`, scope: "firma", text: "Zdjęcie wciąż analizowane — wynik dopiszę przy wpisie" },
          ],
        });
      } else {
        updateSource(id, { status: "opracowane", feedback });
      }
      checkPwaAfterSettle();
    });
    checkPwaAfterSettle();
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
