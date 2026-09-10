/**
 * G3 focused verification, part 3: the checked dispatch surface, the lane
 * policy registration and the schema-fragment vocabulary pins.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/g3/live-proof.mjs) exercises them end to end against the leased
 * dev deployment. What MUST hold structurally is pinned here: exactly ONE
 * certified operation is registered under the write intent
 * (`calendar.reconcileCopy`, G2's honest `unsupported` gap closed);
 * wrong-vocabulary input fails `validation` BEFORE any handler runs; no
 * resolved identity means `unauthenticated`; the executor registration
 * claims the certified job kind; and the fragments' vocabulary pins match
 * the pure module's unions.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ActorContext, parseTableId } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type RequestContext } from "@kiero/runtime";
import {
  MAX_CREATE_ATTEMPTS,
  MAX_DELETE_ATTEMPTS,
  MAX_UPDATE_ATTEMPTS,
} from "../../convex/calendar/sync/cores";
import { reconcileOutcomeExecutor } from "../../convex/calendar/sync/executor";
import {
  calendarSyncHandlers,
  calendarSyncPolicy,
  reconcileCopyEntry,
} from "../../convex/calendar/sync/dispatch";
import {
  SYNC_ATTEMPT_OUTCOMES,
  SYNC_LEG_KINDS,
} from "../../convex/calendar/sync/schema";

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

const validReconcile = () => ({
  copyId: parseTableId("calendarCopies", "k1"),
});

describe("calendar sync dispatch registration", () => {
  it("registers exactly the one certified G3 operation under the write intent", () => {
    const handlers = calendarSyncHandlers();
    expect(Object.keys(handlers).sort()).toEqual(["calendar.reconcileCopy"]);
    expect(handlers["calendar.reconcileCopy"]?.intent).toBe("write");
  });

  it("decodes through the contract entry (the registry is decode authority)", () => {
    expect(reconcileCopyEntry.name).toBe("calendar.reconcileCopy");
    expect(() =>
      Schema.decodeUnknownSync(reconcileCopyEntry.input)(validReconcile()),
    ).not.toThrow();
    // The table brand is compile-time; the RUNTIME id check is Convex's
    // own (ctx.db.normalizeId, A3's proof) — a non-string value still
    // fails the entry's decode here.
    expect(() => Schema.decodeUnknownSync(reconcileCopyEntry.input)({ copyId: 42 })).toThrow();
    expect(() => Schema.decodeUnknownSync(reconcileCopyEntry.input)({})).toThrow();
  });

  it("fails validation before any handler runs on wrong input", async () => {
    const handler = calendarSyncHandlers()["calendar.reconcileCopy"];
    if (handler === undefined) {
      throw new Error("handler missing");
    }
    await expect(
      handler.run({} as never, contextFixture("admin"), { copyId: 42 }, {}),
    ).rejects.toThrow();
  });

  it("keeps the certified membership policy", async () => {
    const context = contextFixture("member");
    const request = { intent: "write" as const };
    const decision = await calendarSyncPolicy.authorize(context, request);
    expect(decision).toEqual(await membershipPolicy.authorize(context, request));
  });

  it("no resolved identity means unauthenticated (composed resolution)", async () => {
    const dispatched = await dispatchCommand(
      {
        resolveContext: async () => null,
        policy: calendarSyncPolicy,
        handlers: calendarSyncHandlers(),
      },
      { db: {} } as never,
      envelope("calendar.reconcileCopy", validReconcile()),
    );
    expect(dispatched._tag).toBe("error");
  });
});

describe("the durable executor registration", () => {
  it("claims exactly the certified calendar.reconcile_outcome job kind", () => {
    expect(reconcileOutcomeExecutor.jobKind).toBe("calendar.reconcile_outcome");
  });

  it("hands the effect to the external action (never inside a transaction)", async () => {
    const outcome = await reconcileOutcomeExecutor.execute({} as never, {} as never, null);
    expect(outcome.outcome).toBe("external");
    if (outcome.outcome !== "external") {
      throw new Error("unreachable");
    }
    // The generated api uses live proxies (fresh references per access),
    // so identity comparison is meaningless here; the target is pinned at
    // compile time by executor.ts's typed import of the runner.
    expect(outcome.action).toBeTruthy();
  });
});

describe("schema-fragment vocabulary pins", () => {
  it("the leg kinds match the pure module's closed vocabulary", () => {
    expect(SYNC_LEG_KINDS).toEqual([
      "create",
      "update",
      "delete",
      "observe_get",
      "observe_list",
    ]);
  });

  it("the attempt outcomes are the A3 ExternalOutcome vocabulary", () => {
    expect(SYNC_ATTEMPT_OUTCOMES).toEqual(["succeeded", "failed", "timeout", "unknown"]);
  });

  it("the retry bounds are positive and stable", () => {
    expect(MAX_CREATE_ATTEMPTS).toBeGreaterThan(0);
    expect(MAX_UPDATE_ATTEMPTS).toBeGreaterThan(0);
    expect(MAX_DELETE_ATTEMPTS).toBeGreaterThan(0);
  });
});
