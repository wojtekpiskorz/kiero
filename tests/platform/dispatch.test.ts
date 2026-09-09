/**
 * Checked dispatch tests (A3): the one path every operation invocation takes.
 * Invalid input reaches no domain effect; every failure is a sanitized
 * closed error; handlers never leak bare throws.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ActorContext, okResult, parseTableId, tableIdSchema } from "@kiero/contracts";
import type { CompanyId } from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  type RequestContext,
} from "@kiero/runtime";

function contextFixture(overrides: Partial<ActorContext> = {}): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", "u1") ?? "u1",
    companyId: parseTableId("companies", "c1") ?? "c1",
    membershipRole: "member",
    isGm: false,
    sessionId: parseTableId("sessions", "s1") ?? "s1",
    via: "user",
    ...overrides,
  });
  return { actor, resolvedAtMs: Date.now() };
}

const emptyCtx = null;

describe("dispatchCommand checked path", () => {
  it("rejects a malformed envelope before anything else runs", async () => {
    const handler = vi.fn(async () => okResult({ done: true }));
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "platform.probeEcho": { intent: "write", run: handler } },
      },
      emptyCtx,
      { operation: 42 },
    );
    expect(result._tag).toBe("error");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown operation", async () => {
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: {},
      },
      emptyCtx,
      { operation: "drifted.nonexistent", input: {}, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("unknown_operation");
    }
  });

  it("fails closed on a registered-but-unimplemented operation", async () => {
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: {},
      },
      emptyCtx,
      { operation: "sources.acceptSource", input: {}, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("not_implemented");
    }
  });

  it("denies without a resolved context (no identity, no way in)", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => null,
        policy: membershipPolicy,
        handlers: { "platform.probeEcho": { intent: "write", run: handler } },
      },
      emptyCtx,
      { operation: "platform.probeEcho", input: { message: "x" }, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies administer intent for a member, allows it for an admin", async () => {
    const run = async (context: RequestContext | null) =>
      dispatchCommand(
        {
          resolveContext: async () => context,
          policy: membershipPolicy,
          handlers: { "platform.probeEcho": { intent: "administer", run: async () => okResult({}) } },
        },
        emptyCtx,
        { operation: "platform.probeEcho", input: { message: "x" }, expectedRevisions: [] },
      );
    const member = await run(contextFixture());
    const admin = await run(contextFixture({ membershipRole: "admin" }));
    expect(member._tag).toBe("error");
    expect(admin._tag).toBe("ok");
  });

  it("rejects a tenant-scoped request outside the actor's company", async () => {
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "platform.probeEcho": { intent: "write", run: async () => okResult({}) } },
      },
      emptyCtx,
      { operation: "platform.probeEcho", input: { message: "x" }, expectedRevisions: [] },
    );
    // Same-company request succeeds...
    expect(result._tag).toBe("ok");
    // ...while the policy itself enforces the tenant boundary:
    const decision = await membershipPolicy.authorize(contextFixture(), {
      intent: "read",
      companyId: Schema.decodeUnknownSync(tableIdSchema("companies"))("c-other") as CompanyId,
    });
    expect(decision.allowed).toBe(false);
  });

  it("invalid input reaches NO domain effect (handler never invoked)", async () => {
    const handler = vi.fn(async () => okResult({ done: true }));
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "platform.probeEcho": { intent: "write", run: handler } },
      },
      emptyCtx,
      { operation: "platform.probeEcho", input: { message: "" }, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("sanitizes a handler crash into the closed unavailable error", async () => {
    const internal = new Error("secret internal detail: db password is hunter2");
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: {
          "platform.probeEcho": {
            intent: "write",
            run: async () => {
              throw internal;
            },
          },
        },
      },
      emptyCtx,
      { operation: "platform.probeEcho", input: { message: "x" }, expectedRevisions: [] },
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unavailable");
      const encoded = JSON.stringify(result.error);
      expect(encoded).not.toContain("hunter2");
      expect(encoded).not.toContain("secret");
    }
  });

  it("passes the command's idempotency key through to the handler", async () => {
    let seen: string | undefined;
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: {
          "platform.probeEcho": {
            intent: "write",
            run: async (_ctx, _context, _input, meta) => {
              seen = meta.idempotencyKey;
              return okResult({});
            },
          },
        },
      },
      emptyCtx,
      {
        operation: "platform.probeEcho",
        input: { message: "x" },
        expectedRevisions: [],
        idempotencyKey: "idem_00000000-0000-4000-8000-000000000000",
      },
    );
    expect(result._tag).toBe("ok");
    expect(seen).toBe("idem_00000000-0000-4000-8000-000000000000");
  });
});
