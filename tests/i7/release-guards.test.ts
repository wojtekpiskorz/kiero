/**
 * I7/R6 focused tests: the release guards, deterministic. These are the
 * issue's CI rows that do not need a cloud: wrong-environment secrets,
 * failed staging checks gating production, the concurrent release attempt
 * rule and the workflow's own structure. The workflow's structure is
 * asserted as TEXT (the repo's established pattern for sibling-owned
 * YAML, cf. the sw.js rows) plus the importable guard logic and the
 * shared target descriptor in infra/release.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  RELEASE_TARGETS,
  checkReleaseTarget,
  checkDescriptorAgainstWorkflow,
  extractJobBlock,
  extractSecretReferences,
} from "../../infra/release/verify-target.mjs";
import {
  committedDescriptorViolations,
  isCommittedDescriptorPath,
  parseTargetDescriptor,
} from "../../infra/release/target-descriptor.mjs";
import {
  appendReleaseRecord,
  buildReleaseRecord,
  readReleaseRecords,
  sha256Hex,
} from "../../infra/release/record-release-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
const checksWorkflow = readFileSync(join(repoRoot, ".github", "workflows", "checks.yml"), "utf8");
const stagingBlock = extractJobBlock(workflow, "staging-deploy") ?? "";
const productionBlock = extractJobBlock(workflow, "production-deploy") ?? "";
const stagingDescriptor = parseTargetDescriptor(
  readFileSync(join(repoRoot, "infra", "release", "targets", "staging.json"), "utf8"),
);
const productionDescriptor = parseTargetDescriptor(
  readFileSync(join(repoRoot, "infra", "release", "targets", "production.json"), "utf8"),
);
const CHECKS_JOB_NAME = "npm ci, typecheck, test, build (Node 22.22.3)";

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

  it("production sits behind the alpha-production environment without claiming protection", () => {
    expect(productionBlock).toMatch(/environment:\s*alpha-production/);
    expect(stagingBlock).toMatch(/environment:\s*staging/);
    // R6: the YAML must not present the environment key as proof of a
    // configured approval gate (live GitHub state, owner/I8 action).
    expect(workflow).toMatch(/cannot prove/i);
    expect(workflow).not.toMatch(/human approval gate/i);
    expect(workflow).toContain("protection is owner-provisioned");
    expect(workflow).not.toContain("environment approval");
  });

  it("one release per target: a concurrent attempt queues, never cancels", () => {
    expect(workflow).toMatch(/group:\s*release-\$\{\{\s*github\.event\.inputs\.target\s*\}\}/);
    expect(workflow).toMatch(/cancel-in-progress:\s*false/);
  });

  it("the read-only permission floor plus Checks read for the gate", () => {
    expect(workflow).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    expect(workflow).not.toMatch(/contents:\s*(write|admin)/);
    for (const block of [stagingBlock, productionBlock]) {
      expect(block).toMatch(/checks:\s*read/);
    }
  });

  it("deploys never run without the rehearsal job", () => {
    expect(workflow).toMatch(/node --experimental-strip-types tools\/migrations\/rehearsal\.mts/);
  });
});

describe("R6-P1: every deploy step is a committed executable (no placeholders)", () => {
  it("contains no echo placeholder anywhere in the workflow", () => {
    expect(workflow).not.toContain("echo");
  });

  it("the guard commands call the committed verify-target.mjs, never the old broken path", () => {
    expect(workflow).not.toContain("verify-release-target.mjs");
    // The run: blocks are folded (>) YAML, so the invocation is asserted
    // piecewise: two guard invocations, each naming its descriptor and
    // the Checks workflow whose job name the descriptor must pin.
    const guardInvocations = workflow.match(/node infra\/release\/verify-target\.mjs/g) ?? [];
    expect(guardInvocations).toHaveLength(2);
    expect(workflow).toContain("--target staging");
    expect(workflow).toContain("--target production");
    expect(workflow).toContain("--descriptor infra/release/targets/staging.json");
    expect(workflow).toContain("--descriptor infra/release/targets/production.json");
    expect((workflow.match(/--checks-workflow \.github\/workflows\/checks\.yml/g) ?? []).length).toBe(2);
    // The referenced files exist in the checkout (the red MODULE_NOT_FOUND
    // defect this issue repairs).
    for (const file of ["infra/release/verify-target.mjs", ".github/workflows/checks.yml"]) {
      expect(() => readFileSync(join(repoRoot, file))).not.toThrow();
    }
  });

  it("each deploy job runs the exact-SHA Checks gate before the adapter", () => {
    for (const [block, descriptorPath] of [
      [stagingBlock, "infra/release/targets/staging.json"],
      [productionBlock, "infra/release/targets/production.json"],
    ] as const) {
      expect(block).toContain("node infra/release/verify-checks.mjs");
      expect(block).toContain(`--descriptor ${descriptorPath}`);
      expect(block).toContain('--token-env CHECKS_GITHUB_TOKEN');
      // The gate token is the workflow's own context token, never a
      // secrets-context reference (the guard's prefix rule is untouched).
      expect(block).toContain("CHECKS_GITHUB_TOKEN: ${{ github.token }}");
      expect(block).not.toContain("secrets.GITHUB_TOKEN");
    }
  });

  it("each deploy job deploys through deploy-component.mjs with the shared descriptor", () => {
    for (const block of [stagingBlock, productionBlock]) {
      expect(block).toContain("node infra/release/deploy-component.mjs");
      expect(block).toContain("--revision \"$GITHUB_SHA\"");
      expect(block).toContain("--checks-report checks-report.json");
      expect(block).toContain("--ledger infra/release/evidence/releases.jsonl");
    }
  });

  it("blocked runs fail while uploading evidence: deploy, record and upload use if: always()", () => {
    for (const block of [stagingBlock, productionBlock]) {
      const alwaysSteps = block.match(/if:\s*\$\{\{\s*always\(\)\s*\}\}/g) ?? [];
      expect(alwaysSteps.length).toBeGreaterThanOrEqual(3);
      expect(block).toContain("deploy-outcomes.json");
      expect(block).toContain("checks-report.json");
      expect(block).toContain("infra/release/evidence/releases.jsonl");
    }
  });

  it("the deploy jobs map only correctly-prefixed secrets and a named vars input", () => {
    expect(stagingBlock).toContain("VITE_CONVEX_URL: ${{ vars.STAGING_CONVEX_URL }}");
    expect(stagingBlock).toContain("CONVEX_DEPLOYMENT: ${{ secrets.STAGING_CONVEX_DEPLOYMENT }}");
    expect(stagingBlock).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.STAGING_CLOUDFLARE_API_TOKEN }}");
    expect(stagingBlock).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.STAGING_CLOUDFLARE_ACCOUNT_ID }}");
    expect(productionBlock).toContain("CONVEX_DEPLOYMENT: ${{ secrets.PRODUCTION_CONVEX_DEPLOYMENT }}");
    expect(productionBlock).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.PRODUCTION_CLOUDFLARE_API_TOKEN }}");
  });

  it("the dispatcher's notes reach the attempt record instead of an empty promise", () => {
    expect(workflow).toContain("recorded verbatim in the release-attempt evidence record");
    for (const block of [stagingBlock, productionBlock]) {
      expect(block).toContain("RELEASE_NOTES: ${{ github.event.inputs.notes }}");
      expect(block).toContain('--notes "$RELEASE_NOTES"');
    }
  });
});

describe("the guard CLI spawned exactly as the workflow runs it", () => {
  const guardCli = join(repoRoot, "infra", "release", "verify-target.mjs");
  const spawnGuard = (args: string[], environment: string) =>
    spawnSync(process.execPath, [guardCli, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", KIERO_ENVIRONMENT: environment },
    });

  it("the exact YAML flag set verifies both targets", () => {
    for (const target of ["staging", "production"]) {
      const run = spawnGuard(
        [
          "--target", target,
          "--workflow", ".github/workflows/release.yml",
          "--descriptor", `infra/release/targets/${target}.json`,
          "--checks-workflow", ".github/workflows/checks.yml",
        ],
        target,
      );
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`release target verified: ${target}`);
    }
  });

  it("a mismatched descriptor refuses with a names-only violation", () => {
    const run = spawnGuard(
      [
        "--target", "staging",
        "--workflow", ".github/workflows/release.yml",
        "--descriptor", "infra/release/targets/production.json",
        "--checks-workflow", ".github/workflows/checks.yml",
      ],
      "staging",
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('descriptor target is "production"');
  });

  it("an unknown flag is a usage error, never silently ignored", () => {
    const run = spawnGuard(
      ["--target", "staging", "--workflow", ".github/workflows/release.yml", "--typo-flag", "x"],
      "staging",
    );
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown argument");
  });

  it("a missing flag value is a usage error", () => {
    const run = spawnGuard(["--target", "staging", "--workflow"], "staging");
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("missing value");
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
      /CONVEX_DEPLOYMENT: \$\{\{ secrets\.STAGING_CONVEX_DEPLOYMENT \}\}/,
      "CONVEX_DEPLOYMENT: ${{ secrets.PRODUCTION_CONVEX_DEPLOYMENT }}",
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

describe("the shared target descriptors (guard, adapter and recorder format)", () => {
  it("both committed descriptors validate and agree with their targets", () => {
    expect(stagingDescriptor.violations).toBeUndefined();
    expect(productionDescriptor.violations).toBeUndefined();
    if (stagingDescriptor.descriptor === undefined || productionDescriptor.descriptor === undefined) {
      throw new Error("committed descriptors must parse");
    }
    expect(
      checkDescriptorAgainstWorkflow({
        descriptor: stagingDescriptor.descriptor,
        target: "staging",
        checksWorkflowText: checksWorkflow,
      }),
    ).toEqual([]);
    expect(
      checkDescriptorAgainstWorkflow({
        descriptor: productionDescriptor.descriptor,
        target: "production",
        checksWorkflowText: checksWorkflow,
      }),
    ).toEqual([]);
  });

  it("each descriptor covers the web build and every deployed runtime component", () => {
    const expected = [
      "web",
      "convex-functions",
      "gateway",
      "media-worker",
      "export-worker",
      "backup-worker",
    ];
    for (const parsed of [stagingDescriptor, productionDescriptor]) {
      const ids = parsed.descriptor?.components.map((component) => component.id);
      expect(ids).toEqual(expected);
    }
  });

  it("the descriptors pin the real deterministic Checks job name", () => {
    expect(stagingDescriptor.descriptor?.checksName).toBe(CHECKS_JOB_NAME);
    expect(productionDescriptor.descriptor?.checksName).toBe(CHECKS_JOB_NAME);
    expect(checksWorkflow).toContain(`name: ${CHECKS_JOB_NAME}`);
  });

  it("a descriptor naming a Checks job that checks.yml lacks is refused", () => {
    const violations = checkDescriptorAgainstWorkflow({
      descriptor: {
        target: "staging",
        githubEnvironment: "staging",
        checksName: "made-up checks job",
      },
      target: "staging",
      checksWorkflowText: checksWorkflow,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("not a job name in the Checks workflow");
  });

  it("a descriptor disagreeing with the requested target is refused", () => {
    const violations = checkDescriptorAgainstWorkflow({
      descriptor: { target: "production", githubEnvironment: "alpha-production", checksName: CHECKS_JOB_NAME },
      target: "staging",
    });
    expect(violations).toContainEqual(expect.stringMatching(/descriptor target is "production"/));
  });

  it("committed descriptors never contain value-like payloads (names only)", () => {
    for (const file of ["staging.json", "production.json"]) {
      const text = readFileSync(join(repoRoot, "infra", "release", "targets", file), "utf8");
      expect(text).not.toMatch(/Bearer\s+/i);
      expect(text).not.toMatch(/(password|token|secret)"?\s*[:=]/i);
    }
  });

  it("committed descriptors never carry the stub transport", () => {
    for (const file of ["staging.json", "production.json"]) {
      const text = readFileSync(join(repoRoot, "infra", "release", "targets", file), "utf8");
      expect(text).not.toContain('"stub"');
      const parsed = parseTargetDescriptor(text);
      if (parsed.descriptor === undefined) {
        throw new Error(`committed descriptor ${file} must parse`);
      }
      expect(committedDescriptorViolations(parsed.descriptor)).toEqual([]);
    }
  });

  it("a stub-transport descriptor is refused in the committed namespace only", () => {
    const hostile = {
      target: "staging",
      githubEnvironment: "staging",
      checksName: CHECKS_JOB_NAME,
      components: [
        {
          id: "web",
          included: true,
          build: null,
          artifact: "apps/web/dist",
          transport: { kind: "stub" },
          requiredConfig: [],
        },
      ],
    };
    const violations = committedDescriptorViolations(hostile);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("stub transport");
    // The staging fixture descriptors used by adapter tests are temp
    // files outside the committed namespace and stay legal.
    if (stagingDescriptor.descriptor === undefined) {
      throw new Error("committed staging descriptor must parse");
    }
    expect(committedDescriptorViolations(stagingDescriptor.descriptor)).toEqual([]);
  });

  it("committed descriptor paths are recognized by location, one base for both halves", () => {
    const committedStaging = join(repoRoot, "infra", "release", "targets", "staging.json");
    // Absolute committed path, base = repository root: committed.
    expect(isCommittedDescriptorPath(committedStaging, repoRoot)).toBe(true);
    // Relative committed path, base = repository root (the workflow shape):
    // the descriptor argument and the targets root pair on the same base.
    expect(isCommittedDescriptorPath("infra/release/targets/staging.json", repoRoot)).toBe(true);
    // Absolute committed path, base = a DIFFERENT workspace (--cwd): the
    // classification follows the passed base, never process.cwd(), so the
    // adapter's --cwd flag cannot split the pairing.
    expect(isCommittedDescriptorPath(committedStaging, join(tmpdir(), "other-workspace"))).toBe(false);
    // A path outside the committed namespace: not committed.
    expect(isCommittedDescriptorPath(join(tmpdir(), "fixture-descriptor.json"))).toBe(false);
  });
});

describe("the release evidence ledger (attempt records)", () => {
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
      descriptorId: "infra/release/targets/staging@2026-09-12",
      migrationLedgerText: "expanded\nbatch-done\n",
      recordedAtIso: "2026-09-11T00:00:00.000Z",
    });
    expect(record).toMatchObject({
      kind: "release-attempt",
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
