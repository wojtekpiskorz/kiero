/**
 * The PWA update safe-point gate (I7): the ONE place that answers "may the
 * update prompt appear RIGHT NOW?".
 *
 * Deferral rules (issue #59: "Recording, editing, and upload defer reload"):
 *
 * - WORK HOLDS: feature surfaces hold the update while work is in flight
 *   ("capture.recording", "capture.uploading", ...). A hold is a named,
 *   idempotent, releasable claim; the prompt waits until every hold is
 *   released. This is the certified adapter seam feature packages expose
 *   (the issue's own integration rule); D4's composer states map onto it
 *   one-to-one (recordingActive / sending).
 * - EDITING SETTLE: document-level input activity inside a short settle
 *   window also defers the prompt, so typing never meets a reload button
 *   mid-keystroke even before a feature wires its holds.
 * - URGENT SIGNALS: security/session events (revocation) register here
 *   and are readable immediately regardless of holds; update deferral
 *   NEVER shields them (policy: securityEventPolicy). The gate does not
 *   render them; it only refuses to keep them private.
 */

/** The gate's tunables (defaults are the shipped behavior). */
export interface PwaUpdateGateOptions {
  /** How long after the last input the page counts as not-being-edited. */
  readonly inputSettleMs?: number;
}

/** The safe-point gate surface the update flow and feature adapters use. */
export interface PwaUpdateGate {
  /** Adds one named hold; returns its (idempotent) release. */
  hold(holder: string): () => void;
  /** The current holders, in registration order. */
  holders(): readonly string[];
  /** Feeds the editing heuristic (call on every user input burst). */
  noteEditingInput(atMs: number): void;
  /** Registers an urgent signal (revocation and friends); never gated. */
  registerUrgentSignal(name: string): void;
  /** The urgent signals seen so far; readable even while holds are open. */
  urgentSignals(): readonly string[];
  /** The safe-point answer for one moment (work-free AND input-settled). */
  isSafePoint(nowMs: number): boolean;
  /** Why the moment is not safe (the first matching reason). */
  deferralReason(nowMs: number): "held-by-work" | "recent-input" | "";
}

const DEFAULT_INPUT_SETTLE_MS = 1500;

/** Creates one gate; the update flow owns exactly one per page. */
export function createPwaUpdateGate(
  options: PwaUpdateGateOptions = {},
): PwaUpdateGate {
  const inputSettleMs = options.inputSettleMs ?? DEFAULT_INPUT_SETTLE_MS;
  const workHolds = new Set<string>();
  const holdOrder: string[] = [];
  const urgent = new Set<string>();
  const urgentOrder: string[] = [];
  let lastInputAtMs = Number.NEGATIVE_INFINITY;

  return {
    hold(holder) {
      if (!workHolds.has(holder)) {
        workHolds.add(holder);
        holdOrder.push(holder);
      }
      let released = false;
      return () => {
        if (!released) {
          released = true;
          workHolds.delete(holder);
          const index = holdOrder.indexOf(holder);
          if (index >= 0) {
            holdOrder.splice(index, 1);
          }
        }
      };
    },
    holders: () => [...holdOrder],
    noteEditingInput(atMs) {
      if (atMs > lastInputAtMs) {
        lastInputAtMs = atMs;
      }
    },
    registerUrgentSignal(name) {
      if (!urgent.has(name)) {
        urgent.add(name);
        urgentOrder.push(name);
      }
    },
    urgentSignals: () => [...urgentOrder],
    deferralReason(nowMs) {
      if (holdOrder.length > 0) {
        return "held-by-work";
      }
      if (nowMs - lastInputAtMs < inputSettleMs) {
        return "recent-input";
      }
      return "";
    },
    isSafePoint(nowMs) {
      return this.deferralReason(nowMs) === "";
    },
  };
}
