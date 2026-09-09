/**
 * C1 focused verification: the pure domain cores for projects, aliases,
 * pause and contact roles (packages/domain/projects).
 *
 * Every boundary the issue names without a deployment:
 * - stage vocabulary decisions over all stage pairings (no sequencing,
 *   close/reopen/reclassify, pause never a stage);
 * - pause vs stage separation, reason bounds, resume-date non-derivation;
 * - codename reservation across retained history (rename, closure, races
 *   between two projects, own re-claim, generated namespace);
 * - role multiplicity without identity duplication;
 * - name validations.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { LocalDate } from "@kiero/contracts";
import {
  CLOSED_STAGES,
  PROJECT_STAGE_LABELS,
  decideStageChange,
  isClosedStage,
  MAX_CODENAME_LENGTH,
  MAX_CONTACT_NAME_LENGTH,
  MAX_PAUSE_REASON_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  CONTACT_KIND_LABELS,
  CONTACT_ROLE_LABELS,
  decideCodenameReservation,
  decideContactRoleAssignment,
  decidePauseChange,
  generatedCodename,
  isGeneratedCodename,
  nextWorkingAliasSequence,
  validateCodename,
  validateContactName,
  validatePauseReason,
  validateProjectDisplayName,
} from "../../packages/domain/projects/index";
import type { ProjectStage } from "@kiero/contracts";

const ALL_STAGES: readonly ProjectStage[] = [
  "inquiry",
  "offer_preparation",
  "awaiting_decision",
  "agreed",
  "in_progress",
  "completed",
  "cancelled",
];

describe("project stage decisions (issue 9 vocabulary)", () => {
  it("renders every stage in Polish and nothing more", () => {
    expect(Object.keys(PROJECT_STAGE_LABELS).sort()).toEqual([...ALL_STAGES].sort());
    expect(PROJECT_STAGE_LABELS.inquiry).toBe("Zapytanie");
    expect(PROJECT_STAGE_LABELS.offer_preparation).toBe("Przygotowanie oferty");
    expect(PROJECT_STAGE_LABELS.awaiting_decision).toBe("Oczekiwanie na decyzję");
    expect(PROJECT_STAGE_LABELS.agreed).toBe("Uzgodnione");
    expect(PROJECT_STAGE_LABELS.in_progress).toBe("W realizacji");
    expect(PROJECT_STAGE_LABELS.completed).toBe("Zakończone");
    expect(PROJECT_STAGE_LABELS.cancelled).toBe("Anulowane");
  });

  it("treats exactly completed and cancelled as closed", () => {
    expect(CLOSED_STAGES).toEqual(["completed", "cancelled"]);
    for (const stage of ALL_STAGES) {
      expect(isClosedStage(stage)).toBe(stage === "completed" || stage === "cancelled");
    }
  });

  it("decides every stage pairing totally (49 pairs, no sequencing)", () => {
    for (const current of ALL_STAGES) {
      for (const target of ALL_STAGES) {
        const decision = decideStageChange(current, target);
        if (current === target) {
          expect(decision.kind).toBe("unchanged");
        } else if (isClosedStage(current) && isClosedStage(target)) {
          expect(decision.kind).toBe("reclassify");
        } else if (isClosedStage(current)) {
          expect(decision.kind).toBe("reopen");
        } else if (isClosedStage(target)) {
          expect(decision.kind).toBe("close");
        } else {
          expect(decision.kind).toBe("move");
        }
      }
    }
  });

  it("allows direct inquiry-to-completed (a clear statement skips stages)", () => {
    expect(decideStageChange("inquiry", "completed")).toEqual({ kind: "close" });
  });

  it("reopens from both closed stages back to any active stage", () => {
    expect(decideStageChange("completed", "in_progress")).toEqual({ kind: "reopen" });
    expect(decideStageChange("cancelled", "agreed")).toEqual({ kind: "reopen" });
  });

  it("reclassifies closure kind without inventing a new closure moment kind", () => {
    expect(decideStageChange("completed", "cancelled")).toEqual({ kind: "reclassify" });
    expect(decideStageChange("cancelled", "completed")).toEqual({ kind: "reclassify" });
  });

  it("has no pause stage and no evidence parameter (silence cannot close)", () => {
    // The fixed vocabulary has no pause member, and the decision consumes
    // exactly two arguments: there is no seat at this table for silence, an
    // elapsed date or an open-task count. The dispatch tests prove the same
    // structurally at the contract boundary.
    expect(ALL_STAGES).not.toContain("paused");
    expect(decideStageChange.length).toBe(2);
  });
});

describe("pause rules (separate mark, not a stage)", () => {
  const pause = (reason: string, resumeOn: string | null = null) => ({
    reason,
    resumeOn: resumeOn === null ? null : Schema.decodeUnknownSync(LocalDate)(resumeOn),
  });

  it("validates the reason: non-empty, trimmed, bounded", () => {
    expect(validatePauseReason("")).toEqual({ ok: false, code: "pause_reason_empty" });
    expect(validatePauseReason("   ")).toEqual({ ok: false, code: "pause_reason_empty" });
    expect(validatePauseReason("a".repeat(MAX_PAUSE_REASON_LENGTH + 1))).toEqual({
      ok: false,
      code: "pause_reason_too_long",
    });
    expect(validatePauseReason(" czekamy na okna ")).toEqual({
      ok: true,
      value: "czekamy na okna",
    });
  });

  it("sets a pause on every active stage and refuses one on closed stages", () => {
    for (const stage of ALL_STAGES) {
      const decision = decidePauseChange(stage, pause("brak materiałów"));
      if (isClosedStage(stage)) {
        expect(decision).toEqual({ kind: "rejected_closed" });
      } else {
        expect(decision).toEqual({ kind: "set" });
      }
    }
  });

  it("clears a pause on any stage, including closed ones", () => {
    for (const stage of ALL_STAGES) {
      expect(decidePauseChange(stage, null)).toEqual({ kind: "clear" });
    }
  });

  it("never reads the resume date: a past proposal is still just a proposal", () => {
    // "Nadejście planowanej daty wznowienia nie potwierdza, że prace ruszyły":
    // the decision is identical whatever the date is — including one long
    // past. Actual resumption is the explicit clear.
    const past = decidePauseChange("in_progress", pause("okna", "2020-01-01"));
    const future = decidePauseChange("in_progress", pause("okna", "2030-06-01"));
    const none = decidePauseChange("in_progress", pause("okna", null));
    expect(past).toEqual(future);
    expect(past).toEqual(none);
    expect(past).toEqual({ kind: "set" });
  });

  it("produces no stage: the decision cannot move the project", () => {
    const decision = decidePauseChange("in_progress", pause("okna", "2030-01-01"));
    expect(Object.keys(decision)).toEqual(["kind"]);
  });
});

describe("codename rules (firm-unique across retained history)", () => {
  it("validates codenames: non-empty, bounded, outside the generated namespace", () => {
    expect(validateCodename("")).toEqual({ ok: false, code: "codename_empty" });
    expect(validateCodename("  ")).toEqual({ ok: false, code: "codename_empty" });
    expect(validateCodename("a".repeat(MAX_CODENAME_LENGTH + 1))).toEqual({
      ok: false,
      code: "codename_too_long",
    });
    expect(validateCodename("#12")).toEqual({
      ok: false,
      code: "codename_generated_namespace",
    });
    expect(validateCodename(" Banan ")).toEqual({ ok: true, value: "Banan" });
  });

  it("generates working aliases in the reserved namespace", () => {
    expect(generatedCodename(1)).toBe("#1");
    expect(isGeneratedCodename("#42")).toBe(true);
    expect(isGeneratedCodename("Banan")).toBe(false);
    expect(nextWorkingAliasSequence(0)).toBe(1);
    expect(nextWorkingAliasSequence(5)).toBe(6);
  });

  it("assigns a fresh codename when the history holds none", () => {
    expect(decideCodenameReservation([], "p1")).toEqual({ kind: "assign" });
  });

  it("refuses a codename another project holds — active OR retired", () => {
    // Retained history keeps the reservation: this is what makes a rename
    // (and a closed project) unable to free a codename for a rival.
    expect(
      decideCodenameReservation(
        [{ aliasId: "a1", projectId: "p2", active: true }],
        "p1",
      ),
    ).toEqual({ kind: "reserved_by_other" });
    expect(
      decideCodenameReservation(
        [{ aliasId: "a1", projectId: "p2", active: false }],
        "p1",
      ),
    ).toEqual({ kind: "reserved_by_other" });
  });

  it("is idempotent for the project's own active codename", () => {
    expect(
      decideCodenameReservation([{ aliasId: "a1", projectId: "p1", active: true }], "p1"),
    ).toEqual({ kind: "already_active", aliasId: "a1" });
  });

  it("reactivates the project's own retired codename", () => {
    expect(
      decideCodenameReservation([{ aliasId: "a1", projectId: "p1", active: false }], "p1"),
    ).toEqual({ kind: "reactivate", aliasId: "a1" });
  });

  it("reactivates deterministically when several retired rows exist", () => {
    const decision = decideCodenameReservation(
      [
        { aliasId: "b2", projectId: "p1", active: false },
        { aliasId: "a1", projectId: "p1", active: false },
      ],
      "p1",
    );
    expect(decision).toEqual({ kind: "reactivate", aliasId: "a1" });
  });

  it("reserves the codename for the owning project even beside a foreign row", () => {
    // First foreign row refuses immediately, regardless of own rows: a
    // codename can never denote two projects.
    const decision = decideCodenameReservation(
      [
        { aliasId: "a1", projectId: "p1", active: true },
        { aliasId: "a2", projectId: "p2", active: false },
      ],
      "p1",
    );
    expect(decision).toEqual({ kind: "reserved_by_other" });
  });
});

describe("contact and role rules (one identity, many roles)", () => {
  it("validates contact names: non-empty, trimmed, bounded, never unique", () => {
    expect(validateContactName("")).toEqual({ ok: false, code: "contact_name_empty" });
    expect(validateContactName("  ")).toEqual({ ok: false, code: "contact_name_empty" });
    expect(validateContactName("n".repeat(MAX_CONTACT_NAME_LENGTH + 1))).toEqual({
      ok: false,
      code: "contact_name_too_long",
    });
    expect(validateContactName(" Kaczmarek ")).toEqual({ ok: true, value: "Kaczmarek" });
  });

  it("renders kinds and roles in Polish", () => {
    expect(CONTACT_KIND_LABELS).toEqual({ person: "Osoba", organization: "Organizacja" });
    expect(CONTACT_ROLE_LABELS).toEqual({
      client: "Klient",
      executor: "Wykonawca",
      supplier: "Dostawca",
    });
  });

  it("assigns each of the three roles to the same contact (multiplicity)", () => {
    expect(decideContactRoleAssignment([], "client")).toEqual({ kind: "assign" });
    expect(decideContactRoleAssignment([{ contactRoleId: "r1", role: "client" }], "executor")).toEqual({
      kind: "assign",
    });
    expect(decideContactRoleAssignment([{ contactRoleId: "r1", role: "client" }], "supplier")).toEqual({
      kind: "assign",
    });
  });

  it("is idempotent per (project, contact, role) without duplicating identity", () => {
    expect(decideContactRoleAssignment([{ contactRoleId: "r1", role: "client" }], "client")).toEqual({
      kind: "existing",
      contactRoleId: "r1",
    });
  });
});

describe("project identity rules", () => {
  it("validates display names: non-empty, trimmed, bounded", () => {
    expect(validateProjectDisplayName("")).toEqual({ ok: false, code: "project_name_empty" });
    expect(validateProjectDisplayName("   ")).toEqual({ ok: false, code: "project_name_empty" });
    expect(validateProjectDisplayName("n".repeat(MAX_PROJECT_NAME_LENGTH + 1))).toEqual({
      ok: false,
      code: "project_name_too_long",
    });
    expect(validateProjectDisplayName(" Łazienka u Kaczmarka ")).toEqual({
      ok: true,
      value: "Łazienka u Kaczmarka",
    });
  });
});
