// Variant B — „Warsztat”: a two-pane workbench. The left pane is always the
// conversation; the right pane is the live memory of the current context
// (Auto → firma knowledge + Co teraz, project pill → pamięć projektu).
// The pill switches the whole workspace: conversation projection + memory.
// Hypothesis: seeing current agreements beside the talk builds trust in the
// agent's memory. Tradeoff: split attention, more chrome on a phone.
import { useEffect, useRef, useState } from "react";
import {
  COMPANY,
  ProjectId,
  PROJECTS,
  SourceMessage,
  TODAY_ISO,
} from "../../data/fixtures";
import { Pill as PillType, store, useStore } from "../../state/store";
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
import "./warsztat.css";

export function WarsztatVariant() {
  const s = useStore();
  const [sourceModal, setSourceModal] = useState<{ id: string; highlight?: ProjectId | "firma" } | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const inProject = s.pill !== "auto";

  // One-line key facts for the mobile memory strip.
  const stripFacts = inProject
    ? s.findings[s.pill as ProjectId]
        .filter((f) => f.meaning || f.unknownNote)
        .slice(0, 2)
        .map((f) => `${f.label}: ${f.value}${f.unknownNote ? ` (${f.unknownNote})` : ""}`)
    : [`${coTerazItems().length} sprawy do urządzenia: zadania i pytania`];

  return (
    <div className="wb wb--root">
      <header className="wb__header">
        <div className="wb__brand">
          <h1>{inProject ? PROJECTS[s.pill as ProjectId].alias : "Rozmowa firmy"}</h1>
          <span className="wb__firm">
            {inProject ? `${PROJECTS[s.pill as ProjectId].address} · widok z Rozmowy firmy` : COMPANY.name}
          </span>
        </div>
        <div className="wb__header-right">
          <PillRow />
          <button className="wb__coteraz" onClick={() => store.setPill("auto")}>
            Co teraz <span className="wb__coteraz-count">{coTerazItems().length}</span>
          </button>
        </div>
      </header>

      <button className="wb__strip" onClick={() => setMemoryOpen(true)} aria-label="Otwórz pamięć kontekstu">
        <b>Pamięć:</b> {stripFacts.join(" · ")} <span className="wb__strip-more">więcej »</span>
      </button>

      <div className="wb__panes">
        <section className="wb__conv" aria-label="Rozmowa">
          <Stream setSourceModal={setSourceModal} />
          <Composer />
        </section>

        <aside className={`wb__memory ${memoryOpen ? "is-open" : ""}`} aria-label="Pamięć bieżącego kontekstu">
          <button className="wb__memory-close" onClick={() => setMemoryOpen(false)} aria-label="Zamknij pamięć">
            ✕ zamknij
          </button>
          <MemoryPanel setSourceModal={setSourceModal} />
        </aside>
      </div>

      {sourceModal && (
        <div className="wb__modal-scrim" onClick={() => setSourceModal(null)}>
          <div role="dialog" aria-modal="true" aria-label="Pełne źródło" onClick={(e) => e.stopPropagation()}>
            <button className="wb__modal-close" onClick={() => setSourceModal(null)} aria-label="Zamknij">
              ✕
            </button>
            <SourceDetail
              source={s.sources.find((x) => x.id === sourceModal.id)!}
              highlightScope={sourceModal.highlight}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Stream({ setSourceModal }: { setSourceModal: (m: { id: string; highlight?: ProjectId | "firma" }) => void }) {
  const s = useStore();
  const bottom = useRef<HTMLDivElement>(null);
  const projectId = s.pill === "auto" ? null : (s.pill as ProjectId);
  const visible = projectId
    ? s.sources.filter((src) => src.fragments.some((f) => f.scope === projectId))
    : s.sources;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [visible.length, s.pill]);

  const days: { key: string; items: SourceMessage[] }[] = [];
  for (const src of visible) {
    const k = dayKey(src.sentAt);
    const last = days[days.length - 1];
    if (last && last.key === k) last.items.push(src);
    else days.push({ key: k, items: [src] });
  }

  return (
    <main className="wb__stream">
      {projectId && (
        <p className="wb__projection-note">
          Widok wpisów Rozmowy firmy powiązanych z „{PROJECTS[projectId].alias}” — jeden oryginał, rzeczywisty autor.
        </p>
      )}
      {days.map((d) => (
        <section key={d.key}>
          <div className="day-divider">{dayLabel(d.key, TODAY_ISO)}</div>
          {d.items.map((m) => (
            <Row key={m.id} source={m} setSourceModal={setSourceModal} />
          ))}
        </section>
      ))}
      <div ref={bottom} />
    </main>
  );
}

function Row({ source, setSourceModal }: { source: SourceMessage; setSourceModal: (m: { id: string; highlight?: ProjectId | "firma" }) => void }) {
  const s = useStore();
  const unread = source.authorId !== s.actorId && !(s.readBy[source.id] ?? []).includes(s.actorId);
  const agent = source.authorId === "kiero";
  return (
    <article
      className={`wb__row ${agent ? "wb__row--agent" : ""} ${unread ? "wb__row--unread" : ""}`}
      onClick={() => unread && store.markRead(source.id)}
    >
      <div className="wb__row-rail">
        <AuthorMark actorId={source.authorId} />
        <span className="wb__row-time">{formatPlTime(source.sentAt)}</span>
      </div>
      <div className="wb__row-body">
        {source.replyTo && <ReplyPreview replyTo={source.replyTo} />}
        {source.text && <p className="wb__text">{source.text}</p>}
        <Attachments source={source} />
        <StatusLine source={source} />
        <AgentFeedback source={source} />
        <ProjectChips
          fragments={source.fragments}
          onOpenProject={(p) => store.setPill(p)}
        />
        <button
          className="wb__row-source"
          onClick={(e) => {
            e.stopPropagation();
            setSourceModal({ id: source.id, highlight: s.pill === "auto" ? undefined : (s.pill as ProjectId) });
          }}
        >
          źródło
        </button>
        {agent && (
          <button
            className="wb__row-answer"
            onClick={(e) => {
              e.stopPropagation();
              store.setReplyTo(source.id);
              (document.getElementById("wb-input") as HTMLTextAreaElement | null)?.focus();
            }}
          >
            Odpowiedz
          </button>
        )}
      </div>
    </article>
  );
}

function Composer() {
  const s = useStore();
  const from: "firma" | ProjectId = s.pill === "auto" ? "firma" : (s.pill as ProjectId);
  const canSend =
    s.draftText.trim().length > 0 || s.draftAttachments.length > 0 || s.recorder.status === "review";

  if (s.recorder.status === "recording") {
    return (
      <footer className="wb__composer wb__composer--recording" aria-label="Nagrywanie">
        <div className="wb__rec-console">
          <span className="wb__rec-label">NAGRYWANIE</span>
          <span className="wb__rec-timer">{mmss(s.recorder.elapsedSec)}</span>
          <Waveform active />
          <button className="wb__rec-stop" onClick={() => store.stopRecording()} aria-label="Zakończ nagrywanie">
            ⏹ Zakończ nagrywanie
          </button>
        </div>
        {s.draftText && <p className="wb__rec-draft">„{s.draftText}”</p>}
      </footer>
    );
  }

  return (
    <footer className="wb__composer" aria-label="Kompozytor">
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
      <div className="wb__input-row">
        <button className="wb__photo-btn" onClick={() => store.addPhoto()} aria-label="Dodaj zdjęcia">
          📷
        </button>
        <textarea
          id="wb-input"
          className="wb__input"
          placeholder={from === "firma" ? "Napisz do firmy… (kontekst: Auto)" : `Napisz w „${PROJECTS[from].alias}”…`}
          rows={1}
          value={s.draftText}
          onChange={(e) => store.setDraftText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) store.send(from);
          }}
        />
        <button
          className={`wb__mic ${canSend && s.recorder.status !== "review" ? "wb__mic--secondary" : ""}`}
          onClick={() => store.startRecording()}
          aria-label="Rozpocznij nagrywanie jednym dotknięciem"
        >
          🎙
        </button>
        {canSend && (
          <button className="wb__mic wb__send" onClick={() => store.send(from)} aria-label="Wyślij">
            Wyślij ▶
          </button>
        )}
      </div>
    </footer>
  );
}

/** Right pane (desktop) / overlay (mobile): live memory for the current context. */
function MemoryPanel({ setSourceModal }: { setSourceModal: (m: { id: string; highlight?: ProjectId | "firma" }) => void }) {
  const s = useStore();
  const projectId = s.pill === "auto" ? null : (s.pill as ProjectId);
  return (
    <>
      <header className="wb__memory-head">
        <h3>Pamięć</h3>
        <span className="wb__memory-ctx">{projectId ? PROJECTS[projectId].alias : "Firma — Co teraz"}</span>
      </header>
      <div className="wb__memory-body">
        {projectId ? (
          <>
            <p className="wb__proj-meta">
              {PROJECTS[projectId].scope} · klient: {PROJECTS[projectId].client} · etap: {PROJECTS[projectId].stage}
            </p>
            <ProjectSummary projectId={projectId} onOpenSource={(id) => setSourceModal({ id, highlight: projectId })} />
          </>
        ) : (
          <div className="wb__coteraz-list">
            <p className="wb__proj-meta">Zadania i pytania wymagające odpowiedzi — dla obu szefów.</p>
            {coTerazItems().map((it) => (
              <article key={it.id} className="wb__coteraz-item">
                <span className={`badge ${it.kind === "pytanie" ? "badge--unknown" : "badge--meaning"}`}>{it.kind}</span>
                <p className="wb__text">{it.text}</p>
                {it.projectId && (
                  <button className="wb__row-source" onClick={() => store.setPill(it.projectId as ProjectId)}>
                    {PROJECTS[it.projectId].alias} →
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export type { PillType };
