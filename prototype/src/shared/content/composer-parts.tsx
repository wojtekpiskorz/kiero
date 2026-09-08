// Building blocks for the capture composer. Each variant arranges these into
// a different structure; the interaction contract (1-tap record, explicit send,
// one source with text+audio+photos) is identical and lives in the store.
import { DraftAttachment } from "../../state/store";
import { store, useStore } from "../../state/store";
import { PROJECTS, ProjectId } from "../../data/fixtures";
import { AudioPlayer, PhotoSvg } from "./components";

export function mmss(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

/** Decorative level meter for the recording console (pure CSS animation). */
export function Waveform({ active }: { active: boolean }) {
  return (
    <span className="waveform" aria-hidden="true">
      {Array.from({ length: 24 }, (_, i) => (
        <span key={i} className="waveform__bar" style={{ animationDelay: `${(i % 8) * 0.09}s` }} data-active={active} />
      ))}
    </span>
  );
}

/** Pill selector: Auto (default) or a project context. */
export function PillRow({ inset = 0 }: { inset?: number }) {
  const { pill } = useStore();
  const items: { key: "auto" | ProjectId; label: string }[] = [
    { key: "auto", label: "Auto" },
    { key: "banan", label: PROJECTS.banan.alias },
    { key: "kaczmarek", label: PROJECTS.kaczmarek.alias },
  ];
  return (
    <div className="pill-row" role="radiogroup" aria-label="Kontekst wiadomości" style={{ paddingLeft: inset }}>
      {items.map((it) => (
        <button
          key={it.key}
          role="radio"
          aria-checked={pill === it.key}
          className={`pill ${pill === it.key ? "pill--on" : ""}`}
          onClick={() => store.setPill(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Thumbnails of photos attached to the current draft, with remove buttons. */
export function DraftThumbs({ attachments, onRemove }: { attachments: DraftAttachment[]; onRemove: (id: string) => void }) {
  if (attachments.length === 0) return null;
  return (
    <div className="draft-thumbs">
      {attachments.map((a) =>
        a.kind === "photo" ? (
          <span className="draft-thumbs__item" key={a.id}>
            <PhotoSvg hue={a.hue ?? 210} size={56} />
            <button
              className="draft-thumbs__x"
              onClick={() => onRemove(a.id)}
              aria-label={`Usuń zdjęcie ${a.label}`}
            >
              ✕
            </button>
            <span className="draft-thumbs__label">{a.label}</span>
          </span>
        ) : (
          <span className="draft-thumbs__item" key={a.id}>
            <span className="draft-thumbs__audio">🎙 {mmss(a.durationSec ?? 0)}</span>
            <button
              className="draft-thumbs__x"
              onClick={() => onRemove(a.id)}
              aria-label="Usuń nagranie ze szkicu"
            >
              ✕
            </button>
          </span>
        )
      )}
    </div>
  );
}

/**
 * Reviewed recording sitting in the draft: listen, discard, keep.
 * Explicit "Wyślij" stays in the composer — no mandatory preview screen.
 */
export function ReviewStrip({ durationSec, interrupted }: { durationSec: number; interrupted: boolean }) {
  return (
    <div className="review-strip">
      {interrupted && (
        <span className="review-strip__note">
          Nagrywanie przerwane — zachowano fragment. Nic nie wysłano automatycznie.
        </span>
      )}
      <AudioPlayer id="draft-review" durationSec={durationSec} />
      <button className="review-strip__discard" onClick={() => store.discardRecording()} aria-label="Odrzuć nagranie">
        🗑 Odrzuć
      </button>
    </div>
  );
}

/** Shared pill/draft/recorder wiring so variants only decide the layout. */
export function useComposerSend() {
  const s = useStore();
  return (from: "firma" | ProjectId) => {
    store.send(from);
    return s;
  };
}
