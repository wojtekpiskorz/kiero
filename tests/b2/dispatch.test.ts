/**
 * B2 focused verification: the typed operation through the REAL checked
 * dispatch path (`dispatchCommand` from @kiero/runtime), with an
 * in-memory LinkingTx injected through the handler factory's seam.
 *
 * This pins the A3 seam contract for B2's registration: envelope decode,
 * registry lookup, context resolution, the authorization seam, contract
 * input decode, the handler, and the result envelope mapping — including
 * the self-service scope rule (`forbidden` for another user id) and the
 * typed conflict codes for incomplete proofs.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ActorContext, type ResultEnvelope } from "@kiero/contracts";
import { dispatchCommand } from "@kiero/runtime";
import type { MutationCtx } from "../../convex/_generated/server";
import { linkingHandlers } from "../../convex/access/linking/operations";
import {
  beginLinkingCore,
  recordGoogleProofCore,
  stageProofCodeCore,
  verifyProofCodeCore,
} from "../../convex/access/linking/ceremony";
import { fakeDb, fakeLinkingTx, fakeUser, type FakeLinkingDb } from "./fake";

const NOW = 1_800_000_000_000;
const EMAIL = "szef@kiero.invalid";

function actorContext(userId: string) {
  return Schema.decodeUnknownSync(ActorContext)({
    userId,
    companyId: "k57company1",
    membershipRole: "admin",
    isGm: false,
    sessionId: "rd7session1",
    via: "user",
  });
}

/** Dispatches an envelope against B2's handlers with the fake store. */
async function dispatch(
  db: FakeLinkingDb,
  envelope: unknown,
  actorUserId = "k57user1",
): Promise<ResultEnvelope> {
  const handlers = linkingHandlers(() => fakeLinkingTx(db));
  return await dispatchCommand(
    {
      // The dispatch test injects the resolved context directly: the real
      // resolveContext (live session -> membership chain) is B1's, already
      // pinned by tests/b1; this seam isolates the B2 handler contract.
      resolveContext: async () => ({
        actor: actorContext(actorUserId),
        resolvedAtMs: NOW,
      }),
      policy: {
        policyId: "test.permissive",
        authorize: async () => ({ allowed: true as const }),
      },
      handlers,
    },
    {} as MutationCtx,
    envelope,
  );
}

function envelope(operation: string, input: unknown): unknown {
  return { operation, input, expectedRevisions: [] };
}

describe("access.linkVerifiedMethod through the checked dispatch", () => {
  function googlePersonDb(): FakeLinkingDb {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser({ googleSubject: "g-sub-1" }));
    db.authAccounts.push({ id: "xs7acc1", userId: "k57user1", provider: "google", providerAccountId: "g-sub-1" });
    return db;
  }

  it("confirms the email-direction link AFTER the identity-layer commit (verifiedIdentity names the ceremony)", async () => {
    const db = googlePersonDb();
    const tx = fakeLinkingTx(db);
    const begun = await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "email_code", nowMs: NOW });
    if (!begun.ok) {
      throw new Error("fixture: begin failed");
    }
    await recordGoogleProofCore(tx, {
      userId: "k57user1",
      profile: { sub: "g-sub-1", email: EMAIL },
      nowMs: NOW,
    });
    const staged = await stageProofCodeCore(tx, { actorUserId: "k57user1", nowMs: NOW });
    if (!staged.ok) {
      throw new Error("fixture: staging failed");
    }
    // The WRITE path is the identity layer (verifyProofCode commits).
    const committed = await verifyProofCodeCore(tx, {
      actorUserId: "k57user1",
      code: staged.value.code,
      nowMs: NOW + 1000,
    });
    expect(committed).toEqual({ ok: true, value: { leg: "target_proof", linked: true } });

    // The typed operation is the read-only confirmation of that commit.
    const result = await dispatch(db, envelope("access.linkVerifiedMethod", {
      userId: "k57user1",
      method: "email_code",
      verifiedIdentity: begun.value.attemptId,
    }));
    expect(result).toEqual({ _tag: "ok", value: { linked: "linked" } });
    expect(db.authAccounts.some((row) => row.provider === "email_code")).toBe(true);
  });

  it("is READ-ONLY mid-ceremony: a typed conflict consumes no staged code", async () => {
    const db = googlePersonDb();
    const tx = fakeLinkingTx(db);
    const begun = await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "email_code", nowMs: NOW });
    if (!begun.ok) {
      throw new Error("fixture: begin failed");
    }
    await recordGoogleProofCore(tx, {
      userId: "k57user1",
      profile: { sub: "g-sub-1", email: EMAIL },
      nowMs: NOW,
    });
    const staged = await stageProofCodeCore(tx, { actorUserId: "k57user1", nowMs: NOW });
    if (!staged.ok) {
      throw new Error("fixture: staging failed");
    }

    // One typed error must never follow a write (review finding 2): the
    // confirmation refuses proofs-incomplete WITHOUT consuming the code…
    const result = await dispatch(db, envelope("access.linkVerifiedMethod", {
      userId: "k57user1",
      method: "email_code",
      verifiedIdentity: begun.value.attemptId,
    }));
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("conflict");
      expect(result.error.code).toBe("link_proofs_incomplete");
    }
    // …so the SAME code still commits through the identity layer.
    const committed = await verifyProofCodeCore(tx, {
      actorUserId: "k57user1",
      code: staged.value.code,
      nowMs: NOW + 1000,
    });
    expect(committed).toEqual({ ok: true, value: { leg: "target_proof", linked: true } });
  });

  it("fails forbidden for another user id (self-service scope)", async () => {
    const db = googlePersonDb();
    const result = await dispatch(
      db,
      envelope("access.linkVerifiedMethod", {
        userId: "k57user2",
        method: "email_code",
        verifiedIdentity: "31415926",
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("forbidden");
      expect(result.error.code).toBe("not_own_account");
    }
  });

  it("fails validation for input the contract schema rejects", async () => {
    const db = googlePersonDb();
    const result = await dispatch(
      db,
      envelope("access.linkVerifiedMethod", { userId: "k57user1", method: "password" }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
    }
  });

  it("fails conflict when the referenced ceremony does not exist", async () => {
    const db = googlePersonDb();
    const result = await dispatch(
      db,
      envelope("access.linkVerifiedMethod", {
        userId: "k57user1",
        method: "email_code",
        verifiedIdentity: "rd7attempt404",
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("conflict");
      expect(result.error.code).toBe("link_ceremony_mismatch");
    }
  });

  it("confirms an already-committed google-direction ceremony idempotently", async () => {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser({ googleSubject: "g-sub-1" }));
    db.attempts.set("rd7attempt1", {
      id: "rd7attempt1",
      userId: "k57user1",
      email: EMAIL,
      initiatingMethod: "email_code",
      targetMethod: "google",
      state: "committed",
      startedAtMs: NOW,
      expiresAtMs: NOW + 60_000,
      firstProofAtMs: NOW,
      pendingCodeHash: null,
      pendingCodeExpiresAtMs: null,
      committedAtMs: NOW + 1000,
      googleSub: "g-sub-1",
      rejectedAtMs: null,
      rejectionCode: null,
    });
    const result = await dispatch(
      db,
      envelope("access.linkVerifiedMethod", {
        userId: "k57user1",
        method: "google",
        verifiedIdentity: "rd7attempt1",
      }),
    );
    expect(result).toEqual({ _tag: "ok", value: { linked: "linked" } });
  });

  it("stays fail-closed for unknown operations", async () => {
    const db = googlePersonDb();
    const result = await dispatch(db, envelope("access.recoverAccount", { userId: "k57user1" }));
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      // The recovery command is DEFINED (operations.ts) but not in the
      // composed contracts registry: dispatch fails closed until B4 wires
      // the invoker — exactly the issue's "invoker unavailable" rule.
      expect(result.error._tag).toBe("unsupported");
      expect(result.error.code).toBe("unknown_operation");
    }
  });
});
