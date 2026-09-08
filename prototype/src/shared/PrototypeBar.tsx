// Floating comparison bar — clearly NOT part of the product UI.
// Cycles variants via ?variant=, never covers the composer (variants reserve
// --proto-bar-h), never steals arrow keys while typing.
import { useEffect } from "react";
import { ACTORS } from "../data/fixtures";
import { store, useStore, VariantKey } from "../state/store";

export const VARIANT_NAMES: Record<VariantKey, string> = {
  A: "A · Taśma",
  B: "B · Warsztat",
  C: "C · Dziennik budowy",
  D: "D · Plac budowy (kierunek)",
};

const ORDER: VariantKey[] = ["A", "B", "C", "D"];

export function PrototypeBar() {
  const s = useStore();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)
      ) {
        return; // never intercept typing/navigation inside form fields
      }
      const idx = ORDER.indexOf(s.variant);
      const next = e.key === "ArrowRight" ? ORDER[(idx + 1) % ORDER.length] : ORDER[(idx + ORDER.length - 1) % ORDER.length];
      store.setVariant(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.variant]);

  const idx = ORDER.indexOf(s.variant);
  const cycle = (dir: 1 | -1) => store.setVariant(ORDER[(idx + dir + ORDER.length) % ORDER.length]);

  const unread = s.sources.filter(
    (src) => src.authorId !== s.actorId && !(s.readBy[src.id] ?? []).includes(s.actorId)
  ).length;

  return (
    <div className="proto-bar" role="region" aria-label="Sterowanie prototypem">
      <span className="proto-bar__badge">PROTOTYP · demo, dane fikcyjne</span>
      <button className="proto-bar__arrow" onClick={() => cycle(-1)} aria-label="Poprzedni wariant (←)">
        ◀
      </button>
      <span className="proto-bar__name" aria-live="polite">
        {VARIANT_NAMES[s.variant]}
      </span>
      <button className="proto-bar__arrow" onClick={() => cycle(1)} aria-label="Następny wariant (→)">
        ▶
      </button>
      <span className="proto-bar__sep" aria-hidden="true" />
      <button className="proto-bar__btn" onClick={() => store.openInspector(!s.inspectorOpen)}>
        Stan
      </button>
      <button className="proto-bar__btn proto-bar__btn--warn" onClick={() => store.reset()}>
        Reset scenariusza
      </button>
      <span className="proto-bar__meta">
        szef: {ACTORS[s.actorId].short}
        {unread > 0 ? ` · nieprzeczytane: ${unread}` : ""}
      </span>
    </div>
  );
}
