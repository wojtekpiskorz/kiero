/**
 * I5 focused verification, part 4: fragment and configuration integrity -
 * the recoveryManifests fragment (columns, closed unions, indexes), the
 * infra/backups mirrors that cannot drift from the single decision module,
 * and the two-place cadence agreement (Convex cron config statement and the
 * Container's cron trigger).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import schema from "../../convex/schema";
import { TABLE_ID_NAMES } from "@kiero/contracts";
import { backupsTables } from "../../convex/operations/backups/schema";
import {
  DAILY_RETENTION_MS,
  DELETED_CONTENT_EXPIRY_MS,
  FRESHNESS_LIMIT_MS,
  FREQUENT_RETENTION_MS,
  LEASE_MS,
  ORPHAN_GRACE_MS,
  R2_FREE_PLAN_LIMITS,
  SCHEDULE_INTERVAL_MS,
} from "../../convex/operations/backups/slot";
import { FAILED_ROW_RETENTION_MS } from "../../convex/operations/backups/functions";
import { DIAGNOSTIC_EVENT_KINDS, KIND_METADATA_ALLOWLIST } from "../../convex/operations/telemetry/redact";

const here = path.dirname(fileURLToPath(import.meta.url));
const infra = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(here, "../../infra/backups", file), "utf8")) as Record<string, unknown>;
const wranglerConfig = readFileSync(path.join(here, "../../apps/backup-worker/wrangler.jsonc"), "utf8");

interface LooseValidator {
  kind: string;
  fields?: Record<string, { kind: string; members?: { value?: string }[] }>;
}

describe("the recoveryManifests fragment", () => {
  const validator = schema.tables.recoveryManifests?.validator as unknown as LooseValidator;
  const fields = validator?.fields ?? {};

  it("keeps the certified state union exactly (building/verified/failed)", () => {
    const state = fields.state;
    expect(state?.kind).toBe("union");
    expect(state?.members?.map((member) => member.value)).toEqual(["building", "verified", "failed"]);
  });

  it("keeps the certified baseline columns and gains only OPTIONAL I5 columns", () => {
    for (const column of [
      "snapshotAtMs",
      "state",
      "databaseManifestHash",
      "mediaManifestHash",
      "mediaObjectCount",
      "verifiedAtMs",
      "expiresAtMs",
      "failureReason",
    ]) {
      expect(fields[column], `missing baseline column ${column}`).toBeDefined();
    }
    for (const column of [
      "slotMs",
      "leaseExpiresAtMs",
      "attempts",
      "tier",
      "inventoryJson",
      "ledgerCount",
      "purgedDroppedJson",
      "databaseBytes",
      "mediaBytes",
      "completedAtMs",
      "manifestHash",
    ]) {
      expect(fields[column], `missing I5 column ${column}`).toBeDefined();
    }
  });

  it("the retention tier is a closed two-value OPTIONAL union", () => {
    const tier = fields.tier as unknown as { kind: string; isOptional?: string; members?: { value?: string }[] };
    expect(tier.kind).toBe("union");
    expect(tier.isOptional).toBe("optional");
    expect(tier.members?.map((member) => member.value)).toEqual(["frequent", "daily"]);
  });

  it("the indexes the protocol's named reads require exist", () => {
    const indexes = (
      backupsTables.recoveryManifests as unknown as { indexes: { indexDescriptor: string; fields: string[] }[] }
    ).indexes;
    const names = indexes.map((index) => index.indexDescriptor);
    expect(names).toContain("by_snapshot");
    expect(names).toContain("by_slot");
    expect(names).toContain("by_state");
    expect(indexes.find((index) => index.indexDescriptor === "by_slot")?.fields).toEqual(["slotMs"]);
  });

  it("the composed table inventory is unchanged (I5 adds NO table)", () => {
    expect(TABLE_ID_NAMES).toHaveLength(75);
    expect(TABLE_ID_NAMES).toContain("recoveryManifests");
  });
});

describe("infra/backups mirrors cannot drift from slot.ts", () => {
  it("retention.json equals the single decision constants", () => {
    const retention = infra("retention.json");
    expect(retention.schedule).toMatchObject({ intervalMs: SCHEDULE_INTERVAL_MS });
    expect(retention.frequent).toMatchObject({ retentionMs: FREQUENT_RETENTION_MS });
    expect(retention.daily).toMatchObject({ retentionMs: DAILY_RETENTION_MS });
    expect(retention.deletedContent).toMatchObject({ expiryMs: DELETED_CONTENT_EXPIRY_MS });
    expect(retention.freshness).toMatchObject({ limitMs: FRESHNESS_LIMIT_MS });
    expect(retention.orphanCollection).toMatchObject({ graceMs: ORPHAN_GRACE_MS });
  });

  it("plan-limits.json equals the measured free-plan allowances", () => {
    const limits = infra("plan-limits.json");
    const r2 = limits.r2 as Record<string, number | string>;
    expect(r2.storageFreeBytes).toBe(R2_FREE_PLAN_LIMITS.storageFreeBytes);
    expect(r2.classAFreePerMonth).toBe(R2_FREE_PLAN_LIMITS.classAFreePerMonth);
    expect(r2.classBFreePerMonth).toBe(R2_FREE_PLAN_LIMITS.classBFreePerMonth);
  });

  it("the failed-row history window is the orphan grace window (one 48h concept)", () => {
    expect(FAILED_ROW_RETENTION_MS).toBe(48 * 60 * 60 * 1000);
    expect(FAILED_ROW_RETENTION_MS).toBe(ORPHAN_GRACE_MS);
  });
});

describe("the cadence agreement (never silently reduced)", () => {
  it("the Container's cron trigger is every 15 minutes in every environment scope", () => {
    const matches = wranglerConfig.match(/"crons": \[\s*"([^"]+)"\s*\]/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3); // top-level + staging + alpha
    for (const match of matches) {
      expect(match).toContain("*/15 * * * *");
    }
  });

  it("the schedule interval is exactly 15 minutes and the lease strictly shorter", () => {
    expect(SCHEDULE_INTERVAL_MS).toBe(15 * 60 * 1000);
    expect(LEASE_MS).toBeLessThan(SCHEDULE_INTERVAL_MS);
  });
});

describe("the I2 diagnostic seam", () => {
  it("ops.backup.stale is a closed kind with exactly the allowlisted keys", () => {
    expect(DIAGNOSTIC_EVENT_KINDS).toContain("ops.backup.stale");
    expect(KIND_METADATA_ALLOWLIST["ops.backup.stale"]).toEqual(["serviceName", "ageMs", "state", "count"]);
  });
});
