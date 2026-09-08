// Shared product-content components used by all variants.
// These render the SAME contract facts (sources, fragments, findings) so the
// variants differ in structure and navigation, not in product semantics.
import { useEffect, useRef, useState } from "react";
import {
  ACTORS,
  Attachment,
  EVENTS,
  FeedbackItem,
  FINDINGS,
  Finding,
  Fragment,
  ProjectId,
  PROJECTS,
  SourceMessage,
  TASKS,
  Task,
  WorkEvent,
} from "../../data/fixtures";
import { statusLabel, store, useStore } from "../../state/store";

export function scopeName(scope: ProjectId | "firma"): string {
  if (scope === "firma") return "Wiedza firmy";
  return PROJECTS[scope].alias;
}

export function AuthorMark({ actorId, size = 28 }: { actorId: keyof typeof ACTORS; size?: number }) {
  const a = ACTORS[actorId];
  const isAgent = a.role === "agent";
  return (
    <span
      className="author-mark"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        fontSize: size * 0.38,
        fontWeight: 800,
        flex: "none",
        background: isAgent ? "var(--ink)" : "var(--them)",
        border: isAgent ? "none" : "1px solid var(--line-strong)",
        color: isAgent ? "#fff" : "var(--ink-2)",
      }}
      aria-hidden="true"
    >
      {isAgent ? "K" : a.initials}
    </span>
  );
}

/** Deterministic inline SVG placeholder for a source photo. */
export function PhotoSvg({ hue, size = 84, caption }: { hue: number; size?: number; caption?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 84 84" role="img" aria-label={caption ?? "zdjęcie"}>
      <rect width="84" height="84" fill={`hsl(${hue} 18% 62%)`} />
      <rect x="10" y="10" width="64" height="64" fill={`hsl(${hue} 22% 74%)`} />
      <path d="M10 58 L34 36 L50 52 L62 42 L74 54 L74 74 L10 74 Z" fill={`hsl(${hue} 24% 46%)`} />
      <circle cx="62" cy="24" r="7" fill={`hsl(${hue} 45% 84%)`} />
    </svg>
  );
}

/** Simulated audio player — progress is fake and purely local. */
export function AudioPlayer({ id, durationSec }: { id: string; durationSec: number }) {
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!playing) {
      if (timer.current) clearInterval(timer.current);
      return;
    }
    timer.current = setInterval(() => {
      setPos((p) => {
        if (p + 0.25 >= durationSec) {
          setPlaying(false);
          return 0;
        }
        return p + 0.25;
      });
    }, 250);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [playing, durationSec]);

  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  return (
    <div className="audio-bubble">
      <button
        className="audio-bubble__play"
        onClick={() => setPlaying((p) => !p)}
        aria-label={playing ? `Pauza nagrania ${id}` : `Odtwórz nagranie ${id}`}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <div className="audio-bubble__meta">
        <div className="audio-bubble__track" role="progressbar" aria-valuenow={pos} aria-valuemax={durationSec}>
          <div className="audio-bubble__fill" style={{ width: `${(pos / durationSec) * 100}%` }} />
        </div>
        <div className="audio-bubble__row">
          <span>{playing ? mmss(pos) : mmss(0)}</span>
          <span>{mmss(durationSec)}</span>
        </div>
      </div>
    </div>
  );
}

export function Attachments({ source }: { source: SourceMessage }) {
  if (source.attachments.length === 0) return null;
  const audio = source.attachments.filter((a): a is Extract<Attachment, { kind: "audio" }> => a.kind === "audio");
  const photos = source.attachments.filter((a): a is Extract<Attachment, { kind: "photo" }> => a.kind === "photo");
  return (
    <div className="msg-attachments">
      {audio.map((a) => (
        <AudioPlayer key={a.id} id={a.id} durationSec={a.durationSec} />
      ))}
      {photos.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {photos.map((p) => (
            <span className="photo-thumb" key={p.id} title={p.caption}>
              <PhotoSvg hue={p.hue} caption={p.caption} size={84} />
              <span className="photo-thumb__label">{p.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReplyPreview({ replyTo }: { replyTo: NonNullable<SourceMessage["replyTo"]> }) {
  const src = useStore().sources.find((s) => s.id === replyTo.sourceId);
  if (!src) return null;
  return (
    <div className="reply-preview">
      <b>Odpowiedź na — {ACTORS[src.authorId].short}:</b> {replyTo.preview}
    </div>
  );
}

export function StatusLine({ source }: { source: SourceMessage }) {
  const mine = useStore().actorId === source.authorId;
  if (!mine) return null;
  const label = statusLabel(source.status, source.waitingOffline);
  const cls =
    source.status === "wysylanie" ? "dot--sending" : source.status === "blad-przetwarzania" ? "dot--err" : "dot--ok";
  return (
    <div className="status-line">
      <span className={`dot ${cls}`} />
      {label}
      {source.waitingOffline && (
        <button className="retry-btn" onClick={() => store.retry(source.id)}>
          Ponów
        </button>
      )}
      {source.status === "blad-przetwarzania" && (
        <span>źródło zapisane — Kiero ponowi przetwarzanie</span>
      )}
    </div>
  );
}

/** Concise expandable agent feedback near the source (full bubble is for questions). */
export function AgentFeedback({ source }: { source: SourceMessage }) {
  if (source.authorId === "kiero") return null; // full agent bubbles stay full
  if (source.feedback === null) {
    return (
      <div className="status-line">
        <span className="dot dot--sending" /> Kiero porządkuje…
      </div>
    );
  }
  if (source.feedback.length === 0) {
    return (
      <div className="status-line">
        <span className="dot dot--ok" /> Zapisano w rozmowie firmy — bez zmian w pamięci
      </div>
    );
  }
  return (
    <details className="agent-feedback">
      <summary>
        Kiero: {source.feedback.length === 1 ? source.feedback[0].text : `${source.feedback.length} ustalenia`}
      </summary>
      <ul>
        {source.feedback.map((f: FeedbackItem) => (
          <li key={f.id}>
            <span className="chip" aria-hidden="true">
              {scopeName(f.scope)}
            </span>
            {f.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Project chips under a message: links to the project conversation (projection). */
export function ProjectChips({
  fragments,
  onOpenProject,
}: {
  fragments: Fragment[];
  onOpenProject: (p: ProjectId) => void;
}) {
  const scopes = [...new Set(fragments.map((f) => f.scope))].filter((s) => s !== "firma");
  if (scopes.length === 0) return null;
  return (
    <div className="chip-row">
      {scopes.map((s) => (
        <button key={s} className="chip chip--accent" onClick={() => onOpenProject(s as ProjectId)}>
          → {PROJECTS[s as ProjectId].alias}
        </button>
      ))}
    </div>
  );
}

/** Full immutable source with its linked fragments; highlight one project scope. */
export function SourceDetail({
  source,
  highlightScope,
}: {
  source: SourceMessage;
  highlightScope?: ProjectId | "firma";
}) {
  const status = useStore();
  return (
    <article className="source-detail" aria-label="Pełne źródło">
      <header className="source-detail__head">
        <AuthorMark actorId={source.authorId} size={22} />
        <strong>{ACTORS[source.authorId].short}</strong>
        <time>{formatPlDateTime(source.sentAt)}</time>
      </header>
      {source.replyTo && <ReplyPreview replyTo={source.replyTo} />}
      <p className="source-detail__text">{source.text || "(wpis bez tekstu — nagranie/zdjęcia)"}</p>
      <Attachments source={source} />
      {source.attachments
        .filter((a) => a.kind === "audio")
        .map((a) => (
          <details className="transcript" key={a.id}>
            <summary>Transkrypcja nagrania</summary>
            {(a as Extract<Attachment, { kind: "audio" }>).transcript}
          </details>
        ))}
      <StatusLine source={source} />
      {source.fragments.length > 0 && (
        <section aria-label="Powiązane fragmenty">
          {source.fragments.map((f) => (
            <div
              key={f.id}
              className={`fragment-card${highlightScope && f.scope === highlightScope ? " fragment-card--match" : ""}`}
            >
              <span className="fragment-card__scope">{scopeName(f.scope)}</span>
              <span className="fragment-card__quote">„{f.quote}”</span>
              <span className="fragment-card__basis">podstawa: {f.basis}</span>
            </div>
          ))}
        </section>
      )}
      {status.processingMode === "ai-fail" && source.status === "blad-przetwarzania" && (
        <p className="status-line">
          <span className="dot dot--err" /> Awaria przetwarzania — źródło pozostaje zapisane (oddzielone od analizy).
        </p>
      )}
    </article>
  );
}

/** Pamięć projektu: current findings with sources and explicit gaps. */
export function ProjectSummary({
  projectId,
  onOpenSource,
}: {
  projectId: ProjectId;
  onOpenSource: (sourceId: string) => void;
}) {
  const findings = FINDINGS[projectId];
  const tasks = TASKS.filter((t) => t.projectId === projectId);
  const events = EVENTS.filter((e) => e.projectId === projectId);
  const sources = useStore().sources;

  const sourcePreview = (id: string) => {
    const s = sources.find((x) => x.id === id);
    if (!s) return null;
    return (
      <button className="finding__source-link" onClick={() => onOpenSource(id)}>
        źródło: {ACTORS[s.authorId].short}, {formatPlShortDate(s.sentAt)}
      </button>
    );
  };

  return (
    <div className="summary">
      <section className="summary__section" aria-label="Ustalenia">
        <h4>Ustalenia</h4>
        {findings.map((f: Finding) => (
          <div className="finding" key={f.id}>
            <div className="finding__top">
              <span className="finding__label">{f.label}</span>
              {f.meaning && <span className="badge badge--meaning">{f.meaning}</span>}
              {f.unknownNote && <span className="badge badge--unknown">{f.unknownNote}</span>}
              {f.corroboration && <span className="badge badge--corroborated">{f.corroboration}</span>}
            </div>
            <span className="finding__value">{f.value}</span>
            {f.sourceIds.length > 0 ? f.sourceIds.map(sourcePreview) : (
              <span className="finding__source-link" style={{ textDecoration: "none", cursor: "default" }}>
                ustalone przy zakładaniu projektu
              </span>
            )}
          </div>
        ))}
      </section>

      <section className="summary__section" aria-label="Zadania">
        <h4>Zadania</h4>
        {tasks.map((t: Task) => (
          <div className="finding" key={t.id}>
            <div className="finding__top">
              <span className="finding__value" style={{ fontWeight: 600 }}>
                {t.title}
              </span>
              <span className="badge badge--meaning">{t.state}</span>
            </div>
            <span className="finding__source-link" style={{ textDecoration: "none", cursor: "default" }}>
              wykonawca: {t.executor} · koordynator: {ACTORS[t.coordinator].short} · termin: {formatPlIsoDate(t.due)}
            </span>
          </div>
        ))}
        {tasks.length === 0 && <p className="finding__source-link">Brak zadań.</p>}
      </section>

      <section className="summary__section" aria-label="Zdarzenia">
        <h4>Zdarzenia</h4>
        {events.map((e: WorkEvent) => (
          <div className="finding" key={e.id}>
            <div className="finding__top">
              <span className="finding__value" style={{ fontWeight: 600 }}>
                {e.title}
              </span>
              <span className="badge badge--meaning">{e.state}</span>
            </div>
            <span className="finding__source-link" style={{ textDecoration: "none", cursor: "default" }}>
              {e.when}
            </span>
          </div>
        ))}
        {events.length === 0 && <p className="finding__source-link">Brak zdarzeń.</p>}
      </section>
    </div>
  );
}

// ---------- Polish date/time helpers (frozen Europe/Warsaw scenario clock) ----------

const dateFmt = new Intl.DateTimeFormat("pl-PL", { weekday: "long", day: "numeric", month: "long" });
const timeFmt = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" });

export function formatPlTime(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function formatPlDate(iso: string): string {
  return dateFmt.format(new Date(iso));
}

export function formatPlShortDate(iso: string): string {
  return new Intl.DateTimeFormat("pl-PL", { day: "numeric", month: "numeric" }).format(new Date(iso));
}

export function formatPlIsoDate(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  return new Intl.DateTimeFormat("pl-PL", { weekday: "short", day: "numeric", month: "numeric" }).format(d);
}

export function formatPlDateTime(iso: string): string {
  return `${formatPlDate(iso)}, ${formatPlTime(iso)}`;
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Group messages by day; label today with the frozen clock. */
export function dayLabel(key: string, todayIso: string): string {
  if (key === todayIso) return `dziś, ${dateFmt.format(new Date(key + "T12:00:00"))}`;
  return dateFmt.format(new Date(key + "T12:00:00"));
}

/** Co teraz: open tasks + open clarification questions (shared fixture-level view). */
export function coTerazItems(): { id: string; kind: "zadanie" | "pytanie"; text: string; projectId?: ProjectId }[] {
  return [
    ...TASKS.filter((t) => t.state !== "Wykonane").map((t) => ({
      id: t.id,
      kind: "zadanie" as const,
      text: `${t.title} — ${t.executor}, termin ${formatPlIsoDate(t.due)}`,
      projectId: t.projectId,
    })),
    {
      id: "q1",
      kind: "pytanie" as const,
      text: "Podstawa podatku ceny robocizny 18 000 zł (Banan): netto czy brutto?",
      projectId: "banan",
    },
  ];
}
