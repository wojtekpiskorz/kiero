/**
 * B4 focused verification (2/3): the transactional cores over the
 * in-memory fake store — grant lifecycle, the audit row landing with every
 * action (ok AND denied outcomes), alpha-participation gating, onboarding,
 * administrator restoration and the recovery invocation resolving the REAL
 * GM actor into B2's ledger.
 *
 * True transactionality is Convex's; what MUST hold structurally is pinned
 * here: each core writes its effect row(s) and its audit row in the SAME
 * call over the SAME store, so a throwing store leaves neither (the fake
 * records inserts verbatim and the counts are exact).
 */

import { describe, expect, it } from "vitest";
import { errorResult, okResult, parseTableId } from "@kiero/contracts";
import { conflictError } from "@kiero/runtime";
import { recoverAccountCore } from "../../convex/access/linking/recovery";
import { fakeDb, fakeLinkingTx, fakeUser } from "../b2/fake";
import {
  performEnterGmMode,
  performExitGmMode,
  performGmActivateCompany,
  performGmEndCompanyAlpha,
  performGmInspectCompany,
  performGmOnboardCompany,
  performGmRecoverAccount,
  performGmRestoreAdministrator,
  type GmAuthority,
} from "../../convex/access/gm/operations";
import { fakeGmCompany, fakeGmDb, fakeGmTx, fakeGmUser, seedJob, seedRun } from "./fake";

const GM_USER = "k57gmoper";
const REASON = "rozmowa z firmą o błędzie przetwarzania";

/** Non-null fixture ids (test data; parseTableId passes them through). */
function cid(id: string) {
  const parsed = parseTableId("companies", id);
  if (parsed === null) {
    throw new Error(`fixture company id rejected: ${id}`);
  }
  return parsed;
}
function uid(id: string) {
  const parsed = parseTableId("users", id);
  if (parsed === null) {
    throw new Error(`fixture user id rejected: ${id}`);
  }
  return parsed;
}

function seededWithOpenGrant(): { db: ReturnType<typeof fakeGmDb>; authority: GmAuthority } {
  const db = fakeGmDb();
  db.users.set(GM_USER, fakeGmUser());
  const grantId = `j97grant${db.grants.size + 1}`;
  db.grants.set(grantId, {
    id: grantId,
    userId: GM_USER,
    reason: REASON,
    enteredAtMs: 1_800_000_000_000,
    closedAtMs: null,
  });
  return { db, authority: { userId: GM_USER, grantId } };
}

function seededCompanyWithAlpha() {
  const { db, authority } = seededWithOpenGrant();
  db.companies.set("k57company1", fakeGmCompany());
  db.activations.push({
    id: "j97activation1",
    companyId: "k57company1",
    activatedByUserId: GM_USER,
    activatedAtMs: 1_800_000_000_000,
    endedAtMs: null,
    endedByUserId: null,
  });
  return { db, authority };
}

describe("GM mode entry and exit (the audited interval)", () => {
  it("opens one grant with an audit row carrying the stated reason", async () => {
    const db = fakeGmDb();
    db.users.set(GM_USER, fakeGmUser());
    const result = await performEnterGmMode(fakeGmTx(db), { userId: GM_USER, reason: REASON });
    expect(result._tag).toBe("ok");
    const grants = [...db.grants.values()];
    expect(grants).toHaveLength(1);
    expect(grants[0]!.closedAtMs).toBeNull();
    expect(grants[0]!.reason).toBe(REASON);
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      actorUserId: GM_USER,
      gmGrantId: grants[0]!.id,
      companyId: null,
      operationName: "access.enterGmMode",
      gmBasis: REASON,
      outcome: "ok",
    });
  });

  it("refuses a second entry while one grant is open (no hidden interval)", async () => {
    const { db } = seededWithOpenGrant();
    const result = await performEnterGmMode(fakeGmTx(db), { userId: GM_USER, reason: REASON });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error.code).toBe("gm_mode_already_active");
    }
    expect(db.grants.size).toBe(1);
    // The refused entry writes NO audit row: no authority existed for it.
    expect(db.audit).toHaveLength(0);
  });

  it("exit closes the actor's grant and audits; re-entry after exit opens a new interval", async () => {
    const { db, authority } = seededWithOpenGrant();
    const exited = await performExitGmMode(fakeGmTx(db), {
      userId: GM_USER,
      grantId: authority.grantId,
    });
    expect(exited._tag).toBe("ok");
    expect(db.grants.get(authority.grantId)!.closedAtMs).not.toBeNull();
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      operationName: "access.exitGmMode",
      gmGrantId: authority.grantId,
      outcome: "ok",
    });

    const reentered = await performEnterGmMode(fakeGmTx(db), { userId: GM_USER, reason: REASON });
    expect(reentered._tag).toBe("ok");
    expect(db.grants.size).toBe(2);
    expect([...db.grants.values()].filter((row) => row.closedAtMs === null)).toHaveLength(1);
  });

  it("exit refuses another operator's grant and an already-closed one", async () => {
    const { db, authority } = seededWithOpenGrant();
    db.users.set("k57other", fakeGmUser({ id: "k57other" }));
    const foreign = await performExitGmMode(fakeGmTx(db), {
      userId: "k57other",
      grantId: authority.grantId,
    });
    expect(foreign._tag).toBe("error");
    if (foreign._tag === "error") {
      expect(foreign.error.code).toBe("gm_not_own_grant");
    }
    const twice = await performExitGmMode(fakeGmTx(db), {
      userId: GM_USER,
      grantId: authority.grantId,
    });
    expect(twice._tag).toBe("ok");
    const closed = await performExitGmMode(fakeGmTx(db), {
      userId: GM_USER,
      grantId: authority.grantId,
    });
    expect(closed._tag).toBe("error");
    if (closed._tag === "error") {
      expect(closed.error.code).toBe("gm_grant_not_open");
    }
  });
});

describe("the audited inspection read", () => {
  it("returns company, alpha state, admin count, runs and jobs with an ok audit row", async () => {
    const { db, authority } = seededCompanyWithAlpha();
    db.memberships.push(
      { membershipId: "m1", companyId: "k57company1", userId: "u1", role: "admin", state: "active" },
      { membershipId: "m2", companyId: "k57company1", userId: "u2", role: "member", state: "active" },
      { membershipId: "m3", companyId: "k57company1", userId: "u3", role: "admin", state: "revoked" },
    );
    seedRun(db, "k57company1");
    seedJob(db, "k57company1");

    const result = await performGmInspectCompany(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      basis: "kontrola przebiegów",
    });
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      const value = result.value as {
        activeAdminCount: number;
        processingRuns: unknown[];
        durableJobs: unknown[];
        company: { name: string };
      };
      expect(value.activeAdminCount).toBe(1);
      expect(value.processingRuns).toHaveLength(1);
      expect(value.durableJobs).toHaveLength(1);
      expect(value.company.name).toBe("Budowa Kowalscy");
    }
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      operationName: "access.gmInspectCompany",
      companyId: "k57company1",
      gmBasis: "kontrola przebiegów",
      outcome: "ok",
    });
  });

  it("after the grant closed, inspection denies with an audited refusal", async () => {
    const { db, authority } = seededCompanyWithAlpha();
    db.grants.get(authority.grantId)!.closedAtMs = 1_800_000_000_100;
    const result = await performGmInspectCompany(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      basis: "kontrola",
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("forbidden");
      expect(result.error.code).toBe("gm_mode_not_active");
    }
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ outcome: "gm_mode_not_active" });
  });

  it("after alpha participation ended, inspection denies with no target data", async () => {
    const { db, authority } = seededCompanyWithAlpha();
    db.activations[0]!.endedAtMs = 1_800_000_000_100;
    const result = await performGmInspectCompany(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      basis: "kontrola",
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error.code).toBe("company_alpha_not_active");
    }
    expect(db.audit[0]).toMatchObject({ outcome: "company_alpha_not_active" });
  });
});

describe("alpha participation lifecycle", () => {
  it("onboarding creates firm + activation + first-admin invitation and audits once", async () => {
    const { db, authority } = seededWithOpenGrant();
    const outcome = await performGmOnboardCompany(fakeGmTx(db), authority, {
      name: "Budowa Nowa",
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
      adminEmail: "szef@budowanowa.pl",
      basis: "wdrożenie nowej firmy",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(db.companies.get(outcome.companyId)?.name).toBe("Budowa Nowa");
      expect(db.activations).toHaveLength(1);
      expect(db.invitations).toHaveLength(1);
      expect(db.invitations[0]!.role).toBe("admin");
      expect(db.invitations[0]!.issuedByUserId).toBe(GM_USER);
      // The stored credential is the hash; the plain code exists only in
      // the issuance closure for the delivery wrapper.
      expect(db.invitations[0]!.codeHash).not.toBe(outcome.code);
      expect(db.invitations[0]!.codeHash.length).toBeGreaterThan(0);
    }
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      operationName: "access.gmOnboardCompany",
      outcome: "ok",
      gmBasis: "wdrożenie nowej firmy",
    });
    // The GM gained no membership in the onboarded firm.
    expect(db.memberships).toHaveLength(0);
  });

  it("activation of an existing firm opens participation; double activation conflicts", async () => {
    const { db, authority } = seededWithOpenGrant();
    db.companies.set("k57company1", fakeGmCompany());
    const first = await performGmActivateCompany(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      basis: "wsparcie alfa",
    });
    expect(first._tag).toBe("ok");
    const second = await performGmActivateCompany(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      basis: "wsparcie alfa",
    });
    expect(second._tag).toBe("error");
    if (second._tag === "error") {
      expect(second.error.code).toBe("company_alpha_already_active");
    }
    expect(db.activations).toHaveLength(1);
    expect(db.audit.map((row) => row.outcome)).toEqual(["ok", "company_alpha_already_active"]);
  });

  it("ending participation closes the activation and keeps history; re-activation opens a new row", async () => {
    const { db, authority } = seededCompanyWithAlpha();
    const ended = await performGmEndCompanyAlpha(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      basis: "firma kończy testy",
    });
    expect(ended._tag).toBe("ok");
    expect(db.activations[0]!.endedAtMs).not.toBeNull();
    expect(db.activations[0]!.endedByUserId).toBe(GM_USER);
    // Membership/history untouched: ending alpha is not membership revocation.
    expect(db.companies.size).toBe(1);

    const again = await performGmActivateCompany(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      basis: "firma wraca do testów",
    });
    expect(again._tag).toBe("ok");
    expect(db.activations).toHaveLength(2);
    expect(db.activations.filter((row) => row.endedAtMs === null)).toHaveLength(1);
  });
});

describe("administrator restoration", () => {
  it("promotes an active member under GM authority, audited", async () => {
    const { db, authority } = seededCompanyWithAlpha();
    db.memberships.push({
      membershipId: "m2",
      companyId: "k57company1",
      userId: "u2",
      role: "member",
      state: "active",
    });
    const result = await performGmRestoreAdministrator(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      userId: uid("u2"),
      basis: "utrata dostępu administratora",
    });
    expect(result._tag).toBe("ok");
    expect(db.memberships[0]!.role).toBe("admin");
    expect(db.audit[0]).toMatchObject({
      operationName: "access.gmRestoreAdministrator",
      outcome: "ok",
    });
  });

  it("refuses a person who is not an active member, audited", async () => {
    const { db, authority } = seededCompanyWithAlpha();
    db.memberships.push({
      membershipId: "m3",
      companyId: "k57company1",
      userId: "u3",
      role: "member",
      state: "revoked",
    });
    const result = await performGmRestoreAdministrator(fakeGmTx(db), authority, {
      companyId: cid("k57company1"),
      userId: uid("u3"),
      basis: "próba",
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error.code).toBe("target_membership_not_found");
    }
    expect(db.audit[0]).toMatchObject({ outcome: "target_membership_not_found" });
  });
});

describe("the recovery invocation resolves the GM actor", () => {
  it("runs B2's real core with the GM operator as performedBy, auditing in the same call", async () => {
    const { db, authority } = seededWithOpenGrant();
    const linking = fakeDb();
    linking.users.set(
      "k57target",
      fakeUser({ id: "k57target", email: "szef@kiero.invalid", googleSubject: "google-sub-1" }),
    );
    // The GM-side store also knows the target account (the invocation
    // resolves it before B2's core runs).
    db.users.set(
      "k57target",
      fakeGmUser({ id: "k57target", email: "szef@kiero.invalid" }),
    );
    linking.registrySessions.push({ id: "s1", userId: "k57target", revokedAtMs: null });
    linking.authSessions.push({ id: "s1", userId: "k57target" });

    const result = await performGmRecoverAccount(
      fakeGmTx(db),
      authority,
      { userId: uid("k57target"), verificationBasis: "weryfikacja przez telefon" },
      (input, performedBy) =>
        recoverAccountCore(fakeLinkingTx(linking), {
          targetUserId: input.userId,
          verificationBasis: input.verificationBasis,
          performedBy,
          nowMs: 1_800_000_100_000,
        }).then((outcome) =>
          outcome.state === "rejected"
            ? errorResult(conflictError("account_not_found", "users", input.userId))
            : okResult({
                recoveredAtMs: outcome.recoveredAtMs,
                revokedSessions: outcome.revokedSessionIds.length,
                clearedAccounts: outcome.clearedAccountIds.length,
                clearedGoogleSubject: outcome.clearedGoogleSubject,
              }),
        ),
    );
    expect(result._tag).toBe("ok");
    // The B2 ledger names the REAL GM actor — not a placeholder.
    expect(linking.recoveries).toHaveLength(1);
    expect(linking.recoveries[0]!.performedBy).toBe(GM_USER);
    expect(linking.recoveries[0]!.verificationBasis).toBe("weryfikacja przez telefon");
    // The target's sessions died.
    expect(linking.registrySessions[0]!.revokedAtMs).not.toBeNull();
    // The GM audit row landed in the same call.
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      operationName: "access.recoverAccount",
      outcome: "ok",
      gmBasis: "weryfikacja przez telefon",
    });
  });

  it("refuses a missing account with an audited not_found and no recovery row", async () => {
    const { db, authority } = seededWithOpenGrant();
    const linking = fakeDb();
    const result = await performGmRecoverAccount(
      fakeGmTx(db),
      authority,
      { userId: uid("k57ghost"), verificationBasis: "weryfikacja" },
      async () => okResult({}),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("not_found");
      expect(result.error.code).toBe("account_not_found");
    }
    expect(linking.recoveries).toHaveLength(0);
    expect(db.audit[0]).toMatchObject({ outcome: "account_not_found" });
  });

  it("after the grant closed, the recovery invocation denies before B2's core runs", async () => {
    const { db, authority } = seededWithOpenGrant();
    db.grants.get(authority.grantId)!.closedAtMs = 1_800_000_000_100;
    let coreRan = false;
    const result = await performGmRecoverAccount(
      fakeGmTx(db),
      authority,
      { userId: uid("k57target"), verificationBasis: "weryfikacja" },
      async () => {
        coreRan = true;
        return okResult({});
      },
    );
    expect(result._tag).toBe("error");
    expect(coreRan).toBe(false);
    expect(db.audit[0]).toMatchObject({ outcome: "gm_mode_not_active" });
  });
});
