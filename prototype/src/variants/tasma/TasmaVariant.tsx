// Variant A — „Taśma”: one continuous company conversation, classic messenger.
// Projects live in a pill row above the composer; summaries and project
// conversations open as overlay sheets. Hypothesis: zero-friction capture,
// everything within one thumb's reach. Tradeoff: current agreements are one
// extra tap away and the stream needs discipline to scan.
import { useEffect, useRef, useState } from "react";
import { ActorId, ACTORS, COMPANY, ProjectId, PROJECTS, SourceMessage, TODAY_ISO } from "../../data/fixtures";
import { store, useStore } from "../../state/store";
import {
  AgentFeedback,
  Attachments,
  AuthorMark,
  coTerazItems,
  dayKey,
  dayLabel,
  formatPlTime,
  ProjectChips,
  ProjectSummary,
  ReplyPreview,
  SourceDetail,
  StatusLine,
} from "../../shared/content/components";
import { DraftThumbs, mmss, PillRow, ReviewStrip, Waveform } from "../../shared/content/composer-parts";
import "./tasma.css";

type Sheet =
  | { kind: "none" }
  | { kind: "project"; projectId: ProjectId; tab: "rozmowa" | "podsumowanie" }
  | { kind: "coteraz" }
  | { kind: "source"; sourceId: string; highlight?: ProjectId | "firma"; back?: Sheet };

export function TasmaVariant() {
  const s = useStore();
  const [sheet, setSheet] = useState<Sheet>({ kind: "none" });

  return (
    <div className="ta ta--root">
      <header className="ta__header">
        <div className="ta__brand">
          <h1>Rozmowa firmy</h1>
          <span className="ta__firm">{COMPANY.name}</span>
        </div>
        <button className="ta__coteraz" onClick={() => setSheet({ kind: "coteraz" })}>
          Co teraz <span className="ta__coteraz-count">{coTerazItems().length}</span>
        </button>
      </header>

      <Stream onOpenProject={(p) => setSheet({ kind: "project", projectId: p, tab: "rozmowa" })} />

      <Composer
        onFocusInput={() => {
          /* input is focused directly by the caller */
        }}
      />

      {sheet.kind === "project" && (
        <ProjectSheet
          projectId={sheet.projectId}
          tab={sheet.tab}
          onTab={(tab) => setSheet({ kind: "project", projectId: sheet.projectId, tab })}
          onClose={() => setSheet({ kind: "none" })}
          onOpenSource={(sourceId, highlight) =>
            setSheet({ kind: "source", sourceId, highlight, back: sheet })
          }
        />
      )}
      {sheet.kind === "coteraz" && (
        <CoTerazSheet
          onClose={() => setSheet({ kind: "none" })}
          onOpenProject={(p) => setSheet({ kind: "project", projectId: p, tab: "rozmowa" })}
          onOpenSource={(id) => setSheet({ kind: "source", sourceId: id, back: sheet })}
        />
      )}
      {sheet.kind === "source" && (
        <SourceSheet
          sourceId={sheet.sourceId}
          highlight={sheet.highlight}
          onClose={() => setSheet(sheet.back ?? { kind: "none" })}
          onOpenProject={(p) => setSheet({ kind: "project", projectId: p, tab: "rozmowa" })}
        />
      )}
      {s.recorder.status === "recording" && null /* console rendered inside composer */}
    </div>
  );
}

function Stream({ onOpenProject }: { onOpenProject: (p: ProjectId) => void }) {
  const s = useStore();
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [s.sources.length]);

  const days: { key: string; items: SourceMessage[] }[] = [];
  for (const src of s.sources) {
    const k = dayKey(src.sentAt);
    const last = days[days.length - 1];
    if (last && last.key === k) last.items.push(src);
    else days.push({ key: k, items: [src] });
  }

  return (
    <main className="ta__stream" aria-label="Rozmowa firmy">
      {days.map((d) => {
        const unread = d.items.filter(
          (m) => m.authorId !== s.actorId && !(s.readBy[m.id] ?? []).includes(s.actorId)
        ).length;
        return (
          <section key={d.key} aria-label={dayLabel(d.key, TODAY_ISO)}>
            <div className="day-divider">
              {dayLabel(d.key, TODAY_ISO)}
              {unread > 0 && s.actorId !== undefined && <span className="unread-dot" title={`${unread} nieprzeczytanych`} />}
            </div>
            {d.items.map((m) => (
              <Bubble key={m.id} source={m} onOpenProject={onOpenProject} />
            ))}
          </section>
        );
      })}
      <div ref={bottom} />
    </main>
  );
}

function Bubble({ source, onOpenProject }: { source: SourceMessage; onOpenProject: (p: ProjectId) => void }) {
  const s = useStore();
  const mine = source.authorId === s.actorId;
  const agent = source.authorId === "kiero";
  const unread = !mine && !(s.readBy[source.id] ?? []).includes(s.actorId);

  return (
    <article
      className={`ta__msg ${mine ? "ta__msg--mine" : "ta__msg--theirs"} ${agent ? "ta__msg--agent" : ""}`}
      onClick={() => unread && store.markRead(source.id)}
    >
      <div className="ta__msg-row">
        {!mine && <AuthorMark actorId={source.authorId} />}
        <div className="ta__bubble">
          <span className="ta__msg-meta">
            {ACTORS[source.authorId].short} · {formatPlTime(source.sentAt)}
            {unread && <span className="unread-dot" style={{ display: "inline-block", marginLeft: 6 }} />}
          </span>
          {source.replyTo && <ReplyPreview replyTo={source.replyTo} />}
          {source.text && <p className="ta__text">{source.text}</p>}
          <Attachments source={source} />
          <StatusLine source={source} />
          <AgentFeedback source={source} />
          <ProjectChips fragments={source.fragments} onOpenProject={onOpenProject} />
          {agent && (
            <div className="ta__agent-actions">
              <button
                className="ta__answer"
                onClick={(e) => {
                  e.stopPropagation();
                  store.setReplyTo(source.id);
                  (document.getElementById("ta-input") as HTMLTextAreaElement | null)?.focus();
                }}
              >
                Odpowiedz
              </button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function Composer({ onFocusInput }: { onFocusInput: () => void }) {
  void onFocusInput;
  const s = useStore();
  const [autoHint, setAutoHint] = useState(false);
  const canSend =
    s.draftText.trim().length > 0 || s.draftAttachments.length > 0 || s.recorder.status === "review";

  const doSend = () => {
    const wasPill = s.pill;
    store.send("firma");
    if (wasPill !== "auto") {
      setAutoHint(true);
      setTimeout(() => setAutoHint(false), 2600);
    }
  };

  if (s.recorder.status === "recording") {
    return (
      <footer className="ta__composer ta__composer--recording" aria-label="Nagrywanie">
        <span className="ta__rec-dot" aria-hidden="true" />
        <Waveform active />
        <span className="ta__rec-timer">{mmss(s.recorder.elapsedSec)}</span>
        <button className="ta__rec-stop" onClick={() => store.stopRecording()} aria-label="Zakończ nagrywanie">
          ⏹ Zakończ
        </button>
      </footer>
    );
  }

  return (
    <footer className="ta__composer" aria-label="Pisz, nagraj lub dodaj zdjęcia">
      <PillRow />
      {autoHint && <p className="ta__auto-hint">Wysłano — kontekst wrócił na „Auto”, kolejna myśl nie odziedziczy budowy.</p>}
      {s.replyTo && (
        <div className="reply-preview">
          Odpowiadasz na: {s.sources.find((x) => x.id === s.replyTo)?.text.slice(0, 48)}…{" "}
          <button className="retry-btn" onClick={() => store.setReplyTo(null)}>
            anuluj
          </button>
        </div>
      )}
      {s.recorder.status === "review" && (
        <ReviewStrip durationSec={s.recorder.elapsedSec} interrupted={s.recorder.interrupted} />
      )}
      <DraftThumbs attachments={s.draftAttachments} onRemove={(id) => store.removeAttachment(id)} />
      <div className="ta__input-row">
        <button className="ta__photo-btn" onClick={() => store.addPhoto()} aria-label="Dodaj zdjęcia">
          📷
        </button>
        <textarea
          id="ta-input"
          className="ta__input"
          placeholder="Napisz do firmy…"
          rows={1}
          value={s.draftText}
          onChange={(e) => store.setDraftText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) doSend();
          }}
        />
        <button
          className={`ta__mic ${canSend && s.recorder.status !== "review" ? "ta__mic--secondary" : ""}`}
          onClick={() => store.startRecording()}
          aria-label="Rozpocznij nagrywanie jednym dotknięciem"
        >
          🎙
        </button>
        {canSend && (
          <button className="ta__mic ta__send" onClick={doSend} aria-label="Wyślij">
            Wyślij ▶
          </button>
        )}
      </div>
    </footer>
  );
}

function SheetShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="ta__sheet-scrim" onClick={onClose}>
      <section
        className="ta__sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ta__sheet-head">
          <button className="ta__sheet-close" onClick={onClose} aria-label="Zamknij">
            ✕
          </button>
          <h2>{title}</h2>
        </header>
        {children}
      </section>
    </div>
  );
}

function ProjectSheet({
  projectId,
  tab,
  onTab,
  onClose,
  onOpenSource,
}: {
  projectId: ProjectId;
  tab: "rozmowa" | "podsumowanie";
  onTab: (t: "rozmowa" | "podsumowanie") => void;
  onClose: () => void;
  onOpenSource: (sourceId: string, highlight?: ProjectId | "firma") => void;
}) {
  const s = useStore();
  const project = PROJECTS[projectId];
  const linked = s.sources.filter((src) => src.fragments.some((f) => f.scope === projectId));
  const canSend =
    s.draftText.trim().length > 0 || s.draftAttachments.length > 0 || s.recorder.status === "review";

  return (
    <SheetShell title={`${project.alias} — ${project.address}`} onClose={onClose}>
      <div className="ta__tabs" role="tablist">
        <button role="tab" aria-selected={tab === "rozmowa"} className={tab === "rozmowa" ? "is-on" : ""} onClick={() => onTab("rozmowa")}>
          Rozmowa
        </button>
        <button
          role="tab"
          aria-selected={tab === "podsumowanie"}
          className={tab === "podsumowanie" ? "is-on" : ""}
          onClick={() => onTab("podsumowanie")}
        >
          Podsumowanie
        </button>
      </div>

      {tab === "podsumowanie" ? (
        <div className="ta__sheet-body">
          <p className="ta__proj-meta">
            {project.scope} · klient: {project.client} · etap: {project.stage}
          </p>
          <ProjectSummary projectId={projectId} onOpenSource={(id) => onOpenSource(id, projectId)} />
        </div>
      ) : (
        <>
          <div className="ta__sheet-body ta__sheet-body--stream">
            <p className="ta__proj-meta">
              Widok wpisów Rozmowy firmy powiązanych z „{project.alias}”. Jeden oryginał, rzeczywisty autor.
            </p>
            {linked.map((src) => (
              <article key={src.id} className="ta__proj-item">
                <span className="ta__msg-meta">
                  {ACTORS[src.authorId].short} · {formatPlTime(src.sentAt)}
                </span>
                <p className="ta__text">{src.text || "(nagranie/zdjęcia)"}</p>
                <Attachments source={src} />
                <ProjectChips fragments={src.fragments} onOpenProject={() => onOpenSource(src.id, projectId)} />
                <button className="ta__open-source" onClick={() => onOpenSource(src.id, projectId)}>
                  Otwórz pełne źródło
                </button>
              </article>
            ))}
          </div>
          <footer className="ta__composer ta__composer--project">
            <span className="pill pill--on">{project.alias}</span>
            {s.recorder.status === "review" && (
              <ReviewStrip durationSec={s.recorder.elapsedSec} interrupted={s.recorder.interrupted} />
            )}
            <DraftThumbs attachments={s.draftAttachments} onRemove={(id) => store.removeAttachment(id)} />
            <div className="ta__input-row">
              <button className="ta__photo-btn" onClick={() => store.addPhoto()} aria-label="Dodaj zdjęcia">
                📷
              </button>
              <textarea
                className="ta__input"
                placeholder={`Napisz w „${project.alias}”…`}
                rows={1}
                value={s.draftText}
                onChange={(e) => store.setDraftText(e.target.value)}
              />
              <button
                className={`ta__mic ${canSend && s.recorder.status !== "review" ? "ta__mic--secondary" : ""}`}
                onClick={() => store.startRecording()}
                aria-label="Rozpocznij nagrywanie jednym dotknięciem"
              >
                🎙
              </button>
              {canSend && (
                <button className="ta__mic ta__send" onClick={() => store.send(projectId)} aria-label="Wyślij">
                  Wyślij ▶
                </button>
              )}
            </div>
          </footer>
        </>
      )}
    </SheetShell>
  );
}

function CoTerazSheet({
  onClose,
  onOpenProject,
  onOpenSource,
}: {
  onClose: () => void;
  onOpenProject: (p: ProjectId) => void;
  onOpenSource: (id: string) => void;
}) {
  const items = coTerazItems();
  return (
    <SheetShell title="Co teraz" onClose={onClose}>
      <div className="ta__sheet-body">
        {items.map((it) => (
          <article key={it.id} className="ta__cotrz-item">
            <span className={`badge ${it.kind === "pytanie" ? "badge--unknown" : "badge--meaning"}`}>{it.kind}</span>
            <p className="ta__text">{it.text}</p>
            {it.projectId && (
              <button className="ta__open-source" onClick={() => onOpenProject(it.projectId as ProjectId)}>
                Przejdź do {PROJECTS[it.projectId].alias}
              </button>
            )}
            {it.kind === "pytanie" && (
              <button className="ta__open-source" onClick={() => onOpenSource("s3")}>
                Otwórz źródło ustalenia
              </button>
            )}
          </article>
        ))}
      </div>
    </SheetShell>
  );
}

function SourceSheet({
  sourceId,
  highlight,
  onClose,
  onOpenProject,
}: {
  sourceId: string;
  highlight?: ProjectId | "firma";
  onClose: () => void;
  onOpenProject: (p: ProjectId) => void;
}) {
  const src = useStore().sources.find((x) => x.id === sourceId);
  if (!src) return null;
  return (
    <SheetShell title="Pełne źródło" onClose={onClose}>
      <div className="ta__sheet-body">
        <SourceDetail source={src} highlightScope={highlight} />
        <ProjectChips fragments={src.fragments} onOpenProject={onOpenProject} />
      </div>
    </SheetShell>
  );
}

export type { ActorId };
