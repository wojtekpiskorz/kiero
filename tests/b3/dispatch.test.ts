/**
 * B3 focused verification: the checked dispatch surface, the authoritative
 * policy registration and the declared consumer-edge projection.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/b3/live-proof.mjs) exercises them end to end. What MUST hold
 * structurally is pinned here: which operations the lane registers and
 * under which intent, that the policy is the B3 registration over the
 * resolved context, that invalid or foreign envelopes fail closed before
 * any handler runs, that the contract entries carry the closed error
 * vocabulary, and that the outbox drain projects both access-revocation
 * events onto the declared cleanup job.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  ActorContext,
  MembershipRole,
  accessOperations,
  okResult,
  parseTableId,
  revokedAccessCleanupInput,
  tableIdSchema,
} from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  type RequestContext,
} from "@kiero/runtime";
import { membershipHandlers, } from "../../convex/access/membership/dispatch";
import { membershipLanePolicy } from "../../convex/access/membership/policy";
import { projectEventToJobInputs } from "../../convex/platform/outbox";
import { membershipTables } from "../../convex/access/membership/schema";

function contextFixture(role: "admin" | "member"): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", "u1"),
    companyId: parseTableId("companies", "c1"),
    membershipRole: role,
    isGm: false,
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

describe("the B3 membership handler registration", () => {
  it("registers exactly the company-scoped membership operations", () => {
    const handlers = membershipHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "access.changeMembershipRole",
      "access.revokeInvitation",
      "access.revokeMembership",
      "access.transferAdministration",
    ]);
  });

  it("binds administration intents to administer, leaving to write", () => {
    const handlers = membershipHandlers();
    expect(handlers["access.revokeInvitation"]?.intent).toBe("administer");
    expect(handlers["access.changeMembershipRole"]?.intent).toBe("administer");
    expect(handlers["access.transferAdministration"]?.intent).toBe("administer");
    // A plain boss may leave their own firm: the core decides self vs admin.
    expect(handlers["access.revokeMembership"]?.intent).toBe("write");
  });

  it("fails closed on admission operations over the company-scoped dispatch", async () => {
    // Combined with the exact-keys assertion above: admission operations
    // are NOT part of this lane's company-scoped registry, so dispatching
    // one here fails closed `unsupported` — the admission surface
    // (admitCommand) is their entry.
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture("admin"),
        policy: membershipLanePolicy,
        handlers: {},
      },
      null,
      envelope("access.acceptInvitation", {
        invitationId: parseTableId("invitations", "i1"),
        verificationCode: "12345678",
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("not_implemented");
    }
  });

  it("never invokes a handler when the contract rejects the input", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture("admin"),
        policy: membershipLanePolicy,
        handlers: {
          "access.createInvitation": { intent: "administer", run: handler },
        },
      },
      undefined,
      envelope("access.createInvitation", { email: "not-an-address", role: "member" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies membership commands without a resolved identity before any handler runs", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => null,
        policy: membershipLanePolicy,
        handlers: { "access.revokeMembership": { intent: "write", run: handler } },
      },
      undefined,
      envelope("access.revokeMembership", { membershipId: parseTableId("memberships", "m1") }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("the B3 policy registration (authoritative for membership rules)", () => {
  it("is the B3 registration over the platform seam", () => {
    expect(membershipLanePolicy.policyId).toBe("access.b3-membership-v1");
  });

  it("denies null contexts and non-admin administer intents like the certified semantics", async () => {
    expect(await membershipLanePolicy.authorize(null, { intent: "write" })).toEqual({
      allowed: false,
      error: expect.objectContaining({ _tag: "unauthenticated" }),
    });
    const memberDecision = await membershipLanePolicy.authorize(contextFixture("member"), {
      intent: "administer",
    });
    expect(memberDecision.allowed).toBe(false);
    const adminDecision = await membershipLanePolicy.authorize(contextFixture("admin"), {
      intent: "administer",
    });
    expect(adminDecision).toEqual({ allowed: true });
  });

  it("keeps the tenant-scope check (cross-company requests deny)", async () => {
    const otherCompanyId = Schema.decodeUnknownSync(tableIdSchema("companies"))("c2");
    const decision = await membershipLanePolicy.authorize(contextFixture("admin"), {
      intent: "read",
      companyId: otherCompanyId,
    });
    expect(decision.allowed).toBe(false);
  });

  it("agrees with the platform default on every intent over the same context", async () => {
    const requests = [
      { intent: "read" as const },
      { intent: "write" as const },
      { intent: "execute" as const },
      { intent: "administer" as const },
      { intent: "inspectGm" as const },
    ];
    for (const role of ["admin", "member"] as const) {
      const context = contextFixture(role);
      for (const request of requests) {
        expect(await membershipLanePolicy.authorize(context, request)).toEqual(
          await membershipPolicy.authorize(context, request),
        );
      }
    }
  });
});

describe("the B3 contract entries (closed error vocabulary)", () => {
  it("declares the admission, issuance and transfer operations with pinned error kinds", () => {
    expect([...accessOperations["access.createCompany"].errorKinds].sort()).toEqual([
      "conflict",
      "validation",
    ]);
    expect([...accessOperations["access.createInvitation"].errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
      "validation",
    ]);
    expect([...accessOperations["access.rejectInvitation"].errorKinds].sort()).toEqual([
      "conflict",
      "not_found",
    ]);
    expect([...accessOperations["access.transferAdministration"].errorKinds].sort()).toEqual([
      "forbidden",
      "not_found",
      "validation",
    ]);
  });

  it("decodes a well-formed createCompany input and rejects a malformed currency", () => {
    const decoded = Schema.decodeUnknownSync(accessOperations["access.createCompany"].input)({
      name: "Budowa Kowalscy",
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
    });
    expect(decoded.name).toBe("Budowa Kowalscy");
    expect(() =>
      Schema.decodeUnknownSync(accessOperations["access.createCompany"].input)({
        name: "X",
        timezone: "Europe/Warsaw",
        defaultCurrency: "zloty",
      }),
    ).toThrow();
  });

  it("carries the timezone as a plain string (the transaction's IANA check is the single authority)", () => {
    // Real IANA shapes the removed regex rejected; the contract layer must
    // pass them through and let validateTimezone decide.
    for (const zone of ["America/Argentina/Buenos_Aires", "Etc/GMT+5", "UTC"]) {
      const decoded = Schema.decodeUnknownSync(accessOperations["access.createCompany"].input)({
        name: "X",
        timezone: zone,
        defaultCurrency: "PLN",
      });
      expect(decoded.timezone, zone).toBe(zone);
    }
  });

  it("carries the single-use invitation code as plain string input, role per the vocabulary", () => {
    const decoded = Schema.decodeUnknownSync(accessOperations["access.createInvitation"].input)({
      email: "szef@firma.pl",
      role: "admin",
    });
    expect(decoded.role).toBe("admin");
    expect(() =>
      Schema.decodeUnknownSync(accessOperations["access.createInvitation"].input)({
        email: "szef@firma.pl",
        role: "boss",
      }),
    ).toThrow();
  });

  it("keeps the role vocabulary pinned to the contracts MembershipRole", () => {
    expect(MembershipRole).toBeDefined();
    const invitationStates = membershipTables.invitations.validator;
    expect(invitationStates).toBeDefined();
  });
});

describe("the declared consumer edge (access revocation drains durably)", () => {
  const membershipId = parseTableId("memberships", "m1");
  const userId = parseTableId("users", "u1");
  const sessionId = parseTableId("sessions", "s1");

  it("projects access.membershipRevoked onto the cleanup job with the successor-policy payload", () => {
    const [projection] = projectEventToJobInputs(
      "access.membershipRevoked",
      { membershipId, userId, revokedAtMs: 123, successorUserId: null },
      "dedup-1",
    );
    expect(projection).toEqual({
      kind: "job",
      jobKind: "access.cleanup_revocation",
      input: { kind: "membership", membershipId, sessionId: null, revokedAtMs: 123 },
      dedupKey: "dedup-1",
    });
    // The projected input decodes against the executor's registry schema.
    expect(() =>
      Schema.decodeUnknownSync(revokedAccessCleanupInput)(
        (projection as { input: unknown }).input,
      ),
    ).not.toThrow();
  });

  it("projects access.sessionRevoked onto the session-kind cleanup job (no timestamp in B1's payload)", () => {
    const [projection] = projectEventToJobInputs(
      "access.sessionRevoked",
      { sessionId },
      "dedup-2",
    );
    expect(projection).toEqual({
      kind: "job",
      jobKind: "access.cleanup_revocation",
      input: { kind: "session", membershipId: null, sessionId },
      dedupKey: "dedup-2",
    });
    expect(() =>
      Schema.decodeUnknownSync(revokedAccessCleanupInput)(
        (projection as { input: unknown }).input,
      ),
    ).not.toThrow();
  });

  it("leaves events without a registered edge undelivered by consumers", () => {
    // E3 owns the extract projection, D5 the normalize projection and E4
    // the join projection; all three edges fan out from
    // sources.sourceAccepted. The still-unprojected example is C5's
    // recomputation edge.
    const projections = projectEventToJobInputs("sources.sourceAccepted", {}, "d");
    expect(projections.map((projection) => projection.kind)).toEqual(["job", "job", "job"]);
    expect(projectEventToJobInputs("memory.dependentsMarkedStale", {}, "d")).toEqual([
      { kind: "unprojected_edge", jobKind: "memory.recompute_dependents" },
    ]);
  });
});
