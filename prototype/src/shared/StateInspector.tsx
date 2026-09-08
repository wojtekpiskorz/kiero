// Scenario + state inspector. Prototype-only controls live here so the product
// surfaces stay free of simulation knobs.
import { ACTORS, ActorId, PROJECTS } from "../data/fixtures";
import { ProcessingMode, statusLabel, store, useStore } from "../state/store";
import { formatPlTime } from "./content/components";

export function StateInspector() {
  const s = useStore();
  if (!s.inspectorOpen) return null;

  return (
    <aside className="inspector" aria-label="Podgląd stanu i sterowanie scenariuszem (tylko prototyp)">
      <header className="inspector__head">
        <h3>Stan symulacji</h3>
        <button className="inspector__close" onClick={() => store.openInspector(false)} aria-label="Zamknij podgląd stanu">
          ✕
        </button>
      </header>
      <p className="inspector__note">
        Zegar scenariusza: wtorek 8.09.2026, 09:0x, strefa firmy Europe/Warsaw. „Jutro” = 9.09.
      </p>

      <section className="inspector__section">
        <h4>Kto jest zalogowany</h4>
        <div className="inspector__row">
          {(["marek", "piotrek"] as ActorId[]).map((id) => (
            <button
              key={id}
              className={`inspector__toggle ${s.actorId === id ? "is-on" : ""}`}
              onClick={() => store.setActor(id)}
            >
              {ACTORS[id].short}
            </button>
          ))}
        </div>
        <p className="inspector__note">Drugi szef widzi te same źródła; stan odczytu jest osobisty.</p>
      </section>

      <section className="inspector__section">
        <h4>Tryb przetwarzania</h4>
        <div className="inspector__row">
          {(
            [
              ["normal", "Zwykły"],
              ["ai-fail", "Awaria AI"],
              ["offline", "Brak sieci"],
            ] as [ProcessingMode, string][]
          ).map(([mode, label]) => (
            <button
              key={mode}
              className={`inspector__toggle ${s.processingMode === mode ? "is-on" : ""}`}
              onClick={() => store.setProcessingMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="inspector__note">Awaria AI nie usuwa przyjętego źródła. Brak sieci wstrzymuje wysyłkę do „Ponów”.</p>
      </section>

      <section className="inspector__section">
        <h4>Przerwanie nagrania</h4>
        <button
          className="inspector__toggle"
          disabled={s.recorder.status !== "recording"}
          onClick={() => store.interruptRecording()}
        >
          Przerwij nagrywanie (zachowaj fragment)
        </button>
        <p className="inspector__note">
          Symuluje blokadę ekranu / rozmowę. Zachowany fragment pozostaje szkicem do odsłuchu i wysłania.
        </p>
      </section>

      <section className="inspector__section">
        <h4>Stan</h4>
        <dl className="inspector__state">
          <div>
            <dt>Aktywny szef</dt>
            <dd>{ACTORS[s.actorId].firstName} {ACTORS[s.actorId].lastName}</dd>
          </div>
          <div>
            <dt>Pigułka kontekstu</dt>
            <dd>{s.pill === "auto" ? "Auto" : PROJECTS[s.pill].alias}</dd>
          </div>
          <div>
            <dt>Szkic kompozytora</dt>
            <dd>
              {s.draftText ? `„${s.draftText.slice(0, 40)}…”` : "brak tekstu"} · załączniki: {s.draftAttachments.length}
            </dd>
          </div>
          <div>
            <dt>Dyktafon</dt>
            <dd>
              {s.recorder.status === "idle"
                ? "bezczynny"
                : `${s.recorder.status} · 0:${String(s.recorder.elapsedSec).padStart(2, "0")}${s.recorder.interrupted ? " (przerwane)" : ""}`}
            </dd>
          </div>
        </dl>
      </section>

      <section className="inspector__section">
        <h4>Źródła ({s.sources.length})</h4>
        <ul className="inspector__sources">
          {s.sources
            .slice()
            .reverse()
            .map((src) => (
              <li key={src.id}>
                <span className="inspector__src-id">{src.id}</span>{" "}
                {ACTORS[src.authorId].short} {formatPlTime(src.sentAt)} —{" "}
                <em>{statusLabel(src.status, src.waitingOffline)}</em>
                {src.fragments.length > 0 && (
                  <span className="inspector__src-frags">
                    {" "}
                    → {src.fragments.map((f) => (f.scope === "firma" ? "firma" : PROJECTS[f.scope].alias)).join(", ")}
                  </span>
                )}
                <span className="inspector__src-read">
                  {" "}
                  przeczytali: {(s.readBy[src.id] ?? []).map((a) => ACTORS[a].short).join(", ") || "—"}
                </span>
              </li>
            ))}
        </ul>
      </section>
    </aside>
  );
}
