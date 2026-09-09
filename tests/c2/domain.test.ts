/**
 * C2 focused verification, part 1: the PURE domain rules from
 * packages/domain/findings — temporal anchoring and precision, provenance
 * typing and acyclicity, plan consistency, the stale-plan guard, correction
 * supersession and withdrawal marking.
 *
 * The transaction halves run against the real dev deployment
 * (tests/c2/live-proof.mjs); what MUST hold structurally is pinned here.
 */

import { describe, expect, it } from "vitest";
import {
  addDays,
  isoWeekday,
  localDateOfInstant,
  resolveRelativeDay,
  type PlanScope,
  type RelativeResolution,
} from "@kiero/domain";
import {
  WITNESS_SUPPORT_KINDS,
  decideWithdrawalMarking,
  isWitnessKind,
  wouldCreateCycle,
} from "@kiero/domain";
import {
  checkPlanConsistency,
  decideCorrection,
  decidePublish,
  planScopeKey,
} from "@kiero/domain";

// ---------------------------------------------------------------------------
// Temporal values: anchored, precise, stable.
// ---------------------------------------------------------------------------

/** Narrows a matched resolution (these tests only read `.day` when matched). */
function resolvedDay(resolution: RelativeResolution): string {
  if (!resolution.matched) {
    throw new Error(`expected a matched resolution: ${resolution.reason}`);
  }
  return resolution.day;
}

/** Narrows a matched resolution's offset (same contract as resolvedDay). */
function resolvedOffsetDays(resolution: RelativeResolution): number {
  if (!resolution.matched) {
    throw new Error(`expected a matched resolution: ${resolution.reason}`);
  }
  return resolution.offsetDays;
}

describe("relative temporal resolution (anchored to the source, not the agent)", () => {
  // 2026-09-08 is a Tuesday; 18:30 Warsaw time.
  const SENT_AT = Date.parse("2026-09-08T16:30:00.000Z");

  it("resolves day words in the source's timezone snapshot", () => {
    expect(resolveRelativeDay("jutro", SENT_AT, "Europe/Warsaw")).toEqual({
      matched: true,
      day: "2026-09-09",
      offsetDays: 1,
    });
    expect(resolvedDay(resolveRelativeDay("dziś", SENT_AT, "Europe/Warsaw"))).toBe("2026-09-08");
    expect(resolvedDay(resolveRelativeDay("wczoraj", SENT_AT, "Europe/Warsaw"))).toBe("2026-09-07");
    expect(resolvedDay(resolveRelativeDay("pojutrze", SENT_AT, "Europe/Warsaw"))).toBe("2026-09-10");
  });

  it("uses the calendar day AT THE SOURCE, so a late-evening send is already the next day in its zone", () => {
    // 22:30 UTC is 00:30 on 2026-09-09 in Warsaw: "jutro" is the 10th.
    const lateEvening = Date.parse("2026-09-08T22:30:00.000Z");
    expect(localDateOfInstant(lateEvening, "Europe/Warsaw")).toBe("2026-09-09");
    expect(resolvedDay(resolveRelativeDay("jutro", lateEvening, "Europe/Warsaw"))).toBe("2026-09-10");
    // The SAME instant in UTC-local terms is still the 8th: the zone snapshot
    // is part of the anchor, not a presentation choice.
    expect(resolvedDay(resolveRelativeDay("jutro", lateEvening, "UTC"))).toBe("2026-09-09");
  });

  it("resolves weekdays as the NEXT such day (never today, never a guess)", () => {
    // Tuesday anchor: "w piątek" is 3 days ahead.
    expect(resolveRelativeDay("w piątek", SENT_AT, "Europe/Warsaw")).toEqual({
      matched: true,
      day: "2026-09-11",
      offsetDays: 3,
    });
    // A Tuesday said on a Tuesday is the NEXT Tuesday.
    expect(resolvedOffsetDays(resolveRelativeDay("wtorek", SENT_AT, "Europe/Warsaw"))).toBe(7);
    expect(resolvedDay(resolveRelativeDay("za 3 dni", SENT_AT, "Europe/Warsaw"))).toBe("2026-09-11");
    expect(resolvedDay(resolveRelativeDay("za tydzień", SENT_AT, "Europe/Warsaw"))).toBe("2026-09-15");
  });

  it("is stable across retries: the resolver takes no 'now', so days later it yields the same day", () => {
    const first = resolveRelativeDay("jutro", SENT_AT, "Europe/Warsaw");
    // A retry "days later" can only repeat the same arguments: the function
    // has no other input. Determinism over identical inputs is the guard.
    const retry = resolveRelativeDay("jutro", SENT_AT, "Europe/Warsaw");
    expect(retry).toEqual(first);
    expect(resolvedDay(first)).toBe("2026-09-09");
  });

  it("leaves unrecognized language unmatched instead of guessing a date", () => {
    for (const expression of ["kiedyś tam", "na szybko", "7 dni po wysyłce może", ""]) {
      expect(resolveRelativeDay(expression, SENT_AT, "Europe/Warsaw")).toEqual({
        matched: false,
        reason: "unrecognized_expression",
      });
    }
  });

  it("keeps day precision: the result is a bare calendar day, no invented hour", () => {
    const resolution = resolveRelativeDay("jutro", SENT_AT, "Europe/Warsaw");
    expect(resolution.matched).toBe(true);
    if (resolution.matched) {
      expect(resolution.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("does calendar arithmetic across month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
    expect(isoWeekday("2026-09-08")).toBe(2); // Tuesday
  });
});

// ---------------------------------------------------------------------------
// Provenance typing: witnesses versus derivations; acyclicity.
// ---------------------------------------------------------------------------

describe("evidence typing (independent corroboration differs from derivation)", () => {
  it("counts only support and independent_corroboration as witnesses", () => {
    expect([...WITNESS_SUPPORT_KINDS].sort()).toEqual([
      "independent_corroboration",
      "support",
    ]);
    expect(isWitnessKind("support")).toBe(true);
    expect(isWitnessKind("independent_corroboration")).toBe(true);
    // An agent's inference is never another witness (issue 8).
    expect(isWitnessKind("derivation")).toBe(false);
    expect(isWitnessKind("supersession")).toBe(false);
  });
});

describe("dependency acyclicity", () => {
  it("accepts chains and diamonds", () => {
    expect(wouldCreateCycle([], [])).toBe(false);
    expect(
      wouldCreateCycle(
        [
          { dependent: "a", dependsOn: "b" },
          { dependent: "b", dependsOn: "c" },
        ],
        [{ dependent: "c", dependsOn: "d" }],
      ),
    ).toBe(false);
    expect(
      wouldCreateCycle(
        [
          { dependent: "a", dependsOn: "b" },
          { dependent: "a", dependsOn: "c" },
        ],
        [{ dependent: "d", dependsOn: "a" }],
      ),
    ).toBe(false);
  });

  it("rejects cycles within the planned edges alone", () => {
    expect(
      wouldCreateCycle([], [
        { dependent: "a", dependsOn: "b" },
        { dependent: "b", dependsOn: "a" },
      ]),
    ).toBe(true);
  });

  it("rejects a planned edge closing a cycle over the existing graph", () => {
    expect(
      wouldCreateCycle([{ dependent: "b", dependsOn: "a" }], [
        { dependent: "a", dependsOn: "b" },
      ]),
    ).toBe(true);
    // Longer cycle through existing edges.
    expect(
      wouldCreateCycle(
        [
          { dependent: "b", dependsOn: "c" },
          { dependent: "c", dependsOn: "d" },
        ],
        [{ dependent: "d", dependsOn: "b" }],
      ),
    ).toBe(true);
  });

  it("rejects self-derivation", () => {
    expect(wouldCreateCycle([], [{ dependent: "a", dependsOn: "a" }])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan consistency and the stale-plan guard.
// ---------------------------------------------------------------------------

const scope = (projectId?: string): PlanScope =>
  projectId === undefined ? { kind: "company" } : { kind: "project", projectId };

describe("plan consistency", () => {
  const base = {
    findingId: null,
    scope: scope(),
    semanticKey: "termin.dostawy",
    evidence: [{ sourceId: "s1" }],
    derivesFrom: [] as string[],
  };

  it("requires a basis for every revision (evidence or derivation)", () => {
    expect(checkPlanConsistency([{ ...base, evidence: [], derivesFrom: [] }])).toEqual({
      ok: false,
      code: "revision_without_basis",
    });
    // A pure derivation has its basis findings.
    expect(
      checkPlanConsistency([{ ...base, evidence: [], derivesFrom: ["f1"] }]).ok,
    ).toBe(true);
  });

  it("refuses one plan writing the same finding identity twice", () => {
    expect(
      checkPlanConsistency([
        { ...base, semanticKey: "cena.ustalona" },
        { ...base, semanticKey: "cena.ustalona" },
      ]),
    ).toEqual({ ok: false, code: "duplicate_planned_finding_identity" });
    // Different scopes are different identities.
    expect(
      checkPlanConsistency([
        { ...base, scope: scope(), semanticKey: "cena.ustalona" },
        { ...base, scope: scope("p1"), semanticKey: "cena.ustalona" },
      ]).ok,
    ).toBe(true);
  });

  it("refuses derivation of itself and project scope without a project", () => {
    expect(
      checkPlanConsistency([
        { ...base, findingId: "f1", derivesFrom: ["f1"] },
      ]),
    ).toEqual({ ok: false, code: "derivation_of_itself" });
    expect(checkPlanConsistency([{ ...base, scope: scope() }]).ok).toBe(true);
    // A project scope with no project resolvable is not a plan at all.
    expect(
      checkPlanConsistency([{ ...base, scope: { kind: "project" } }]),
    ).toEqual({ ok: false, code: "project_scope_without_project" });
  });

  it("keys project identities per project (a company rule is not a project finding)", () => {
    expect(planScopeKey(scope(), "kolor")).toBe("company|kolor");
    expect(planScopeKey(scope("p1"), "kolor")).toBe("project|p1|kolor");
    expect(planScopeKey(scope("p2"), "kolor")).not.toBe(planScopeKey(scope("p1"), "kolor"));
  });
});

describe("the stale-plan guard (expected revisions decide precedence)", () => {
  const readiness = (overrides: Partial<Parameters<typeof decidePublish>[0]>) => ({
    changeSetState: "prepared",
    captured: [{ findingId: "f1", revision: 1 }],
    caller: [{ findingId: "f1", revision: 1 }],
    current: { f1: 1 },
    ...overrides,
  });

  it("publishes when captured and caller expectations equal the current counters", () => {
    expect(decidePublish(readiness({}))).toEqual({ decision: "publish" });
  });

  it("refuses a resumed older plan after a newer correction bumped the counter", () => {
    // The old plan captured revision 1; the correction moved the finding to 2.
    const afterCorrection = readiness({ current: { f1: 2 } });
    expect(decidePublish(afterCorrection)).toEqual({
      decision: "refuse",
      code: "stale_plan",
    });
    // Even a caller that LIED about having refreshed (claims 1): captured
    // expectations still refuse. And an honestly refreshed caller (claims 2)
    // is refused too: the plan itself is old — reconsidering means a NEW plan.
    expect(
      decidePublish(readiness({ current: { f1: 2 }, caller: [{ findingId: "f1", revision: 2 }] })),
    ).toEqual({ decision: "refuse", code: "stale_plan" });
  });

  it("refuses caller expectation mismatches separately from stale plans", () => {
    expect(
      decidePublish(readiness({ caller: [{ findingId: "f1", revision: 5 }] })),
    ).toEqual({ decision: "refuse", code: "caller_expectation_mismatch" });
  });

  it("refuses change sets that are no longer prepared (idempotent republish)", () => {
    for (const state of ["published", "failed", "superseded", "publishing"]) {
      expect(decidePublish(readiness({ changeSetState: state }))).toEqual({
        decision: "refuse",
        code: "change_set_not_prepared",
      });
    }
  });

  it("models the concurrent stale-plan rejection sequence end to end", () => {
    // Plan prepared at f1=1; a concurrent correction commits first (f1=2);
    // the plan's publish is then evaluated and refused — the later explicit
    // correction is never rolled back by the older plan's completion.
    let counter = 1;
    const captured = [{ findingId: "f1", revision: 1 }];
    expect(
      decidePublish({ changeSetState: "prepared", captured, caller: captured, current: { f1: counter } }),
    ).toEqual({ decision: "publish" });
    counter += 1; // the newer explicit correction commits
    expect(
      decidePublish({ changeSetState: "prepared", captured, caller: captured, current: { f1: counter } }),
    ).toEqual({ decision: "refuse", code: "stale_plan" });
  });
});

describe("correction supersession (explicit, history retained)", () => {
  it("applies only against the revision the corrector saw", () => {
    expect(decideCorrection(1, 1)).toEqual({ decision: "apply" });
    expect(decideCorrection(2, 1)).toEqual({ decision: "refuse", code: "revision_mismatch" });
    expect(decideCorrection(1, 3)).toEqual({ decision: "refuse", code: "revision_mismatch" });
  });
});

describe("withdrawal marking decision", () => {
  it("marks unknown when the withdrawn source was the only witness", () => {
    expect(
      decideWithdrawalMarking({
        currentRevisionOrigin: "publication",
        currentEvidence: [{ sourceId: "s1", supportKind: "support" }],
        withdrawnSourceId: "s1",
      }),
    ).toEqual({ decision: "mark_unknown" });
  });

  it("retains the finding when an independent witness on another source remains", () => {
    expect(
      decideWithdrawalMarking({
        currentRevisionOrigin: "publication",
        currentEvidence: [
          { sourceId: "s1", supportKind: "support" },
          { sourceId: "s2", supportKind: "independent_corroboration" },
        ],
        withdrawnSourceId: "s1",
      }),
    ).toEqual({ decision: "retained", basis: "independent_witness" });
    // Withdraw the OTHER source: s1 still supports it.
    expect(
      decideWithdrawalMarking({
        currentRevisionOrigin: "publication",
        currentEvidence: [
          { sourceId: "s1", supportKind: "support" },
          { sourceId: "s2", supportKind: "independent_corroboration" },
        ],
        withdrawnSourceId: "s2",
      }),
    ).toEqual({ decision: "retained", basis: "independent_witness" });
  });

  it("retains explicit corrections and avoids double marking", () => {
    expect(
      decideWithdrawalMarking({
        currentRevisionOrigin: "correction",
        currentEvidence: [{ sourceId: "s1", supportKind: "support" }],
        withdrawnSourceId: "s1",
      }),
    ).toEqual({ decision: "retained", basis: "explicit_correction" });
    expect(
      decideWithdrawalMarking({
        currentRevisionOrigin: "withdrawal_marking",
        currentEvidence: [],
        withdrawnSourceId: "s1",
      }),
    ).toEqual({ decision: "retained", basis: "already_marked" });
  });

  it("does not count derivation links as surviving witnesses", () => {
    expect(
      decideWithdrawalMarking({
        currentRevisionOrigin: "publication",
        currentEvidence: [
          { sourceId: "s1", supportKind: "support" },
          { sourceId: "s1", supportKind: "derivation" },
        ],
        withdrawnSourceId: "s1",
      }),
    ).toEqual({ decision: "mark_unknown" });
  });
});
