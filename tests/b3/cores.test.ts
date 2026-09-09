/**
 * B3 focused verification: the pure membership cores.
 *
 * The decision boundaries the issue names, without a deployment:
 * invitation admission (target address, expiry edge, revocation, use
 * count, code, the one-active-company rule), the v1 active-firm rule, the
 * last-admin invariant, role-change classification, administration
 * transfer and the issuance input validators.
 */

import { describe, expect, it } from "vitest";
import { parseTableId } from "@kiero/contracts";
import {
  INVITATION_CODE_LENGTH,
  INVITATION_TTL_MS,
  activeAdministrators,
  admissionErrorKind,
  classifyRoleChange,
  decideAdministrationTransfer,
  decideInvitationAdmission,
  decideLastAdminChange,
  earliestActiveMembership,
  generateInvitationCode,
  normalizeInvitationCode,
  validateCompanyName,
  validateInvitationEmail,
  validateTimezone,
  type InvitationView,
  type InviteeView,
  type MembershipViewWithTime,
} from "../../convex/access/membership/cores";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const COMPANY = parseTableId("companies", "k57company00000000000000")!;
const COMPANY_B = parseTableId("companies", "k57companyb00000000000z")!;
const USER_A = parseTableId("users", "k57usera0000000000000000")!;
const USER_B = parseTableId("users", "k57userb0000000000000000")!;
const MEMBERSHIP_1 = parseTableId("memberships", "k57member10000000000000")!;
const MEMBERSHIP_2 = parseTableId("memberships", "k57member20000000000000")!;

function invitation(overrides: Partial<InvitationView> = {}): InvitationView {
  return {
    state: "pending",
    email: "szef@firma.pl",
    role: "member",
    companyId: COMPANY,
    codeHash: "hash-of-code",
    expiresAtMs: NOW + INVITATION_TTL_MS,
    ...overrides,
  };
}

function invitee(overrides: Partial<InviteeView> = {}): InviteeView {
  return {
    email: "szef@firma.pl",
    hasGoogleSubject: false,
    emailVerifiedMs: null,
    activeMembership: null,
    ...overrides,
  };
}

describe("decideInvitationAdmission (the atomic acceptance decision)", () => {
  it("admits a matching, pending, unexpired invitation with the right code for a firm-less person", () => {
    const decision = decideInvitationAdmission(
      invitation(),
      invitee(),
      "hash-of-code",
      NOW,
    );
    expect(decision).toEqual({
      ok: true,
      grant: { companyId: COMPANY, role: "member" },
    });
  });

  it("refuses an invitation addressed to a different address (no existence leak)", () => {
    const decision = decideInvitationAdmission(
      invitation(),
      invitee({ email: "ktos.inny@firma.pl" }),
      "hash-of-code",
      NOW,
    );
    expect(decision).toEqual({ ok: false, code: "invitation_not_addressed_to_actor" });
    expect(admissionErrorKind("invitation_not_addressed_to_actor")).toBe("not_found");
  });

  it("refuses a Google identity whose address was never verified (control unproven)", () => {
    const decision = decideInvitationAdmission(
      invitation(),
      invitee({ hasGoogleSubject: true, emailVerifiedMs: null }),
      "hash-of-code",
      NOW,
    );
    expect(decision).toEqual({ ok: false, code: "email_control_unproven" });
    expect(admissionErrorKind("email_control_unproven")).toBe("validation");
  });

  it("admits a Google identity whose address was verified", () => {
    const decision = decideInvitationAdmission(
      invitation(),
      invitee({ hasGoogleSubject: true, emailVerifiedMs: NOW - DAY }),
      "hash-of-code",
      NOW,
    );
    expect(decision.ok).toBe(true);
  });

  it("refuses every non-pending state (single use, revocation, rejection)", () => {
    for (const state of ["accepted", "revoked", "expired", "rejected"] as const) {
      const decision = decideInvitationAdmission(
        invitation({ state }),
        invitee(),
        "hash-of-code",
        NOW,
      );
      expect(decision).toEqual({ ok: false, code: "invitation_not_pending" });
    }
    expect(admissionErrorKind("invitation_not_pending")).toBe("conflict");
  });

  it("expiry is inclusive at the instant and refuses one millisecond later", () => {
    const atExpiry = decideInvitationAdmission(
      invitation({ expiresAtMs: NOW }),
      invitee(),
      "hash-of-code",
      NOW,
    );
    expect(atExpiry.ok).toBe(true);
    const beyond = decideInvitationAdmission(
      invitation({ expiresAtMs: NOW }),
      invitee(),
      "hash-of-code",
      NOW + 1,
    );
    expect(beyond).toEqual({ ok: false, code: "invitation_expired" });
    expect(admissionErrorKind("invitation_expired")).toBe("conflict");
  });

  it("refuses a mismatching code (single-use hashed code)", () => {
    const decision = decideInvitationAdmission(
      invitation(),
      invitee(),
      "hash-of-a-different-code",
      NOW,
    );
    expect(decision).toEqual({ ok: false, code: "verification_code_mismatch" });
    expect(admissionErrorKind("verification_code_mismatch")).toBe("validation");
  });

  it("refuses a person who already has an active firm (v1 one-active-company rule)", () => {
    const decision = decideInvitationAdmission(
      invitation(),
      invitee({ activeMembership: { companyId: COMPANY_B } }),
      "hash-of-code",
      NOW,
    );
    expect(decision).toEqual({ ok: false, code: "one_active_company_rule" });
    expect(admissionErrorKind("one_active_company_rule")).toBe("conflict");
  });

  it("checks the address before the code: a wrong-person code probe learns nothing", () => {
    const decision = decideInvitationAdmission(
      invitation(),
      invitee({ email: "ktos.inny@firma.pl" }),
      "totally-wrong",
      NOW,
    );
    expect(decision).toEqual({ ok: false, code: "invitation_not_addressed_to_actor" });
  });
});

describe("earliestActiveMembership (the v1 active-firm rule)", () => {
  function membership(
    id: ReturnType<typeof parseTableId<"memberships">>,
    overrides: Partial<MembershipViewWithTime> = {},
  ): MembershipViewWithTime {
    return {
      _id: id!,
      companyId: COMPANY,
      userId: USER_A,
      role: "member",
      state: "active",
      createdAtMs: NOW,
      ...overrides,
    };
  }

  it("returns null when every membership is revoked (leaving preserves history, not access)", () => {
    expect(
      earliestActiveMembership([
        membership(MEMBERSHIP_1, { state: "revoked" }),
        membership(MEMBERSHIP_2, { state: "revoked" }),
      ]),
    ).toBeNull();
  });

  it("picks the earliest active membership, ignoring later and revoked rows", () => {
    const earliest = membership(MEMBERSHIP_1, { createdAtMs: NOW - 5 * DAY });
    expect(
      earliestActiveMembership([
        membership(MEMBERSHIP_2, { createdAtMs: NOW }),
        earliest,
        membership(MEMBERSHIP_1, { state: "revoked", createdAtMs: NOW - 10 * DAY }),
      ]),
    ).toBe(earliest);
  });
});

describe("the last-admin invariant", () => {
  const admin = (id: ReturnType<typeof parseTableId<"memberships">>, userId: ReturnType<typeof parseTableId<"users">>) =>
    ({
      _id: id!,
      companyId: COMPANY,
      userId: userId!,
      role: "admin",
      state: "active",
      createdAtMs: NOW,
    }) as const;
  const member = (id: ReturnType<typeof parseTableId<"memberships">>, userId: ReturnType<typeof parseTableId<"users">>) =>
    ({
      _id: id!,
      companyId: COMPANY,
      userId: userId!,
      role: "member",
      state: "active",
      createdAtMs: NOW,
    }) as const;

  it("counts only active administrators", () => {
    const rows = [
      admin(MEMBERSHIP_1, USER_A),
      member(MEMBERSHIP_2, USER_B),
      { ...admin(MEMBERSHIP_2, USER_B), state: "revoked" as const },
    ];
    expect(activeAdministrators(rows)).toHaveLength(1);
  });

  it("blocks removing the final administrator (leave, revoke or demote)", () => {
    const only = admin(MEMBERSHIP_1, USER_A);
    expect(decideLastAdminChange(only, [only])).toEqual({
      allowed: false,
      code: "last_administrator",
    });
  });

  it("allows removing an administrator while another current boss holds administration", () => {
    const first = admin(MEMBERSHIP_1, USER_A);
    const second = admin(MEMBERSHIP_2, USER_B);
    expect(decideLastAdminChange(first, [first, second])).toEqual({ allowed: true });
  });

  it("never constrains plain members", () => {
    const plain = member(MEMBERSHIP_2, USER_B);
    expect(decideLastAdminChange(plain, [plain])).toEqual({ allowed: true });
  });
});

describe("role changes and administration transfer", () => {
  it("classifies role changes as unchanged, promote or demote", () => {
    expect(classifyRoleChange("member", "member")).toBe("unchanged");
    expect(classifyRoleChange("member", "admin")).toBe("promote_to_admin");
    expect(classifyRoleChange("admin", "member")).toBe("demote_to_member");
  });

  const actorAdmin = {
    _id: MEMBERSHIP_1!,
    companyId: COMPANY,
    userId: USER_A,
    role: "admin" as const,
    state: "active" as const,
    createdAtMs: NOW,
  };
  const targetMember = {
    _id: MEMBERSHIP_2!,
    companyId: COMPANY,
    userId: USER_B,
    role: "member" as const,
    state: "active" as const,
    createdAtMs: NOW,
  };

  it("accepts an acting admin transferring to a current member of the same firm", () => {
    expect(decideAdministrationTransfer({ actor: actorAdmin, target: targetMember })).toEqual({
      ok: true,
    });
  });

  it("refuses a non-admin actor, an inactive or cross-firm target, and self-transfer", () => {
    expect(
      decideAdministrationTransfer({
        actor: { ...actorAdmin, role: "member" },
        target: targetMember,
      }),
    ).toEqual({ ok: false, code: "requires_admin" });
    expect(
      decideAdministrationTransfer({
        actor: actorAdmin,
        target: { ...targetMember, state: "revoked" as const },
      }),
    ).toEqual({ ok: false, code: "target_not_active" });
    expect(
      decideAdministrationTransfer({
        actor: actorAdmin,
        target: { ...targetMember, companyId: COMPANY_B },
      }),
    ).toEqual({ ok: false, code: "target_not_found" });
    expect(
      decideAdministrationTransfer({
        actor: actorAdmin,
        target: { ...targetMember, userId: USER_A },
      }),
    ).toEqual({ ok: false, code: "transfer_to_self" });
  });
});

describe("issuance helpers", () => {
  it("generates uniform-shape 8-digit codes (rejection sampling)", () => {
    for (let index = 0; index < 25; index++) {
      const code = generateInvitationCode();
      expect(code).toHaveLength(INVITATION_CODE_LENGTH);
      expect(code).toMatch(/^[0-9]{8}$/);
    }
  });

  it("normalizes a pasted code by trimming only", () => {
    expect(normalizeInvitationCode("  12345678 \n")).toBe("12345678");
  });

  it("validates company names (words, bounded length)", () => {
    expect(validateCompanyName("  Budowa Kowalscy  ")).toEqual({
      ok: true,
      value: "Budowa Kowalscy",
    });
    expect(validateCompanyName("   ")).toEqual({ ok: false, code: "company_name_empty" });
    expect(validateCompanyName("x".repeat(101))).toEqual({
      ok: false,
      code: "company_name_too_long",
    });
  });

  it("validates real IANA zones only (the single timezone authority)", () => {
    expect(validateTimezone("Europe/Warsaw")).toEqual({ ok: true, value: "Europe/Warsaw" });
    // Real shapes a short regex rejects (the reason the contract input
    // carries a plain string and this validator is the one authority).
    for (const zone of ["America/Argentina/Buenos_Aires", "Etc/GMT+5", "UTC"]) {
      expect(validateTimezone(zone), zone).toEqual({ ok: true, value: zone });
    }
    expect(validateTimezone("Mars/Olympus")).toEqual({ ok: false, code: "timezone_invalid" });
  });

  it("validates and normalizes invitation target addresses", () => {
    expect(validateInvitationEmail("Szef@Firma.PL")).toEqual({
      ok: true,
      value: "szef@firma.pl",
    });
    expect(validateInvitationEmail("not-an-email")).toEqual({
      ok: false,
      code: "invitation_email_invalid",
    });
    expect(validateInvitationEmail("a@b")).toEqual({
      ok: false,
      code: "invitation_email_invalid",
    });
  });
});
