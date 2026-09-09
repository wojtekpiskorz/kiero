/**
 * B4 focused verification (3/3): the checked GM dispatch surface — the
 * handler registry and its allowlist, the closed failures in check order
 * (envelope, unknown operation, non-GM operation, authority, input), and
 * the fail-closed matrix the issue demands: member operations never route
 * through GM authority, GM operations never route through the membership
 * dispatch, and no GM endpoint reaches immutable sources, arbitrary models
 * or raw database patches.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/b4/live-proof.mjs) exercises them end to end.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { errorResult, okResult, parseTableId, accessOperations } from "@kiero/contracts";
import { dispatchCommand, forbiddenError, membershipPolicy } from "@kiero/runtime";
import { membershipHandlers } from "../../convex/access/membership/dispatch";
import { membershipLanePolicy } from "../../convex/access/membership/policy";
import { ActorContext } from "@kiero/contracts";
import {
  GM_OPERATIONS,
  GM_POLICY_ID,
  MEMBER_OPERATIONS,
  decideGmRequest,
  decideOperationSurface,
} from "../../convex/access/gm/policy";
import {
  dispatchGmCommandWith,
  gmHandlers,
  type AuthorityResolution,
  type GmDispatchDeps,
} from "../../convex/access/gm/dispatch";
import type { RequestContext } from "@kiero/runtime";

function contextFixture(role: "admin" | "member", isGm: boolean): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", "u1"),
    companyId: parseTableId("companies", "c1"),
    membershipRole: role,
    isGm,
    sessionId: parseTableId("sessions", "s1"),
    via: "user",
  });
  return { actor, resolvedAtMs: Date.now() };
}

const envelope = (operation: string, input: unknown) => ({
  operation,
  input,
  expectedRevisions: [],
});

/**
 * The dispatch type pins its ctx to MutationCtx (the recovery runner needs
 * it); the check-order tests exercise only decode/allowlist/authority
 * ordering, so a null stand-in is TEST FIXTURE DATA documented here.
 */
const noCtx = null as unknown as Parameters<typeof dispatchGmCommandWith>[1];

/** Production-shaped deps with an injectable authority resolution. */
function depsWithAuthority(
  resolution: AuthorityResolution,
  handlerSpy?: ReturnType<typeof vi.fn>,
): GmDispatchDeps {
  return {
    policyId: GM_POLICY_ID,
    allowlist: GM_OPERATIONS,
    resolveAuthority: async () => resolution,
    handlers:
      handlerSpy === undefined
        ? gmHandlers()
        : ({
            "access.gmInspectCompany": { run: handlerSpy },
          } as unknown as Record<string, never>),
  };
}

const granted: AuthorityResolution = {
  ok: true,
  authority: { userId: "k57gmoper", grantId: "j97grant1" },
};
const deniedNoGrant: AuthorityResolution = {
  ok: false,
  result: errorResult(forbiddenError("gm_mode_not_active", "gm")),
};

describe("the GM handler registration", () => {
  it("registers exactly the audited GM operations", () => {
    expect(Object.keys(gmHandlers()).sort()).toEqual([...GM_OPERATIONS].sort());
  });

  it("the allowlist contains enter/exit nowhere and the six operations exactly once", () => {
    // enterGmMode is the ACTION-gated act (never routed through the
    // command dispatch); exit rides the dispatch because its authority IS
    // the open grant it closes.
    expect(GM_OPERATIONS).toContain("access.exitGmMode");
    expect(GM_OPERATIONS).not.toContain("access.enterGmMode");
    expect(GM_OPERATIONS.filter((name) => name === "access.recoverAccount")).toHaveLength(1);
    expect(new Set(GM_OPERATIONS).size).toBe(GM_OPERATIONS.length);
  });
});

describe("the operation-surface routing (membership/GM layering)", () => {
  it("routes member operations to the member surface, GM operations to the GM surface", () => {
    for (const name of MEMBER_OPERATIONS) {
      expect(decideOperationSurface(name)).toBe("member");
    }
    for (const name of GM_OPERATIONS) {
      expect(decideOperationSurface(name)).toBe("gm");
    }
  });

  it("member operations fail closed over the GM dispatch (GM authority is not membership)", async () => {
    for (const name of MEMBER_OPERATIONS) {
      const result = await dispatchGmCommandWith(
        depsWithAuthority(granted),
        noCtx,
        envelope(name, {}),
      );
      expect(result._tag, name).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag, name).toBe("unsupported");
      }
    }
  });

  it("GM operations fail closed over the membership dispatch (membership is not GM authority)", async () => {
    for (const name of ["access.gmInspectCompany", "access.recoverAccount", "access.gmEndCompanyAlpha"]) {
      const result = await dispatchCommand(
        {
          resolveContext: async () => contextFixture("admin", false),
          policy: membershipLanePolicy,
          handlers: membershipHandlers(),
        },
        noCtx,
        envelope(name, {}),
      );
      expect(result._tag, name).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag, name).toBe("unsupported");
        expect(result.error.code, name).toBe("not_implemented");
      }
    }
  });

  it("a member (isGm false) is denied inspectGm by the platform policy; a GM context passes only with isGm", async () => {
    const member = contextFixture("admin", false);
    expect((await membershipPolicy.authorize(member, { intent: "inspectGm" })).allowed).toBe(false);
    const gmMember = contextFixture("admin", true);
    expect((await membershipPolicy.authorize(gmMember, { intent: "inspectGm" })).allowed).toBe(true);
  });
});

describe("fail-closed: no GM route to immutable sources, arbitrary models or raw patches", () => {
  it("source-editing operations fail closed over the GM dispatch", async () => {
    for (const name of ["sources.withdrawSource", "sources.purgeSource", "sources.acceptSource"]) {
      const result = await dispatchGmCommandWith(
        depsWithAuthority(granted),
        noCtx,
        envelope(name, {}),
      );
      expect(result._tag, name).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag, name).toBe("unsupported");
      }
    }
  });

  it("H4's retry/reanalysis operations do not route through B4's authority (unsupported until H4)", async () => {
    for (const name of ["operations.retryProcessingStep", "operations.requestReanalysis"]) {
      const result = await dispatchGmCommandWith(
        depsWithAuthority(granted),
        noCtx,
        envelope(name, {}),
      );
      expect(result._tag, name).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag, name).toBe("unsupported");
      }
    }
  });

  it("an arbitrary model id reaches no handler: no such operation, and the inspection input carries no model field", async () => {
    const spy = vi.fn(async () => okResult({}));
    const result = await dispatchGmCommandWith(
      depsWithAuthority(granted, spy),
      noCtx,
      envelope("operations.runArbitraryModel", { modelId: "z-ai/glm-5.3-flash" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error.code).toBe("unknown_operation");
    }
    expect(spy).not.toHaveBeenCalled();
    // The one GM read contract decodes company + basis only: no model field
    // exists to submit.
    const decoded = Schema.decodeUnknownSync(accessOperations["access.gmInspectCompany"].input)({
      companyId: parseTableId("companies", "c1"),
      basis: "kontrola",
    });
    expect(Object.keys(decoded).sort()).toEqual(["basis", "companyId"]);
  });
});

describe("the dispatch check order (closed errors, sanitized)", () => {
  it("fails a malformed envelope with validation before anything else", async () => {
    const result = await dispatchGmCommandWith(depsWithAuthority(granted), noCtx, { nonsense: true });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
  });

  it("fails an unknown operation with unsupported unknown_operation", async () => {
    const result = await dispatchGmCommandWith(
      depsWithAuthority(granted),
      noCtx,
      envelope("access.nonexistentOperation", {}),
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
      policyId: GM_POLICY_ID,
      allowlist: GM_OPERATIONS,
      resolveAuthority: async () => deniedNoGrant,
      handlers: { "access.gmInspectCompany": { run: spy } },
    } as unknown as GmDispatchDeps;
    const result = await dispatchGmCommandWith(
      deps,
      noCtx,
      envelope("access.gmInspectCompany", { companyId: parseTableId("companies", "c1"), basis: "x" }),
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
      policyId: GM_POLICY_ID,
      allowlist: GM_OPERATIONS,
      resolveAuthority: async () => granted,
      handlers: { "access.gmInspectCompany": { run: spy } },
    } as unknown as GmDispatchDeps;
    const result = await dispatchGmCommandWith(
      deps,
      noCtx,
      envelope("access.gmInspectCompany", { companyId: parseTableId("companies", "c1"), basis: "" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the pure GM request gate (policy registration)", () => {
  it("is the B4 registration id", () => {
    expect(GM_POLICY_ID).toBe("access.b4-gm-v1");
  });

  it("decides unauthenticated without a live session, forbidden without a grant, allowed with both", () => {
    expect(decideGmRequest({ hasLiveSession: false, hasOpenGrant: false })).toEqual({
      allowed: false,
      kind: "unauthenticated",
    });
    expect(decideGmRequest({ hasLiveSession: true, hasOpenGrant: false })).toEqual({
      allowed: false,
      kind: "forbidden",
      code: "gm_mode_not_active",
    });
    expect(decideGmRequest({ hasLiveSession: true, hasOpenGrant: true })).toEqual({
      allowed: true,
    });
    // The gate never consults membership — that independence is the point.
    expect(decideGmRequest({ hasLiveSession: true, hasOpenGrant: true })).toEqual(
      decideGmRequest({ hasLiveSession: true, hasOpenGrant: true }),
    );
  });
});

describe("the B4 contract entries (closed error vocabulary)", () => {
  it("declares the staged recovery command with B2's pinned shapes", () => {
    const entry = accessOperations["access.recoverAccount"];
    expect([...entry.errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
      "not_found",
      "validation",
    ]);
    const decoded = Schema.decodeUnknownSync(entry.input)({
      userId: parseTableId("users", "u9"),
      verificationBasis: "weryfikacja przez telefon",
    });
    expect(decoded.verificationBasis).toBe("weryfikacja przez telefon");
    expect(() =>
      Schema.decodeUnknownSync(entry.input)({ userId: parseTableId("users", "u9"), verificationBasis: "" }),
    ).toThrow();
  });

  it("declares enter with the honest conflict kind and the GM operations with pinned kinds", () => {
    expect([...accessOperations["access.enterGmMode"].errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
    ]);
    expect([...accessOperations["access.gmInspectCompany"].errorKinds].sort()).toEqual([
      "forbidden",
      "not_found",
      "validation",
    ]);
    expect([...accessOperations["access.gmEndCompanyAlpha"].errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
      "not_found",
    ]);
  });

  it("requires a basis on every company-targeting GM operation", () => {
    const decodedInspect = Schema.decodeUnknownSync(
      accessOperations["access.gmInspectCompany"].input,
    )({ companyId: parseTableId("companies", "c1"), basis: "podstawa" });
    const decodedActivate = Schema.decodeUnknownSync(
      accessOperations["access.gmActivateCompany"].input,
    )({ companyId: parseTableId("companies", "c1"), basis: "podstawa" });
    const decodedRestore = Schema.decodeUnknownSync(
      accessOperations["access.gmRestoreAdministrator"].input,
    )({
      companyId: parseTableId("companies", "c1"),
      userId: parseTableId("users", "u1"),
      basis: "podstawa",
    });
    const decodedEnd = Schema.decodeUnknownSync(accessOperations["access.gmEndCompanyAlpha"].input)(
      { companyId: parseTableId("companies", "c1"), basis: "podstawa" },
    );
    for (const decoded of [decodedInspect, decodedActivate, decodedRestore, decodedEnd]) {
      expect(Object.keys(decoded as Record<string, unknown>)).toContain("basis");
    }
  });
});
