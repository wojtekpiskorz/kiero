/**
 * R6 focused tests: the evidence ledger's truthful schemas. Every deploy
 * run appends exactly one component-outcome record per component; the
 * three terminal states carry closed key sets, and "deployed" cannot
 * exist without a digest and a remote identity. Blocked records carry
 * configuration NAMES and observed labels only, never values.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  appendReleaseRecord,
  buildComponentOutcomeRecord,
  buildReleaseRecord,
  readReleaseRecords,
  RELEASE_EVIDENCE_PATH,
} from "../../infra/release/record-release-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const recorderCli = join(repoRoot, "infra", "release", "record-release-evidence.mjs");
const stagingDescriptor = join(repoRoot, "infra", "release", "targets", "staging.json");
const REVISION = "5555555555555555555555555555555555555555";

const sortedKeys = (record: object) => Object.keys(record).sort();

describe("the deployed outcome cannot exist without bytes and identity", () => {
  it("builds a fully-qualified deployed record", () => {
    const record = buildComponentOutcomeRecord({
      target: "staging",
      revision: REVISION,
      descriptorId: "infra/release/targets/staging@2026-09-12",
      outcome: {
        component: "web",
        outcome: "deployed",
        digest: "a".repeat(64),
        fileCount: 12,
        transportKind: "wrangler-pages",
        remoteIdentity: { kind: "cloudflare-pages", id: "kiero-staging-web" },
      },
      recordedAtIso: "2026-09-12T00:00:00.000Z",
    });
    expect(sortedKeys(record)).toEqual([
      "component",
      "descriptorId",
      "digest",
      "fileCount",
      "kind",
      "outcome",
      "recordedAtIso",
      "remoteIdentity",
      "revision",
      "target",
      "transportKind",
    ]);
  });

  it("refuses a deployed record without a digest", () => {
    expect(() =>
      buildComponentOutcomeRecord({
        target: "staging",
        revision: REVISION,
        descriptorId: "d@2026-09-12",
        outcome: { component: "web", outcome: "deployed", remoteIdentity: { kind: "k", id: "i" } },
      }),
    ).toThrow(/digest/);
  });

  it("refuses a deployed record without a remote identity", () => {
    expect(() =>
      buildComponentOutcomeRecord({
        target: "staging",
        revision: REVISION,
        descriptorId: "d@2026-09-12",
        outcome: { component: "web", outcome: "deployed", digest: "a".repeat(64) },
      }),
    ).toThrow(/remote identity/);
    expect(() =>
      buildComponentOutcomeRecord({
        target: "staging",
        revision: REVISION,
        descriptorId: "d@2026-09-12",
        outcome: {
          component: "web",
          outcome: "deployed",
          digest: "a".repeat(64),
          remoteIdentity: { kind: "k", id: "" },
        },
      }),
    ).toThrow(/remote identity/);
  });
});

describe("the skipped and blocked schemas are closed", () => {
  it("skipped exists only with the descriptor-exclusion reason", () => {
    const record = buildComponentOutcomeRecord({
      target: "staging",
      revision: REVISION,
      descriptorId: "d@2026-09-12",
      outcome: { component: "backup-worker", outcome: "skipped", skipReason: "excluded-by-descriptor" },
      recordedAtIso: "2026-09-12T00:00:00.000Z",
    });
    expect(sortedKeys(record)).toEqual([
      "component",
      "descriptorId",
      "kind",
      "outcome",
      "recordedAtIso",
      "revision",
      "skipReason",
      "target",
    ]);
    expect(() =>
      buildComponentOutcomeRecord({
        target: "staging",
        revision: REVISION,
        descriptorId: "d@2026-09-12",
        outcome: { component: "backup-worker", outcome: "skipped", skipReason: "felt-like-it" },
      }),
    ).toThrow(/excluded-by-descriptor/);
  });

  it("blocked requires a reason and records names only", () => {
    const record = buildComponentOutcomeRecord({
      target: "staging",
      revision: REVISION,
      descriptorId: "d@2026-09-12",
      outcome: {
        component: "convex-functions",
        outcome: "blocked",
        blockedReason: "missing-configuration",
        missingConfigNames: ["CONVEX_DEPLOYMENT"],
      },
      recordedAtIso: "2026-09-12T00:00:00.000Z",
    });
    expect(sortedKeys(record)).toEqual([
      "blockedReason",
      "component",
      "descriptorId",
      "kind",
      "missingConfigNames",
      "outcome",
      "recordedAtIso",
      "revision",
      "target",
    ]);
    expect(() =>
      buildComponentOutcomeRecord({
        target: "staging",
        revision: REVISION,
        descriptorId: "d@2026-09-12",
        outcome: { component: "x", outcome: "blocked" },
      }),
    ).toThrow(/blockedReason/);
    expect(() =>
      buildComponentOutcomeRecord({
        target: "staging",
        revision: REVISION,
        descriptorId: "d@2026-09-12",
        // Deliberately invalid payload (would be a schema bug upstream).
        outcome: JSON.parse('{"component":"x","outcome":"maybe"}'),
      }),
    ).toThrow(/unknown component outcome/);
  });
});

describe("the mixed ledger stays append-only and torn-line tolerant", () => {
  it("holds attempt and component-outcome records side by side", () => {
    const ledger = join(mkdtempSync(join(tmpdir(), "kiero-evidence-")), "releases.jsonl");
    const attempt = buildReleaseRecord({
      target: "staging",
      revision: REVISION,
      rehearsalPassed: true,
      rehearsalRows: 9,
      runtimeVersion: "a3.0",
      clientVersion: "i7.1",
      descriptorId: "d@2026-09-12",
      recordedAtIso: "2026-09-12T00:00:00.000Z",
    });
    appendReleaseRecord(attempt, ledger);
    const outcomes: { component: string; outcome: "deployed" | "skipped" | "blocked"; [field: string]: unknown }[] = [
      { component: "web", outcome: "blocked", blockedReason: "missing-configuration", missingConfigNames: ["VITE_CONVEX_URL"] },
      { component: "gateway", outcome: "skipped", skipReason: "excluded-by-descriptor" },
      {
        component: "convex-functions",
        outcome: "deployed",
        digest: "b".repeat(64),
        transportKind: "convex-deploy",
        remoteIdentity: { kind: "convex-deployment", id: "team:project:staging" },
      },
    ];
    for (const outcome of outcomes) {
      appendReleaseRecord(
        buildComponentOutcomeRecord({ target: "staging", revision: REVISION, descriptorId: "d@2026-09-12", outcome }),
        ledger,
      );
    }
    // A torn line (a killed append) is skipped, never repaired.
    writeFileSync(ledger, `{"kind": "tor`, { flag: "a" });
    const records = readReleaseRecords(ledger);
    expect(records.map((record) => record.kind)).toEqual([
      "release-attempt",
      "component-outcome",
      "component-outcome",
      "component-outcome",
    ]);
  });
});

describe("the recorder CLI (exact workflow flags)", () => {
  it("appends a sanitized attempt record naming the descriptor and the dispatcher's notes", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-recorder-"));
    const ledger = join(directory, "releases.jsonl");
    const migrationLedger = join(directory, "rehearsal-ledger.jsonl");
    writeFileSync(migrationLedger, "expanded\nbatch-done\n");
    const run = spawnSync(
      process.execPath,
      [
        recorderCli,
        "--target", "staging",
        "--descriptor", stagingDescriptor,
        "--revision", REVISION,
        "--notes", "hotfix: gateway routing repair",
        "--rehearsal-passed", "true",
        "--rehearsal-rows", "9",
        "--runtime-version", "a3.0",
        "--client-version", "i7.1",
        "--migration-ledger", migrationLedger,
        "--ledger", ledger,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    expect(run.status).toBe(0);
    const records = readReleaseRecords(ledger);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "release-attempt",
      target: "staging",
      revision: REVISION,
      descriptorId: "infra/release/targets/staging@2026-09-12",
      notes: "hotfix: gateway routing repair",
      rehearsal: "9 PASS",
    });
    const raw = readFileSync(ledger, "utf8");
    expect(raw).not.toMatch(/Bearer|CLOUDFLARE_API_TOKEN\s*[:=]\s*['"]?\w/);
  });

  it("omits the notes field when the dispatcher supplied none", () => {
    const record = buildReleaseRecord({
      target: "staging",
      revision: REVISION,
      rehearsalPassed: true,
      rehearsalRows: 9,
      runtimeVersion: "a3.0",
      clientVersion: "i7.1",
      notes: "",
      recordedAtIso: "2026-09-12T00:00:00.000Z",
    });
    expect(sortedKeys(record)).not.toContain("notes");
  });

  it("an unknown flag is a usage error, never silently ignored", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-recorder-"));
    const ledger = join(directory, "releases.jsonl");
    const run = spawnSync(
      process.execPath,
      [recorderCli, "--target", "staging", "--descriptor", stagingDescriptor, "--typo", "x", "--ledger", ledger],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown argument");
    expect(readReleaseRecords(ledger)).toHaveLength(0);
  });

  it("refuses a target that disagrees with the descriptor", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-recorder-"));
    const ledger = join(directory, "releases.jsonl");
    const run = spawnSync(
      process.execPath,
      [recorderCli, "--target", "production", "--descriptor", stagingDescriptor, "--ledger", ledger],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("does not match");
    expect(readReleaseRecords(ledger)).toHaveLength(0);
  });
});

describe("the committed ledger (when present) stays sanitized", () => {
  it("holds only the two documented record kinds with closed schemas", () => {
    const committed = readReleaseRecords();
    expect(RELEASE_EVIDENCE_PATH.protocol).toBe("file:");
    for (const record of committed) {
      expect(["release-attempt", "component-outcome"]).toContain(record.kind);
      if (record.kind === "release-attempt") {
        // notes is the one optional field (present only when dispatched).
        expect(sortedKeys(record).filter((key) => key !== "notes")).toEqual([
          "clientVersion",
          "descriptorId",
          "kind",
          "migrationLedgerSha256",
          "recordedAtIso",
          "rehearsal",
          "revision",
          "runtimeVersion",
          "target",
        ]);
        if ("notes" in record) {
          expect(typeof record.notes).toBe("string");
        }
      } else {
        expect(sortedKeys(record)).toContain("component");
        expect(["deployed", "skipped", "blocked"]).toContain(record.outcome);
        if (record.outcome === "deployed") {
          expect(typeof record.digest).toBe("string");
          expect(typeof record.remoteIdentity).toBe("object");
        }
      }
    }
  });
});
