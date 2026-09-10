/**
 * C5 focused verification, part 1: the pure recomputation core — the
 * dependent-marking decision (sole-witness vs corroborated vs derived),
 * the updating-until-revalidated state, bounded recomputation grouping,
 * the automation-exclusion gate and the stale-plan interaction with C2's
 * guard. (Cycle safety of the graph itself is pinned in tests/c2 with
 * wouldCreateCycle; the durable cascade terminates on marking idempotence.)
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { KnowledgeState } from "@kiero/contracts";
import {
  decidePublish,
  deriveTaskDueness,
  decideDependentRecomputation,
  explicitUpdating,
  groupRecomputeBatches,
  isUpdatingKnowledgeState,
  updatingUntilRevalidatedReason,
  dependentUpdatingReason,
} from "@kiero/domain";

describe("the dependent-marking decision", () => {
  const derivationArgs = {
    cause: "derivation" as const,
    currentRevisionOrigin: "publication",
    currentKnowledgeTag: "known",
    currentWitnesses: [] as { sourceId: string; supportKind: string; sourceActive: boolean }[],
  };

  it("marks a derivation whose basis moved: updating, never discarded", () => {
    const decision = decideDependentRecomputation(derivationArgs);
    expect(decision).toEqual({ decision: "mark_updating" });
  });

  it("keeps an explicitly corrected dependent (a correction keeps its authority)", () => {
    expect(
      decideDependentRecomputation({
        ...derivationArgs,
        currentRevisionOrigin: "correction",
      }),
    ).toEqual({ decision: "retain", basis: "explicit_correction" });
  });

  it("keeps a derivation that carries its own live witness (independent evidence survives)", () => {
    expect(
      decideDependentRecomputation({
        ...derivationArgs,
        currentWitnesses: [
          { sourceId: "s2", supportKind: "independent_corroboration", sourceActive: true },
        ],
      }),
    ).toEqual({ decision: "retain", basis: "independent_witness" });
  });

  it("marks a derivation whose only witness died with the basis", () => {
    expect(
      decideDependentRecomputation({
        ...derivationArgs,
        currentWitnesses: [
          { sourceId: "s-withdrawn", supportKind: "support", sourceActive: false },
        ],
      }),
    ).toEqual({ decision: "mark_updating" });
  });

  it("is idempotent: an already-marked or already-unknown dependent is never marked twice", () => {
    expect(
      decideDependentRecomputation({
        ...derivationArgs,
        currentKnowledgeTag: "updating",
      }),
    ).toEqual({ decision: "retain", basis: "already_marked" });
    expect(
      decideDependentRecomputation({
        ...derivationArgs,
        currentKnowledgeTag: "unknown",
      }),
    ).toEqual({ decision: "retain", basis: "already_marked" });
  });

  it("leaves shared-evidence and assignment dependents to the witness-based marking core", () => {
    for (const cause of ["shared_evidence", "assignment"] as const) {
      expect(
        decideDependentRecomputation({ ...derivationArgs, cause }),
      ).toEqual({ decision: "retain", basis: "witness_judged_elsewhere" });
    }
  });

  it("reports a dependent without a current revision as gone", () => {
    expect(
      decideDependentRecomputation({
        ...derivationArgs,
        currentRevisionOrigin: null,
        currentKnowledgeTag: null,
      }),
    ).toEqual({ decision: "gone" });
  });
});

describe("the updating-until-revalidated state", () => {
  it("constructs and round-trips through the certified contract", () => {
    const state = explicitUpdating(updatingUntilRevalidatedReason("f1"));
    expect(state).toEqual({
      _tag: "updating",
      reason: "updating_until_revalidated: f1",
    });
    // Encoded wire form survives the contract codec (the Convex validator's
    // pinned shape).
    const encoded = Schema.encodeSync(KnowledgeState)(state);
    expect(encoded).toEqual({ _tag: "updating", reason: "updating_until_revalidated: f1" });
    expect(Schema.decodeUnknownSync(KnowledgeState)(encoded)).toEqual(state);
  });

  it("is recognized by the automation gate predicate", () => {
    expect(isUpdatingKnowledgeState({ _tag: "updating" })).toBe(true);
    expect(isUpdatingKnowledgeState({ _tag: "known" })).toBe(false);
    expect(isUpdatingKnowledgeState({ _tag: "unknown" })).toBe(false);
  });

  it("excludes updating findings from automation exactly like C4's dueness gate", () => {
    // The stale derived value cannot trigger delivery: an updating binding
    // has no usable due moment (work/dueness refuses every non-known tag).
    const dueness = deriveTaskDueness({
      state: "todo",
      deadline: {
        knowledgeState: {
          _tag: "updating",
          reason: updatingUntilRevalidatedReason("basis"),
        },
        temporal: {
          shape: { _tag: "day", day: "2026-09-09" },
          originalExpression: "piątek",
          role: "agreed",
        },
      },
      nowMs: Date.parse("2026-09-10T12:00:00.000Z"),
      companyTimezone: "Europe/Warsaw",
    });
    expect(dueness).toEqual({ kind: "term_unusable", reason: "updating" });
    // The two gates cannot disagree: the predicate and the dueness gate
    // exclude exactly the same tag.
    expect(isUpdatingKnowledgeState({ _tag: "updating" })).toBe(true);
  });
});

describe("bounded recomputation groups", () => {
  it("groups affected findings by provenance source (one re-analysis per source)", () => {
    const groups = groupRecomputeBatches([
      { findingId: "d1", provenanceSourceId: "s9", provenanceSourceActive: true },
      { findingId: "d2", provenanceSourceId: "s9", provenanceSourceActive: true },
      { findingId: "d3", provenanceSourceId: "s7", provenanceSourceActive: true },
    ]);
    expect(groups).toEqual([
      { sourceId: "s9", findingIds: ["d1", "d2"] },
      { sourceId: "s7", findingIds: ["d3"] },
    ]);
  });

  it("never registers a re-analysis for a dead provenance source", () => {
    // A withdrawn or purged provenance source supports no new run; the
    // dependent stays honestly updating until NEW evidence arrives.
    const groups = groupRecomputeBatches([
      { findingId: "d1", provenanceSourceId: "s-withdrawn", provenanceSourceActive: false },
    ]);
    expect(groups).toEqual([]);
  });

  it("deduplicates findings inside one group", () => {
    const groups = groupRecomputeBatches([
      { findingId: "d1", provenanceSourceId: "s9", provenanceSourceActive: true },
      { findingId: "d1", provenanceSourceId: "s9", provenanceSourceActive: true },
    ]);
    expect(groups).toEqual([{ sourceId: "s9", findingIds: ["d1"] }]);
  });
});

describe("stale-plan interactions with C2's guard (recompute cannot restore removed support)", () => {
  it("an updating marking bumps the counter, so an older prepared plan refuses as stale", () => {
    // The plan was prepared while the dependent was at revision 3. The
    // recomputation marked it updating: revision 4. Resuming the old plan
    // must refuse `stale_plan` — arrival time never decides precedence.
    const decision = decidePublish({
      changeSetState: "prepared",
      captured: [{ findingId: "d1", revision: 3 }],
      caller: [{ findingId: "d1", revision: 3 }],
      current: { d1: 4 },
    });
    expect(decision).toEqual({ decision: "refuse", code: "stale_plan" });
  });

  it("a plan prepared AFTER the marking publishes against the bumped counter", () => {
    const decision = decidePublish({
      changeSetState: "prepared",
      captured: [{ findingId: "d1", revision: 4 }],
      caller: [{ findingId: "d1", revision: 4 }],
      current: { d1: 4 },
    });
    expect(decision).toEqual({ decision: "publish" });
  });

  it("the marking reason names the root finding and cause for the history", () => {
    expect(dependentUpdatingReason("f-root", "source_withdrawn")).toBe(
      "dependent_updating:f-root:source_withdrawn",
    );
  });
});
