/**
 * B2 focused verification: the ceremony, email-change, session-recovery
 * and manual-recovery cores over the in-memory fake (./fake.ts).
 *
 * These pin the issue's focused checks without a deployment:
 * - a link requires BOTH fresh proofs (either leg missing → typed
 *   rejection, NO partial writes);
 * - opposite-direction races leave one canonical result (the loser of a
 *   double commit sees the committed state and returns a typed rejection);
 * - mismatched address / stale proof / two established accounts reject
 *   with typed codes and write nothing;
 * - email change needs recent authentication + the code from the NEW
 *   address, and a failed confirmation changes nothing;
 * - recovery revokes every session (both layers), clears methods, keeps
 *   the account row (stable actor ids) and records the verification basis;
 * - after recovery (the only unlink path), a fresh ceremony links again.
 */

import { describe, expect, it } from "vitest";
import { LINKING_WINDOW_MS } from "../../convex/access/linking/policy";
import {
  beginLinkingCore,
  cancelLinkingCore,
  googleLinkFromCallbackCore,
  linkingStatusCore,
  recordGoogleProofCore,
  stageProofCodeCore,
  verifyProofCodeCore,
} from "../../convex/access/linking/ceremony";
import { confirmEmailChangeCore, stageEmailChangeCore } from "../../convex/access/linking/emailChange";
import { revokeOtherSessionsCore } from "../../convex/access/linking/sessionControls";
import { recoverAccountCore } from "../../convex/access/linking/recovery";
import { fakeAttempt, fakeDb, fakeLinkingTx, fakeUser, type FakeLinkingDb } from "./fake";

const NOW = 1_800_000_000_000;
const EMAIL = "szef@kiero.invalid";
const NEW_EMAIL = "nowy@kiero.invalid";

describe("email person adds Google (both proofs, atomic commit)", () => {
  function seeded(): FakeLinkingDb {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser());
    db.authAccounts.push({ id: "xs7acc1", userId: "k57user1", provider: "email_code", providerAccountId: EMAIL });
    return db;
  }

  it("runs the full ceremony: begin, code first proof, OAuth commit", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);

    const begun = await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });
    expect(begun).toEqual({ ok: true, value: { attemptId: "rd7attempt1" } });
    expect(db.attempts.get("rd7attempt1")?.initiatingMethod).toBe("email_code");

    const staged = await stageProofCodeCore(tx, { actorUserId: "k57user1", nowMs: NOW + 1000 });
    expect(staged.ok).toBe(true);
    if (staged.ok) {
      expect(staged.value.leg).toBe("first_proof");
      expect(staged.value.email).toBe(EMAIL);
    }

    const verified = await verifyProofCodeCore(tx, {
      actorUserId: "k57user1",
      code: staged.ok ? staged.value.code : "",
      nowMs: NOW + 2000,
    });
    expect(verified).toEqual({ ok: true, value: { leg: "first_proof", linked: false } });

    const link = await googleLinkFromCallbackCore(tx, {
      rawProfile: { sub: "g-sub-1", email: EMAIL, email_verified: true, hd: "kiero.invalid" },
      usersWithEmail: [{ id: "k57user1", email: EMAIL, googleSubject: null }],
      nowMs: NOW + 3000,
    });
    expect(link).toEqual({ committed: true, userId: "k57user1" });
    expect(db.users.get("k57user1")?.googleSubject).toBe("g-sub-1");
    expect(db.attempts.get("rd7attempt1")?.state).toBe("committed");
    expect(db.attempts.get("rd7attempt1")?.googleSub).toBe("g-sub-1");
  });

  it("rejects the OAuth proof when the first proof is missing (no partial writes)", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });

    const link = await googleLinkFromCallbackCore(tx, {
      rawProfile: { sub: "g-sub-1", email: EMAIL, email_verified: true, hd: "kiero.invalid" },
      usersWithEmail: [{ id: "k57user1", email: EMAIL, googleSubject: null }],
      nowMs: NOW + 1000,
    });
    expect(link).toEqual({ committed: false, reason: "no_active_ceremony" });
    expect(db.users.get("k57user1")?.googleSubject).toBeNull();
    expect(db.attempts.get("rd7attempt1")?.state).toBe("awaiting_first_proof");
  });

  it("rejects the OAuth proof when the first proof went stale", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });
    const row = db.attempts.get("rd7attempt1");
    if (row === undefined) {
      throw new Error("fixture: no attempt");
    }
    row.state = "awaiting_target_proof";
    row.firstProofAtMs = NOW - LINKING_WINDOW_MS - 1;

    const link = await googleLinkFromCallbackCore(tx, {
      rawProfile: { sub: "g-sub-1", email: EMAIL, email_verified: true, hd: "kiero.invalid" },
      usersWithEmail: [{ id: "k57user1", email: EMAIL, googleSubject: null }],
      nowMs: NOW,
    });
    expect(link).toEqual({ committed: false, reason: "proof_stale" });
    expect(db.users.get("k57user1")?.googleSubject).toBeNull();
  });

  it("rejects a mismatched address with no partial writes", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });
    const row = db.attempts.get("rd7attempt1");
    if (row !== undefined) {
      row.state = "awaiting_target_proof";
      row.firstProofAtMs = NOW;
    }

    const link = await googleLinkFromCallbackCore(tx, {
      rawProfile: { sub: "g-sub-1", email: "inny@kiero.invalid", email_verified: true, hd: "inny.invalid" },
      usersWithEmail: [{ id: "k57user2", email: "inny@kiero.invalid", googleSubject: null }],
      nowMs: NOW,
    });
    expect(link).toEqual({ committed: false, reason: "no_active_ceremony" });
    expect(db.users.get("k57user1")?.googleSubject).toBeNull();
  });

  it("second commit of the same ceremony is refused (exactly-once)", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });
    const row = db.attempts.get("rd7attempt1");
    if (row !== undefined) {
      row.state = "awaiting_target_proof";
      row.firstProofAtMs = NOW;
    }
    const profile = { sub: "g-sub-1", email: EMAIL, email_verified: true, hd: "kiero.invalid" };
    const usersWithEmail = [{ id: "k57user1", email: EMAIL, googleSubject: null }];
    const first = await googleLinkFromCallbackCore(tx, { rawProfile: profile, usersWithEmail, nowMs: NOW });
    expect(first).toEqual({ committed: true, userId: "k57user1" });

    // The retried transaction observes the committed state and refuses
    // with a typed code (the subject now belongs to the linked account):
    // exactly one commit, no duplicate rows or writes.
    const second = await googleLinkFromCallbackCore(tx, { rawProfile: profile, usersWithEmail, nowMs: NOW });
    expect(second.committed).toBe(false);
    if (!second.committed) {
      expect(
        ["target_account_established", "method_already_attached", "no_active_ceremony"],
      ).toContain(second.reason);
    }
    expect(db.users.get("k57user1")?.googleSubject).toBe("g-sub-1");
    expect([...db.attempts.values()].filter((row) => row.state === "committed")).toHaveLength(1);
  });
});

describe("google person adds email-code (both proofs, atomic commit)", () => {
  function seeded(): FakeLinkingDb {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser({ googleSubject: "g-sub-1" }));
    db.authAccounts.push({ id: "xs7acc1", userId: "k57user1", provider: "google", providerAccountId: "g-sub-1" });
    return db;
  }

  it("records the fresh Google proof on OAuth resume, then commits via the emailed code", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);

    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "email_code", nowMs: NOW });
    expect(db.attempts.get("rd7attempt1")?.initiatingMethod).toBe("google");

    await recordGoogleProofCore(tx, {
      userId: "k57user1",
      profile: { sub: "g-sub-1", email: EMAIL },
      nowMs: NOW + 1000,
    });
    expect(db.attempts.get("rd7attempt1")?.state).toBe("awaiting_target_proof");
    expect(db.attempts.get("rd7attempt1")?.firstProofAtMs).toBe(NOW + 1000);

    const staged = await stageProofCodeCore(tx, { actorUserId: "k57user1", nowMs: NOW + 2000 });
    expect(staged.ok && staged.value.leg).toBe("target_proof");
    const confirmed = await verifyProofCodeCore(tx, {
      actorUserId: "k57user1",
      code: staged.ok ? staged.value.code : "",
      nowMs: NOW + 3000,
    });
    expect(confirmed).toEqual({ ok: true, value: { leg: "target_proof", linked: true } });

    // One account, both methods: the email-code credential now exists.
    expect(
      db.authAccounts.find((row) => row.provider === "email_code")?.userId,
    ).toBe("k57user1");
    expect(db.users.get("k57user1")?.emailVerificationTime).toBe(NOW + 3000);
    expect(db.attempts.get("rd7attempt1")?.state).toBe("committed");
  });

  it("does not advance on an OAuth resume of a DIFFERENT Google account", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "email_code", nowMs: NOW });
    await recordGoogleProofCore(tx, {
      userId: "k57user1",
      profile: { sub: "g-sub-INNY", email: EMAIL },
      nowMs: NOW,
    });
    expect(db.attempts.get("rd7attempt1")?.state).toBe("awaiting_first_proof");
  });

  it("refuses the whole ceremony when the address's email credential belongs to another established account", async () => {
    const db = seeded();
    db.users.set("k57user2", fakeUser({ id: "k57user2", email: EMAIL }));
    db.authAccounts.push({ id: "xs7acc2", userId: "k57user2", provider: "email_code", providerAccountId: EMAIL });
    const tx = fakeLinkingTx(db);

    // Two established accounts (the google person and the email person at
    // one address): the ceremony refuses to open with the typed code, and
    // NOTHING is written (no merge without a supported resolution).
    const begun = await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "email_code", nowMs: NOW });
    expect(begun).toEqual({ ok: false, code: "target_account_established" });
    expect(db.attempts.size).toBe(0);
    expect(db.authAccounts.filter((row) => row.provider === "email_code")).toHaveLength(1);
    expect(
      db.authAccounts.find((row) => row.provider === "email_code")?.userId,
    ).toBe("k57user2");
  });
});

describe("begin serialization and cancellation", () => {
  it("refuses a second ceremony for the same address while one is active", async () => {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser());
    db.users.set("k57user2", fakeUser({ id: "k57user2" }));
    const tx = fakeLinkingTx(db);
    const first = await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });
    expect(first.ok).toBe(true);
    const second = await beginLinkingCore(tx, { actorUserId: "k57user2", targetMethod: "google", nowMs: NOW });
    expect(second).toEqual({ ok: false, code: "ceremony_in_progress" });
  });

  it("cancel rejects the ceremony and frees the address", async () => {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser());
    const tx = fakeLinkingTx(db);
    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });
    expect(await cancelLinkingCore(tx, { actorUserId: "k57user1", nowMs: NOW })).toEqual({ cancelled: true });
    expect(db.attempts.get("rd7attempt1")?.state).toBe("rejected");
    const again = await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW + 1 });
    expect(again.ok).toBe(true);
  });

  it("wrong codes never advance the ceremony", async () => {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser());
    const tx = fakeLinkingTx(db);
    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });
    await stageProofCodeCore(tx, { actorUserId: "k57user1", nowMs: NOW });
    const wrong = await verifyProofCodeCore(tx, { actorUserId: "k57user1", code: "00000000", nowMs: NOW });
    expect(wrong).toEqual({ ok: false, code: "code_wrong_or_expired" });
    expect(db.attempts.get("rd7attempt1")?.state).toBe("awaiting_first_proof");
  });
});

describe("email change", () => {
  function seeded(): FakeLinkingDb {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser());
    db.authAccounts.push({ id: "xs7acc1", userId: "k57user1", provider: "email_code", providerAccountId: EMAIL });
    return db;
  }

  it("requires a recently started session to request", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    const stale = await stageEmailChangeCore(tx, {
      actorUserId: "k57user1",
      newEmail: NEW_EMAIL,
      sessionStartedAtMs: NOW - 16 * 60 * 1000,
      nowMs: NOW,
    });
    expect(stale).toEqual({ ok: false, code: "proof_stale" });
    expect(db.emailChanges.size).toBe(0);
  });

  it("moves the address and repoints the credential atomically on confirm", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    const staged = await stageEmailChangeCore(tx, {
      actorUserId: "k57user1",
      newEmail: NEW_EMAIL,
      sessionStartedAtMs: NOW,
      nowMs: NOW,
    });
    expect(staged.ok).toBe(true);
    const confirmed = await confirmEmailChangeCore(tx, {
      actorUserId: "k57user1",
      code: staged.ok ? staged.value.code : "",
      nowMs: NOW + 1000,
    });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.value.newEmail).toBe(NEW_EMAIL);
    }
    expect(db.users.get("k57user1")?.email).toBe(NEW_EMAIL);
    expect(
      db.authAccounts.find((row) => row.provider === "email_code")?.providerAccountId,
    ).toBe(NEW_EMAIL);
    // The old address no longer owns the credential: a sign-in code for it
    // would create a separate fresh person (B1's policy), not resume this one.
  });

  it("a failed confirmation leaves the old method and state unchanged", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    await stageEmailChangeCore(tx, {
      actorUserId: "k57user1",
      newEmail: NEW_EMAIL,
      sessionStartedAtMs: NOW,
      nowMs: NOW,
    });
    const failed = await confirmEmailChangeCore(tx, { actorUserId: "k57user1", code: "00000000", nowMs: NOW + 1000 });
    expect(failed).toEqual({ ok: false, code: "code_wrong_or_expired" });
    expect(db.users.get("k57user1")?.email).toBe(EMAIL);
    expect(
      db.authAccounts.find((row) => row.provider === "email_code")?.providerAccountId,
    ).toBe(EMAIL);
    const request = [...db.emailChanges.values()][0];
    expect(request?.confirmedAtMs).toBeNull();
  });

  it("rejects pending ceremonies when the address moves", async () => {
    const db = seeded();
    const tx = fakeLinkingTx(db);
    await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW });
    const staged = await stageEmailChangeCore(tx, {
      actorUserId: "k57user1",
      newEmail: NEW_EMAIL,
      sessionStartedAtMs: NOW,
      nowMs: NOW,
    });
    await confirmEmailChangeCore(tx, {
      actorUserId: "k57user1",
      code: staged.ok ? staged.value.code : "",
      nowMs: NOW + 1000,
    });
    expect(db.attempts.get("rd7attempt1")?.state).toBe("rejected");
    expect(db.attempts.get("rd7attempt1")?.rejectionCode).toBe("email_changed");
  });
});

describe("session recovery", () => {
  it("revokes every OTHER device through the canonical B1 core", async () => {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser());
    db.registrySessions = [
      { id: "rd7current", userId: "k57user1", revokedAtMs: null },
      { id: "rd7phone", userId: "k57user1", revokedAtMs: null },
      { id: "rd7laptop", userId: "k57user1", revokedAtMs: null },
      { id: "rd7old", userId: "k57user1", revokedAtMs: NOW - 5 },
    ];
    const tx = fakeLinkingTx(db);
    const outcome = await revokeOtherSessionsCore(tx, {
      actorUserId: "k57user1",
      currentSessionId: "rd7current",
      nowMs: NOW,
      companyIdForEvent: "k57company1",
    });
    expect(outcome.revokedCount).toBe(2);
    expect(db.registrySessions.find((row) => row.id === "rd7current")?.revokedAtMs).toBeNull();
    expect(db.registrySessions.find((row) => row.id === "rd7phone")?.revokedAtMs).toBe(NOW);
    expect(db.publishedRevocations).toHaveLength(2);
  });
});

describe("manual recovery (the only unlink path) and relink", () => {
  function linkedAccount(): FakeLinkingDb {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser({ googleSubject: "g-sub-1", emailVerificationTime: NOW - 1000 }));
    db.authAccounts.push(
      { id: "xs7acc1", userId: "k57user1", provider: "email_code", providerAccountId: EMAIL },
      { id: "xs7acc2", userId: "k57user1", provider: "google", providerAccountId: "g-sub-1" },
    );
    db.registrySessions = [
      { id: "rd7s1", userId: "k57user1", revokedAtMs: null },
      { id: "rd7s2", userId: "k57user1", revokedAtMs: null },
    ];
    db.authSessions = [
      { id: "js7a1", userId: "k57user1" },
      { id: "js7a2", userId: "k57user1" },
    ];
    db.refreshTokens = [
      { id: "rt7t1", sessionId: "js7a1" },
      { id: "rt7t2", sessionId: "js7a2" },
    ];
    db.attempts.set(
      "rd7attempt1",
      fakeAttempt({ state: "awaiting_target_proof", firstProofAtMs: NOW - 1000 }),
    );
    return db;
  }

  it("revokes every session on both layers, clears methods, keeps the account row and records the basis", async () => {
    const db = linkedAccount();
    const tx = fakeLinkingTx(db);
    const outcome = await recoverAccountCore(tx, {
      targetUserId: "k57user1",
      verificationBasis: "weryfikacja przez obsłużę: telefon + dokument",
      performedBy: "dev-proof",
      nowMs: NOW,
    });
    expect(outcome.state).toBe("recovered");
    if (outcome.state !== "recovered") {
      return;
    }
    expect(outcome.revokedSessionIds).toEqual(["rd7s1", "rd7s2"]);
    expect(outcome.clearedAccountIds).toEqual(["xs7acc1", "xs7acc2"]);
    expect(outcome.clearedGoogleSubject).toBe(true);

    // Both session layers are gone: registry revoked, upstream deleted
    // with refresh tokens — no pre-recovery token survives either check.
    expect(db.registrySessions.every((row) => row.revokedAtMs === NOW)).toBe(true);
    expect(db.authSessions).toHaveLength(0);
    expect(db.refreshTokens).toHaveLength(0);

    // The account row survives with stable id; methods are cleared and a
    // fresh setup is required (no credentials remain).
    expect(db.users.get("k57user1")?.googleSubject).toBeNull();
    expect(db.authAccounts).toHaveLength(0);
    expect(db.attempts.get("rd7attempt1")?.state).toBe("rejected");

    expect(db.recoveries).toEqual([
      {
        userId: "k57user1",
        verificationBasis: "weryfikacja przez obsłużę: telefon + dokument",
        performedBy: "dev-proof",
        performedAtMs: NOW,
        revokedSessionIds: ["rd7s1", "rd7s2"],
        clearedAccountIds: ["xs7acc1", "xs7acc2"],
        clearedGoogleSubject: true,
      },
    ]);
  });

  it("refuses an unknown account", async () => {
    const tx = fakeLinkingTx(fakeDb());
    const outcome = await recoverAccountCore(tx, {
      targetUserId: "k57ghost",
      verificationBasis: "basis",
      performedBy: "dev-proof",
      nowMs: NOW,
    });
    expect(outcome).toEqual({ state: "rejected", reason: "no_such_account" });
  });

  it("a fresh ceremony links again after recovery (relink semantics)", async () => {
    const db = linkedAccount();
    const tx = fakeLinkingTx(db);
    await recoverAccountCore(tx, {
      targetUserId: "k57user1",
      verificationBasis: "weryfikacja",
      performedBy: "dev-proof",
      nowMs: NOW,
    });

    // Fresh email-code sign-in at the address resumes the SAME person row
    // (B1's orphan-resume path: googleSubject cleared, credential gone).
    db.authAccounts.push({ id: "xs7acc3", userId: "k57user1", provider: "email_code", providerAccountId: EMAIL });
    const begun = await beginLinkingCore(tx, { actorUserId: "k57user1", targetMethod: "google", nowMs: NOW + 60_000 });
    expect(begun.ok).toBe(true);

    const staged = await stageProofCodeCore(tx, { actorUserId: "k57user1", nowMs: NOW + 61_000 });
    const verified = await verifyProofCodeCore(tx, {
      actorUserId: "k57user1",
      code: staged.ok ? staged.value.code : "",
      nowMs: NOW + 62_000,
    });
    expect(verified.ok).toBe(true);
    const relink = await googleLinkFromCallbackCore(tx, {
      rawProfile: { sub: "g-sub-1", email: EMAIL, email_verified: true, hd: "kiero.invalid" },
      usersWithEmail: [{ id: "k57user1", email: EMAIL, googleSubject: null }],
      nowMs: NOW + 63_000,
    });
    expect(relink).toEqual({ committed: true, userId: "k57user1" });
    expect(db.users.get("k57user1")?.googleSubject).toBe("g-sub-1");
  });
});

describe("linking status view", () => {
  it("reports both methods and the ceremony's next leg", async () => {
    const db = fakeDb();
    db.users.set("k57user1", fakeUser({ googleSubject: "g-sub-1" }));
    db.attempts.set(
      "rd7attempt1",
      fakeAttempt({ initiatingMethod: "google", targetMethod: "email_code", state: "awaiting_first_proof" }),
    );
    const view = await linkingStatusCore(fakeLinkingTx(db), { userId: "k57user1", nowMs: NOW });
    expect(view?.googleLinked).toBe(true);
    expect(view?.emailCodeLinked).toBe(false);
    expect(view?.activeAttempt?.nextLeg).toBe("google_oauth");
  });
});
