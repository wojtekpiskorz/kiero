/**
 * G2 focused verification, part 3: the checked dispatch surface, the lane
 * policy registration and the schema-fragment vocabulary pins.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/g2/live-proof.mjs) exercises them end to end against the leased
 * dev deployment. What MUST hold structurally is pinned here: exactly ONE
 * certified operation is registered under the write intent (G3's
 * reconcileCopy honestly unsupported); wrong-vocabulary input fails
 * `validation` BEFORE any handler runs; no resolved identity means
 * `unauthenticated`; and the fragment's vocabulary pins match the pure
 * module's unions.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ActorContext, calendarOperations, parseTableId } from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type RequestContext } from "@kiero/runtime";
import {
  SUBJECT_EXCLUSIONS,
  TERM_WITHDRAW_REASONS,
  WITHDRAW_REASONS,
} from "@kiero/domain";
import {
  calendarProjectionHandlers,
  calendarProjectionPolicy,
  setCopyHiddenEntry,
} from "../../convex/calendar/projection/dispatch";
import { HIDE_ORIGINS } from "../../convex/calendar/projection/schema";

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

const validHide = () => ({
  copyId: parseTableId("calendarCopies", "k1"),
  hidden: true,
});

describe("calendar projection dispatch registration", () => {
  it("registers exactly the two certified G2+G5 operations under the write intent", () => {
    const handlers = calendarProjectionHandlers();
    // G5 (issue #107) appended calendar.setSelection to this lane's registry:
    // the minimal flagged amendment of this pin.
    expect(Object.keys(handlers).sort()).toEqual(["calendar.setCopyHidden", "calendar.setSelection"]);
    expect(handlers["calendar.setCopyHidden"]?.intent).toBe("write");
    expect(handlers["calendar.setSelection"]?.intent).toBe("write");
  });

  it("is G3's reconcileCopy that stays unsupported: the lane never fakes it", () => {
    const handlers = calendarProjectionHandlers();
    expect("calendar.reconcileCopy" in handlers).toBe(false);
    expect("calendar.reconcileCopy" in calendarOperations).toBe(true);
  });

  it("carries the certified membership policy under its own policy id", async () => {
    expect(calendarProjectionPolicy.policyId).toBe("calendar.g2-projection-v1");
    const context = contextFixture("member");
    const decision = await calendarProjectionPolicy.authorize(context, {
      intent: "write",
    });
    expect(decision).toEqual({ allowed: true });
    expect(membershipPolicy.policyId).toBe("platform.membership-default");
  });
});

describe("checked dispatch behavior", () => {
  it("fails closed `unauthenticated` before any handler runs without identity", async () => {
    const handler = vi.fn();
    const result = await dispatchCommand(
      {
        resolveContext: () => Promise.resolve(null),
        policy: calendarProjectionPolicy,
        handlers: {
          "calendar.setCopyHidden": { intent: "write", run: handler },
        },
      },
      { auth: null, db: {} } as never,
      envelope("calendar.setCopyHidden", validHide()),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails `validation` on wrong input before any handler runs", async () => {
    const handler = vi.fn();
    const context = contextFixture("admin");
    const result = await dispatchCommand(
      {
        resolveContext: () => Promise.resolve(context),
        policy: calendarProjectionPolicy,
        handlers: {
          "calendar.setCopyHidden": { intent: "write", run: handler },
        },
      },
      { auth: null, db: {} } as never,
      envelope("calendar.setCopyHidden", { copyId: "k1", hidden: "yes" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed `unsupported` for unknown or unimplemented operations", async () => {
    const context = contextFixture("admin");
    for (const operation of [
      "calendar.reconcileCopy",
      "calendar.inventProjectionOp",
      "calendar.forceProjectAll",
    ]) {
      const result = await dispatchCommand(
        {
          resolveContext: () => Promise.resolve(context),
          policy: calendarProjectionPolicy,
          handlers: calendarProjectionHandlers(),
        },
        { auth: null, db: {} } as never,
        envelope(operation, validHide()),
      );
      expect(result._tag).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag).toBe("unsupported");
      }
    }
  });

  it("decodes the certified input contract through the registered entry", () => {
    const decoded = Schema.decodeUnknownSync(setCopyHiddenEntry.input)(validHide());
    expect(decoded.hidden).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(setCopyHiddenEntry.input)({ copyId: "k1", hidden: 1 }),
    ).toThrow();
  });
});

describe("vocabulary ownership pins", () => {
  it("the merged withdraw list is exactly the domain's two owned lists, no hand copies", () => {
    expect(WITHDRAW_REASONS).toEqual([...SUBJECT_EXCLUSIONS, ...TERM_WITHDRAW_REASONS]);
    // Every reason the decision functions emit is a member of the merged
    // list (each emission site is pinned by name in tests/g2/domain.test.ts;
    // the schema validator and the transaction write are TYPED against
    // these lists, so drift fails typecheck instead of silently dropping).
    for (const reason of WITHDRAW_REASONS) {
      expect(typeof reason).toBe("string");
    }
  });

  it("hide origins stay the personal-decision vocabulary", () => {
    expect(HIDE_ORIGINS).toEqual(["user_request", "deleted_in_google", "moved_in_google"]);
  });
});
