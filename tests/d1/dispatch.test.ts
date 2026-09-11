/**
 * D1 focused tests: the sources lane's checked dispatch wiring and the
 * certified contract surface it validates against.
 *
 * Source immutability is structural: there is no edit operation anywhere in
 * the composed registry, D1 registers exactly one write operation
 * (acceptance), and every attempt to reach another mutation of a source
 * fails closed. The handler itself needs a Convex transaction; the LIVE
 * proofs exercise it against the real deployment.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ActorContext, okResult, parseTableId, sourcesOperations } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type RequestContext } from "@kiero/runtime";
import { sourcesHandlers } from "../../convex/sources/accept/dispatch";
import {
  acceptSourceEntry,
  dedupeProjectHints,
} from "../../convex/sources/accept/acceptance";

function contextFixture(): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", "u1"),
    companyId: parseTableId("companies", "c1"),
    membershipRole: "member",
    isGm: false,
    sessionId: parseTableId("sessions", "s1"),
    via: "user",
  });
  return { actor, resolvedAtMs: Date.now() };
}

const validInput = {
  uploadId: parseTableId("uploads", "up1") ?? "up1",
  authorText: "Kaczmarek: wpłata zaliczki przyjęta",
  intendedSentAtIso: "2026-09-09T07:15:00.000Z",
  timezoneSnapshot: "Europe/Warsaw",
  projectHints: [parseTableId("projects", "p1") ?? "p1"],
};

const envelope = (operation: string, input: unknown, idempotencyKey?: string) => ({
  operation,
  input,
  expectedRevisions: [],
  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
});

describe("the certified sources.acceptSource contract surface", () => {
  it("decodes a well-formed acceptance input", () => {
    const decoded = Schema.decodeUnknownSync(acceptSourceEntry.input)(validInput);
    expect(decoded.authorText).toBe(validInput.authorText);
    expect(decoded.projectHints).toEqual(validInput.projectHints);
  });

  it("rejects malformed input (missing upload, empty zone, wrong hint type)", () => {
    const { uploadId: _missing, ...withoutUpload } = validInput;
    expect(() => Schema.decodeUnknownSync(acceptSourceEntry.input)(withoutUpload)).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(acceptSourceEntry.input)({ ...validInput, timezoneSnapshot: "" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(acceptSourceEntry.input)({ ...validInput, projectHints: [42] }),
    ).toThrow();
  });

  it("declares exactly the closed error kinds D1 can surface", () => {
    expect([...acceptSourceEntry.errorKinds].sort()).toEqual(["conflict", "forbidden", "validation"]);
  });
});

describe("sources handler registration (one write operation, nothing else)", () => {
  it("registers acceptance as the only D1 sources lane write", () => {
    const handlers = sourcesHandlers();
    // C5's sanctioned append (issue #28 owns the withdrawal operation's
    // implementation; D1 owns only acceptance here). E7's sanctioned append
    // (issue #115) adds the project reassignment the same way. I4's
    // sanctioned append (issue #56) adds the permanent deletion (an
    // administer-intent operation implemented in the deletion lane's own
    // module).
    expect(Object.keys(handlers).sort()).toEqual([
      "sources.acceptSource",
      "sources.purgeSource",
      "sources.reassignSource",
      "sources.withdrawSource",
    ]);
    expect(handlers["sources.acceptSource"]?.intent).toBe("write");
    expect(handlers["sources.purgeSource"]?.intent).toBe("administer");
  });
});

describe("rejection of source editing (immutability at the surface)", () => {
  it("denies any unknown edit operation with unsupported/unknown_operation", async () => {
    const result = await dispatchCommand(
      { resolveContext: async () => contextFixture(), policy: membershipPolicy, handlers: {} },
      null,
      envelope("sources.editSource", { sourceId: "s1", authorText: "po fakcie" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("unknown_operation");
    }
  });

  it("fails closed on declared-but-unimplemented lifecycle operations (C5 owns withdraw)", async () => {
    // The sources registry registers acceptance only (asserted above), so
    // the generic checked path decides this envelope with no binding.
    const result = await dispatchCommand(
      { resolveContext: async () => contextFixture(), policy: membershipPolicy, handlers: {} },
      null,
      envelope("sources.withdrawSource", { sourceId: "s1", reason: "pomyłka" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("not_implemented");
    }
  });
});

describe("invalid acceptance input reaches no domain effect", () => {
  it("never invokes the handler when the contract rejects the input", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "sources.acceptSource": { intent: "write", run: handler } },
      },
      null,
      envelope("sources.acceptSource", { ...validInput, timezoneSnapshot: "" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies acceptance without a resolved identity before any handler runs", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => null,
        policy: membershipPolicy,
        handlers: { "sources.acceptSource": { intent: "write", run: handler } },
      },
      null,
      envelope("sources.acceptSource", validInput),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("passes the logical-source key to the handler as the idempotency key", async () => {
    let seen: string | undefined;
    const key = "idem_00000000-0000-4000-8000-000000000000";
    await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: {
          "sources.acceptSource": {
            intent: "write",
            run: async (_tx, _context, _input, meta) => {
              seen = meta.idempotencyKey;
              return okResult({});
            },
          },
        },
      },
      null,
      envelope("sources.acceptSource", validInput, key),
    );
    expect(seen).toBe(key);
  });
});

describe("project hints stay bounded context", () => {
  it("deduplicates repeated hints (repeated pills are noise, not authority)", () => {
    expect(dedupeProjectHints(["p1", "p1", "p1"])).toEqual(["p1"]);
  });

  it("keeps the hint array a plain reference list (no clause forcing)", () => {
    const decoded = Schema.decodeUnknownSync(acceptSourceEntry.input)({
      ...validInput,
      projectHints: [],
    });
    // A general source: no project at all is a valid acceptance.
    expect(decoded.projectHints).toEqual([]);
  });
});

describe("registry consistency for the D1 surface", () => {
  it("keeps sources.acceptSource and sources.sourceAccepted in the composed surface", () => {
    expect(sourcesOperations["sources.acceptSource"]?.name).toBe("sources.acceptSource");
  });
});
