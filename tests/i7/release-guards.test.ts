/**
 * I7 focused tests: the release guards, deterministic. These are the
 * issue's CI rows that do not need a cloud: wrong-environment secrets,
 * failed staging checks gating production, the concurrent release
 * attempt rule, and the evidence ledger's shape. The workflow's own
 * structure is asserted as TEXT (the repo's established pattern for
 * sibling-owned YAML, cf. the sw.js rows) plus the importable guard
 * logic in infra/release.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  RELEASE_TARGETS,
  checkReleaseTarget,
  extractJobBlock,
  extractSecretReferences,
} from "../../infra/release/verify-target.mjs";
import {
  appendReleaseRecord,
  buildReleaseRecord,
  readReleaseRecords,
  sha256Hex,
} from "../../infra/release/record-release-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
const stagingBlock = extractJobBlock(workflow, "staging-deploy") ?? "";
const productionBlock = extractJobBlock(workflow, "production-deploy") ?? "";

describe("the release workflow's explicit-production rule (issue AC)", () => {
  it("triggers ONLY on an explicit dispatch with a chosen target", () => {
    expect(workflow).toMatch(/on:\s*\n\s+workflow_dispatch:/);
    expect(workflow).not.toMatch(/^\s*(push|pull_request|schedule|release):/m);
    expect(workflow).toMatch(/options:\s*\[staging, production\]/);
    expect(workflow).toMatch(/required:\s*true/);
  });

  it("production runs only on the explicit production target", () => {
    expect(productionBlock).toMatch(
      /if:\s*\$\{\{\s*github\.event\.inputs\.target\s*==\s*'production'\s*\}\}/,
    );
  });

  it("a failed staging check gates production (needs chain)", () => {
    expect(productionBlock).toMatch(/needs:\s*\[rehearse,\s*staging-deploy\]/);
    // The staging job itself needs the rehearsal.
    expect(stagingBlock).toMatch(/needs:\s*rehearse/);
  });

  it("production sits behind the protected alpha-production environment", () => {
    expect(productionBlock).toMatch(/environment:\s*alpha-production/);
    expect(stagingBlock).toMatch(/environment:\s*staging/);
  });

  it("one release per target: a concurrent attempt queues, never cancels", () => {
    expect(workflow).toMatch(/group:\s*release-\$\{\{\s*github\.event\.inputs\.target\s*\}\}/);
    expect(workflow).toMatch(/cancel-in-progress:\s*false/);
  });

  it("the read-only permission floor", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    expect(workflow).not.toMatch(/contents:\s*(write|admin)/);
  });

  it("deploys never run without the rehearsal job", () => {
    expect(workflow).toMatch(/node --experimental-strip-types tools\/migrations\/rehearsal\.mts/);
  });
});

describe("wrong-environment secrets (the guard logic)", () => {
  it("extracts secret references and the environment of one job block", () => {
    const block = extractJobBlock(workflow, "staging-deploy");
    expect(block).toBeTruthy();
    const references = extractSecretReferences(block ?? "");
    expect(references).toContain("STAGING_CONVEX_DEPLOYMENT");
    for (const name of references) {
      expect(name.startsWith("STAGING_")).toBe(true);
    }
  });

  it("accepts the shipped workflow for both targets", () => {
    expect(checkReleaseTarget({ target: "staging", workflowText: workflow, jobId: "staging-deploy" })).toEqual([]);
    expect(
      checkReleaseTarget({ target: "production", workflowText: workflow, jobId: "production-deploy" }),
    ).toEqual([]);
  });

  it("rejects a cross-environment secret smuggled into a job", () => {
    const hostile = workflow.replace(
      /STAGING_PROVISIONED: \$\{\{ secrets\.STAGING_CONVEX_DEPLOYMENT \}\}/,
      "STAGING_PROVISIONED: ${{ secrets.PRODUCTION_CONVEX_DEPLOYMENT }}",
    );
    const violations = checkReleaseTarget({
      target: "staging",
      workflowText: hostile,
      jobId: "staging-deploy",
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("PRODUCTION_CONVEX_DEPLOYMENT");
  });

  it("rejects a wrong environment declaration and a wrong runtime label", () => {
    const hostile = workflow.replace("environment: staging", "environment: dev");
    expect(
      checkReleaseTarget({ target: "staging", workflowText: hostile, jobId: "staging-deploy" }),
    ).toContainEqual(expect.stringMatching(/must declare environment: staging/));

    expect(
      checkReleaseTarget({
        target: "production",
        workflowText: workflow,
        jobId: "production-deploy",
        environmentLabel: "staging",
      }),
    ).toContainEqual(expect.stringMatching(/runtime environment label/));
  });

  it("refuses unknown targets and missing jobs", () => {
    const unknown = checkReleaseTarget({ target: "dev", workflowText: workflow, jobId: "x" });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatch(/unknown target "dev"/);
    const missing = checkReleaseTarget({
      target: "staging",
      workflowText: "jobs:\n  other:\n",
      jobId: "nope",
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/declares no job "nope"/);
  });

  it("the target inventory is exactly staging and production", () => {
    expect(Object.keys(RELEASE_TARGETS).sort()).toEqual(["production", "staging"]);
  });
});

describe("the release evidence ledger", () => {
  it("records are append-only, digested and torn-line tolerant", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-release-evidence-"));
    const ledger = join(directory, "releases.jsonl");
    const record = buildReleaseRecord({
      target: "staging",
      revision: "abc123",
      rehearsalPassed: true,
      rehearsalRows: 9,
      runtimeVersion: "a3.0",
      clientVersion: "i7.1",
      migrationLedgerText: "expanded\nbatch-done\n",
      recordedAtIso: "2026-09-11T00:00:00.000Z",
    });
    expect(record).toMatchObject({
      target: "staging",
      rehearsal: "9 PASS",
      migrationLedgerSha256: sha256Hex("expanded\nbatch-done\n"),
    });
    appendReleaseRecord(record, ledger);
    appendReleaseRecord(
      { ...record, target: "production", recordedAtIso: "2026-09-11T01:00:00.000Z" },
      ledger,
    );
    // A torn line (a killed append) is skipped, never repaired.
    writeFileSync(ledger, `{"target": "tor`, { flag: "a" });
    const records = readReleaseRecords(ledger);
    expect(records).toHaveLength(2);
    expect(records.map((entry) => entry.target)).toEqual(["staging", "production"]);
  });

  it("the committed ledger holds only sanitized fields (no values)", () => {
    const committed = readReleaseRecords();
    for (const record of committed) {
      expect(Object.keys(record).sort()).toEqual([
        "clientVersion",
        "migrationLedgerSha256",
        "recordedAtIso",
        "rehearsal",
        "revision",
        "runtimeVersion",
        "target",
      ]);
    }
  });
});

describe("the release rehearsal (spawned exactly as CI runs it)", () => {
  it("passes end to end with exit code 0", () => {
    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", join(repoRoot, "tools", "migrations", "rehearsal.mts")],
      { encoding: "utf8", env: { ...process.env, KIERO_REHEARSAL_LEDGER: join(tmpdir(), `kiero-rehearsal-test-${Date.now()}.jsonl`) } },
    );
    expect(output).toContain("9/9 rows PASS");
    for (const row of ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]) {
      expect(output).toContain(`[PASS] ${row}`);
    }
  }, 30_000);
});
