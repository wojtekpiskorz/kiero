/**
 * G5 focused verification, part 3: the checked dispatch surface for the
 * selection write: the same path G2 proved for the personal hide.
 *
 * Structurally pinned here: the handler registry carries BOTH certified
 * projection writes under the write intent; a selection envelope without a
 * resolved identity fails `unauthenticated` before any handler runs; a
 * malformed selection fails `validation` before any handler runs; G3's
 * reconcileCopy (and anything invented) still fails closed `unsupported`.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ActorContext, parseTableId } from "@kiero/contracts";
import { dispatchCommand, type RequestContext } from "@kiero/runtime";
import {
  calendarProjectionHandlers,
  calendarProjectionPolicy,
  setSelectionEntry,
} from "../../convex/calendar/projection/dispatch";

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

describe("calendar projection dispatch carries the selection write", () => {
  it("registers both certified projection writes (the flagged G2-pin amendment)", () => {
    const handlers = calendarProjectionHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "calendar.setCopyHidden",
      "calendar.setSelection",
    ]);
    expect(handlers["calendar.setSelection"]?.intent).toBe("write");
  });

  it("decodes the certified selection input through the registered entry", () => {
    const decoded = Schema.decodeUnknownSync(setSelectionEntry.input)({
      mode: "explicit",
      projectIds: ["p1"],
    });
    expect(decoded).toEqual({ mode: "explicit", projectIds: ["p1"] });
    expect(() => Schema.decodeUnknownSync(setSelectionEntry.input)({ mode: "explicit" })).toThrow();
  });

  it("fails closed `unauthenticated` before any handler runs without identity", async () => {
    const handler = vi.fn();
    const result = await dispatchCommand(
      {
        resolveContext: () => Promise.resolve(null),
        policy: calendarProjectionPolicy,
        handlers: { "calendar.setSelection": { intent: "write", run: handler } },
      },
      { auth: null, db: {} } as never,
      envelope("calendar.setSelection", { mode: "all_projects" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails `validation` on a malformed selection before any handler runs", async () => {
    const handler = vi.fn();
    const context = contextFixture("admin");
    const result = await dispatchCommand(
      {
        resolveContext: () => Promise.resolve(context),
        policy: calendarProjectionPolicy,
        handlers: { "calendar.setSelection": { intent: "write", run: handler } },
      },
      { auth: null, db: {} } as never,
      envelope("calendar.setSelection", { mode: "explicit" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("still fails closed `unsupported` for G3's and invented operations", async () => {
    const context = contextFixture("member");
    for (const operation of ["calendar.reconcileCopy", "calendar.forceScope"]) {
      const result = await dispatchCommand(
        {
          resolveContext: () => Promise.resolve(context),
          policy: calendarProjectionPolicy,
          handlers: calendarProjectionHandlers(),
        },
        { auth: null, db: {} } as never,
        envelope(operation, { mode: "all_projects" }),
      );
      expect(result._tag).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag).toBe("unsupported");
      }
    }
  });
});
