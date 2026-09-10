/**
 * H4 focused verification (2/5): the checked GM processing dispatch; the
 * handler registry and its allowlist, the closed failures in check order
 * (envelope, unknown operation, foreign operation, authority, input), and
 * the two-way fail-closed matrix: this lane's operations route through GM
 * authority ONLY through their own registry; never through B4's GM
 * dispatch, never through the membership dispatch; and no member, source-
 * editing, read-marking or model-facing operation routes through this one.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { errorResult, okResult, parseTableId, operationsOperations } from "@kiero/contracts";
import { forbiddenError } from "@kiero/runtime";
import { membershipHandlers } from "../../convex/access/membership/dispatch";
import { GM_OPERATIONS } from "../../convex/access/gm/policy";
import { gmHandlers } from "../../convex/access/gm/dispatch";
import { dispatchGmCommandWith, type AuthorityResolution, type GmDispatchDeps } from "../../convex/access/gm/dispatch";
import {
  GM_PROCESSING_OPERATIONS,
  gmProcessingDeps,
  gmProcessingHandlers,
} from "../../convex/operations/processing/dispatch";

const envelope = (operation: string, input: unknown) => ({
  operation,
  input,
  expectedRevisions: [],
});

/**
 * The dispatch type pins its ctx to MutationCtx; the check-order tests
 * exercise only decode/allowlist/authority ordering, so a null stand-in is
 * TEST FIXTURE DATA documented here (B4's own dispatch test precedent).
 */
const noCtx = null as unknown as Parameters<typeof dispatchGmCommandWith>[1];

const granted: AuthorityResolution = {
  ok: true,
  authority: { userId: "k57gmoper", grantId: "j97grant1" },
};
const deniedNoGrant: AuthorityResolution = {
  ok: false,
  result: errorResult(forbiddenError("gm_mode_not_active", "gm")),
};

describe("the GM processing handler registration", () => {
  it("registers exactly this lane's three operations", () => {
    expect(Object.keys(gmProcessingHandlers()).sort()).toEqual([...GM_PROCESSING_OPERATIONS].sort());
    expect(GM_PROCESSING_OPERATIONS).toEqual([
      "operations.inspectProcessingRun",
      "operations.retryProcessingStep",
      "operations.requestReanalysis",
    ]);
    expect(new Set(GM_PROCESSING_OPERATIONS).size).toBe(GM_PROCESSING_OPERATIONS.length);
  });

  it("the production deps carry B4's authority resolution (consumed, not duplicated)", () => {
    const deps = gmProcessingDeps();
    expect(deps.allowlist).toBe(GM_PROCESSING_OPERATIONS);
    expect(deps.resolveAuthority.name).toBe("resolveGmAuthority");
    expect(Object.keys(deps.handlers).sort()).toEqual([...GM_PROCESSING_OPERATIONS].sort());
  });
});

describe("the two-way fail-closed routing", () => {
  // The REAL foreign registries; never second hand-maintained copies.
  const memberOperations = Object.keys(membershipHandlers());
  const b4GmOperations = Object.keys(gmHandlers());

  it("this lane's registry is disjoint from B4's GM registry and the membership registry", () => {
    expect(GM_PROCESSING_OPERATIONS.filter((name) => b4GmOperations.includes(name))).toEqual([]);
    expect(GM_PROCESSING_OPERATIONS.filter((name) => memberOperations.includes(name))).toEqual([]);
    expect(b4GmOperations.length).toBeGreaterThan(0);
    expect(memberOperations.length).toBeGreaterThan(0);
  });

  it("member and B4 GM operations fail closed over the processing dispatch", async () => {
    for (const name of [...memberOperations.slice(0, 3), ...b4GmOperations.slice(0, 3)]) {
      const result = await dispatchGmCommandWith(gmProcessingDeps(), noCtx, envelope(name, {}));
      expect(result._tag, name).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag, name).toBe("unsupported");
      }
    }
  });

  it("this lane's operations fail closed over B4's GM dispatch (B4's registry is untouched)", async () => {
    for (const name of GM_PROCESSING_OPERATIONS) {
      const result = await dispatchGmCommandWith(
        {
          allowlist: GM_OPERATIONS,
          resolveAuthority: async () => granted,
          handlers: gmHandlers(),
        },
        noCtx,
        envelope(name, {}),
      );
      expect(result._tag, name).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag, name).toBe("unsupported");
      }
    }
  });

  it("source-editing and read-marking operations fail closed over the processing dispatch", async () => {
    for (const name of [
      "sources.withdrawSource",
      "sources.acceptSource",
      "attention.markSourceRead",
      "memory.prepareChangeSet",
    ]) {
      const result = await dispatchGmCommandWith(gmProcessingDeps(), noCtx, envelope(name, {}));
      expect(result._tag, name).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag, name).toBe("unsupported");
      }
    }
  });
});

describe("fail-closed: no arbitrary model selection surface", () => {
  it("an arbitrary model id reaches no handler: no such operation exists", async () => {
    const spy = vi.fn(async () => okResult({}));
    const result = await dispatchGmCommandWith(
      {
        allowlist: GM_PROCESSING_OPERATIONS,
        resolveAuthority: async () => granted,
        handlers: { "operations.inspectProcessingRun": { run: spy } },
      } as unknown as GmDispatchDeps,
      noCtx,
      envelope("operations.runArbitraryModel", { modelId: "z-ai/glm-5.3-flash" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error.code).toBe("unknown_operation");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("no processing operation input carries a model field, and excess model keys decode away", () => {
    const inspect = Schema.decodeUnknownSync(operationsOperations["operations.inspectProcessingRun"].input)({
      processingRunId: parseTableId("processingRuns", "k57run0001q2x9w7c1vbn8hj6t0a5q3z"),
      basis: "kontrola",
      model: "z-ai/glm-5.3-flash",
    });
    expect(Object.keys(inspect).sort()).toEqual(["basis", "processingRunId"]);
    const retry = Schema.decodeUnknownSync(operationsOperations["operations.retryProcessingStep"].input)({
      stepId: parseTableId("processingSteps", "k57stp0001q2x9w7c1vbn8hj6t0a5q3z"),
      expectedRunState: "failed",
      basis: "kontrola",
      model: "z-ai/glm-5.3-flash",
    });
    expect(Object.keys(retry).sort()).toEqual(["basis", "expectedRunState", "stepId"]);
    const reanalysis = Schema.decodeUnknownSync(operationsOperations["operations.requestReanalysis"].input)({
      sourceId: parseTableId("sources", "k57src0001q2x9w7c1vbn8hj6t0a5q3z"),
      reason: "powtórna wycena",
      expectedLatestRunId: parseTableId("processingRuns", "k57run0001q2x9w7c1vbn8hj6t0a5q3z"),
      model: "z-ai/glm-5.3-flash",
    });
    expect(Object.keys(reanalysis).sort()).toEqual([
      "expectedLatestRunId",
      "reason",
      "sourceId",
    ]);
  });
});

describe("the dispatch check order (closed errors, sanitized)", () => {
  it("fails a malformed envelope with validation before anything else", async () => {
    const result = await dispatchGmCommandWith(gmProcessingDeps(), noCtx, { nonsense: true });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
  });

  it("fails an unknown operation with unsupported unknown_operation", async () => {
    const result = await dispatchGmCommandWith(
      gmProcessingDeps(),
      noCtx,
      envelope("operations.nonexistentOperation", {}),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("unknown_operation");
    }
  });

  it("denies without an open grant before the handler runs (no target data leak)", async () => {
    const spy = vi.fn(async () => okResult({}));
    const deps = {
      allowlist: GM_PROCESSING_OPERATIONS,
      resolveAuthority: async () => deniedNoGrant,
      handlers: { "operations.inspectProcessingRun": { run: spy } },
    } as unknown as GmDispatchDeps;
    const result = await dispatchGmCommandWith(
      deps,
      noCtx,
      envelope("operations.inspectProcessingRun", {
        processingRunId: parseTableId("processingRuns", "k57run0001q2x9w7c1vbn8hj6t0a5q3z"),
        basis: "kontrola",
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("forbidden");
      expect(result.error.code).toBe("gm_mode_not_active");
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails invalid input with validation and never invokes the handler", async () => {
    const spy = vi.fn(async () => okResult({}));
    const deps = {
      allowlist: GM_PROCESSING_OPERATIONS,
      resolveAuthority: async () => granted,
      handlers: { "operations.inspectProcessingRun": { run: spy } },
    } as unknown as GmDispatchDeps;
    const result = await dispatchGmCommandWith(
      deps,
      noCtx,
      envelope("operations.inspectProcessingRun", {
        processingRunId: parseTableId("processingRuns", "k57run0001q2x9w7c1vbn8hj6t0a5q3z"),
        basis: "",
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the H4 contract entries (closed error vocabulary)", () => {
  it("declares the inspection with the enriched projection and pinned kinds", () => {
    const entry = operationsOperations["operations.inspectProcessingRun"];
    expect([...entry.errorKinds].sort()).toEqual(["forbidden", "not_found", "validation"]);
  });

  it("declares retry with the stale-revision conflict and unsupported kinds", () => {
    expect([...operationsOperations["operations.retryProcessingStep"].errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
      "not_found",
      "unsupported",
      "validation",
    ]);
  });

  it("declares reanalysis with the stale-inspection conflict kind", () => {
    expect([...operationsOperations["operations.requestReanalysis"].errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
      "not_found",
      "validation",
    ]);
  });
});
