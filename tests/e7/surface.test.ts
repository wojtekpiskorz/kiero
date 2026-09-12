/**
 * E7 focused tests, deterministic half (issue #115).
 *
 * Covers the surface invariants the issue's acceptance criteria name:
 *
 * - the certified contract shapes: `sources.reassignSource` decodes its
 *   input/result, refuses malformed references, and is registered on the
 *   checked sources dispatch exactly like the sibling write commands;
 * - the pure decisions: the declared-set de-duplication, the
 *   nothing-to-change set comparison, and the C5 scope re-assessment
 *   decision proving the WHOLE narrowing rule in one place (company
 *   memory, still-linked scopes, correction authority, idempotence,
 *   surviving placement witness), exactly the branch the marking core
 *   runs;
 * - the declared consumer edge: `sources.sourceReassigned` projects onto
 *   the recomputation cause and the amended executor input still decodes
 *   every existing registration shape (no required key was added);
 * - the amended origin vocabulary: `reassignment_marking` crosses the
 *   memory-history wire, the source evidence wire and the Polish label
 *   maps (a vocabulary change fails this build instead of rendering a raw
 *   machine code);
 * - the dossier's honest copy: the reassignment control's Polish text
 *   exists, the stale absence note is gone, and the closed error hints
 *   cover the operation's typed conflicts.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/e7/live-proof.mjs) exercises them end to end.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  errorResult,
  events,
  okResult,
  operations,
  parseTableId,
  recomputeDependentsInput,
  sourcesOperations,
} from "@kiero/contracts";
import { conflictError } from "@kiero/runtime";
import { projectEventToJobInputs } from "../../convex/platform/outbox";
import { sourcesHandlers } from "../../convex/sources/accept/dispatch";
import {
  dedupeProjectIds,
  reassignSourceEntry,
  sameLinkSet,
} from "../../convex/sources/reassign/reassignment";
import { decideScopeReassessment } from "../../convex/memory/findings/reassignment";
import { recomputeDependentsExecutor } from "../../convex/memory/recompute/executor";
import { SourceEvidenceRow } from "../../convex/sources/read/exposition";
import { memoryCopy } from "../../apps/web/src/features/memory/state";
import { failureHint, sourceDetailCopy } from "../../apps/web/src/features/source-detail/state";
import {
  reassignFormAfter,
  submitReassignment,
  type ReassignFormState,
  type ReassignMutations,
  type ReassignOutcome,
} from "../../apps/web/src/features/source-detail/reassign";

const sourceId = parseTableId("sources", "s1") ?? "s1";
const projectId = parseTableId("projects", "p1") ?? "p1";
const otherProjectId = parseTableId("projects", "p2") ?? "p2";

describe("the certified sources.reassignSource contract surface", () => {
  it("declares the operation and its event in the composed registry", () => {
    expect(operations["sources.reassignSource"]).toBeDefined();
    expect(sourcesOperations["sources.reassignSource"]).toBeDefined();
    expect(events["sources.sourceReassigned"]).toBeDefined();
  });

  it("decodes a well-formed reassignment input and receipt", () => {
    const decoded = Schema.decodeUnknownSync(reassignSourceEntry.input)({
      sourceId,
      projectIds: [projectId, otherProjectId],
      expectedProjectIds: [projectId],
    });
    expect(decoded.sourceId).toBe(sourceId);
    expect(decoded.projectIds).toEqual([projectId, otherProjectId]);
    expect(decoded.expectedProjectIds).toEqual([projectId]);
    // The empty set is valid input: it means company-general knowledge.
    expect(
      Schema.decodeUnknownSync(reassignSourceEntry.input)({
        sourceId,
        projectIds: [],
        expectedProjectIds: [],
      }),
    ).toEqual({ sourceId, projectIds: [], expectedProjectIds: [] });
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.result)({
        reassignedAtMs: 0,
        projectIds: [],
      }),
    ).not.toThrow();
  });

  it("rejects malformed input (missing source, non-string reference)", () => {
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.input)({
        projectIds: [],
        expectedProjectIds: [],
      }),
    ).toThrow();
    // The table brands are compile-time; at the runtime boundary a
    // non-string reference refuses here, a well-formed but unknown or
    // foreign one refuses in the transaction (normalizeId + tenant check).
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.input)({
        sourceId,
        projectIds: [42],
        expectedProjectIds: [],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.input)({
        sourceId,
        projectIds: "p1",
        expectedProjectIds: [],
      }),
    ).toThrow();
  });

  it("requires the observed-placement precondition (R4): omission never decodes", () => {
    // A pre-repair client that omits expectedProjectIds fails the contract
    // decode — the handler never runs, so the command can never bypass
    // concurrency protection. Optional or defaulted is forbidden by shape.
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.input)({ sourceId, projectIds: [projectId] }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.input)({
        sourceId,
        projectIds: [projectId],
        expectedProjectIds: undefined,
      }),
    ).toThrow();
  });

  it("accepts ordering and duplicates in the observed set (normalization is the transaction's)", () => {
    // The wire shape carries raw sets; dedupeProjectIds and the order-
    // insensitive comparison (both transaction-pure, covered by the
    // mutation tests) decide equality. Duplicate or reordered observed
    // ids therefore decode without a false stale conflict.
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.input)({
        sourceId,
        projectIds: [projectId],
        expectedProjectIds: [otherProjectId, projectId, otherProjectId],
      }),
    ).not.toThrow();
  });

  it("rejects malformed observed references like malformed declared ones", () => {
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.input)({
        sourceId,
        projectIds: [projectId],
        expectedProjectIds: [42],
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(reassignSourceEntry.input)({
        sourceId,
        projectIds: [projectId],
        expectedProjectIds: "p1",
      }),
    ).toThrow();
  });

  it("decodes the event payload (the committed link set)", () => {
    const entry = events["sources.sourceReassigned"];
    if (entry === undefined) {
      throw new Error("sources.sourceReassigned missing from the registry");
    }
    expect(() =>
      Schema.decodeUnknownSync(entry.payload)({ sourceId, projectIds: [projectId] }),
    ).not.toThrow();
    expect(() => Schema.decodeUnknownSync(entry.payload)({ sourceId })).toThrow();
  });

  it("registers the reassignment on the sources checked path like the siblings", () => {
    const handlers = sourcesHandlers();
    expect(handlers["sources.reassignSource"]).toBeDefined();
    expect(handlers["sources.reassignSource"]?.intent).toBe("write");
    // The sibling entries are untouched.
    expect(handlers["sources.acceptSource"]).toBeDefined();
    expect(handlers["sources.withdrawSource"]).toBeDefined();
  });
});

describe("the pure reassignment decisions", () => {
  it("de-duplicates the declared set order-preserving", () => {
    expect(dedupeProjectIds([projectId, otherProjectId, projectId])).toEqual([
      projectId,
      otherProjectId,
    ]);
    expect(dedupeProjectIds([])).toEqual([]);
  });

  it("compares link sets order-insensitively and detects every real change", () => {
    expect(sameLinkSet([projectId, otherProjectId], [otherProjectId, projectId])).toBe(true);
    expect(sameLinkSet([], [])).toBe(true);
    expect(sameLinkSet([projectId], [])).toBe(false);
    expect(sameLinkSet([projectId, otherProjectId], [projectId])).toBe(false);
    // Raw duplicates never reach this comparison (dedupeProjectIds runs
    // first); the raw-shape behavior is therefore length-based refusal.
    expect(sameLinkSet([projectId, projectId], [projectId])).toBe(false);
  });
});

describe("the C5 scope re-assessment decision (pure)", () => {
  const witness = (sourceId: string, sourceActive: boolean, linkedToScope: boolean) => ({
    sourceId,
    sourceActive,
    linkedToScope,
  });
  const base = {
    currentKnowledgeTag: "known",
    currentRevisionOrigin: "publication",
    scopeKind: "project" as const,
    scopeProjectId: projectId,
    // The scope project is NOT in the moved source's current links (the
    // link set that changed); a still-linked scope names it here.
    currentProjectIds: [otherProjectId],
    movedSourceId: sourceId,
    restsOnMovedSource: true,
    currentWitnesses: [] as ReturnType<typeof witness>[],
  };

  it("marks a known publication in an unlinked scope with no surviving witness", () => {
    expect(decideScopeReassessment(base)).toEqual({ decision: "mark_updating" });
  });

  it("narrows: company memory is never marked (the rule's floor)", () => {
    expect(
      decideScopeReassessment({ ...base, scopeKind: "company", scopeProjectId: null }),
    ).toEqual({ decision: "retain", basis: "company_scope" });
  });

  it("narrows: a scope the source still links keeps standing", () => {
    expect(
      decideScopeReassessment({ ...base, currentProjectIds: [projectId, otherProjectId] }),
    ).toEqual({ decision: "retain", basis: "scope_still_linked" });
  });

  it("is idempotent: an already-marked (non-known) finding stays as it is", () => {
    expect(
      decideScopeReassessment({ ...base, currentKnowledgeTag: "updating" }),
    ).toEqual({ decision: "retain", basis: "already_marked" });
    expect(
      decideScopeReassessment({ ...base, currentKnowledgeTag: "unknown" }),
    ).toEqual({ decision: "retain", basis: "already_marked" });
  });

  it("keeps an explicit correction's authority", () => {
    expect(
      decideScopeReassessment({ ...base, currentRevisionOrigin: "correction" }),
    ).toEqual({ decision: "retain", basis: "explicit_correction" });
  });

  it("retains a finding that does not rest on the moved source", () => {
    expect(
      decideScopeReassessment({ ...base, restsOnMovedSource: false }),
    ).toEqual({ decision: "retain", basis: "not_resting_on_moved_source" });
  });

  it("retains a finding with another active witness still linked to the scope", () => {
    expect(
      decideScopeReassessment({ ...base, currentWitnesses: [witness("sx", true, true)] }),
    ).toEqual({ decision: "retain", basis: "independent_placement_witness" });
  });

  it("marks when the other witness is inactive or unlinked", () => {
    expect(
      decideScopeReassessment({ ...base, currentWitnesses: [witness("sx", false, true)] }),
    ).toEqual({ decision: "mark_updating" });
    expect(
      decideScopeReassessment({ ...base, currentWitnesses: [witness("sx", true, false)] }),
    ).toEqual({ decision: "mark_updating" });
  });
});

describe("the declared consumer edge and the amended executor input", () => {
  it("projects sources.sourceReassigned onto the source_reassigned recompute job", () => {
    const [projection] = projectEventToJobInputs(
      "sources.sourceReassigned",
      { sourceId, projectIds: [projectId] },
      "dedup-r",
    );
    expect(projection).toEqual({
      kind: "job",
      jobKind: "memory.recompute_dependents",
      input: {
        rootFindingId: null,
        sourceId,
        cause: "source_reassigned",
        reason: null,
        withdrawnByUserId: null,
        reassignedByUserId: null,
      },
      dedupKey: "dedup-r",
    });
    expect(() =>
      Schema.decodeUnknownSync(recomputeDependentsInput)(
        (projection as { input: unknown }).input,
      ),
    ).not.toThrow();
  });

  it("keeps the actor OPTIONAL: every pre-existing registration shape still decodes", () => {
    expect(() =>
      Schema.decodeUnknownSync(recomputeDependentsInput)({
        rootFindingId: null,
        sourceId,
        cause: "source_withdrawn",
        reason: "pomyłka",
        withdrawnByUserId: null,
      }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(recomputeDependentsInput)({
        rootFindingId: null,
        sourceId,
        cause: "source_reassigned",
        reason: null,
        withdrawnByUserId: null,
        reassignedByUserId: null,
      }),
    ).not.toThrow();
    // The cause vocabulary stays closed.
    expect(() =>
      Schema.decodeUnknownSync(recomputeDependentsInput)({
        rootFindingId: null,
        sourceId: null,
        cause: "guess",
        reason: null,
        withdrawnByUserId: null,
      }),
    ).toThrow();
  });

  it("keeps ONE executor implementation for the recomputation kind", () => {
    expect(recomputeDependentsExecutor.jobKind).toBe("memory.recompute_dependents");
  });
});

describe("the amended origin vocabulary (additive, flagged)", () => {
  it("carries reassignment_marking across the source evidence wire", () => {
    const row = {
      findingId: "f1",
      semanticKey: "k",
      scope: { _tag: "company" },
      supportKind: "support",
      citedRevisionId: "r1",
      citedRevision: 1,
      citedOrigin: "reassignment_marking",
      citedRecordedAtMs: 1,
      fragmentId: null,
      fragmentAnchor: null,
      currentRevisionId: "r2",
      currentRevision: 2,
      currentKnowledgeState: { _tag: "updating", reason: "updating_until_revalidated: x" },
      currentValue: { _tag: "text_note", text: "x" },
      currentOrigin: "reassignment_marking",
      currentReason: "source_reassigned:p1",
      currentRecordedAtMs: 2,
      supersededByNewerRevision: false,
    };
    expect(Schema.decodeUnknownSync(SourceEvidenceRow)(row).citedOrigin).toBe(
      "reassignment_marking",
    );
  });

  it("renders the new origin through the Polish label maps", () => {
    expect(
      (memoryCopy.originLabels as Record<string, string>)["reassignment_marking"],
    ).toBeTypeOf("string");
    expect(memoryCopy.originLabels["reassignment_marking"]).toContain(
      "przypisaniu źródła",
    );
  });
});

describe("the dossier's honest reassignment copy (E7's mount)", () => {
  it("ships the control's copy and drops the stale absence note", () => {
    expect(sourceDetailCopy.reassignmentHeading).toBe("Przypisanie do projektów");
    expect(sourceDetailCopy.reassignmentIntro).toContain("wiedzy ogólnej firmy");
    expect(sourceDetailCopy.reassignmentDone).toContain("ponownie rozpatrywane");
    expect(sourceDetailCopy.reassignmentUnchanged).toContain("aktualne");
    // The honest absence note is gone: the operation now exists.
    expect("reassignmentNote" in sourceDetailCopy).toBe(false);
  });

  it("keeps the withdrawn source's placement honest (no reassignment after withdrawal)", () => {
    expect(sourceDetailCopy.withdrawnReassignmentNote).toContain("wycofane");
  });
});

describe("the stale-refusal surface (R4, issue #129)", () => {
  it("renders the Polish stale copy through the closed-error hint", () => {
    expect(sourceDetailCopy.reassignmentStale).toBe(
      "Przypisanie źródła zmieniło się. Odświeżyliśmy aktualny wybór. Sprawdź go i zapisz ponownie.",
    );
    expect(failureHint("source_placement_stale", "server message")).toBe(
      sourceDetailCopy.reassignmentStale,
    );
  });

  it("declares the precondition on every submit envelope", async () => {
    const envelopes: unknown[] = [];
    const mutations: ReassignMutations = {
      reassignSource: async (args) => {
        envelopes.push(args.envelope);
        return errorResult(conflictError("source_placement_stale", "sources", sourceId));
      },
    };
    const outcome = await submitReassignment(mutations, sourceId, [projectId], [
      otherProjectId,
    ]);
    expect(outcome._tag).toBe("refused");
    if (outcome._tag === "refused") {
      expect(outcome.stale).toBe(true);
      expect(outcome.code).toBe("source_placement_stale");
    }
    expect(envelopes).toEqual([
      {
        operation: "sources.reassignSource",
        input: {
          sourceId,
          projectIds: [otherProjectId],
          expectedProjectIds: [projectId],
        },
        expectedRevisions: [],
      },
    ]);
  });

  it("resets the form to the authoritative placement after a stale refusal (never merges)", () => {
    const loaded: ReassignFormState = {
      selected: new Set([projectId, otherProjectId]), // the boss edited the stale form
      observed: new Set([projectId]),
      stale: false,
    };
    const refused: ReassignOutcome = {
      _tag: "refused",
      code: "source_placement_stale",
      message: "Dane zmieniły się w międzyczasie. Odśwież i spróbuj ponownie.",
      stale: true,
    };
    // The detail read now carries another boss's committed placement.
    const reset = reassignFormAfter(loaded, refused, [otherProjectId]);
    expect([...reset.selected]).toEqual([otherProjectId]);
    expect([...reset.observed]).toEqual([otherProjectId]);
    expect(reset.stale).toBe(true);
    // No success notice path: the surface shows the stale hint, not the
    // reassignment-done copy (the notice wiring keys off the outcome tag).
    expect(failureHint(refused.code, refused.message)).not.toContain("Przypisanie zapisane");
  });

  it("keeps the form untouched on every non-stale outcome", () => {
    const loaded: ReassignFormState = {
      selected: new Set([otherProjectId]),
      observed: new Set([projectId]),
      stale: false,
    };
    const unchangedRefusal = reassignFormAfter(
      loaded,
      { _tag: "refused", code: "source_links_unchanged", message: "m", stale: false },
      [otherProjectId],
    );
    expect(unchangedRefusal).toBe(loaded);
    const lost = reassignFormAfter(loaded, { _tag: "lost" }, [otherProjectId]);
    expect(lost).toBe(loaded);
  });

  it("converges the boss's deliberate second submit after the reload", async () => {
    // Editor B loaded [P1]; A moved the source to [P2]; B's first submit is
    // refused stale. B's form reloads the authoritative [P2]; the explicit
    // second submit declares THAT observed set and is accepted.
    const seen: { expected: string[]; desired: string[] }[] = [];
    let call = 0;
    const mutations: ReassignMutations = {
      reassignSource: async (args) => {
        call += 1;
        const input = (args.envelope as { input: { projectIds: string[]; expectedProjectIds: string[] } })
          .input;
        seen.push({ expected: input.expectedProjectIds, desired: input.projectIds });
        if (call === 1) {
          return errorResult(conflictError("source_placement_stale", "sources", sourceId));
        }
        return okResult({ reassignedAtMs: 1, projectIds: input.projectIds });
      },
    };

    let form: ReassignFormState = {
      selected: new Set([projectId, otherProjectId]),
      observed: new Set([projectId]),
      stale: false,
    };
    const first = await submitReassignment(mutations, sourceId, [...form.observed], [
      ...form.selected,
    ]);
    form = reassignFormAfter(form, first, [otherProjectId]); // the reloaded placement
    expect([...form.observed]).toEqual([otherProjectId]);

    const second = await submitReassignment(mutations, sourceId, [...form.observed], [
      ...form.selected,
    ]);
    expect(second._tag).toBe("reassigned");
    form = reassignFormAfter(form, second, []);
    expect([...form.selected]).toEqual([otherProjectId]);
    expect(form.stale).toBe(false);

    // The two submits declared DIFFERENT observed sets: the precondition
    // rode the reload exactly once.
    expect(seen).toEqual([
      { expected: [projectId], desired: [projectId, otherProjectId] },
      { expected: [otherProjectId], desired: [otherProjectId] },
    ]);
  });
});
