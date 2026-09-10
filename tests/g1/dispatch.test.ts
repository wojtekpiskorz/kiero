/**
 * G1 focused verification: the checked dispatch surface and the credential
 * store.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/g1/live-proof.mjs) exercises them end to end. What MUST hold
 * structurally is pinned here: the lane registers exactly the two
 * certified connection operations under `write`, fails closed before any
 * handler runs (unauthenticated identity, invalid contract input), and the
 * credential store seals/opens round-trip with the documented
 * plaintext-dev fallback.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  ActorContext,
  calendarOperations,
  okResult,
  parseTableId,
} from "@kiero/contracts";
import { dispatchCommand, membershipPolicy, type RequestContext } from "@kiero/runtime";
import { calendarHandlers, calendarLanePolicy } from "../../convex/calendar/connection/dispatch";
import {
  openCredential,
  sealCredential,
} from "../../convex/calendar/connection/credentialStore";

function contextFixture(): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", "u1"),
    companyId: parseTableId("companies", "c1"),
    membershipRole: "admin",
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

describe("the G1 calendar handler registration", () => {
  it("registers exactly the two certified connection operations", () => {
    const handlers = calendarHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "calendar.connectCalendar",
      "calendar.disconnectCalendar",
    ]);
  });

  it("binds both operations to the write intent (a plain boss connects his own calendar)", () => {
    const handlers = calendarHandlers();
    expect(handlers["calendar.connectCalendar"]?.intent).toBe("write");
    expect(handlers["calendar.disconnectCalendar"]?.intent).toBe("write");
  });

  it("fails closed on the projection lane's operations (G2/G3 own them)", async () => {
    // Empty handler table (the B3 pattern): combined with the exact-keys
    // assertion above, the projection operations are provably absent from
    // this lane's registry, so dispatch fails closed `unsupported`.
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: calendarLanePolicy,
        handlers: {},
      },
      null,
      envelope("calendar.setCopyHidden", { copyId: parseTableId("calendarCopies", "k1"), hidden: true }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unsupported");
    }
  });

  it("never invokes a handler when the contract rejects the input", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => contextFixture(),
        policy: calendarLanePolicy,
        handlers: { "calendar.disconnectCalendar": { intent: "write", run: handler } },
      },
      undefined,
      envelope("calendar.disconnectCalendar", { connectionId: 42 }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies calendar commands without a resolved identity before any handler runs", async () => {
    const handler = vi.fn(async () => okResult({}));
    const result = await dispatchCommand(
      {
        resolveContext: async () => null,
        policy: calendarLanePolicy,
        handlers: { "calendar.connectCalendar": { intent: "write", run: handler } },
      },
      undefined,
      envelope("calendar.connectCalendar", { googleCalendarId: "cal" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it("carries the closed error vocabulary the contract declares", () => {
    expect(calendarOperations["calendar.connectCalendar"].errorKinds).toContain("conflict");
    expect(calendarOperations["calendar.disconnectCalendar"].errorKinds).toContain("not_found");
  });
});

describe("the G1 policy registration", () => {
  it("is the G1 registration over the platform seam (membership semantics)", async () => {
    expect(calendarLanePolicy.policyId).toBe("calendar.g1-connection-v1");
    expect(await calendarLanePolicy.authorize(null, { intent: "write" })).toEqual({
      allowed: false,
      error: expect.objectContaining({ _tag: "unauthenticated" }),
    });
    const member = await membershipPolicy.authorize(contextFixture(), { intent: "write" });
    expect(member.allowed).toBe(true);
  });
});

describe("the credential store", () => {
  const bundle = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    accessTokenExpiresAtMs: 123,
    obtainedAtMs: 100,
  };

  it("round-trips an AES-GCM-sealed bundle with the configured key", async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).map(() => 7)));
    const sealed = await sealCredential(bundle, { KIERO_CALENDAR_TOKEN_KEY: key });
    expect(sealed.storage).toBe("encrypted_aesgcm");
    expect(sealed.ciphertext).not.toContain("access-1");
    expect(sealed.ciphertext).not.toContain("refresh-1");
    const opened = await openCredential(sealed.storage, sealed.ciphertext, {
      KIERO_CALENDAR_TOKEN_KEY: key,
    });
    expect(opened).toEqual(bundle);
  });

  it("records the documented plaintext-dev fallback without a key", async () => {
    const sealed = await sealCredential(bundle, {});
    expect(sealed.storage).toBe("plaintext_dev");
    const opened = await openCredential(sealed.storage, sealed.ciphertext, {});
    expect(opened).toEqual(bundle);
  });

  it("fails closed on absent material, wrong kinds and tampered ciphertext", async () => {
    const key = btoa(String.fromCharCode(...new Uint8Array(32).map(() => 9)));
    expect(await openCredential(undefined, undefined, {})).toBeNull();
    expect(await openCredential("none", "x", {})).toBeNull();
    const sealed = await sealCredential(bundle, { KIERO_CALENDAR_TOKEN_KEY: key });
    expect(await openCredential(sealed.storage, `${sealed.ciphertext.slice(0, -2)}aa`, {})).toBeNull();
    expect(await openCredential(sealed.storage, sealed.ciphertext, {})).toBeNull();
  });
});
