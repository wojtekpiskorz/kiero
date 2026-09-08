// Variant D — „Plac budowy”: the owner-chosen direction (ticket #12).
// Feed look from A (messenger stream), persistent memory sidebar from B,
// slim bottom capture bar from C. Hosts the full scenario walkthroughs:
// corrections, clarifications, checklists, closed-project obligations,
// search (incl. OCR), Google Calendar, notifications, access/GM and a
// PWA update that waits for a safe moment.
import { useEffect, useRef, useState } from "react";
import {
  ACTORS,
  ActorId,
  COMPANY,
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
  CitedSources,
  coTerazItems,
  dayKey,
  dayLabel,
  formatPlTime,
  ProjectChips,
  ProjectSummary,
  ReplyPreview,
  SourceDetail,
  StatusLine,
  formatPlShortDate,
} from "../../shared/content/components";
import { DraftThumbs, mmss, PillRow, ReviewStrip, Waveform } from "../../shared/content/composer-parts";
import "./plac.css";

type Overlay =
  | { kind: "none" }
  | { kind: "source"; sourceId: string; highlight?: ProjectId | "firma" }
  | { kind: "task"; taskId: string }
  | { kind: "search"; initialQuery?: string }
  | { kind: "calendar" }
  | { kind: "notif" }
  | { kind: "access" }
  | { kind: "scenariusze" }
  | { kind: "side"; tab: "pamiec" | "coteraz" }; // mobile sidebar overlay

export function PlacVariant() {
  const s = useStore();
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const inProject = s.pill !== "auto";
  const projectId = inProject ? (s.pill as ProjectId) : null;

  const stripFacts = projectId
    ? s.findings[projectId]
        .filter((f) => f.meaning || f.unknownNote)
        .slice(0, 2)
        .map((f) => `${f.label}: ${f.value}${f.unknownNote ? ` (${f.unknownNote})` : ""}`)
    : [`${coTerazItems().length} spraw w „Co teraz”: zadania i pytania do obu szefów`];

  return (
    <div className="pl pl--root">
      {s.accessRevoked && <RevokedScreen />}
      <PwaBanner />
      <header className="pl__header">
        <div className="pl__brand">
          <h1>{inProject ? PROJECTS[projectId!].alias : "Rozmowa firmy"}</h1>
          <span className="pl__firm">
            {inProject ? `${PROJECTS[projectId!].address} · widok z Rozmowy firmy` : COMPANY.name}
          </span>
        </div>
        <div className="pl__tools">
          <PillRow />
          <div className="pl__icons">
            <button className="pl__icon" onClick={() => setOverlay({ kind: "search" })} aria-label="Szukaj w historii">
              🔍
            </button>
            <button className="pl__icon" onClick={() => setOverlay({ kind: "calendar" })} aria-label="Kalendarz Google">
              📅
            </button>
            <button className="pl__icon" onClick={() => setOverlay({ kind: "notif" })} aria-label="Powiadomienia">
              🔔
            </button>
            <button className="pl__icon" onClick={() => setOverlay({ kind: "access" })} aria-label="Dostęp i GM">
              👥
            </button>
            <button className="pl__icon pl__icon--scen" onClick={() => setOverlay({ kind: "scenariusze" })} aria-label="Scenariusze demonstracyjne">
              ▶ Scenariusze
            </button>
          </div>
        </div>
      </header>

      <button className="pl__strip" onClick={() => setOverlay({ kind: "side", tab: projectId ? "pamiec" : "coteraz" })}>
        <b>{projectId ? `Pamięć · ${PROJECTS[projectId].alias}` : "Co teraz"}</b> {stripFacts.join(" · ")}{" "}
        <span className="pl__strip-more">więcej »</span>
      </button>

      <div className="pl__panes">
        <section className="pl__feed-col" aria-label="Rozmowa">
          <Feed setOverlay={setOverlay} />
          <CaptureBar />
        </section>

        <aside className="pl__side" aria-label="Pamięć i Co teraz">
          <Sidebar setOverlay={setOverlay} />
        </aside>
      </div>

      {overlay.kind === "source" && (
        <Sheet title="Pełne źródło" onClose={() => setOverlay({ kind: "none" })}>
          <SourceOverlay sourceId={overlay.sourceId} highlight={overlay.highlight} setOverlay={setOverlay} />
        </Sheet>
      )}
      {overlay.kind === "task" && <TaskSheet taskId={overlay.taskId} onClose={() => setOverlay({ kind: "none" })} />}
      {overlay.kind === "search" && (
        <SearchPanel
          initialQuery={overlay.initialQuery}
          onOpenSource={(id) => setOverlay({ kind: "source", sourceId: id })}
          onClose={() => setOverlay({ kind: "none" })}
        />
      )}
      {overlay.kind === "calendar" && <CalendarPanel onClose={() => setOverlay({ kind: "none" })} />}
      {overlay.kind === "notif" && <NotifPanel onClose={() => setOverlay({ kind: "none" })} />}
      {overlay.kind === "access" && <AccessPanel onClose={() => setOverlay({ kind: "none" })} />}
      {overlay.kind === "scenariusze" && (
        <ScenariosPanel onClose={() => setOverlay({ kind: "none" })} setOverlay={setOverlay} />
      )}
      {overlay.kind === "side" && (
        <Sheet title={s.pill === "auto" ? "Co teraz i wiedza firmy" : `Pamięć · ${PROJECTS[s.pill as ProjectId].alias}`} onClose={() => setOverlay({ kind: "none" })}>
          <SideTabs initialTab={overlay.tab} setOverlay={setOverlay} embedded />
        </Sheet>
      )}
    </div>
  );
}

function PwaBanner() {
  const { pwa } = useStore();
  if (pwa === "none") return null;
  return (
    <div className="pl__pwa" role="status">
      {pwa === "available" && (
        <>
          <span>Dostępna aktualizacja Kiero — szkic i nagrania są bezpieczne.</span>
          <button onClick={() => store.activatePwaUpdate()}>Zainstaluj i przeładuj</button>
        </>
      )}
      {pwa === "waiting" && (
        <span>Aktualizacja czeka — zainstalujemy ją, gdy zakończysz nagrywanie i wysyłkę.</span>
      )}
      {pwa === "done" && <span>Zaktualizowano — Twój szkic został zachowany.</span>}
    </div>
  );
}

function RevokedScreen() {
  return (
    <div className="pl__revoked" role="alertdialog" aria-label="Dostęp cofnięty">
      <div>
        <h2>Dostęp do firmy MAR-PIT został cofnięty</h2>
        <p>
          Administrator firmy cofnął Twoje członkostwo. Twoje wcześniejsze wpisy pozostają w historii firmy z Twoim
          autorstwem; nie masz już dostępu do rozmowy, pamięci ani plików.
        </p>
        <button onClick={() => store.simulateRevoked(false)}>Wróć do wersji demo</button>
      </div>
    </div>
  );
}

function Feed({ setOverlay }: { setOverlay: (o: Overlay) => void }) {
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
    <main className="pl__feed">
      {projectId && (
        <p className="pl__projection">
          Widok wpisów Rozmowy firmy powiązanych z „{PROJECTS[projectId].alias}” — jeden oryginał, rzeczywisty autor.
        </p>
      )}
      {days.map((d) => {
        const unread = d.items.filter(
          (m) => m.authorId !== s.actorId && !(s.readBy[m.id] ?? []).includes(s.actorId)
        ).length;
        return (
          <section key={d.key}>
            <div className="day-divider">
              {dayLabel(d.key, TODAY_ISO)}
              {unread > 0 && <span className="unread-dot" title={`${unread} nieprzeczytanych`} />}
            </div>
            {d.items.map((m) => (
              <Bubble key={m.id} source={m} setOverlay={setOverlay} />
            ))}
          </section>
        );
      })}
      <div ref={bottom} />
    </main>
  );
}

function Bubble({ source, setOverlay }: { source: SourceMessage; setOverlay: (o: Overlay) => void }) {
  const s = useStore();
  const mine = source.authorId === s.actorId;
  const agent = source.authorId === "kiero";
  const unread = !mine && !(s.readBy[source.id] ?? []).includes(s.actorId);
  return (
    <article className={`pl__msg ${mine ? "pl__msg--mine" : "pl__msg--theirs"} ${agent ? "pl__msg--agent" : ""}`}>
      <div className="pl__msg-row">
        {!mine && <AuthorMark actorId={source.authorId} />}
        <div className="pl__bubble">
          <span className="pl__msg-meta">
            {ACTORS[source.authorId].short} · {formatPlTime(source.sentAt)}
            {unread && <span className="unread-dot" style={{ display: "inline-block", marginLeft: 6 }} />}
          </span>
          {source.replyTo && <ReplyPreview replyTo={source.replyTo} />}
          {source.text && <p className="pl__text">{source.text}</p>}
          <Attachments source={source} />
          {agent && source.citesSourceIds && (
            <CitedSources
              ids={source.citesSourceIds}
              onOpenSource={(id) => setOverlay({ kind: "source", sourceId: id })}
            />
          )}
          <StatusLine source={source} />
          <AgentFeedback source={source} />
          <ProjectChips
            fragments={source.fragments}
            onOpenProject={(p) => store.setPill(p)}
          />
          <button
            className="pl__open-source"
            onClick={() =>
              setOverlay({
                kind: "source",
                sourceId: source.id,
                highlight: s.pill === "auto" ? undefined : (s.pill as ProjectId),
              })
            }
          >
            źródło
          </button>
          {agent && (
            <button
              className="pl__answer"
              onClick={() => {
                store.setReplyTo(source.id);
                document.getElementById("pl-input")?.focus();
              }}
            >
              Odpowiedz
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function CaptureBar() {
  const s = useStore();
  const [expanded, setExpanded] = useState(false);
  const from: "firma" | ProjectId = s.pill === "auto" ? "firma" : (s.pill as ProjectId);
  const canSend =
    s.draftText.trim().length > 0 || s.draftAttachments.length > 0 || s.recorder.status === "review";
  const needsOpen =
    expanded || s.recorder.status === "review" || s.draftAttachments.length > 0 || s.replyTo !== null || s.draftText.length > 0;

  if (s.recorder.status === "recording") {
    return (
      <footer className="pl__capture pl__capture--recording" aria-label="Nagrywanie">
        <span className="pl__rec-badge">● REC</span>
        <span className="pl__rec-timer">{mmss(s.recorder.elapsedSec)}</span>
        <Waveform active />
        <span className="pl__rec-hint">Nagrywasz — dotknij „Zakończ”. Aktualizacja PWA poczeka.</span>
        <button className="pl__rec-stop" onClick={() => store.stopRecording()}>
          ⏹ Zakończ
        </button>
      </footer>
    );
  }

  if (!needsOpen) {
    return (
      <footer className="pl__capture pl__capture--slim" aria-label="Szybki wpis">
        <button
          className="pl__slim-mic"
          onClick={() => store.startRecording()}
          aria-label="Nagraj wpis jednym dotknięciem"
        >
          🎙 Nagraj
        </button>
        <button className="pl__slim-text" onClick={() => setExpanded(true)}>
          Dodaj wpis… <span className="pl__slim-photo" role="img" aria-label="zdjęcia">📷</span>
        </button>
      </footer>
    );
  }

  return (
    <footer className="pl__capture" aria-label="Kompozytor wpisu">
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
      <div className="pl__input-row">
        <button className="pl__photo-btn" onClick={() => store.addPhoto()} aria-label="Dodaj zdjęcia">
          📷
        </button>
        <textarea
          id="pl-input"
          className="pl__input"
          placeholder={from === "firma" ? "Napisz do firmy… (kontekst: Auto)" : `Napisz w „${PROJECTS[from].alias}”…`}
          rows={1}
          value={s.draftText}
          onChange={(e) => store.setDraftText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
              store.send(from);
              setExpanded(false);
            }
          }}
        />
        <button
          className={`pl__mic ${canSend ? "pl__mic--secondary" : ""}`}
          onClick={() => store.startRecording()}
          aria-label="Nagraj do tego wpisu"
        >
          🎙
        </button>
        {canSend && (
          <button
            className="pl__send"
            aria-label="Wyślij"
            onClick={() => {
              store.send(from);
              setExpanded(false);
            }}
          >
            Wyślij ▶
          </button>
        )}
      </div>
    </footer>
  );
}

function Sidebar({ setOverlay }: { setOverlay: (o: Overlay) => void }) {
  return (
    <div className="pl__side-inner">
      <SideTabs initialTab="auto" setOverlay={setOverlay} embedded />
    </div>
  );
}

function SideTabs({
  initialTab,
  setOverlay,
  embedded = false,
}: {
  initialTab: "pamiec" | "coteraz" | "auto";
  setOverlay: (o: Overlay) => void;
  embedded?: boolean;
}) {
  const s = useStore();
  const [tab, setTab] = useState<"pamiec" | "coteraz">(
    initialTab === "auto" ? (s.pill === "auto" ? "coteraz" : "pamiec") : initialTab
  );
  const projectId = s.pill === "auto" ? null : (s.pill as ProjectId);

  // The sidebar follows workspace context: project pill → its memory, Auto → Co teraz.
  useEffect(() => {
    setTab(s.pill === "auto" ? "coteraz" : "pamiec");
  }, [s.pill]);

  return (
    <>
      {!embedded && <button className="pl__side-close" onClick={() => setOverlay({ kind: "none" })}>✕ zamknij</button>}
      <div className="pl__side-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "coteraz"} className={tab === "coteraz" ? "is-on" : ""} onClick={() => setTab("coteraz")}>
          Co teraz
        </button>
        <button role="tab" aria-selected={tab === "pamiec"} className={tab === "pamiec" ? "is-on" : ""} onClick={() => setTab("pamiec")}>
          {projectId ? `Pamięć · ${PROJECTS[projectId].alias}` : "Wiedza firmy"}
        </button>
      </div>
      <div className="pl__side-body">
        {tab === "coteraz" ? (
          <CoTerazList setOverlay={setOverlay} />
        ) : projectId ? (
          <>
            <p className="pl__proj-meta">
              {PROJECTS[projectId].scope} · klient: {PROJECTS[projectId].client} · etap: {PROJECTS[projectId].stage}
            </p>
            <ProjectSummary
              projectId={projectId}
              onOpenSource={(id) => setOverlay({ kind: "source", sourceId: id, highlight: projectId })}
              onOpenTask={(id) => setOverlay({ kind: "task", taskId: id })}
            />
          </>
        ) : (
          <FirmKnowledge setOverlay={setOverlay} />
        )}
      </div>
    </>
  );
}

function CoTerazList({ setOverlay }: { setOverlay: (o: Overlay) => void }) {
  const items = coTerazItems();
  return (
    <div className="pl__cotrz">
      <p className="pl__proj-meta">Wspólne dla obu szefów — praca i pytania wymagające odpowiedzi.</p>
      {items.map((it) => (
        <article key={it.id} className="pl__cotrz-item">
          <span className={`badge ${it.kind === "pytanie" ? "badge--unknown" : "badge--meaning"}`}>{it.kind}</span>
          {it.overdue && <span className="badge badge--unknown">po terminie</span>}
          <p className="pl__cotrz-text">{it.text}</p>
          <div className="pl__cotrz-actions">
            {it.taskId && (
              <button className="pl__link" onClick={() => setOverlay({ kind: "task", taskId: it.taskId! })}>
                otwórz zadanie
              </button>
            )}
            {it.projectId && (
              <button className="pl__link" onClick={() => store.setPill(it.projectId!)}>
                {PROJECTS[it.projectId].alias} →
              </button>
            )}
            {it.kind === "pytanie" && it.id === "q1" && (
              <button className="pl__link" onClick={() => setOverlay({ kind: "source", sourceId: "s5" })}>
                odpowiedz na pytanie
              </button>
            )}
            {it.kind === "pytanie" && it.id === "q2" && (
              <button className="pl__link" onClick={() => setOverlay({ kind: "source", sourceId: "s10" })}>
                odpowiedz na pytanie
              </button>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function FirmKnowledge({ setOverlay }: { setOverlay: (o: Overlay) => void }) {
  const s = useStore();
  const firmSources = s.sources.filter((src) => src.fragments.some((f) => f.scope === "firma"));
  return (
    <div className="pl__cotrz">
      <p className="pl__proj-meta">Wiedza ogólna firmy — nieprzypisana do jednej budowy.</p>
      {firmSources.map((src) => (
        <article key={src.id} className="pl__cotrz-item">
          <span className="badge badge--meaning">wiedza firmy</span>
          <p className="pl__cotrz-text">{src.text}</p>
          <button className="pl__link" onClick={() => setOverlay({ kind: "source", sourceId: src.id })}>
            źródło: {ACTORS[src.authorId].short}, {formatPlShortDate(src.sentAt)}
          </button>
        </article>
      ))}
    </div>
  );
}

// ---------- overlays ----------

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="pl__scrim" onClick={onClose}>
      <section className="pl__sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="pl__sheet-head">
          <h2>{title}</h2>
          <button className="pl__sheet-close" onClick={onClose} aria-label="Zamknij">
            ✕
          </button>
        </header>
        <div className="pl__sheet-body">{children}</div>
      </section>
    </div>
  );
}

function SourceOverlay({
  sourceId,
  highlight,
  setOverlay,
}: {
  sourceId: string;
  highlight?: ProjectId | "firma";
  setOverlay: (o: Overlay) => void;
}) {
  const src = useStore().sources.find((x) => x.id === sourceId);
  if (!src) return null;
  return (
    <>
      <SourceDetail source={src} highlightScope={highlight} />
      {src.authorId === "kiero" && src.citesSourceIds && (
        <CitedSources ids={src.citesSourceIds} onOpenSource={(id) => setOverlay({ kind: "source", sourceId: id })} />
      )}
      <ProjectChips fragments={src.fragments} onOpenProject={(p) => store.setPill(p)} />
    </>
  );
}

function TaskSheet({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const s = useStore();
  const t = s.tasks.find((x) => x.id === taskId);
  if (!t) return null;
  const project = PROJECTS[t.projectId];
  const unchecked = (t.checklistItems ?? []).filter((c) => !c.done).length;
  return (
    <Sheet title={`${t.title} — ${project.alias}`} onClose={onClose}>
      <div className="pl__task">
        <p className="pl__proj-meta">
          {project.address} · etap projektu: {project.stage}
          {project.stage === "Zakończony" && " — projekt zamknięty, otwarte zobowiązania zostają"}
        </p>
        <div className="pl__task-row">
          <span className="badge badge--meaning">{t.state}</span>
          <span className="badge badge--unknown">wykonawca: {t.executor}</span>
          <span className="badge badge--meaning">
            koordynator: {t.coordinator ? ACTORS[t.coordinator].short : "brak — przypomnienia do wszystkich"}
          </span>
        </div>
        {t.note && <p className="pl__proj-meta">{t.note}</p>}

        {t.checklistItems && (
          <section className="summary__section" aria-label="Checklista">
            <h4>Checklista (jednopoziomowa)</h4>
            {t.checklistItems.map((c) => (
              <label key={c.id} className="pl__check">
                <input
                  type="checkbox"
                  checked={c.done}
                  onChange={() => store.toggleChecklistItem(t.id, c.id)}
                />
                <span className={c.done ? "pl__check--done" : ""}>{c.label}</span>
              </label>
            ))}
            <p className="pl__proj-meta">
              Punkty i zadanie są niezależne: zakończenie zadania nie odhacza punktów, a odhaczenie wszystkich
              punktów nie kończy zadania.
            </p>
          </section>
        )}

        <button
          className="pl__task-complete"
          onClick={() => store.completeTask(t.id)}
        >
          {t.state === "Wykonane" ? "Przywróć do zrobienia" : "Zakończ zadanie"}
          {t.state !== "Wykonane" && unchecked > 0 ? ` (${unchecked} nieodhaczonych punktów zostanie)` : ""}
        </button>
      </div>
    </Sheet>
  );
}

function SearchPanel({
  initialQuery,
  onOpenSource,
  onClose,
}: {
  initialQuery?: string;
  onOpenSource: (id: string) => void;
  onClose: () => void;
}) {
  const s = useStore();
  const [q, setQ] = useState(initialQuery ?? "");
  const [project, setProject] = useState<"all" | ProjectId>("all");
  const [author, setAuthor] = useState<"all" | ActorId>("all");
  const [day, setDay] = useState<"all" | "2026-09-08" | "2026-09-07">("all");

  const needle = q.trim().toLowerCase();
  const results = s.sources.filter((src) => {
    if (project !== "all" && !src.fragments.some((f) => f.scope === project)) return false;
    if (author !== "all" && src.authorId !== author) return false;
    if (day !== "all" && !src.sentAt.startsWith(day)) return false;
    if (!needle) return false;
    const hay = [
      src.text,
      ...src.attachments.map((a) => (a.kind === "audio" ? a.transcript : (a.ocrText ?? ""))),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  });

  return (
    <Sheet title="Szukaj w historii firmy" onClose={onClose}>
      <div className="pl__search">
        <input
          className="pl__search-input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Wiadomości, transkrypcje, tekst ze zdjęć…"
          aria-label="Fraza szukana"
        />
        <div className="pl__search-filters">
          <select value={project} onChange={(e) => setProject(e.target.value as "all" | ProjectId)} aria-label="Filtr projektu">
            <option value="all">Wszystkie projekty</option>
            <option value="banan">Banan</option>
            <option value="kaczmarek">Kaczmarek</option>
            <option value="omega">Omega</option>
          </select>
          <select value={author} onChange={(e) => setAuthor(e.target.value as "all" | ActorId)} aria-label="Filtr autora">
            <option value="all">Wszyscy</option>
            <option value="marek">Marek</option>
            <option value="piotrek">Piotrek</option>
            <option value="kiero">Kiero</option>
          </select>
          <select value={day} onChange={(e) => setDay(e.target.value as "all" | "2026-09-08" | "2026-09-07")} aria-label="Filtr dnia">
            <option value="all">Dowolny dzień</option>
            <option value="2026-09-08">Dziś (8.09)</option>
            <option value="2026-09-07">Wczoraj (7.09)</option>
          </select>
        </div>
        <p className="pl__proj-meta">
          {needle ? `Trafienia: ${results.length} — tekst, transkrypcje i OCR zdjęć.` : "Wpisz frazę, np. „faktura”, „obróbki”, „18 tysięcy”."}
        </p>
        {results.map((src) => {
          const matchedAudio = src.attachments.some((a) => a.kind === "audio" && a.transcript.toLowerCase().includes(needle));
          const matchedOcr = src.attachments.some((a) => a.kind === "photo" && (a.ocrText ?? "").toLowerCase().includes(needle));
          return (
            <article key={src.id} className="pl__cotrz-item">
              <span className="badge badge--meaning">
                {ACTORS[src.authorId].short} · {formatPlTime(src.sentAt)}
              </span>
              {matchedAudio && <span className="badge badge--unknown">trafienie w transkrypcji</span>}
              {matchedOcr && <span className="badge badge--unknown">trafienie w OCR zdjęcia</span>}
              <p className="pl__cotrz-text">{src.text || "(nagranie/zdjęcia)"}</p>
              <button className="pl__link" onClick={() => onOpenSource(src.id)}>
                otwórz źródło (odtwarzanie/zdjęcie)
              </button>
            </article>
          );
        })}
      </div>
    </Sheet>
  );
}

function CalendarPanel({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const cal = s.calendar;
  return (
    <Sheet title="Kalendarz Kiero w Google" onClose={onClose}>
      <div className="pl__cal">
        <section className="summary__section">
          <h4>Połączenie</h4>
          {cal.connected ? (
            cal.attention ? (
              <p className="pl__cotrz-text">
                Połączenie wymaga uwagi — token wygasł. Kiero wstrzymał publikację do ponownego połączenia.{" "}
                <button className="pl__link" onClick={() => store.calendarReconnect()}>
                  Połącz ponownie
                </button>
              </p>
            ) : (
              <p className="pl__cotrz-text">
                Połączono (osobiste, niezależne od logowania).{" "}
                <button className="pl__link" onClick={() => store.calendarDisconnect()}>
                  Rozłącz
                </button>
              </p>
            )
          ) : (
            <p className="pl__cotrz-text">
              Kalendarz nie jest podłączony. <button className="pl__link" onClick={() => store.calendarConnect()}>Połącz z Google</button>
            </p>
          )}
          <p className="pl__proj-meta">
            Synchronizacja jednokierunkowa Kiero → Google. Ręczne zmiany w Google nie wracają do Kiero; aktualne
            ustalenia żyją w Kiero.
          </p>
        </section>

        <section className="summary__section">
          <h4>Zakres projektów</h4>
          {(["banan", "kaczmarek", "omega"] as ProjectId[]).map((p) => (
            <label key={p} className="pl__check">
              <input
                type="checkbox"
                checked={cal.scopes[p]}
                disabled={!cal.connected}
                onChange={() => store.calendarToggleScope(p)}
              />
              <span>{PROJECTS[p].alias}</span>
            </label>
          ))}
        </section>

        <section className="summary__section">
          <h4>Kopie w Twoim kalendarzu</h4>
          {cal.copies.map((c) => {
            const hiddenForMe = c.hiddenByActor.includes(s.actorId);
            return (
              <div className="finding" key={c.id}>
                <div className="finding__top">
                  <span className="finding__value" style={{ fontWeight: 600 }}>
                    {c.title}
                  </span>
                  {c.marker5 && <span className="badge badge--meaning">znacznik 5 min (godzina bez czasu trwania)</span>}
                  {!c.marker5 && <span className="badge badge--meaning">cały dzień</span>}
                </div>
                <span className="finding__source-link" style={{ textDecoration: "none", cursor: "default" }}>
                  {c.when}
                </span>
                <div className="pl__cal-row">
                  {hiddenForMe ? (
                    <>
                      <span className="badge badge--unknown">ukryte dla Ciebie (osobiste)</span>
                      <button className="pl__link" onClick={() => store.calendarRestoreCopy(c.id)}>
                        przywróć
                      </button>
                    </>
                  ) : (
                    <>
                      <span className={`badge ${c.status === "blad" ? "badge--unknown" : c.status === "oczekuje" ? "badge--meaning" : "badge--corroborated"}`}>
                        {c.status === "blad" ? "błąd synchronizacji" : c.status === "oczekuje" ? "oczekuje na Google" : "zapisano w Google"}
                      </span>
                      {(c.status === "blad" || c.status === "oczekuje") && cal.connected && !cal.attention && (
                        <button className="pl__link" onClick={() => store.calendarRetryCopy(c.id)}>
                          ponów synchronizację
                        </button>
                      )}
                      <button className="pl__link" onClick={() => store.calendarHideCopy(c.id)}>
                        ukryj dla mnie
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <p className="pl__proj-meta">
            Ukrycie kopii jest osobiste: nie anuluje zadania/zdarzenia i nie dotyka kalendarzy innych szefów.
            Zadanie i zdarzenie mają odrębne wpisy.
          </p>
        </section>
      </div>
    </Sheet>
  );
}

function NotifPanel({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const p = s.notif[s.actorId];
  const isPiotrek = s.actorId === "piotrek";
  return (
    <Sheet title={`Powiadomienia — ${ACTORS[s.actorId].short}`} onClose={onClose}>
      <div className="pl__notif">
        <section className="summary__section">
          <h4>Wyciszenie rozmowy</h4>
          <label className="pl__check">
            <input
              type="checkbox"
              checked={p.conversationMuted}
              onChange={(e) => store.setNotif(s.actorId, { conversationMuted: e.target.checked })}
            />
            <span>Wycisz powiadomienia o nowych wpisach</span>
          </label>
          <p className="pl__proj-meta">
            Nie dostajesz pushów o wpisach; rozmowa i stan odczytu działają normalnie w aplikacji.
          </p>
        </section>
        <section className="summary__section">
          <h4>Przypomnienia o zadaniach</h4>
          <label className="pl__check">
            <input
              type="checkbox"
              checked={p.reminderMuted}
              onChange={(e) => store.setNotif(s.actorId, { reminderMuted: e.target.checked })}
            />
            <span>Wycisz przypomnienia o zadaniach</span>
          </label>
          <p className="pl__proj-meta">
            Dotyczy tylko przypomnień o zadaniach; nie wycisza rozmowy i nie zmienia terminów.
          </p>
        </section>
        <section className="summary__section">
          <h4>Odroczenie przypomnień (jedno zadanie, osobiste)</h4>
          <div className="pl__cal-row">
            <button className="pl__link" onClick={() => store.setNotif(s.actorId, { snoozeUntil: "2026-09-08T10:00" })}>
              na godzinę
            </button>
            <button className="pl__link" onClick={() => store.setNotif(s.actorId, { snoozeUntil: "2026-09-09T08:00" })}>
              do jutra 8:00
            </button>
            <button className="pl__link" onClick={() => store.setNotif(s.actorId, { snoozeUntil: null })}>
              anuluj odroczenie
            </button>
          </div>
          <p className="pl__proj-meta">
            {p.snoozeUntil
              ? `Odroczone do ${p.snoozeUntil.replace("T", ", ")} — tylko dla Ciebie i tylko to zadanie.`
              : "Brak aktywnego odroczenia."}
          </p>
        </section>
        {isPiotrek && (
          <p className="pl__proj-meta">
            Przykład różnicy: Piotrek ma domyślnie wyciszone przypomnienia i odroczenie do jutra — Marek nie.
            Przełącz szefa w podglądzie stanu, aby porównać.
          </p>
        )}
      </div>
    </Sheet>
  );
}

function AccessPanel({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [email, setEmail] = useState("");
  return (
    <Sheet title="Dostęp do firmy i GM (alfa)" onClose={onClose}>
      <div className="pl__access">
        <section className="summary__section">
          <h4>Zaproszenia</h4>
          <form
            className="finding__edit"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.includes("@")) {
                store.invite(email);
                setEmail("");
              }
            }}
          >
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="adres e-mail nowego szefa"
              aria-label="Adres e-mail zapraszanego"
            />
            <button type="submit">Wyślij zaproszenie</button>
          </form>
          {s.invitations.map((i) => (
            <div className="finding" key={i.id}>
              <span className="finding__value" style={{ fontWeight: 600 }}>
                {i.email}
              </span>
              <span className={`badge ${i.status === "cofnięte" ? "badge--unknown" : "badge--meaning"}`}>{i.status}</span>
              {i.status === "wysłane" && (
                <button className="pl__link" onClick={() => store.revokeInvitation(i.id)}>
                  cofnij dostęp
                </button>
              )}
            </div>
          ))}
          <p className="pl__proj-meta">Zwykłe konto ma w v1 jedną firmę. Cofnięcie dostępu działa natychmiast.</p>
          <button className="pl__link" onClick={() => store.simulateRevoked(true)}>
            Symuluj ekran utraty dostępu
          </button>
        </section>

        <section className="summary__section">
          <h4>GM — przetwarzanie (tryb alfa)</h4>
          {s.gmRuns.length === 0 && (
            <p className="pl__proj-meta">
              Brak nieudanych procesów. Włącz „Awaria AI” w podglądzie stanu i wyślij wiadomość, aby zobaczyć scenę GM.
            </p>
          )}
          {s.gmRuns.map((r) => {
            const src = s.sources.find((x) => x.id === r.sourceId);
            return (
              <div className="finding" key={r.id}>
                <div className="finding__top">
                  <span className="finding__value" style={{ fontWeight: 600 }}>
                    {src?.text.slice(0, 40) ?? r.sourceId}…
                  </span>
                  <span className={`badge ${r.status === "failed" ? "badge--unknown" : "badge--corroborated"}`}>
                    {r.status === "failed" ? "etap nieudany" : "rozstrzygnięte"}
                  </span>
                </div>
                <span className="finding__source-link" style={{ textDecoration: "none", cursor: "default" }}>
                  {r.stage} · {r.note}
                </span>
                {r.status === "failed" && (
                  <button className="pl__link" onClick={() => store.gmRetry(r.id)}>
                    ponów etap (GM, audytowany)
                  </button>
                )}
              </div>
            );
          })}
          <p className="pl__proj-meta">
            GM widzi szczegóły procesów i może ponowić etap; nie zmienia autorstwa źródeł ani stanów odczytu szefów
            i nie wybiera modeli.
          </p>
        </section>
      </div>
    </Sheet>
  );
}

function ScenariosPanel({
  onClose,
  setOverlay,
}: {
  onClose: () => void;
  setOverlay: (o: Overlay) => void;
}) {
  const items: { n: number; title: string; what: string; action?: () => void }[] = [
    {
      n: 1,
      title: "Natychmiastowy wpis",
      what: "Otwarcie = rozmowa firmy. „Nagraj” jednym dotknięciem, stop, odsłuch, Wyślij; tekst i kilka zdjęć w jednym źródle.",
    },
    {
      n: 2,
      title: "Mieszane źródło",
      what: "Wpis o Bananie, Kaczmarku i sprawie firmowej; fragmenty, prawdziwy autor, przejście do jednego oryginału.",
      action: () => setOverlay({ kind: "source", sourceId: "s2" }),
    },
    {
      n: 3,
      title: "Stany, częściowa analiza, awaria",
      what: "Wysyłanie → Zapisano → porządkowanie → wynik. W trybie awarii AI źródło przetrwa; przy zdjęciach wyniki mogą być częściowe.",
      action: () => store.setProcessingMode("partial"),
    },
    {
      n: 4,
      title: "Przerwania i aktualizacja PWA",
      what: "Przerwane nagrywanie = odzyskiwalny szkic; Ponów nie tworzy duplikatu; aktualizacja PWA czeka na koniec nagrywania/wysyłki.",
      action: () => store.requestPwaUpdate(),
    },
    {
      n: 5,
      title: "Pytanie o termin i korekta",
      what: "Agent odpowiada z źródłem; „zmieniamy na środę” aktualizuje ustalenie z historią; sprzeczność rodzi pytanie, nie zgadywanie.",
      action: () => store.setDraftText("Kiedy przyjadą płytki na Banana?"),
    },
    {
      n: 6,
      title: "Kwota bez netto/brutto",
      what: "Niepodana podstawa jest jawna; odpowiedź „netto” doprecyzowuje ustalenie i zamyka pytanie.",
      action: () => setOverlay({ kind: "source", sourceId: "s5" }),
    },
    {
      n: 7,
      title: "Checklista i zamknięty projekt",
      what: "Punkty niezależne od zadania (zakończ z nieodhaczonymi); Omega: zamknięty projekt, zadanie po terminie, brak koordynatora.",
      action: () => setOverlay({ kind: "task", taskId: "t1" }),
    },
    {
      n: 8,
      title: "Co teraz",
      what: "Zadania i pytania wspólne; przejście do projektu/zadania z zachowanym kontekstem.",
      action: () => setOverlay({ kind: "side", tab: "coteraz" }),
    },
    {
      n: 9,
      title: "Dwa szefowie, odczyt i wyciszenia",
      what: "Nieprzeczytane są osobiste, stan odczytu źródła wspólny; wyciszenie rozmowy ≠ wyciszenie przypomnień ≠ odroczenie.",
      action: () => store.setActor("piotrek"),
    },
    {
      n: 10,
      title: "Wyszukiwarka",
      what: "Tekst, transkrypcje i OCR zdjęć; filtry projektu/autora/dnia; wynik prowadzi do źródła z odtwarzaniem.",
      action: () => setOverlay({ kind: "search", initialQuery: "faktura" }),
    },
    {
      n: 11,
      title: "Kalendarz Google",
      what: "Połączenie i zakres, znacznik 5 min, oczekująca/zakończona błędem synchronizacja, osobiste ukrycie, ponowne połączenie.",
      action: () => setOverlay({ kind: "calendar" }),
    },
    {
      n: 12,
      title: "Zaproszenia, utrata dostępu, GM",
      what: "Zaproszenie i cofnięcie; ekran braku dostępu; GM ponawia nieudany etap bez ruszania odczytów i autorstwa.",
      action: () => setOverlay({ kind: "access" }),
    },
  ];

  return (
    <Sheet title="Scenariusze demonstracyjne" onClose={onClose}>
      <p className="pl__proj-meta">
        Dwanaście ścieżek z ticketu. Przycisk ustawia scenę; dokończ ją w aplikacji i wróć tu po następny.
      </p>
      {items.map((it) => (
        <article key={it.n} className="pl__cotrz-item">
          <span className="badge badge--meaning">scenariusz {it.n}</span>
          <strong className="pl__cotrz-title">{it.title}</strong>
          <p className="pl__cotrz-text">{it.what}</p>
          {it.action && (
            <button
              className="pl__link"
              onClick={() => {
                it.action!();
              }}
            >
              pokaż
            </button>
          )}
        </article>
      ))}
    </Sheet>
  );
}
