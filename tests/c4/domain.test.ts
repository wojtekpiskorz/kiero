/**
 * C4 focused verification, part 1: the PURE domain rules from
 * packages/domain/work — task states (Czeka needs its reason), checklist
 * independence in both directions, event states (a passed date proves
 * nothing), temporal binding roles, derived dueness across company-timezone
 * day boundaries, and effective coordination from membership lifecycle.
 *
 * The transaction halves run against the real dev deployment
 * (tests/c4/live-proof.mjs); what MUST hold structurally is pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  CHECKLIST_ITEM_STATE_LABELS,
  CLOSED_TASK_STATES,
  DEADLINE_ROLES,
  EVENT_STATE_LABELS,
  TASK_STATE_LABELS,
  checkCoordinatorMembership,
  checkTemporalBinding,
  checklistProgress,
  decideChecklistItemChange,
  decideChecklistPromotion,
  decideEventStateChange,
  decideTaskStateChange,
  deriveEffectiveCoordinator,
  deriveEventTiming,
  deriveTaskDueness,
  dueMomentOf,
  hasElapsed,
  isClosedTaskState,
  isOpenTaskState,
  lastDayOfMonth,
  temporalValueOf,
  validateChecklistDescription,
  validateEventTitle,
  validateTaskTitle,
  validateWaitingReason,
  type TaskDueness,
  type TemporalValueWire,
} from "@kiero/domain";
import type { EventOccurrenceState, TaskState } from "@kiero/contracts";

const TASK_STATES: readonly TaskState[] = ["todo", "in_progress", "waiting", "done", "cancelled"];
const EVENT_STATES: readonly EventOccurrenceState[] = ["planned", "occurred", "cancelled"];

const day = (value: string, role: TemporalValueWire["role"] = "agreed"): TemporalValueWire => ({
  shape: { _tag: "day", day: value },
  originalExpression: value,
  role,
});
const known = { _tag: "known" } as const;
const WARSAW = "Europe/Warsaw";

// ---------------------------------------------------------------------------
// Task state: the glossary vocabulary and the Czeka rule
// ---------------------------------------------------------------------------

describe("task state vocabulary (Stan zadania)", () => {
  it("renders exactly the five glossary states in Polish", () => {
    expect(TASK_STATE_LABELS).toEqual({
      todo: "Do zrobienia",
      in_progress: "W toku",
      waiting: "Czeka",
      done: "Wykonane",
      cancelled: "Anulowane",
    });
    expect(CLOSED_TASK_STATES).toEqual(["done", "cancelled"]);
    for (const state of TASK_STATES) {
      expect(isClosedTaskState(state)).toBe(state === "done" || state === "cancelled");
      expect(isOpenTaskState(state)).toBe(!isClosedTaskState(state));
    }
  });

  it("refuses Czeka without a saved reason (a known obstacle needs its reason)", () => {
    const current = { state: "todo" as const, waitingReason: null };
    expect(decideTaskStateChange(current, { state: "waiting", waitingReason: undefined })).toEqual({
      kind: "rejected",
      code: "waiting_reason_required",
    });
    expect(decideTaskStateChange(current, { state: "waiting", waitingReason: "   " })).toEqual({
      kind: "rejected",
      code: "waiting_reason_required",
    });
    expect(
      decideTaskStateChange(current, { state: "waiting", waitingReason: "x".repeat(501) }),
    ).toEqual({ kind: "rejected", code: "waiting_reason_too_long" });
    expect(validateWaitingReason("  brak okien  ")).toEqual({ ok: true, value: "brak okien" });
  });

  it("enters Czeka with the trimmed reason saved on the transition", () => {
    expect(
      decideTaskStateChange(
        { state: "in_progress", waitingReason: null },
        { state: "waiting", waitingReason: "  czekamy na odpowiedź klienta " },
      ),
    ).toEqual({
      kind: "transition",
      from: "in_progress",
      to: "waiting",
      waitingReason: "czekamy na odpowiedź klienta",
      close: false,
      reopen: false,
    });
  });

  it("refuses a reason outside Czeka (the reason belongs to that one state)", () => {
    for (const state of TASK_STATES.filter((s) => s !== "waiting")) {
      expect(
        decideTaskStateChange({ state: "todo", waitingReason: null }, { state, waitingReason: "bo" }),
      ).toEqual({ kind: "rejected", code: "waiting_reason_only_for_waiting" });
    }
  });

  it("re-describes the obstacle without moving the state (Czeka to Czeka, new reason)", () => {
    const current = { state: "waiting" as const, waitingReason: "brak okien" };
    expect(decideTaskStateChange(current, { state: "waiting", waitingReason: "brak okien" })).toEqual({
      kind: "unchanged",
    });
    const redescribed = decideTaskStateChange(current, {
      state: "waiting",
      waitingReason: "brak drzwi",
    });
    expect(redescribed).toEqual({ kind: "reason_changed", waitingReason: "brak drzwi" });
    // The domain decision is the authority for the transaction halves: a
    // re-description is NOT a state move, so no from/to pair exists and the
    // transaction must not bump `stateChangedAtMs` (which would reposition
    // the task inside `by_company_state` on a mere reason edit).
    expect("from" in redescribed).toBe(false);
    expect("to" in redescribed).toBe(false);
  });

  it("clears the reason when leaving Czeka", () => {
    const decision = decideTaskStateChange(
      { state: "waiting", waitingReason: "brak okien" },
      { state: "in_progress", waitingReason: undefined },
    );
    expect(decision).toEqual({
      kind: "transition",
      from: "waiting",
      to: "in_progress",
      waitingReason: null,
      close: false,
      reopen: false,
    });
  });

  it("needs no sequence: Do zrobienia goes straight to Wykonane, and reopen is explicit", () => {
    expect(
      decideTaskStateChange({ state: "todo", waitingReason: null }, { state: "done", waitingReason: undefined }),
    ).toMatchObject({ kind: "transition", from: "todo", to: "done", close: true, reopen: false });
    expect(
      decideTaskStateChange({ state: "done", waitingReason: null }, { state: "todo", waitingReason: undefined }),
    ).toMatchObject({ kind: "transition", from: "done", to: "todo", close: false, reopen: true });
    // Correcting WHAT ended it (done -> cancelled) is neither a close nor a reopen.
    expect(
      decideTaskStateChange({ state: "done", waitingReason: null }, { state: "cancelled", waitingReason: undefined }),
    ).toMatchObject({ kind: "transition", close: false, reopen: false });
  });

  it("is total over every pairing of the five states and idempotent on the same state", () => {
    for (const from of TASK_STATES) {
      for (const to of TASK_STATES) {
        const decision = decideTaskStateChange(
          { state: from, waitingReason: from === "waiting" ? "r" : null },
          { state: to, waitingReason: to === "waiting" ? "r" : undefined },
        );
        expect(decision.kind, `${from} -> ${to}`).toBe(from === to ? "unchanged" : "transition");
      }
    }
  });

  it("has no input through which checklist progress or time could complete a task", () => {
    // The decision's parameters are exactly (current record, commanded
    // target): the function's arity and the view types carry no checklist
    // counts and no clock. Pinning arity keeps a future "helpful" parameter
    // from sneaking in unnoticed.
    expect(decideTaskStateChange.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Checklist: independent in both directions, one level, promotion
// ---------------------------------------------------------------------------

describe("checklist independence (Checklista zadania)", () => {
  const open = { description: "kupić płytki", state: "open" as const, promotedToTaskId: null };

  it("renders the completion mark in Polish", () => {
    expect(CHECKLIST_ITEM_STATE_LABELS).toEqual({ open: "Nieodhaczony", checked: "Odhaczony" });
  });

  it("checking every point yields ONLY list progress, never a parent verdict", () => {
    const items = [
      { ...open, state: "checked" as const },
      { ...open, description: "zamówić fugę", state: "checked" as const },
      { ...open, description: "wezwać hydraulika", state: "checked" as const },
    ];
    expect(checklistProgress(items)).toEqual({ checked: 3, total: 3 });
    // There is no function in the work domain that maps list progress to a
    // task state; the ONLY state decision takes no list at all.
    expect(decideTaskStateChange.length).toBe(2);
  });

  it("records Wykonane with 2/3 as a valid, honest state (progress stays progress)", () => {
    const items = [
      { ...open, state: "checked" as const },
      { ...open, description: "b", state: "checked" as const },
      { ...open, description: "c", state: "open" as const },
    ];
    expect(checklistProgress(items)).toEqual({ checked: 2, total: 3 });
    const closed = decideTaskStateChange(
      { state: "in_progress", waitingReason: null },
      { state: "done", waitingReason: undefined },
    );
    expect(closed.kind).toBe("transition");
    // Completing the parent changes nothing about the points: the point
    // decision is a separate function over the point alone.
    expect(decideChecklistItemChange(items[2] ?? null, { description: "c", state: "open" })).toEqual({
      kind: "unchanged",
    });
  });

  it("creates, updates, and is idempotent on identical content", () => {
    expect(decideChecklistItemChange(null, { description: "  kupić płytki ", state: "open" })).toEqual({
      kind: "create",
      description: "kupić płytki",
    });
    expect(decideChecklistItemChange(open, { description: "kupić płytki", state: "checked" })).toEqual({
      kind: "update",
      description: "kupić płytki",
      descriptionChanged: false,
      stateChanged: true,
    });
    expect(decideChecklistItemChange(open, { description: "kupić kafle", state: "open" })).toEqual({
      kind: "update",
      description: "kupić kafle",
      descriptionChanged: true,
      stateChanged: false,
    });
    expect(decideChecklistItemChange(open, { description: "kupić płytki", state: "open" })).toEqual({
      kind: "unchanged",
    });
    expect(decideChecklistItemChange(null, { description: "   ", state: "open" })).toEqual({
      kind: "rejected",
      code: "checklist_description_empty",
    });
    expect(validateChecklistDescription("x".repeat(301))).toEqual({
      ok: false,
      code: "checklist_description_too_long",
    });
  });

  it("promotes an open point into a linked task titled by the point, then freezes the point", () => {
    expect(decideChecklistPromotion(open)).toEqual({ kind: "promote", title: "kupić płytki" });
    const promoted = { ...open, promotedToTaskId: "t2" };
    expect(decideChecklistPromotion(promoted)).toEqual({ kind: "rejected", code: "item_promoted" });
    expect(decideChecklistItemChange(promoted, { description: "kupić płytki", state: "checked" })).toEqual({
      kind: "rejected",
      code: "item_promoted",
    });
    // A checked point needs no owner or deadline of its own.
    expect(decideChecklistPromotion({ ...open, state: "checked" })).toEqual({
      kind: "rejected",
      code: "item_checked",
    });
  });

  it("excludes promoted points from list progress (their obligation moved)", () => {
    expect(
      checklistProgress([
        { ...open, state: "checked" },
        { ...open, description: "b", promotedToTaskId: "t2" },
      ]),
    ).toEqual({ checked: 1, total: 1 });
  });
});

// ---------------------------------------------------------------------------
// Event state: explicit facts only
// ---------------------------------------------------------------------------

describe("event state (Stan zdarzenia)", () => {
  it("renders the three glossary states in Polish", () => {
    expect(EVENT_STATE_LABELS).toEqual({
      planned: "Planowane",
      occurred: "Odbyło się",
      cancelled: "Anulowane",
    });
  });

  it("is total over every pairing and idempotent on the same state", () => {
    for (const from of EVENT_STATES) {
      for (const to of EVENT_STATES) {
        expect(decideEventStateChange(from, to)).toEqual(
          from === to ? { kind: "unchanged" } : { kind: "transition", from, to },
        );
      }
    }
  });

  it("takes no time: an elapsed planned date cannot enter the decision", () => {
    expect(decideEventStateChange.length).toBe(2);
  });

  it("validates event titles", () => {
    expect(validateEventTitle(" Dostawa okien ")).toEqual({ ok: true, value: "Dostawa okien" });
    expect(validateEventTitle("  ")).toEqual({ ok: false, code: "event_title_empty" });
    expect(validateEventTitle("x".repeat(201))).toEqual({ ok: false, code: "event_title_too_long" });
  });
});

// ---------------------------------------------------------------------------
// Temporal bindings: roles and value shapes
// ---------------------------------------------------------------------------

describe("temporal binding roles (proposed / internal / agreed / actual)", () => {
  const temporalFinding = (role: TemporalValueWire["role"]) => ({
    _tag: "temporal",
    temporal: day("2026-10-12", role),
  });

  it("binds the three forward-looking roles as a task deadline and refuses actual", () => {
    expect(DEADLINE_ROLES).toEqual(["proposed", "internal", "agreed"]);
    for (const role of ["proposed", "internal", "agreed"] as const) {
      expect(checkTemporalBinding("task_deadline", temporalFinding(role))).toMatchObject({ ok: true });
    }
    expect(checkTemporalBinding("task_deadline", temporalFinding("actual"))).toEqual({
      ok: false,
      code: "deadline_role_actual",
    });
  });

  it("binds any role as an event time (planned or actual occurrence date)", () => {
    for (const role of ["proposed", "internal", "agreed", "actual"] as const) {
      expect(checkTemporalBinding("event_time", temporalFinding(role))).toMatchObject({ ok: true });
    }
  });

  it("refuses a finding whose current value is not temporal", () => {
    const money = {
      _tag: "money",
      money: {
        role: "agreed_price",
        amount: { _tag: "exact", value: "10000" },
        currency: "PLN",
        currencyOrigin: "stated",
        taxBasis: "not_specified",
        certainty: "exact",
      },
    };
    expect(temporalValueOf(money)).toBeNull();
    expect(temporalValueOf({ _tag: "text_note", text: "x" })).toBeNull();
    expect(temporalValueOf("garbage")).toBeNull();
    expect(checkTemporalBinding("task_deadline", money)).toEqual({ ok: false, code: "finding_not_temporal" });
    expect(checkTemporalBinding("event_time", { _tag: "text_note", text: "x" })).toEqual({
      ok: false,
      code: "finding_not_temporal",
    });
  });

  it("reads the temporal payload through the contract codec (no cast)", () => {
    expect(temporalValueOf(temporalFinding("agreed"))).toEqual(day("2026-10-12", "agreed"));
  });
});

// ---------------------------------------------------------------------------
// Derived dueness: "Zadanie po terminie" in the company timezone
// ---------------------------------------------------------------------------

describe("derived dueness (Zadanie po terminie)", () => {
  const at = (iso: string) => Date.parse(iso);
  const dueness = (
    state: TaskState,
    temporal: TemporalValueWire | null,
    nowMs: number,
    tz = WARSAW,
    knowledgeState: { _tag: "known" } | { _tag: "unknown"; reason: string } | { _tag: "conflicted" } | { _tag: "not_applicable" } = known,
  ): TaskDueness =>
    deriveTaskDueness({
      state,
      deadline: temporal === null && knowledgeState._tag === "known" ? null : { knowledgeState, temporal },
      nowMs,
      companyTimezone: tz,
    });

  it("becomes overdue only AFTER the deadline day ends in the company timezone (summer, CEST)", () => {
    const deadline = day("2026-09-08");
    // 23:59:59 in Warsaw on the 8th (21:59:59Z): still that day, still pending.
    expect(dueness("todo", deadline, at("2026-09-08T21:59:59.999Z"))).toEqual({
      kind: "pending",
      due: { _tag: "end_of_local_day", day: "2026-09-08" },
    });
    // 00:00:00 in Warsaw on the 9th (22:00:00Z): the day ended, overdue.
    expect(dueness("todo", deadline, at("2026-09-08T22:00:00.000Z"))).toEqual({
      kind: "overdue",
      due: { _tag: "end_of_local_day", day: "2026-09-08" },
    });
  });

  it("uses the COMPANY zone, not the server's: the same instant is still the 8th in UTC", () => {
    const deadline = day("2026-09-08");
    const instant = at("2026-09-08T22:00:00.000Z");
    expect(dueness("todo", deadline, instant, WARSAW).kind).toBe("overdue");
    expect(dueness("todo", deadline, instant, "UTC").kind).toBe("pending");
    // And a zone WEST of UTC is even earlier in its day.
    expect(dueness("todo", deadline, instant, "America/New_York").kind).toBe("pending");
    // A zone far east already reached the 9th long ago.
    expect(dueness("todo", deadline, at("2026-09-08T14:00:00.000Z"), "Pacific/Auckland").kind).toBe("overdue");
  });

  it("follows the zone's real rules across DST (winter, CET)", () => {
    const deadline = day("2026-01-05");
    expect(dueness("todo", deadline, at("2026-01-05T22:59:59.999Z")).kind).toBe("pending");
    expect(dueness("todo", deadline, at("2026-01-05T23:00:00.000Z")).kind).toBe("overdue");
  });

  it("never invents a day for month or year precision: the term ends with the period", () => {
    const february = { shape: { _tag: "month", month: "2026-02" }, originalExpression: "w lutym", role: "agreed" } as const;
    expect(lastDayOfMonth("2026-02")).toBe("2026-02-28");
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(lastDayOfMonth("2026-12")).toBe("2026-12-31");
    // 2026-02-28 23:59:59 Warsaw = 22:59:59Z: pending. 2026-03-01 00:00 Warsaw: overdue.
    expect(dueness("todo", february, at("2026-02-28T22:59:59.999Z"))).toEqual({
      kind: "pending",
      due: { _tag: "end_of_local_day", day: "2026-02-28" },
    });
    expect(dueness("todo", february, at("2026-02-28T23:00:00.000Z")).kind).toBe("overdue");
    const year = { shape: { _tag: "year", year: "2025" }, originalExpression: "w 2025", role: "internal" } as const;
    expect(dueness("todo", year, at("2025-12-31T22:59:59.000Z")).kind).toBe("pending");
    expect(dueness("todo", year, at("2025-12-31T23:00:00.000Z"))).toEqual({
      kind: "overdue",
      due: { _tag: "end_of_local_day", day: "2025-12-31" },
    });
  });

  it("takes a range's END as the term and leaves an open end unusable", () => {
    const bounded = {
      shape: { _tag: "range", start: { _tag: "day", day: "2026-09-01" }, end: { _tag: "month", month: "2026-09" } },
      originalExpression: "we wrześniu",
      role: "agreed",
    } as const;
    expect(dueness("todo", bounded, at("2026-09-30T21:59:59.000Z"))).toEqual({
      kind: "pending",
      due: { _tag: "end_of_local_day", day: "2026-09-30" },
    });
    expect(dueness("todo", bounded, at("2026-09-30T22:00:00.000Z")).kind).toBe("overdue");
    const openEnded = {
      shape: { _tag: "range", start: { _tag: "day", day: "2026-09-01" }, end: null },
      originalExpression: "od września",
      role: "agreed",
    } as const;
    expect(dueness("todo", openEnded, at("2030-01-01T00:00:00.000Z"))).toEqual({
      kind: "term_unusable",
      reason: "open_ended",
    });
  });

  it("elapses a zoned date/time at its instant, wherever the company is", () => {
    const zoned = {
      shape: { _tag: "date_time", value: "2026-01-05T10:30:00.000+01:00[Europe/Warsaw]" },
      originalExpression: "5 stycznia o 10:30",
      role: "agreed",
    } as const;
    const instant = at("2026-01-05T09:30:00.000Z");
    expect(dueMomentOf(zoned)).toEqual({ ok: true, due: { _tag: "instant", epochMs: instant } });
    expect(dueness("todo", zoned, instant).kind).toBe("pending"); // not yet past
    expect(dueness("todo", zoned, instant + 1).kind).toBe("overdue");
    expect(dueness("todo", zoned, instant + 1, "Pacific/Honolulu").kind).toBe("overdue");
    expect(hasElapsed({ _tag: "instant", epochMs: instant }, instant, WARSAW)).toBe(false);
  });

  it("does not suspend the term while Czeka: a known obstacle is not a moved deadline", () => {
    expect(dueness("waiting", day("2026-09-08"), at("2026-09-09T12:00:00.000Z")).kind).toBe("overdue");
    expect(dueness("in_progress", day("2026-09-08"), at("2026-09-09T12:00:00.000Z")).kind).toBe("overdue");
  });

  it("is never overdue once Wykonane or Anulowane, and never without a term", () => {
    const longPast = at("2030-01-01T00:00:00.000Z");
    expect(dueness("done", day("2026-09-08"), longPast)).toEqual({ kind: "closed" });
    expect(dueness("cancelled", day("2026-09-08"), longPast)).toEqual({ kind: "closed" });
    expect(dueness("todo", null, longPast)).toEqual({ kind: "no_deadline" });
  });

  it("reports an unknown, conflicted or not-applicable term as unusable, not overdue", () => {
    const longPast = at("2030-01-01T00:00:00.000Z");
    expect(dueness("todo", day("2026-09-08"), longPast, WARSAW, { _tag: "conflicted" })).toEqual({
      kind: "term_unusable",
      reason: "conflicted",
    });
    expect(dueness("todo", day("2026-09-08"), longPast, WARSAW, { _tag: "unknown", reason: "asked" })).toEqual({
      kind: "term_unusable",
      reason: "unknown",
    });
    expect(dueness("todo", day("2026-09-08"), longPast, WARSAW, { _tag: "not_applicable" })).toEqual({
      kind: "term_unusable",
      reason: "not_applicable",
    });
    // A binding whose finding stopped being temporal (revised to a note).
    expect(dueness("todo", null, longPast, WARSAW, known)).toEqual({ kind: "no_deadline" });
    expect(
      deriveTaskDueness({
        state: "todo",
        deadline: { knowledgeState: known, temporal: null },
        nowMs: longPast,
        companyTimezone: WARSAW,
      }),
    ).toEqual({ kind: "term_unusable", reason: "not_temporal" });
    // An actual date that later replaced the agreed term is not a deadline.
    expect(dueness("todo", day("2026-09-08", "actual"), longPast)).toEqual({
      kind: "term_unusable",
      reason: "role_actual",
    });
  });
});

// ---------------------------------------------------------------------------
// Derived event timing: elapsed stays planned
// ---------------------------------------------------------------------------

describe("derived event timing (Stan zdarzenia: upływ daty nie potwierdza)", () => {
  const at = (iso: string) => Date.parse(iso);
  const timing = (state: EventOccurrenceState, temporal: TemporalValueWire | null, nowMs: number) =>
    deriveEventTiming({
      state,
      time: temporal === null ? null : { knowledgeState: known, temporal },
      nowMs,
      companyTimezone: WARSAW,
    });

  it("reports a planned event past its date as ELAPSED-UNCONFIRMED, never occurred", () => {
    const friday = day("2026-09-11");
    expect(timing("planned", friday, at("2026-09-11T20:00:00.000Z"))).toEqual({
      kind: "planned_upcoming",
      due: { _tag: "end_of_local_day", day: "2026-09-11" },
    });
    const afterFriday = timing("planned", friday, at("2026-09-13T20:00:00.000Z"));
    expect(afterFriday).toEqual({
      kind: "planned_elapsed_unconfirmed",
      due: { _tag: "end_of_local_day", day: "2026-09-11" },
    });
    expect(afterFriday.kind).not.toBe("occurred");
  });

  it("reflects only the explicit state for occurred and cancelled", () => {
    expect(timing("occurred", day("2026-09-11"), at("2026-09-01T00:00:00.000Z"))).toEqual({ kind: "occurred" });
    expect(timing("cancelled", day("2026-09-11"), at("2030-01-01T00:00:00.000Z"))).toEqual({ kind: "cancelled" });
  });

  it("accepts an actual-role time for an event and reports a missing or unusable one", () => {
    expect(timing("planned", day("2026-09-11", "actual"), at("2026-09-01T00:00:00.000Z")).kind).toBe(
      "planned_upcoming",
    );
    expect(timing("planned", null, at("2026-09-01T00:00:00.000Z"))).toEqual({ kind: "planned_no_time" });
    expect(
      deriveEventTiming({
        state: "planned",
        time: { knowledgeState: { _tag: "conflicted" }, temporal: day("2026-09-11") },
        nowMs: at("2030-01-01T00:00:00.000Z"),
        companyTimezone: WARSAW,
      }),
    ).toEqual({ kind: "planned_time_unusable", reason: "conflicted" });
  });
});

// ---------------------------------------------------------------------------
// Executor, coordinator, effective coordination
// ---------------------------------------------------------------------------

describe("executor and coordinator (Wykonawca / Koordynator zadania)", () => {
  it("validates task titles", () => {
    expect(validateTaskTitle("  Odebrać dostawę ")).toEqual({ ok: true, value: "Odebrać dostawę" });
    expect(validateTaskTitle("   ")).toEqual({ ok: false, code: "task_title_empty" });
    expect(validateTaskTitle("x".repeat(201))).toEqual({ ok: false, code: "task_title_too_long" });
  });

  it("lets only an active membership coordinate", () => {
    expect(checkCoordinatorMembership("active")).toEqual({ ok: true });
    expect(checkCoordinatorMembership("revoked")).toEqual({
      ok: false,
      code: "coordinator_membership_not_active",
    });
  });

  it("derives the effective coordinator: active stays, revoked becomes unassigned, history untouched", () => {
    const assignment = { membershipId: "m1", state: "active" as const };
    expect(deriveEffectiveCoordinator(assignment)).toBe("m1");
    expect(deriveEffectiveCoordinator({ ...assignment, state: "revoked" })).toBeNull();
    expect(deriveEffectiveCoordinator(null)).toBeNull();
    // The input is not mutated: the stored assignment remains the history.
    expect(assignment).toEqual({ membershipId: "m1", state: "active" });
  });

  it("has no actor input: nothing here can assign the command's author", () => {
    expect(deriveEffectiveCoordinator.length).toBe(1);
    expect(checkCoordinatorMembership.length).toBe(1);
  });
});
