/**
 * G2 focused verification, part 1: the PURE projection rules from
 * packages/domain/calendar — personal eligibility (selected projects,
 * coordinated-by-me or unassigned, open tasks and planned events), the
 * deterministic term mapping (all-day / interval / five-minute marker per
 * CONTEXT.md), DST-safe company-time rendering, Polish copy text free of
 * private source material, hide persistence, and the per-pass suspension
 * decisions. The transaction halves run against the real dev deployment
 * (tests/g2/live-proof.mjs); what MUST hold structurally is pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  MARKER_DURATION_MS,
  companyDate,
  companyTime,
  copySemanticId,
  copyTitle,
  decideHideAfterDerivation,
  decideProjectionMode,
  decideSubjectEligibility,
  decideTerm,
  desiredCopyForSubject,
  desiredEvent,
  hiddenCopyMustBeAbsent,
  taskStateLabel,
  type DerivationContext,
  type EventSubjectView,
  type PersonalScope,
  type TaskSubjectView,
} from "@kiero/domain";
import type { KnowledgeStateWire, TemporalValueWire, TermBindingView } from "@kiero/domain";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const known: KnowledgeStateWire = { _tag: "known" };
const conflicted: KnowledgeStateWire = { _tag: "conflicted" };

const temporal = (
  shape: TemporalValueWire["shape"],
  role: TemporalValueWire["role"] = "agreed",
): TemporalValueWire => ({ shape, originalExpression: "ustalone", role });

const binding = (
  temporalValue: TemporalValueWire | null,
  state: KnowledgeStateWire = known,
  revisionId = "rev1",
): TermBindingView => ({ knowledgeState: state, temporal: temporalValue, revisionId });

const ALL_PROJECTS: PersonalScope = {
  projectSelection: { mode: "all_projects" },
  ownMembershipIds: new Set(["mA"]),
};

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

const event = (overrides: Partial<EventSubjectView> = {}): EventSubjectView => ({
  kind: "event",
  eventId: "e1",
  projectId: "p1",
  title: "Dostawa okien",
  state: "planned",
  time: binding(temporal({ _tag: "day", day: "2026-10-15" })),
  ...overrides,
});

const CONTEXT: DerivationContext = {
  companyId: "c1",
  userId: "u1",
  googleAccountSubject: "google-sub-1",
  projectName: "Banan",
  companyTimezone: "Europe/Warsaw",
  appBaseUrl: "https://kiero.example",
};

// ---------------------------------------------------------------------------
// Personal scope
// ---------------------------------------------------------------------------

describe("personal eligibility", () => {
  it("projects my coordinated open tasks and unassigned ones, in every selected project", () => {
    expect(decideSubjectEligibility(task(), ALL_PROJECTS)).toEqual({ eligible: true });
    expect(
      decideSubjectEligibility(task({ coordinatorMembershipId: null }), ALL_PROJECTS),
    ).toEqual({ eligible: true });
    expect(
      decideSubjectEligibility(task({ state: "waiting" }), ALL_PROJECTS),
    ).toEqual({ eligible: true });
  });

  it("excludes another boss's task and closed tasks, but never for elapsed time alone", () => {
    expect(
      decideSubjectEligibility(task({ coordinatorMembershipId: "mB" }), ALL_PROJECTS),
    ).toEqual({ eligible: false, reason: "out_of_personal_scope" });
    for (const state of ["done", "cancelled"] as const) {
      expect(decideSubjectEligibility(task({ state }), ALL_PROJECTS)).toEqual({
        eligible: false,
        reason: "subject_closed",
      });
    }
    // A PAST date alone never excludes (past unresolved obligations stay).
    const past = task({ deadline: binding(temporal({ _tag: "day", day: "2020-01-02" })) });
    expect(decideSubjectEligibility(past, ALL_PROJECTS)).toEqual({ eligible: true });
  });

  it("projects all planned events; occurred and cancelled ones withdraw", () => {
    expect(decideSubjectEligibility(event(), ALL_PROJECTS)).toEqual({ eligible: true });
    for (const state of ["occurred", "cancelled"] as const) {
      expect(decideSubjectEligibility(event({ state }), ALL_PROJECTS)).toEqual({
        eligible: false,
        reason: "subject_closed",
      });
    }
  });

  it("filters by the boss's explicit project selection; closed projects stay by default", () => {
    const explicit: PersonalScope = {
      projectSelection: { mode: "explicit", projectIds: new Set(["p2"]) },
      ownMembershipIds: new Set(["mA"]),
    };
    expect(decideSubjectEligibility(task(), explicit)).toEqual({
      eligible: false,
      reason: "out_of_personal_scope",
    });
    expect(decideSubjectEligibility(task({ projectId: "p2" }), explicit)).toEqual({
      eligible: true,
    });
    // Default selection includes every project stage (retained obligations
    // in closed projects stay visible); stage is not even an input here.
    expect(decideSubjectEligibility(task(), ALL_PROJECTS)).toEqual({ eligible: true });
  });
});

// ---------------------------------------------------------------------------
// Term mapping
// ---------------------------------------------------------------------------

describe("term qualification and mapping", () => {
  it("maps a concrete date to all-day, a day range to an interval, a lone time to the marker", () => {
    expect(decideTerm(binding(temporal({ _tag: "day", day: "2026-10-15" })))).toEqual({
      ok: true,
      term: { _tag: "all_day", day: "2026-10-15" },
    });
    expect(
      decideTerm(
        binding(
          temporal({
            _tag: "range",
            start: { _tag: "day", day: "2026-10-15" },
            end: { _tag: "day", day: "2026-10-20" },
          }),
        ),
      ),
    ).toEqual({
      ok: true,
      term: { _tag: "all_day_range", startDay: "2026-10-15", endDay: "2026-10-20" },
    });
    const marker = decideTerm(
      binding(temporal({ _tag: "date_time", value: "2026-10-15T08:30:00.000+02:00[Europe/Warsaw]" })),
    );
    expect(marker).toEqual({
      ok: true,
      term: { _tag: "marker", epochMs: Date.parse("2026-10-15T08:30:00.000+02:00") },
    });
  });

  it("withdraws proposals, approximations, unresolved terms, missing and open-ended bindings", () => {
    expect(decideTerm(binding(temporal({ _tag: "day", day: "2026-10-15" }, "proposed")))).toEqual({
      ok: false,
      reason: "term_proposed",
    });
    expect(decideTerm(binding(temporal({ _tag: "day", day: "2026-10-15" }, "actual")))).toEqual({
      ok: false,
      reason: "term_actual",
    });
    expect(decideTerm(binding(temporal({ _tag: "month", month: "2026-10" })))).toEqual({
      ok: false,
      reason: "term_approximate",
    });
    expect(decideTerm(binding(temporal({ _tag: "year", year: "2026" })))).toEqual({
      ok: false,
      reason: "term_approximate",
    });
    expect(
      decideTerm(
        binding(
          temporal({
            _tag: "range",
            start: { _tag: "month", month: "2026-10" },
            end: { _tag: "day", day: "2026-10-20" },
          }),
        ),
      ),
    ).toEqual({ ok: false, reason: "term_approximate" });
    expect(
      decideTerm(
        binding(temporal({ _tag: "range", start: { _tag: "day", day: "2026-10-15" }, end: null })),
      ),
    ).toEqual({ ok: false, reason: "term_open_ended" });
    expect(decideTerm(binding(null))).toEqual({ ok: false, reason: "term_not_temporal" });
    expect(
      decideTerm(binding(temporal({ _tag: "day", day: "2026-10-15" }), conflicted)),
    ).toEqual({ ok: false, reason: "term_unresolved" });
    expect(decideTerm(binding(null, { _tag: "unknown", reason: "niejasne" }))).toEqual({
      ok: false,
      reason: "term_unresolved",
    });
    expect(decideTerm(null)).toEqual({ ok: false, reason: "no_binding" });
  });

  it("keeps internal plans and agreed terms, the two exporting roles", () => {
    for (const role of ["internal", "agreed"] as const) {
      expect(decideTerm(binding(temporal({ _tag: "day", day: "2026-10-15" }, role)))).toEqual({
        ok: true,
        term: { _tag: "all_day", day: "2026-10-15" },
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Copy text, marker semantics, DST
// ---------------------------------------------------------------------------

describe("copy text and the five-minute marker", () => {
  it("marks the title with the hour in company time and explains the marker in the description", () => {
    const subject = task({
      deadline: binding(
        temporal({ _tag: "date_time", value: "2026-10-15T08:30:00.000+02:00[Europe/Warsaw]" }),
      ),
    });
    const term = { _tag: "marker", epochMs: Date.parse("2026-10-15T08:30:00.000+02:00") } as const;
    expect(copyTitle(subject, term, CONTEXT)).toBe(
      "Zadanie: Odebrać dostawę — godz. 08:30 (czas firmy)",
    );
    const payload = desiredEvent(subject, subject.deadline as TermBindingView, term, CONTEXT);
    expect(payload.start.dateTime).toBe("2026-10-15T06:30:00.000Z");
    expect(payload.end.dateTime).toBe("2026-10-15T06:35:00.000Z");
    expect(Date.parse(payload.end.dateTime ?? "") - Date.parse(payload.start.dateTime ?? "")).toBe(
      MARKER_DURATION_MS,
    );
    expect(payload.description).toContain("pięciominutowy znacznik");
    expect(payload.description).toContain("nie ustalenie czasu pracy");
    expect(payload.description).toContain("czas firmy");
    expect(payload.description).toContain("Projekt: Banan");
    expect(payload.description).toContain("Stan: Do zrobienia");
    expect(payload.description).toContain("termin uzgodniony");
    expect(payload.description).toContain("https://kiero.example/co-teraz?zadanie=t1");
  });

  it("keeps a date-only term all-day with an exclusive next-day end and no invented hour", () => {
    const payload = desiredEvent(
      event(),
      event().time as TermBindingView,
      { _tag: "all_day", day: "2026-10-15" },
      CONTEXT,
    );
    expect(payload.start).toEqual({ date: "2026-10-15" });
    expect(payload.end).toEqual({ date: "2026-10-16" });
    expect(payload.summary).toBe("Zdarzenie: Dostawa okien");
    expect(payload.description).toContain("cały dzień");
  });

  it("maps a day range to one all-day interval across the whole span", () => {
    const payload = desiredEvent(
      event(),
      event().time as TermBindingView,
      { _tag: "all_day_range", startDay: "2026-10-15", endDay: "2026-10-20" },
      CONTEXT,
    );
    expect(payload.start).toEqual({ date: "2026-10-15" });
    expect(payload.end).toEqual({ date: "2026-10-21" });
  });

  it("renders company time across DST transitions (Europe/Warsaw)", () => {
    // Spring forward 2026-03-29: 02:00 -> 03:00 CET->CEST.
    const before = Date.parse("2026-03-28T15:30:00.000+01:00");
    const spring = Date.parse("2026-03-29T03:30:00.000+02:00");
    const fall = Date.parse("2026-10-25T02:30:00.000+02:00");
    expect(companyTime(before, "Europe/Warsaw")).toBe("15:30");
    expect(companyTime(spring, "Europe/Warsaw")).toBe("03:30");
    expect(companyTime(fall, "Europe/Warsaw")).toBe("02:30");
    expect(companyDate(spring, "Europe/Warsaw")).toBe("29.03.2026");
    // The same instant renders per the reader's rules, but the copy text is
    // always the FIRM's zone: a New York instant still prints Warsaw time.
    const newYork = Date.parse("2026-03-29T03:30:00.000+02:00");
    expect(companyTime(newYork, "Europe/Warsaw")).toBe("03:30");
  });

  it("labels states in Polish, including Czeka's saved reason", () => {
    expect(taskStateLabel("waiting", "brak materiałów")).toBe("Czeka (brak materiałów)");
    expect(taskStateLabel("done")).toBe("Wykonane");
  });

  it("keeps new copies free-time and free of Google event reminders", () => {
    const payload = desiredEvent(
      task(),
      task().deadline as TermBindingView,
      { _tag: "all_day", day: "2026-10-15" },
      CONTEXT,
    );
    expect(payload.transparency).toBe("transparent");
    expect(payload.reminders).toEqual({ useDefault: false, overrides: [] });
  });
});

// ---------------------------------------------------------------------------
// Deterministic identities
// ---------------------------------------------------------------------------

describe("copy identity", () => {
  it("is stable per user/company/account/subject and separates a task from its linked event", () => {
    const base = {
      companyId: "c1",
      userId: "u1",
      googleAccountSubject: "g1",
    };
    const id = copySemanticId({ ...base, subjectKind: "task", subjectId: "t1" });
    expect(copySemanticId({ ...base, subjectKind: "task", subjectId: "t1" })).toBe(id);
    expect(copySemanticId({ ...base, subjectKind: "event", subjectId: "e1" })).not.toBe(id);
    expect(copySemanticId({ ...base, userId: "u2", subjectKind: "task", subjectId: "t1" })).not.toBe(id);
    expect(
      copySemanticId({ ...base, googleAccountSubject: "g2", subjectKind: "task", subjectId: "t1" }),
    ).not.toBe(id);
    expect(copySemanticId({ ...base, googleAccountSubject: null, subjectKind: "task", subjectId: "t1" })).not.toBe(id);
  });
});

// ---------------------------------------------------------------------------
// One subject's complete desired copy
// ---------------------------------------------------------------------------

describe("desiredCopyForSubject", () => {
  it("derives a projected copy with payload, semantic id and the current revision basis", () => {
    const want = desiredCopyForSubject(task(), ALL_PROJECTS, CONTEXT);
    expect(want.desired).toEqual({
      state: "projected",
      payload: expect.objectContaining({ summary: "Zadanie: Odebrać dostawę" }),
    });
    expect(want.semanticId).toBe(
      copySemanticId({
        companyId: "c1",
        userId: "u1",
        googleAccountSubject: "google-sub-1",
        subjectKind: "task",
        subjectId: "t1",
      }),
    );
    expect(want.derivationRevisionId).toBe("rev1");
  });

  it("withdraws with a machine reason when the subject or term leaves the scope", () => {
    expect(desiredCopyForSubject(task({ state: "done" }), ALL_PROJECTS, CONTEXT).desired).toEqual({
      state: "withdrawn",
      reason: "subject_closed",
    });
    expect(
      desiredCopyForSubject(task({ coordinatorMembershipId: "mB" }), ALL_PROJECTS, CONTEXT).desired,
    ).toEqual({ state: "withdrawn", reason: "out_of_personal_scope" });
    expect(
      desiredCopyForSubject(
        task({ deadline: binding(temporal({ _tag: "month", month: "2026-10" })) }),
        ALL_PROJECTS,
        CONTEXT,
      ).desired,
    ).toEqual({ state: "withdrawn", reason: "term_approximate" });
    expect(desiredCopyForSubject(task({ deadline: null }), ALL_PROJECTS, CONTEXT).desired).toEqual({
      state: "withdrawn",
      reason: "no_binding",
    });
  });
});

// ---------------------------------------------------------------------------
// Hide persistence
// ---------------------------------------------------------------------------

describe("hide persistence", () => {
  it("survives every re-derivation until an explicit restore", () => {
    const hidden = { hidden: true, origin: "user_request" as const };
    expect(decideHideAfterDerivation(hidden, undefined)).toEqual({
      next: hidden,
      changed: false,
    });
    // A correction, a state change, a disqualification: none of them is a
    // restore request.
    expect(decideHideAfterDerivation(hidden, {})).toEqual({ next: hidden, changed: false });
    expect(decideHideAfterDerivation(hidden, { restore: false })).toEqual({
      next: hidden,
      changed: false,
    });
    const restored = decideHideAfterDerivation(hidden, { restore: true });
    expect(restored.next).toEqual({ hidden: false, origin: null });
    expect(restored.changed).toBe(true);
  });

  it("keeps a hidden copy absent from Google without withdrawing the subject", () => {
    expect(hiddenCopyMustBeAbsent(true)).toBe(true);
    expect(hiddenCopyMustBeAbsent(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-pass suspension
// ---------------------------------------------------------------------------

describe("per-pass connection recheck", () => {
  const connected = { state: "connected" as const, firmStillActive: true };

  it("projects only on a confirmed refresh", () => {
    expect(decideProjectionMode(connected, "refreshed")).toEqual({ kind: "project" });
  });

  it("suspends without writes on unknown refresh, lost consent, lost membership or absent credential", () => {
    expect(decideProjectionMode(connected, "unknown")).toEqual({
      kind: "suspend",
      reason: "refresh_unknown",
    });
    expect(decideProjectionMode(connected, "definitely_lost")).toEqual({
      kind: "suspend",
      reason: "refresh_lost",
    });
    expect(decideProjectionMode(connected, "no_credential")).toEqual({
      kind: "suspend",
      reason: "no_credential",
    });
    expect(decideProjectionMode({ ...connected, firmStillActive: false }, "refreshed")).toEqual({
      kind: "suspend",
      reason: "membership_lost",
    });
    expect(decideProjectionMode({ ...connected, state: "error" }, "refreshed")).toEqual({
      kind: "suspend",
      reason: "not_connected",
    });
    expect(decideProjectionMode(null, "refreshed")).toEqual({
      kind: "suspend",
      reason: "no_connection",
    });
  });
});
