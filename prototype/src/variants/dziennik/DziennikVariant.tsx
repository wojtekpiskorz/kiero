// Variant C — „Dziennik budowy”: the conversation reads as the firm's work
// journal. Day sections, time-gutter entries, and inline digest cards where
// the agent organized something. Capture is a calm slim bar that starts
// recording with one tap and expands only when needed. Hypothesis: the stream
// itself becomes an auditable record of what happened and what Kiero made of
// it. Tradeoff: denser than a messenger, text entry costs one extra tap.
import { useEffect, useRef, useState } from "react";
import {
  ACTORS,
  COMPANY,
  FeedbackItem,
  ProjectId,
  PROJECTS,
  SourceMessage,
  TODAY_ISO,
} from "../../data/fixtures";
import { store, useStore } from "../../state/store";
import {
  AgentFeedback,
  Attachments,
  AuthorMark,
  coTerazItems,
  dayKey,
  dayLabel,
  formatPlTime,
  ProjectSummary,
  ReplyPreview,
  SourceDetail,
  StatusLine,
} from "../../shared/content/components";
import { DraftThumbs, mmss, PillRow, ReviewStrip, Waveform } from "../../shared/content/composer-parts";
import "./dziennik.css";

type Filter = "all" | ProjectId;

export function DziennikVariant() {
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState(false); // capture bar expansion
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [projectCard, setProjectCard] = useState<ProjectId | null>(null);

  const applyFilter = (f: Filter) => {
    setFilter(f);
    store.setPill(f === "all" ? "auto" : f);
  };

  return (
    <div className="dz dz--root">
      <header className="dz__header">
        <div className="dz__brand">
          <h1>Dziennik firmy</h1>
          <span className="dz__firm">{COMPANY.name} · wtorek, 8 września 2026</span>
        </div>
        <div className="dz__filters" role="radiogroup" aria-label="Filtr projektu">
          <button
            role="radio"
            aria-checked={filter === "all"}
            className={`dz__filter ${filter === "all" ? "is-on" : ""}`}
            onClick={() => applyFilter("all")}
          >
            Wszystko
          </button>
          {(["banan", "kaczmarek"] as ProjectId[]).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={filter === p}
              className={`dz__filter ${filter === p ? "is-on" : ""}`}
              onClick={() => applyFilter(p)}
            >
              {PROJECTS[p].alias}
            </button>
          ))}
          {filter !== "all" && (
            <button className="dz__filter dz__filter--card" onClick={() => setProjectCard(filter)}>
              Karta projektu »
            </button>
          )}
        </div>
      </header>

      <Journal
        filter={filter}
        openSource={openSource}
        setOpenSource={setOpenSource}
        setProjectCard={setProjectCard}
      />

      <CaptureBar
        expanded={expanded}
        setExpanded={setExpanded}
      />

      {projectCard && (
        <div className="dz__card-scrim" onClick={() => setProjectCard(null)}>
          <section
            className="dz__card-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`Karta projektu ${PROJECTS[projectCard].alias}`}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="dz__card-head">
              <h2>
                {PROJECTS[projectCard].alias} — {PROJECTS[projectCard].address}
              </h2>
              <button className="dz__card-close" onClick={() => setProjectCard(null)} aria-label="Zamknij kartę">
                ✕
              </button>
            </header>
            <p className="dz__proj-meta">
              {PROJECTS[projectCard].scope} · klient: {PROJECTS[projectCard].client} · etap: {PROJECTS[projectCard].stage}
            </p>
            <div className="dz__card-body">
              <ProjectSummary projectId={projectCard} onOpenSource={(id) => {
                setProjectCard(null);
                setOpenSource(id);
              }} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function Journal({
  filter,
  openSource,
  setOpenSource,
  setProjectCard,
}: {
  filter: Filter;
  openSource: string | null;
  setOpenSource: (id: string | null) => void;
  setProjectCard: (p: ProjectId | null) => void;
}) {
  const s = useStore();
  const bottom = useRef<HTMLDivElement>(null);
  const visible = filter === "all"
    ? s.sources
    : s.sources.filter((src) => src.fragments.some((f) => f.scope === filter));

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [visible.length, filter]);

  const days: { key: string; items: SourceMessage[] }[] = [];
  for (const src of visible) {
    const k = dayKey(src.sentAt);
    const last = days[days.length - 1];
    if (last && last.key === k) last.items.push(src);
    else days.push({ key: k, items: [src] });
  }

  return (
    <main className="dz__journal">
      {days.map((d) => (
        <section key={d.key} aria-label={dayLabel(d.key, TODAY_ISO)}>
          <div className="dz__day">
            <span className="dz__day-label">{dayLabel(d.key, TODAY_ISO)}</span>
            <span className="dz__day-count">
              {d.items.length} {d.items.length === 1 ? "wpis" : "wpisów"}
            </span>
          </div>
          {d.key === TODAY_ISO && filter === "all" && <CoTerazCard setProjectCard={setProjectCard} />}
          {d.items.map((m) => (
            <JournalRow
              key={m.id}
              source={m}
              open={openSource === m.id}
              onToggle={() => setOpenSource(openSource === m.id ? null : m.id)}
              setProjectCard={setProjectCard}
            />
          ))}
        </section>
      ))}
      <div ref={bottom} />
    </main>
  );
}

function CoTerazCard({ setProjectCard }: { setProjectCard: (p: ProjectId | null) => void }) {
  const items = coTerazItems();
  return (
    <article className="dz__digest dz__digest--cotrz">
      <header>
        <h3>Co teraz</h3>
        <span>{items.length} spraw</span>
      </header>
      <ul>
        {items.map((it) => (
          <li key={it.id}>
            <span className={`badge ${it.kind === "pytanie" ? "badge--unknown" : "badge--meaning"}`}>{it.kind}</span>
            <span className="dz__digest-text">{it.text}</span>
            {it.projectId && (
              <button className="dz__digest-link" onClick={() => setProjectCard(it.projectId as ProjectId)}>
                {PROJECTS[it.projectId].alias} »
              </button>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

/** Digest card: what Kiero made of a source, in place in the journal. */
function DigestCard({
  source,
  setProjectCard,
}: {
  source: SourceMessage;
  setProjectCard: (p: ProjectId | null) => void;
}) {
  if (!source.feedback || source.feedback.length === 0) return null;
  const byScope = new Map<string, FeedbackItem>();
  for (const f of source.feedback) byScope.set(f.scope, f);
  return (
    <article className="dz__digest" aria-label="Ustalenia Kiero z tego wpisu">
      <header>
        <h3>Kiero uporządkował</h3>
        <span>{formatPlTime(source.sentAt)}</span>
      </header>
      <ul>
        {[...byScope.entries()].map(([scope, f]) => (
          <li key={scope}>
            <span className="chip chip--accent">{scope === "firma" ? "Firma" : PROJECTS[scope as ProjectId].alias}</span>
            <span className="dz__digest-text">{f.text}</span>
            {scope !== "firma" && (
              <button className="dz__digest-link" onClick={() => setProjectCard(scope as ProjectId)}>
                karta »
              </button>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}

function JournalRow({
  source,
  open,
  onToggle,
  setProjectCard,
}: {
  source: SourceMessage;
  open: boolean;
  onToggle: () => void;
  setProjectCard: (p: ProjectId | null) => void;
}) {
  const s = useStore();
  const unread = source.authorId !== s.actorId && !(s.readBy[source.id] ?? []).includes(s.actorId);
  const agent = source.authorId === "kiero";
  return (
    <>
      <article
        className={`dz__row ${agent ? "dz__row--agent" : ""} ${unread ? "dz__row--unread" : ""} ${open ? "dz__row--open" : ""}`}
        onClick={() => {
          if (unread) store.markRead(source.id);
          onToggle();
        }}
      >
        <div className="dz__row-time">{formatPlTime(source.sentAt)}</div>
        <div className="dz__row-author">
          <AuthorMark actorId={source.authorId} size={24} />
        </div>
        <div className="dz__row-body">
          {unread && <span className="unread-dot dz__row-dot" aria-label="nieprzeczytany" />}
          <span className="dz__row-name">{ACTORS[source.authorId].short}</span>
          {source.replyTo && <ReplyPreview replyTo={source.replyTo} />}
          {source.text && <p className="dz__text">{source.text}</p>}
          <Attachments source={source} />
          <StatusLine source={source} />
          <AgentFeedback source={source} />
          <span className="dz__row-toggle">{open ? "▲ źródło" : "▼ źródło"}</span>
        </div>
      </article>

      {open && (
        <div className="dz__source-inline">
          <SourceDetail source={source} />
          {agent && (
            <button
              className="dz__answer"
              onClick={() => {
                store.setReplyTo(source.id);
                document.getElementById("dz-input")?.focus();
              }}
            >
              Odpowiedz
            </button>
          )}
        </div>
      )}

      <DigestCard source={source} setProjectCard={setProjectCard} />
    </>
  );
}

function CaptureBar({ expanded, setExpanded }: { expanded: boolean; setExpanded: (v: boolean) => void }) {
  const s = useStore();
  const from: "firma" | ProjectId = s.pill === "auto" ? "firma" : (s.pill as ProjectId);
  const canSend =
    s.draftText.trim().length > 0 || s.draftAttachments.length > 0 || s.recorder.status === "review";

  const collapse = () => {
    if (s.recorder.status !== "recording" && !s.draftText && s.draftAttachments.length === 0) setExpanded(false);
  };

  if (s.recorder.status === "recording") {
    return (
      <footer className="dz__capture dz__capture--recording" aria-label="Nagrywanie">
        <span className="dz__rec-badge">● REC</span>
        <span className="dz__rec-timer">{mmss(s.recorder.elapsedSec)}</span>
        <Waveform active />
        <span className="dz__rec-hint">Nagrywasz — dotknij „Zakończ”, nic nie musisz trzymać</span>
        <button className="dz__rec-stop" onClick={() => store.stopRecording()}>
          ⏹ Zakończ
        </button>
      </footer>
    );
  }

  const needsOpen = expanded || s.recorder.status === "review" || s.draftAttachments.length > 0 || s.replyTo !== null || s.draftText.length > 0;

  if (!needsOpen) {
    return (
      <footer className="dz__capture dz__capture--slim" aria-label="Szybki wpis">
        <button
          className="dz__slim-mic"
          onClick={() => store.startRecording()}
          aria-label="Nagraj wpis jednym dotknięciem"
        >
          🎙 Nagraj
        </button>
        <button className="dz__slim-text" onClick={() => setExpanded(true)}>
          Dodaj wpis… <span className="dz__slim-photo" role="img" aria-label="zdjęcia">📷</span>
        </button>
      </footer>
    );
  }

  return (
    <footer className="dz__capture" aria-label="Kompozytor wpisu">
      <PillRow />
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
      <div className="dz__input-row">
        <button className="dz__photo-btn" onClick={() => store.addPhoto()} aria-label="Dodaj zdjęcia">
          📷
        </button>
        <textarea
          id="dz-input"
          className="dz__input"
          placeholder={from === "firma" ? "Co się dzieje na budowie…" : `Wpis w „${PROJECTS[from].alias}”…`}
          rows={1}
          value={s.draftText}
          onChange={(e) => store.setDraftText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
              store.send(from);
              collapse();
            }
          }}
        />
        <button
          className={`dz__mic ${canSend && s.recorder.status !== "review" ? "dz__mic--secondary" : ""}`}
          onClick={() => store.startRecording()}
          aria-label="Nagraj do tego wpisu"
        >
          🎙
        </button>
        {canSend && (
          <button
            className="dz__send"
            onClick={() => {
              store.send(from);
              collapse();
            }}
          >
            Wyślij ▶
          </button>
        )}
      </div>
    </footer>
  );
}
