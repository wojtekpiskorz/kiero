/**
 * I5 focused verification, part 1: the PURE decision model (slot.ts) -
 * cadence, single-run lease (overlap refusal, takeover, retry bounds),
 * freshness from SNAPSHOT time, retention tiers (48h/14d), the 30-day
 * deleted-content invariant, reference-aware collection, orphan candidacy
 * and plan-limit measurement.
 */

import { describe, expect, it } from "vitest";
import {
  DAILY_RETENTION_MS,
  DELETED_CONTENT_EXPIRY_MS,
  FRESHNESS_LIMIT_MS,
  FREQUENT_RETENTION_MS,
  LEASE_MS,
  MAX_ATTEMPTS_PER_SLOT,
  SCHEDULE_INTERVAL_MS,
  canonicalJson,
  decideBegin,
  isOrphanCandidate,
  deletedContentInvariantHolds,
  exceededAllowances,
  freshnessOf,
  isSafeObjectKey,
  isSha256Hex,
  isValidFailureReason,
  planSweep,
  retentionMsOfTier,
  slotIsCurrent,
  slotOf,
  staleDedupKey,
  tierOfSlot,
  type ManifestRowView,
} from "../../convex/operations/backups/slot";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("cadence and slots", () => {
  it("the cadence is 15 minutes and the lease is strictly shorter than one slot", () => {
    expect(SCHEDULE_INTERVAL_MS).toBe(15 * MIN);
    expect(LEASE_MS).toBeLessThan(SCHEDULE_INTERVAL_MS);
  });

  it("floors timestamps onto the 15-minute grid", () => {
    expect(slotOf(0)).toBe(0);
    expect(slotOf(15 * MIN - 1)).toBe(0);
    expect(slotOf(15 * MIN)).toBe(15 * MIN);
    expect(slotOf(15 * MIN + 42_000)).toBe(15 * MIN);
  });

  it("a slot is current exactly inside its own window", () => {
    expect(slotIsCurrent(0, 0)).toBe(true);
    expect(slotIsCurrent(0, SCHEDULE_INTERVAL_MS - 1)).toBe(true);
    expect(slotIsCurrent(0, SCHEDULE_INTERVAL_MS)).toBe(false);
  });
});

describe("retention tiers", () => {
  it("frequent sets are kept 48 hours and daily sets through day 14", () => {
    expect(FREQUENT_RETENTION_MS).toBe(48 * HOUR);
    expect(DAILY_RETENTION_MS).toBe(14 * DAY);
    expect(retentionMsOfTier("frequent")).toBe(FREQUENT_RETENTION_MS);
    expect(retentionMsOfTier("daily")).toBe(DAILY_RETENTION_MS);
  });

  it("the first slot of each UTC day is the daily tier", () => {
    expect(tierOfSlot(0)).toBe("daily");
    expect(tierOfSlot(DAY)).toBe("daily");
    expect(tierOfSlot(DAY + 15 * MIN)).toBe("frequent");
    expect(tierOfSlot(DAY - SCHEDULE_INTERVAL_MS)).toBe("frequent");
  });

  it("no set can outlive the 30-day deleted-content expiry (construction + assertion)", () => {
    expect(DELETED_CONTENT_EXPIRY_MS).toBe(30 * DAY);
    expect(FREQUENT_RETENTION_MS).toBeLessThan(DELETED_CONTENT_EXPIRY_MS);
    expect(DAILY_RETENTION_MS).toBeLessThan(DELETED_CONTENT_EXPIRY_MS);
    expect(deletedContentInvariantHolds()).toBe(true);
  });
});

describe("the single-run lease decision", () => {
  const slot = 1000 * SCHEDULE_INTERVAL_MS;
  const row = (overrides: Partial<ManifestRowView>): ManifestRowView => ({
    slotMs: slot,
    state: "building",
    attempts: 1,
    leaseExpiresAtMs: slot + LEASE_MS,
    snapshotAtMs: slot,
    ...overrides,
  });

  it("an empty slot starts", () => {
    expect(decideBegin(slot, null, slot + 1)).toEqual({ action: "start" });
  });

  it("a live lease refuses the overlapping attempt", () => {
    const now = slot + 1 * MIN; // lease still live (12 min)
    expect(decideBegin(slot, row({}), now)).toEqual({ action: "refuse", reason: "lease_held" });
  });

  it("an expired lease is taken over (interrupted runs resume, never overlap)", () => {
    const now = slot + LEASE_MS + 1;
    expect(decideBegin(slot, row({ leaseExpiresAtMs: slot + LEASE_MS }), now)).toEqual({
      action: "takeover",
      reason: "lease_expired",
    });
  });

  it("a verified slot is idempotently complete", () => {
    expect(decideBegin(slot, row({ state: "verified" }), slot + 1)).toEqual({
      action: "refuse",
      reason: "already_complete",
    });
  });

  it("a failed slot retries only while current and under the attempt bound", () => {
    expect(decideBegin(slot, row({ state: "failed" }), slot + 1)).toEqual({
      action: "retry",
      reason: "slot_failed_retryable",
    });
    expect(decideBegin(slot, row({ state: "failed" }), slot + SCHEDULE_INTERVAL_MS)).toEqual({
      action: "refuse",
      reason: "slot_passed",
    });
    expect(
      decideBegin(slot, row({ state: "failed", attempts: MAX_ATTEMPTS_PER_SLOT }), slot + 1),
    ).toEqual({ action: "refuse", reason: "attempts_exhausted" });
  });

  it("an expired lease of an exhausted building row refuses instead of looping", () => {
    expect(
      decideBegin(
        slot,
        row({ attempts: MAX_ATTEMPTS_PER_SLOT, leaseExpiresAtMs: slot + LEASE_MS }),
        slot + LEASE_MS + 1,
      ),
    ).toEqual({ action: "refuse", reason: "attempts_exhausted" });
  });
});

describe("freshness from snapshot time", () => {
  it("fresh inside one hour, stale beyond it - measured from SNAPSHOT, not completion", () => {
    const snapshot = 10 * HOUR;
    expect(freshnessOf([snapshot], [], snapshot + 30 * MIN).state).toBe("fresh");
    const stale = freshnessOf([snapshot], [], snapshot + FRESHNESS_LIMIT_MS + 1);
    expect(stale.state).toBe("stale");
    expect(stale.ageMs).toBe(FRESHNESS_LIMIT_MS + 1);
  });

  it("uses the NEWEST verified snapshot, not the newest attempt", () => {
    const now = 10 * HOUR;
    const state = freshnessOf([now - 3 * HOUR, now - 10 * MIN], [now - 1 * MIN], now);
    expect(state.state).toBe("fresh");
    expect(state.ageMs).toBe(10 * MIN);
    expect(state.recentFailures).toBe(1);
  });

  it("attempts that never verified are never_verified, deduped by anchor 0", () => {
    const state = freshnessOf([], [5 * MIN], 10 * HOUR);
    expect(state.state).toBe("never_verified");
    expect(staleDedupKey(state.dedupAnchorMs ?? 0)).toBe("backup_stale:0");
  });

  it("staleness episodes dedup on the newest verified snapshot", () => {
    expect(staleDedupKey(1234)).toBe("backup_stale:1234");
  });
});

describe("reference-aware retention sweep", () => {
  const rows = (state: "verified" | "building" | "failed", expiresAtMs: number | undefined, keys: string[], slot: number) => ({
    manifestId: `m-${slot}-${state}`,
    slotMs: slot,
    state,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    mediaObjectKeys: keys,
  });
  const now = 100 * HOUR;

  it("collects expired sets but never an object referenced by a SURVIVING manifest", () => {
    const plan = planSweep(
      [
        rows("verified", now - 1, ["shared/a", "old/a"], 1),
        rows("verified", now + HOUR, ["shared/a", "live/b"], 2),
      ],
      now,
    );
    expect(plan.expiredSets).toHaveLength(1);
    expect(plan.expiredSets[0]?.manifestId).toBe("m-1-verified");
    expect(plan.survivingReferences).toEqual(["live/b", "shared/a"]);
    // shared/a survives via the living set; old/a dies with its only set.
    expect(plan.deletableObjectKeys).toEqual(["old/a"]);
  });

  it("objects referenced only by expiring sets are deletable when every referencing set expires", () => {
    const plan = planSweep(
      [rows("verified", now - 1, ["x/1"], 1), rows("verified", now - 1, ["x/1"], 2)],
      now,
    );
    expect(plan.deletableObjectKeys).toEqual(["x/1"]);
  });

  it("building and failed rows are never collected and never donate references", () => {
    const plan = planSweep(
      [rows("building", undefined, ["w/1"], 1), rows("failed", now - 1, ["f/1"], 2)],
      now,
    );
    expect(plan.expiredSets).toHaveLength(0);
    expect(plan.survivingReferences).toEqual([]);
    expect(plan.deletableObjectKeys).toEqual([]);
  });
});

describe("orphan candidacy", () => {
  it("collects only unreferenced pool objects past the grace window", () => {
    const now = 100 * HOUR;
    const referenced = ["media/referenced"];
    expect(isOrphanCandidate("media/old", referenced, now - 49 * HOUR, now)).toBe(true);
    expect(isOrphanCandidate("media/fresh", referenced, now - 1 * HOUR, now)).toBe(false);
    expect(isOrphanCandidate("media/referenced", referenced, now - 100 * HOUR, now)).toBe(false);
  });
});

describe("validation helpers", () => {
  it("accepts sha256 hex and rejects everything else", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("A".repeat(64))).toBe(false);
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });

  it("failure reasons are closed snake_case vocabulary", () => {
    expect(isValidFailureReason("media_object_missing")).toBe(true);
    expect(isValidFailureReason("Media Object")).toBe(false);
    expect(isValidFailureReason("x")).toBe(false);
    expect(isValidFailureReason("has space")).toBe(false);
  });

  it("pool keys must be safe tenant paths (no traversal)", () => {
    expect(isSafeObjectKey("companies/k123/uploads/k456/0-image")).toBe(true);
    expect(isSafeObjectKey("../etc/passwd")).toBe(false);
    expect(isSafeObjectKey("has space")).toBe(false);
    expect(isSafeObjectKey("UPPER")).toBe(false);
  });

  it("canonical JSON is stable regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: true, c: null }] })).toBe(
      '{"a":[2,{"c":null,"d":true}],"b":1}',
    );
  });
});

describe("plan-limit measurement (P12)", () => {
  it("measures which free allowances the run's usage exceeds", () => {
    expect(exceededAllowances(5_000, 10, 10)).toEqual([]);
    expect(exceededAllowances(11_000_000_000, 10, 10)).toEqual(["storage"]);
    expect(exceededAllowances(100, 2_000_000, 10)).toEqual(["class_a_ops"]);
    expect(exceededAllowances(100, 10, 20_000_000)).toEqual(["class_b_ops"]);
  });
});
