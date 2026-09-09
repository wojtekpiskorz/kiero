/**
 * B4 focused verification (1/3): the pure GM decision cores — the grant
 * lifecycle decisions, the per-company authority decision and the
 * deployment eligibility parsing. (The membership/GM layering itself is
 * pinned structurally in dispatch.test.ts, against the real registries.)
 */

import { describe, expect, it } from "vitest";
import {
  MAX_GM_REASON_LENGTH,
  decideGmCompanyAccess,
  decideGmEntry,
  decideGmEntryEligibility,
  decideGmExit,
  gmActivationOpen,
  gmGrantOpen,
  normalizeGmStatement,
  openGrantOfUser,
  parseGmOperatorAllowList,
  type GmActivationView,
  type GmGrantView,
} from "../../convex/access/gm/cores";

function grant(overrides: Partial<GmGrantView> = {}): GmGrantView {
  return {
    id: "j97grant1",
    userId: "k57gmoper",
    reason: "rozmowa z firmą o błędzie przetwarzania",
    enteredAtMs: 1_800_000_000_000,
    closedAtMs: null,
    ...overrides,
  };
}

function activation(overrides: Partial<GmActivationView> = {}): GmActivationView {
  return {
    id: "j97activation1",
    companyId: "k57company1",
    activatedAtMs: 1_800_000_000_000,
    endedAtMs: null,
    ...overrides,
  };
}

describe("GM statement normalization (reason/basis)", () => {
  it("trims and accepts bounded prose", () => {
    const normalized = normalizeGmStatement("  podstawa  ");
    expect(normalized).toEqual({ ok: true, value: "podstawa" });
  });

  it("rejects empty and over-long statements", () => {
    expect(normalizeGmStatement("   ")).toEqual({ ok: false });
    expect(normalizeGmStatement("x".repeat(MAX_GM_REASON_LENGTH + 1))).toEqual({ ok: false });
    const bounded = "x".repeat(MAX_GM_REASON_LENGTH);
    expect(normalizeGmStatement(bounded)).toEqual({ ok: true, value: bounded });
  });
});

describe("grant lifecycle decisions", () => {
  it("open means closedAtMs null, on grants and activations alike", () => {
    expect(gmGrantOpen(grant())).toBe(true);
    expect(gmGrantOpen(grant({ closedAtMs: 1_800_000_060_000 }))).toBe(false);
    expect(gmActivationOpen(activation())).toBe(true);
    expect(gmActivationOpen(activation({ endedAtMs: 1_800_000_060_000 }))).toBe(false);
  });

  it("finds the user's single open grant among closed ones", () => {
    const closed = grant({ id: "j97grant0", closedAtMs: 1 });
    expect(openGrantOfUser([closed, grant()])?.id).toBe("j97grant1");
    expect(openGrantOfUser([closed])).toBeNull();
    expect(openGrantOfUser([])).toBeNull();
  });

  it("entry conflicts while a grant is open; entry after exit is a new interval", () => {
    expect(decideGmEntry([])).toEqual({ ok: true });
    expect(decideGmEntry([grant()])).toEqual({ ok: false, code: "gm_mode_already_active" });
    expect(decideGmEntry([grant({ closedAtMs: 5 })])).toEqual({ ok: true });
  });

  it("exit requires the actor's own open grant", () => {
    const own = decideGmExit(grant(), "k57gmoper");
    expect(own.ok).toBe(true);
    const foreign = decideGmExit(grant(), "k57other");
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.code).toBe("gm_not_own_grant");
    }
    const closed = decideGmExit(grant({ closedAtMs: 5 }), "k57gmoper");
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.code).toBe("gm_grant_not_open");
    }
    const missing = decideGmExit(null, "k57gmoper");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("gm_grant_not_open");
    }
  });

  it("elapsed time alone never closes a grant (no expiry decision exists)", () => {
    const old = grant({ enteredAtMs: 1_000 });
    const farFuture = 9_000_000_000_000;
    // The only inputs are row facts; however much time passes, the grant
    // stays open until exit closes it.
    expect(gmGrantOpen(old)).toBe(true);
    expect(farFuture - old.enteredAtMs).toBeGreaterThan(0);
  });
});

describe("the per-company authority decision", () => {
  it("allows open grant + existing company + open activation", () => {
    expect(
      decideGmCompanyAccess({ grantOpen: true, companyExists: true, activation: activation() }),
    ).toEqual({ ok: true });
  });

  it("denies without an open grant, leaking no target facts", () => {
    const denial = decideGmCompanyAccess({
      grantOpen: false,
      companyExists: true,
      activation: activation(),
    });
    expect(denial).toEqual({ ok: false, kind: "forbidden", code: "gm_mode_not_active" });
  });

  it("denies a missing company as not_found", () => {
    expect(
      decideGmCompanyAccess({ grantOpen: true, companyExists: false, activation: null }),
    ).toEqual({ ok: false, kind: "not_found", code: "company_not_found" });
  });

  it("denies when alpha participation ended or never existed", () => {
    expect(
      decideGmCompanyAccess({
        grantOpen: true,
        companyExists: true,
        activation: activation({ endedAtMs: 1_800_000_060_000 }),
      }),
    ).toEqual({ ok: false, kind: "forbidden", code: "company_alpha_not_active" });
    expect(
      decideGmCompanyAccess({ grantOpen: true, companyExists: true, activation: null }),
    ).toEqual({ ok: false, kind: "forbidden", code: "company_alpha_not_active" });
  });
});

describe("deployment operator designation", () => {
  it("an absent or empty allow-list designates nobody (fail-closed)", () => {
    expect(parseGmOperatorAllowList(undefined).size).toBe(0);
    expect(parseGmOperatorAllowList("").size).toBe(0);
    expect(parseGmOperatorAllowList(" , ,").size).toBe(0);
    expect(decideGmEntryEligibility("operator@kiero.invalid", parseGmOperatorAllowList(undefined))).toBe(false);
  });

  it("normalizes addresses and drops malformed entries", () => {
    const list = parseGmOperatorAllowList("Operator@Kiero.Invalid, not-an-email ,x@y.pl");
    expect(list.has("operator@kiero.invalid")).toBe(true);
    expect(list.has("x@y.pl")).toBe(true);
    expect(list.size).toBe(2);
  });

  it("eligibility matches the normalized live-session email", () => {
    const list = parseGmOperatorAllowList("operator@kiero.invalid");
    expect(decideGmEntryEligibility("operator@kiero.invalid", list)).toBe(true);
    expect(decideGmEntryEligibility("  Operator@Kiero.Invalid ", list)).toBe(true);
    expect(decideGmEntryEligibility("someone-else@kiero.invalid", list)).toBe(false);
  });
});
