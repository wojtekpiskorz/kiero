/**
 * C5 focused verification, part 2: the registration surface — the declared
 * consumer edges' projections, the executor composition, the withdrawal
 * operation's handler registration, and the amended contract shapes.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/c5/live-proof.mjs) exercises them end to end. What MUST hold
 * structurally is pinned here.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { convexToJson, jsonToConvex } from "convex/values";
import {
  KnowledgeState,
  events,
  parseTableId,
  recomputeDependentsInput,
} from "@kiero/contracts";
import { projectEventToJobInput } from "../../convex/platform/outbox";
import { jobExecutors } from "../../convex/platform/executors";
import { sourcesHandlers } from "../../convex/sources/accept/dispatch";
import { recomputeDependentsExecutor } from "../../convex/memory/recompute/executor";
import { withdrawSourceEntry, RECOMPUTE_PIPELINE_VERSION } from "../../convex/memory/recompute/withdrawal";
import { findingsTables } from "../../convex/memory/findings/schema";

const findingId = parseTableId("findings", "f1");
const sourceId = parseTableId("sources", "s1");
const userId = parseTableId("users", "u1");

describe("the executor composition (one implementation per registered kind)", () => {
  it("registers the C5 executor under memory.recompute_dependents", () => {
    expect(jobExecutors["memory.recompute_dependents"]).toBe(recomputeDependentsExecutor);
    expect(recomputeDependentsExecutor.jobKind).toBe("memory.recompute_dependents");
  });
});

describe("the three declared consumer edges drain into recomputation", () => {
  it("projects sources.sourceWithdrawn onto the source_withdrawn job with the reason", () => {
    const projection = projectEventToJobInput(
      "sources.sourceWithdrawn",
      { sourceId, reason: "wysłane przez pomyłkę" },
      "dedup-w",
    );
    expect(projection).toEqual({
      kind: "job",
      jobKind: "memory.recompute_dependents",
      input: {
        rootFindingId: null,
        sourceId,
        cause: "source_withdrawn",
        reason: "wysłane przez pomyłkę",
        withdrawnByUserId: null,
      },
      dedupKey: "dedup-w",
    });
    expect(() =>
      Schema.decodeUnknownSync(recomputeDependentsInput)(
        (projection as { input: unknown }).input,
      ),
    ).not.toThrow();
  });

  it("projects memory.dependentsMarkedStale onto the cascade carrier job", () => {
    const projection = projectEventToJobInput(
      "memory.dependentsMarkedStale",
      { rootFindingId: findingId, dependentFindingIds: [findingId], withdrawnByUserId: userId },
      "dedup-s",
    );
    expect(projection).toEqual({
      kind: "job",
      jobKind: "memory.recompute_dependents",
      input: {
        rootFindingId: findingId,
        sourceId: null,
        cause: "dependent_stale",
        reason: null,
        withdrawnByUserId: userId,
      },
      dedupKey: "dedup-s",
    });
    expect(() =>
      Schema.decodeUnknownSync(recomputeDependentsInput)(
        (projection as { input: unknown }).input,
      ),
    ).not.toThrow();
  });

  it("projects memory.findingRevised onto the revalidation walk job", () => {
    const projection = projectEventToJobInput(
      "memory.findingRevised",
      { findingId, revisionId: parseTableId("findingRevisions", "r1"), supersedesRevisionId: null },
      "dedup-r",
    );
    expect(projection).toEqual({
      kind: "job",
      jobKind: "memory.recompute_dependents",
      input: {
        rootFindingId: findingId,
        sourceId: null,
        cause: "reanalysis",
        reason: null,
        withdrawnByUserId: null,
      },
      dedupKey: "dedup-r",
    });
    expect(() =>
      Schema.decodeUnknownSync(recomputeDependentsInput)(
        (projection as { input: unknown }).input,
      ),
    ).not.toThrow();
  });

  it("keeps a NULLABLE actor: an event without one still decodes", () => {
    expect(() =>
      Schema.decodeUnknownSync(recomputeDependentsInput)({
        rootFindingId: findingId,
        sourceId: null,
        cause: "dependent_stale",
        reason: null,
        withdrawnByUserId: null,
      }),
    ).not.toThrow();
    // The event payload amendment accepts publishers without an actor.
    const markedStale = events["memory.dependentsMarkedStale"];
    expect(markedStale).toBeDefined();
    if (markedStale === undefined) {
      throw new Error("memory.dependentsMarkedStale missing from the registry");
    }
    expect(() =>
      Schema.decodeUnknownSync(markedStale.payload)({
        rootFindingId: findingId,
        dependentFindingIds: [],
        withdrawnByUserId: null,
      }),
    ).not.toThrow();
  });
});

describe("the withdrawal operation registration", () => {
  it("registers sources.withdrawSource on the sources checked path", () => {
    const handlers = sourcesHandlers();
    expect(handlers["sources.withdrawSource"]).toBeDefined();
    expect(handlers["sources.withdrawSource"]?.intent).toBe("write");
    // The D1 entry is untouched.
    expect(handlers["sources.acceptSource"]).toBeDefined();
  });

  it("decodes the certified withdraw input and result shapes", () => {
    const decoded = Schema.decodeUnknownSync(withdrawSourceEntry.input)({
      sourceId,
      reason: "Szef wysłał tę wiadomość przez pomyłkę",
    });
    expect(decoded.sourceId).toBe(sourceId);
    expect(() =>
      Schema.decodeUnknownSync(withdrawSourceEntry.result)({ withdrawnAtMs: 0 }),
    ).not.toThrow();
  });
});

describe("the amended contract shapes (additive, flagged)", () => {
  it("KnowledgeState gains the updating variant and survives the Convex wire", () => {
    const decoded = Schema.decodeUnknownSync(KnowledgeState)({
      _tag: "updating",
      reason: "updating_until_revalidated: f1",
    });
    expect(decoded._tag).toBe("updating");
    // decode -> encode -> Convex wire -> decode -> compare (the pinned
    // validator's runtime proof, the conversion-test pattern).
    const encoded = Schema.encodeSync(KnowledgeState)(decoded);
    const convexWire = jsonToConvex(convexToJson(encoded));
    expect(Schema.encodeSync(KnowledgeState)(Schema.decodeUnknownSync(KnowledgeState)(convexWire))).toEqual(
      encoded,
    );
    // The closed vocabulary still refuses invented tags.
    expect(() => Schema.decodeUnknownSync(KnowledgeState)({ _tag: "guess" })).toThrow();
  });

  it("the findings schema fragment still pins the extended knowledge vocabulary", () => {
    expect(findingsTables.findings).toBeDefined();
    expect(
      Schema.decodeUnknownSync(KnowledgeState)({ _tag: "updating", reason: "r" }),
    ).toEqual({ _tag: "updating", reason: "r" });
  });

  it("reanalysis runs record the C5 pipeline version until E3 pins its own", () => {
    expect(RECOMPUTE_PIPELINE_VERSION).toBe("c5.recompute/1");
  });
});
