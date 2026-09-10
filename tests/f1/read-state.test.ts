/**
 * F1 focused tests: read-state pure decisions and the lane's checked
 * dispatch wiring (the tests/d1 pattern).
 *
 * Per-person isolation and cross-view atomicity are STRUCTURAL: one row per
 * user + logical source, no view/device dimension in the key. These tests
 * pin the transition decision (idempotent marks, one event per actual
 * transition), the unread projection over canonical D1 source ids, and the
 * fail-closed dispatch order. The live two-boss/two-device/two-view proofs
 * run against the real leased deployment (tests/f1/live-proof.mjs
 * transcripts in the issue report).
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ActorContext, okResult, parseTableId } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type RequestContext } from "@kiero/runtime";
import { readStateHandlers } from "../../convex/attention/read_state/dispatch";
import {
  markSourceReadOperation,
} from "../../convex/attention/read_state/operations";
import {
  countUnread,
  decideReadTransition,
  projectReadState,
} from "../../convex/attention/read_state/state";

function contextFixture(userIdValue = "u1"): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", userIdValue),
    companyId: parseTableId("companies", "c1"),
    membershipRole: "member",
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

const S1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";

describe("read transition decision (idempotent marks, one event per change)", () => {
  it("treats an absent row as unread", () => {
    expect(decideReadTransition(null, true)).toBe("changed");
    // Marking "unread" when no row exists is already the truth: no write,
    // no event.
    expect(decideReadTransition(null, false)).toBe("unchanged");
  });

  it("is unchanged when the stored state already says this", () => {
    expect(decideReadTransition({ read: true }, true)).toBe("unchanged");
    expect(decideReadTransition({ read: false }, false)).toBe("unchanged");
  });

  it("changes only on an actual flip", () => {
    expect(decideReadTransition({ read: false }, true)).toBe("changed");
    expect(decideReadTransition({ read: true }, false)).toBe("changed");
  });
});

describe("unread projection over canonical source ids", () => {
  it("resolves absence as unread (the glossary definition)", () => {
    const entries = projectReadState([S1], []);
    expect(entries).toEqual([{ sourceId: S1, read: false, readAtMs: null }]);
    expect(countUnread(entries)).toBe(1);
  });

  it("reads the one row per source regardless of which view supplied the id", () => {
    const row = { sourceId: S1, read: true, readAtMs: 123 };
    // The same source id the company view, any project view and every
    // device of this person carry: one row answers all of them.
    expect(projectReadState([S1, S1], [row])).toEqual([
      { sourceId: S1, read: true, readAtMs: 123 },
    ]);
    expect(countUnread(projectReadState([S1], [row]))).toBe(0);
  });

  it("keeps request order and collapses duplicate ids", () => {
    const a = "k57d0000000000000000000000000001";
    const b = "k57d0000000000000000000000000002";
    const entries = projectReadState([b, a, b], [{ sourceId: a, read: true, readAtMs: 5 }]);
    expect(entries.map((entry) => entry.sourceId)).toEqual([b, a]);
    expect(entries[1]).toEqual({ sourceId: a, read: true, readAtMs: 5 });
  });

  it("reports an explicit unread mark as unread with its timestamp", () => {
    const entries = projectReadState(
      [S1],
      [{ sourceId: S1, read: false, readAtMs: 7 }],
    );
    expect(entries).toEqual([{ sourceId: S1, read: false, readAtMs: 7 }]);
  });
});

describe("read-state handler registration (one write operation, nothing else)", () => {
  it("registers markSourceRead as the only read-state lane write", () => {
    const handlers = readStateHandlers();
    expect(Object.keys(handlers).sort()).toEqual(["attention.markSourceRead"]);
    expect(handlers["attention.markSourceRead"]?.intent).toBe("write");
  });
});

describe("invalid or foreign commands reach no domain effect", () => {
  it("denies an unknown edit operation with unsupported/unknown_operation", async () => {
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "attention.markSourceRead": { intent: "write", run: async () => okResult({}) } },
      },
      null,
      envelope("attention.resetReadState", { sourceId: S1 }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("unknown_operation");
    }
  });

  it("fails closed on declared-but-unimplemented sibling operations (F2/F3/F4 own them)", async () => {
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "attention.markSourceRead": { intent: "write", run: async () => okResult({}) } },
      },
      null,
      envelope("attention.snoozeTaskReminders", { taskId: "t1", untilMs: 1 }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("not_implemented");
    }
  });

  it("never invokes the handler when the contract rejects the input", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: membershipPolicy,
        handlers: { "attention.markSourceRead": { intent: "write", run: handler } },
      },
      null,
      envelope("attention.markSourceRead", { sourceId: S1 }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies the mark without a resolved identity before any handler runs", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => null,
        policy: membershipPolicy,
        handlers: { "attention.markSourceRead": { intent: "write", run: handler } },
      },
      null,
      envelope("attention.markSourceRead", { sourceId: S1, read: true }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("the certified attention.markSourceRead contract surface", () => {
  it("decodes a well-formed mark in both directions", () => {
    expect(
      Schema.decodeUnknownSync(markSourceReadOperation.input)({ sourceId: S1, read: true }),
    ).toEqual({ sourceId: S1, read: true });
    expect(
      Schema.decodeUnknownSync(markSourceReadOperation.input)({ sourceId: S1, read: false }),
    ).toEqual({ sourceId: S1, read: false });
  });

  it("rejects a malformed source reference", () => {
    expect(() =>
      Schema.decodeUnknownSync(markSourceReadOperation.input)({ sourceId: 42, read: true }),
    ).toThrow();
  });

  it("declares exactly the closed error kinds F1 can surface", () => {
    expect([...markSourceReadOperation.errorKinds].sort()).toEqual(["forbidden", "not_found"]);
  });
});
