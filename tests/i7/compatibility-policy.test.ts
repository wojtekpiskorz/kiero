/**
 * I7 focused tests: the shared compatibility policy's version window,
 * measured-absence contract gate, security immediacy and repair refusals.
 * These rows are the deterministic half of the issue's CI checks
 * ("concurrent release attempt" lives in release-guards.test.ts; the
 * migration retry rows live in migration-engine.test.ts).
 */

import { describe, expect, it } from "vitest";
import {
  compareReleaseVersions,
  decideClientSupport,
  decideContractRemoval,
  parseReleaseVersion,
  planReleaseRepair,
  securityEventPolicy,
} from "../../tools/migrations/policy";

describe("release versions", () => {
  it("parses dotted numeric versions and refuses everything else", () => {
    expect(parseReleaseVersion("1")).toEqual({ major: 1, minor: 0, patch: 0 });
    expect(parseReleaseVersion("1.2")).toEqual({ major: 1, minor: 2, patch: 0 });
    expect(parseReleaseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseReleaseVersion("1.2.3.4")).toBeNull();
    expect(parseReleaseVersion("v1.2")).toBeNull();
    expect(parseReleaseVersion("1.2-beta")).toBeNull();
    expect(parseReleaseVersion("")).toBeNull();
  });

  it("compares major, then minor, then patch", () => {
    const v = (value: string) => parseReleaseVersion(value) as NonNullable<
      ReturnType<typeof parseReleaseVersion>
    >;
    expect(compareReleaseVersions(v("1.2.3"), v("1.2.3"))).toBe(0);
    expect(compareReleaseVersions(v("1.2.3"), v("1.10.0"))).toBeLessThan(0);
    expect(compareReleaseVersions(v("2.0.0"), v("1.99.99"))).toBeGreaterThan(0);
  });
});

describe("the client support window", () => {
  const policy = { currentVersion: "1.4.0", minSupportedVersion: "1.2.0" };

  it("answers current, update-available and update-required by window", () => {
    expect(decideClientSupport(policy, "1.4.0")).toBe("current");
    expect(decideClientSupport(policy, "2.0.0")).toBe("current");
    expect(decideClientSupport(policy, "1.4.1")).toBe("current");
    expect(decideClientSupport(policy, "1.3.0")).toBe("update-available");
    expect(decideClientSupport(policy, "1.2.0")).toBe("update-available");
    expect(decideClientSupport(policy, "1.1.9")).toBe("update-required");
    expect(decideClientSupport(policy, "1.0.0")).toBe("update-required");
  });

  it("never guesses support for unparseable versions", () => {
    expect(decideClientSupport(policy, "banana")).toBeNull();
  });
});

describe("security immediacy (issue AC)", () => {
  it("revocation applies immediately for EVERY client age, unsupported included", () => {
    for (const decision of [
      "current",
      "update-available",
      "update-required",
      null,
    ] as const) {
      expect(securityEventPolicy(decision)).toEqual({
        revocationApplication: "immediate",
        deferredByUpdateState: false,
      });
    }
  });
});

describe("the measured-absence contract gate", () => {
  const gate = { minSupportedVersion: "1.2.0", absenceWindowMs: 14 * 24 * 3600 * 1000 };
  const DAY = 24 * 3600 * 1000;
  const now = 1_000_000_000;

  it("blocks while an older version was observed inside the window", () => {
    const decision = decideContractRemoval(
      gate,
      [
        { version: "1.1.9", observedAtMs: now - 2 * DAY },
        { version: "1.0.3", observedAtMs: now - 20 * DAY },
      ],
      now,
    );
    expect(decision).toMatchObject({
      allowed: false,
      blocking: { version: "1.1.9" },
    });
  });

  it("allows after measured absence, reporting the newest older age", () => {
    const decision = decideContractRemoval(
      gate,
      [{ version: "1.1.9", observedAtMs: now - 20 * DAY }],
      now,
    );
    expect(decision).toEqual({
      allowed: true,
      newestOlderObservationAgeMs: 20 * DAY,
    });
  });

  it("ignores versions still inside the window's support", () => {
    const decision = decideContractRemoval(
      gate,
      [
        { version: "1.2.0", observedAtMs: now },
        { version: "1.9.9", observedAtMs: now },
      ],
      now,
    );
    expect(decision).toEqual({ allowed: true, newestOlderObservationAgeMs: null });
  });

  it("refuses to run on an unparseable gate", () => {
    expect(() =>
      decideContractRemoval(
        { minSupportedVersion: "x", absenceWindowMs: 1 },
        [],
        now,
      ),
    ).toThrow(/is not a release version/);
    expect(() =>
      decideContractRemoval(gate, [{ version: "x", observedAtMs: now }], now),
    ).toThrow(/is not a release version/);
  });
});

describe("repair planning (issue AC: no old database, no resurrected access)", () => {
  it("refuses database restore as release rollback", () => {
    expect(planReleaseRepair({ kind: "restore_database_backup" })).toEqual({
      kind: "rejected",
      reason: "database_restore_forbidden",
    });
  });

  it("a code rollback keeps the expanded schema, migrated data and revocations", () => {
    const plan = planReleaseRepair({
      kind: "rollback_code",
      releaseId: "rel_1",
      previousVersion: "1.3.0",
    });
    expect(plan.kind).toBe("compatible_rollback");
    if (plan.kind === "compatible_rollback") {
      expect(plan.redeployVersion).toBe("1.3.0");
      expect(plan.keeps.join(" ")).toContain("revoked access");
      expect(plan.keeps.join(" ")).not.toContain("restore");
    }
  });

  it("a forward fix ships as a new compatible release through the rehearsal", () => {
    const plan = planReleaseRepair({ kind: "forward_fix", releaseId: "rel_1" });
    expect(plan.kind).toBe("forward_fix");
    if (plan.kind === "forward_fix") {
      expect(plan.steps.join(" ")).toContain("rehearsal");
    }
  });
});
