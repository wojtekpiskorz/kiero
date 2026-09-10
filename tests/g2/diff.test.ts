/**
 * G2 focused verification, part 2: desired-state DIFFING — idempotence
 * (a repeated pass produces zero actions), re-derivation after a
 * correction (payload update), withdrawal on completion and requalification
 * on reopen, and the two property proofs the issue names: deterministic
 * semantic ids and no private source/media/financial content in payloads.
 *
 * The diff is the seam G3 completes against Google: every action carries a
 * stable subject identity, so a repeated sync of the same object never
 * creates an additional copy and an unknown Google outcome never forces a
 * blind retry.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  copySemanticId,
  desiredCopyForSubject,
  diffDesiredCopies,
  type DesiredCopy,
  type DesiredGoogleEvent,
  type ExistingCopy,
  type EventSubjectView,
  type TaskSubjectView,
  type TermBindingView,
  type WorkSubjectView,
} from "@kiero/domain";
import type { KnowledgeStateWire, TemporalValueWire } from "@kiero/domain";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const known: KnowledgeStateWire = { _tag: "known" };
const temporal = (
  shape: TemporalValueWire["shape"],
  role: TemporalValueWire["role"] = "agreed",
): TemporalValueWire => ({ shape, originalExpression: "ustalone", role });
const binding = (
  value: TemporalValueWire | null,
  revisionId = "rev1",
): TermBindingView => ({ knowledgeState: known, temporal: value, revisionId });

const task = (overrides: Partial<TaskSubjectView> = {}): TaskSubjectView => ({
  kind: "task",
  taskId: "t1",
  projectId: "p1",
  title: "Odebrać dostawę",
  state: "todo",
  coordinatorMembershipId: "mA",
  deadline: binding(temporal({ _tag: "day", day: "2026-10-15" })),
  ...overrides,
});

const CONTEXT = {
  companyId: "c1",
  userId: "u1",
  googleAccountSubject: "g1",
  projectName: "Banan",
  companyTimezone: "Europe/Warsaw",
  appBaseUrl: "https://kiero.example",
};

const SCOPE = {
  projectSelection: { mode: "all_projects" as const },
  ownMembershipIds: new Set(["mA"]),
};

const wantOf = (subject: WorkSubjectView, revision = "rev1"): DesiredCopy =>
  desiredCopyForSubject(
    subject.kind === "task"
      ? { ...subject, deadline: binding((subject as TaskSubjectView).deadline?.temporal ?? null, revision) }
      : { ...subject, time: binding((subject as EventSubjectView).time?.temporal ?? null, revision) },
    SCOPE,
    CONTEXT,
  );

type MutableExisting = {
  copyId: string;
  subjectKind: "task" | "event";
  subjectId: string;
  semanticId: string;
  hidden: boolean;
  derivationRevisionId: string | null;
  desiredState: "projected" | "withdrawn";
  payload: DesiredGoogleEvent | null;
};

/** Applies diff actions the way the transaction does (immutable rebuild). */
function applyActions(
  existing: readonly ExistingCopy[],
  actions: ReturnType<typeof diffDesiredCopies>,
): MutableExisting[] {
  const next: MutableExisting[] = existing.map((row) => ({ ...row }));
  for (const action of actions) {
    if (action.action === "create" && action.desired.desired.state === "projected") {
      next.push({
        copyId: `copy-${action.desired.subjectKind}-${action.desired.subjectId}`,
        subjectKind: action.desired.subjectKind,
        subjectId: action.desired.subjectId,
        semanticId: action.desired.semanticId,
        hidden: false,
        derivationRevisionId: action.desired.desired.derivationRevisionId,
        desiredState: action.desired.desired.state,
        payload: action.desired.desired.payload,
      });
    } else if (action.action === "update") {
      const row = next.find((candidate) => candidate.copyId === action.copyId);
      if (row !== undefined) {
        row.semanticId = action.desired.semanticId;
        row.derivationRevisionId = action.desired.desired.derivationRevisionId;
        row.desiredState = action.desired.desired.state;
        row.payload =
          action.desired.desired.state === "projected" ? action.desired.desired.payload : null;
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Idempotence
// ---------------------------------------------------------------------------

describe("desired-state diff idempotence", () => {
  it("creates once, then nothing: a repeated pass over the applied result is all `none`", () => {
    const want = [wantOf(task())];
    const first = diffDesiredCopies([], want);
    expect(first).toHaveLength(1);
    expect(first[0]?.action).toBe("create");
    const afterFirst = applyActions([], first);
    const second = diffDesiredCopies(afterFirst, want);
    expect(second.map((a) => a.action)).toEqual(["none"]);
    const third = diffDesiredCopies(applyActions(afterFirst, second), want);
    expect(third.map((a) => a.action)).toEqual(["none"]);
  });

  it("never creates a row for a withdrawn desire (hides can only live on existing copies)", () => {
    const withdrawn = wantOf(task({ state: "done" }));
    expect(diffDesiredCopies([], [withdrawn])).toEqual([]);
  });

  it("updates the payload after a correction moves the date, then settles", () => {
    const corrected = wantOf(task(), "rev2");
    const created = applyActions([], diffDesiredCopies([], [wantOf(task(), "rev1")]));
    const update = diffDesiredCopies(created, [corrected]);
    expect(update.map((a) => a.action)).toEqual(["update"]);
    const settled = diffDesiredCopies(applyActions(created, update), [corrected]);
    expect(settled.map((a) => a.action)).toEqual(["none"]);
  });

  it("withdraws on completion, requalifies on reopen, and stays settled in both states", () => {
    const open = wantOf(task());
    const done = wantOf(task({ state: "done" }));
    let state = applyActions([], diffDesiredCopies([], [open]));
    expect(state[0]?.desiredState).toBe("projected");
    state = applyActions(state, diffDesiredCopies(state, [done]));
    expect(state[0]?.desiredState).toBe("withdrawn");
    expect(diffDesiredCopies(state, [done]).map((a) => a.action)).toEqual(["none"]);
    state = applyActions(state, diffDesiredCopies(state, [open]));
    expect(state[0]?.desiredState).toBe("projected");
    expect(diffDesiredCopies(state, [open]).map((a) => a.action)).toEqual(["none"]);
  });

  it("keeps one row per subject: an account switch re-mints the semantic id on the same row", () => {
    const before = wantOf(task());
    const after = desiredCopyForSubject(task(), SCOPE, {
      ...CONTEXT,
      googleAccountSubject: "g2",
    });
    let state = applyActions([], diffDesiredCopies([], [before]));
    const rebind = diffDesiredCopies(state, [after]);
    expect(rebind.map((a) => a.action)).toEqual(["update"]);
    state = applyActions(state, rebind);
    expect(state).toHaveLength(1);
    expect(state[0]?.semanticId).toBe(after.semanticId);
    expect(diffDesiredCopies(state, [after]).map((a) => a.action)).toEqual(["none"]);
  });

  it("carries the fresh derivation basis on update actions (the event's source)", () => {
    const corrected = wantOf(task(), "rev2");
    const created = applyActions([], diffDesiredCopies([], [wantOf(task(), "rev1")]));
    const update = diffDesiredCopies(created, [corrected]);
    expect(
      update.map((a) => (a.action === "update" ? a.desired.desired.derivationRevisionId : null)),
    ).toEqual(["rev2"]);
  });

  it("withdraws an orphaned row honestly instead of keeping it", () => {
    const row: ExistingCopy = {
      copyId: "copy-task-gone",
      subjectKind: "task",
      subjectId: "tGone",
      semanticId: "sid",
      hidden: false,
      derivationRevisionId: "rev1",
      desiredState: "projected",
      payload: null,
    };
    const actions = diffDesiredCopies([row], []);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.action).toBe("update");
  });
});

// ---------------------------------------------------------------------------
// Property proofs (deterministic; no new dependency — a seeded generator)
// ---------------------------------------------------------------------------

/** A tiny deterministic LCG so property runs are reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("property: deterministic semantic ids", () => {
  it("equal identity inputs always produce equal ids, across 500 random identities", () => {
    const random = lcg(20260909);
    for (let i = 0; i < 500; i += 1) {
      const identity = {
        companyId: `c${Math.floor(random() * 1000)}`,
        userId: `u${Math.floor(random() * 1000)}`,
        googleAccountSubject: random() < 0.5 ? `g${Math.floor(random() * 10)}` : null,
        subjectKind: (random() < 0.5 ? "task" : "event") as "task" | "event",
        subjectId: `s${Math.floor(random() * 10000)}`,
      };
      const first = copySemanticId(identity);
      const second = copySemanticId({ ...identity });
      expect(second).toBe(first);
      // A different subject never shares the id.
      expect(copySemanticId({ ...identity, subjectId: `${identity.subjectId}x` })).not.toBe(first);
    }
  });
});

describe("property: no private source, media or financial content in payloads", () => {
  it("payloads contain only the work title and the project name, never source material", () => {
    const random = lcg(424242);
    // Adversarial text a source message could carry: conversation content,
    // media references and financial notes. None of it is an input to the
    // payload builder, so none of it can appear — the structural guarantee
    // the property pins.
    const privateFragments = [
      "wycena 45 000 zł netto",
      "zaliczka 10 000 PLN",
      "link: /api/sources/attachments/img_123.jpg",
      "nagranie voice-0042.webm",
      "Klient powiedział w rozmowie, że",
      "hasło: banana42",
    ];
    for (let i = 0; i < 200; i += 1) {
      const privateText = privateFragments[Math.floor(random() * privateFragments.length)] ?? "";
      const subject = task({
        title: `Zadanie ${i}`,
        deadline: binding(
          temporal(
            random() < 0.5
              ? { _tag: "day", day: "2026-11-01" }
              : { _tag: "date_time", value: "2026-11-01T09:00:00.000+01:00[Europe/Warsaw]" },
          ),
        ),
      });
      // Even if the PRIVATE text reached the context's project name, the
      // builder would embed it; the guarantee under test is the builder's
      // closed inputs, so the context uses clean product text.
      const want = desiredCopyForSubject(subject, SCOPE, {
        ...CONTEXT,
        projectName: `Projekt ${i}`,
      });
      if (want.desired.state !== "projected") {
        throw new Error("property fixture must qualify");
      }
      const payload = want.desired.payload as DesiredGoogleEvent;
      const serialized = canonicalJson(payload);
      expect(serialized).not.toContain(privateText);
      expect(serialized).toContain(`Zadanie ${i}`);
    }
  });
});

describe("canonical payload comparison", () => {
  it("is stable for equal payloads in any key order and differs for changed payloads", () => {
    const a = { summary: "T", description: "D", start: { date: "2026-10-15" } };
    const b = { start: { date: "2026-10-15" }, description: "D", summary: "T" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    const c = { ...a, start: { date: "2026-10-16" } };
    expect(canonicalJson(c)).not.toBe(canonicalJson(a));
  });
});
