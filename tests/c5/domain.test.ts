/**
 * C5 focused verification, part 1: the pure recomputation core — the
 * dependency traversal (cycle-safe, resumable), the dependent-marking
 * decision (sole-witness vs corroborated vs derived), the revalidation
 * transitions, bounded recomputation grouping, the automation-exclusion
 * gate and the stale-plan interaction with C2's guard.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { KnowledgeState } from "@kiero/contracts";
import {
  decidePublish,
  deriveTaskDueness,
  directDependents,
  decideDependentRecomputation,
  explicitUpdating,
  groupRecomputeBatches,
  isRevalidated,
  isUpdatingKnowledgeState,
  nextDependentsBatch,
  traverseDependents,
  updatingUntilRevalidatedReason,
  dependentUpdatingReason,
  type DependencyEdge,
} from "@kiero/domain";

const edge = (dependent: string, dependsOn: string): DependencyEdge => ({
  dependent,
  dependsOn,
});

describe("the dependency traversal (tenant edges supplied by the caller)", () => {
  it("walks a dependent chain level by level from one root", () => {
    const edges = [edge("d1", "root"), edge("d2", "d1"), edge("d3", "d2")];
    const walk = traverseDependents(edges, ["root"]);
    expect(walk.levels).toEqual([["d1"], ["d2"], ["d3"]]);
    expect([...walk.visited].sort()).toEqual(["d1", "d2", "d3", "root"]);
  });

  it("merges diamonds without visiting a finding twice", () => {
    // root -> a, root -> b, a -> c, b -> c.
    const edges = [edge("a", "root"), edge("b", "root"), edge("c", "a"), edge("c", "b")];
    const walk = traverseDependents(edges, ["root"]);
    expect(walk.levels[0]?.sort()).toEqual(["a", "b"]);
    expect(walk.levels[1]).toEqual(["c"]);
    expect(walk.visited.filter((id) => id === "c")).toHaveLength(1);
  });

  it("is cycle-safe even on a graph that violates the acyclicity invariant", () => {
    // x -> y -> z -> x plus a tail off z. The visited set must terminate it.
    const cyclic = [edge("y", "x"), edge("z", "y"), edge("x", "z"), edge("t", "z")];
    const walk = traverseDependents(cyclic, ["x"]);
    expect([...walk.visited].sort()).toEqual(["t", "x", "y", "z"]);
  });

  it("never crosses into findings outside the supplied edges (tenant scope is the caller's)", () => {
    const edges = [edge("d1", "root"), edge("foreign", "other")];
    const walk = traverseDependents(edges, ["root"]);
    expect(walk.levels).toEqual([["d1"]]);
    expect(walk.visited).not.toContain("foreign");
  });

  it("resumes from a durable checkpoint: already-visited findings are skipped", () => {
    const edges = [edge("d1", "root"), edge("d2", "d1"), edge("d3", "d2")];
    // The first level committed and checkpointed {root, d1}.
    const first = nextDependentsBatch(edges, new Set(["root"]), ["root"]);
    expect(first.batch).toEqual(["d1"]);
    const resumed = nextDependentsBatch(edges, new Set(["root", "d1"]), ["d1"]);
    expect(resumed.batch).toEqual(["d2"]);
    // Replaying the same checkpoint returns the same batch (idempotent).
    expect(nextDependentsBatch(edges, new Set(["root", "d1"]), ["d1"]).batch).toEqual(["d2"]);
  });

  it("directDependents is stable and deduplicated", () => {
    const edges = [edge("a", "root"), edge("a", "root"), edge("b", "root")];
    expect(directDependents(edges, "root")).toEqual(["a", "b"]);
    expect(directDependents(edges, "other")).toEqual([]);
  });
});

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

  it("revalidation = a newer publication or correction replaced the marking", () => {
    expect(isRevalidated("publication", "known")).toBe(true);
    expect(isRevalidated("correction", "known")).toBe(true);
    // The marking itself is not revalidation...
    expect(isRevalidated("withdrawal_marking", "updating")).toBe(false);
    // ...and even a publication-tagged revision still updating is not.
    expect(isRevalidated("publication", "updating")).toBe(false);
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
