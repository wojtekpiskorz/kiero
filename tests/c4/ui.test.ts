/**
 * C4 focused verification: the barebones work-list ("Co teraz" work half)
 * feature surface.
 *
 * The host entry for `/co-teraz` stays PENDING by design (mounting is the
 * A4 host lane's edit, joined by the attention half); what this pins is the
 * feature surface the host will mount: the Polish vocabularies rendered
 * from the single domain source, the copy completeness for the load-bearing
 * semantics (independent completion, elapsed-dates-prove-nothing, Czeka
 * reason), and the failure hints for the load-bearing codes. Node-safe:
 * state-only imports, no React tree.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  ChecklistItemState,
  EventOccurrenceState,
  TaskState,
} from "@kiero/contracts";
import {
  CHECKLIST_ITEM_STATE_LABELS,
  EVENT_STATE_LABELS,
  TASK_STATE_LABELS,
} from "../../packages/domain/work/index";
import {
  checklistItemStateLabels,
  eventStateLabels,
  eventStateOrder,
  failureHint,
  taskStateLabels,
  taskStateOrder,
  workCopy,
} from "../../apps/web/src/features/work-list/state";

const CONTRACT_TASK_STATES = [
  "todo",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
] as const;

const CONTRACT_EVENT_STATES = ["planned", "occurred", "cancelled"] as const;

describe("the work-list feature vocabulary", () => {
  it("renders exactly the contract task-state vocabulary, in Polish", () => {
    for (const token of CONTRACT_TASK_STATES) {
      expect(() => Schema.decodeUnknownSync(TaskState)(token)).not.toThrow();
      expect(taskStateLabels[token as keyof typeof taskStateLabels]).toBeTypeOf("string");
    }
    // No "blocked"/"paused" task state exists: the vocabulary is closed.
    expect(() => Schema.decodeUnknownSync(TaskState)("blocked")).toThrow();
    expect(Object.keys(taskStateLabels).sort()).toEqual([...CONTRACT_TASK_STATES].sort());
    expect(taskStateLabels).toEqual(TASK_STATE_LABELS);
    expect(taskStateOrder).toEqual(CONTRACT_TASK_STATES);
  });

  it("renders the checklist mark and event-state vocabularies in Polish", () => {
    for (const token of ["open", "checked"] as const) {
      expect(() => Schema.decodeUnknownSync(ChecklistItemState)(token)).not.toThrow();
    }
    expect(() => Schema.decodeUnknownSync(ChecklistItemState)("done")).toThrow();
    expect(checklistItemStateLabels).toEqual(CHECKLIST_ITEM_STATE_LABELS);
    for (const token of CONTRACT_EVENT_STATES) {
      expect(() => Schema.decodeUnknownSync(EventOccurrenceState)(token)).not.toThrow();
    }
    expect(() => Schema.decodeUnknownSync(EventOccurrenceState)("happened")).toThrow();
    expect(eventStateLabels).toEqual(EVENT_STATE_LABELS);
    expect(eventStateOrder).toEqual(CONTRACT_EVENT_STATES);
  });

  it("carries honest copy for the independence and evidence semantics", () => {
    // Parent completion is independent of checklist completion.
    expect(workCopy.tasksNote).toContain("nie kończy");
    expect(workCopy.tasksNote).toContain("nieodhaczonych punktach");
    expect(workCopy.checklistIntro).toContain("nie zmienia stanu zadania");
    // A passed date proves nothing about an event.
    expect(workCopy.eventsNote).toContain("Minięcie daty nie potwierdza");
    expect(workCopy.eventStateIntro).toContain("Minięcie terminu niczego nie potwierdza");
    // Czeka requires its saved reason.
    expect(workCopy.taskStateIntro).toContain("Czeka wymaga zapisanego powodu");
    // Promotion keeps the point's state and history.
    expect(workCopy.promoteIntro).toContain("zachowuje swój stan i historię");
    // Unassigned coordination is the honest shared queue, not an error.
    expect(workCopy.coordinatorLabel(false)).toContain("wspólna kolejka");
  });

  it("points the empty state at the create form that exists, in glossary terms", () => {
    // "Zadanie" is the glossary term; the empty state must name the control
    // the surface actually renders (the create form below), never a missing
    // one — and the create copy exists and describes what really happens.
    expect(workCopy.noTasks).toContain("zadanie");
    expect(workCopy.noTasks).not.toContain("zobowiązanie");
    expect(workCopy.noTasks).toContain("poniżej");
    expect(workCopy.createHeading).toContain("Zapisz zadanie");
    expect(workCopy.createIntro).toContain("Do zrobienia");
    expect(workCopy.createIntro).toContain("wspólnej kolejce");
    expect(workCopy.createPlaceholder).toMatch(/.+/u);
    expect(workCopy.created).toMatch(/[Zz]adanie/);
  });

  it("renders derived dueness as present claims, never as state changes", () => {
    expect(workCopy.duenessLabel({ kind: "overdue", due: { _tag: "instant", epochMs: 0 } })).toBe(
      "po terminie",
    );
    expect(workCopy.duenessLabel({ kind: "closed" })).toContain("bez zaległości");
    expect(
      workCopy.duenessLabel({ kind: "term_unusable", reason: "conflicted" }),
    ).toContain("wstrzymane");
    expect(workCopy.timingLabel({ kind: "planned_elapsed_unconfirmed", due: { _tag: "instant", epochMs: 0 } })).toContain(
      "bez potwierdzenia",
    );
    expect(workCopy.timingLabel({ kind: "occurred" })).toBe("odbyło się");
  });

  it("hints the load-bearing machine codes", () => {
    for (const code of [
      "waiting_reason_required",
      "waiting_reason_only_for_waiting",
      "item_promoted",
      "item_checked",
      "revision_mismatch",
      "finding_not_temporal",
      "deadline_role_actual",
      "finding_project_mismatch",
      "coordinator_membership_not_active",
    ]) {
      expect(failureHint(code), code).toMatch(/.+/u);
    }
    expect(failureHint("never_seen_code")).toBeNull();
    expect(failureHint(undefined)).toBeNull();
  });
});

it("pins the no-project fallback copy to the rendered surface name", () => {
  expect(workCopy.createNeedsProject).toContain("sekcji Projekty");
  expect(workCopy.createNeedsProject).not.toContain("katalogu projekt");
});
