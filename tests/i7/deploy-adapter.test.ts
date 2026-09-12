/**
 * R6 focused tests: the checked deploy adapter. Stub transports and
 * temporary fixtures only; no cloud is touched. Proves the adapter's
 * contract: the deterministic Checks success for the exact revision is
 * required, configuration NAMES are validated before any transport, real
 * artifact paths and validated descriptors reach the transport, and the
 * three terminal outcomes (deployed / skipped / blocked) are truthful.
 * Missing-config and wrong-target runs make ZERO transport calls.
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BLOCKED_REASONS, digestArtifactPath, runCommand } from "../../infra/release/deploy-component.mjs";
import { readReleaseRecords } from "../../infra/release/record-release-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const adapterCli = join(repoRoot, "infra", "release", "deploy-component.mjs");
const committedStagingDescriptor = join(repoRoot, "infra", "release", "targets", "staging.json");
const CHECKS_JOB_NAME = "npm ci, typecheck, test, build (Node 22.22.3)";
const REVISION = "3333333333333333333333333333333333333333";

/** The ledger row shape deploy-component.mjs appends (JSON round-tripped). */
interface OutcomeRow {
  kind: string;
  target: string;
  revision: string;
  descriptorId: string;
  component: string;
  outcome: string;
  blockedReason?: string;
  missingConfigNames?: string[];
  observedEnvironmentLabel?: string;
  requiredEnvironmentLabel?: string;
  buildExitCode?: number;
  artifactPath?: string;
  artifactError?: string;
  skipReason?: string;
  digest?: string;
  fileCount?: number;
  transportKind?: string;
  remoteIdentity?: { kind: string; id: string };
  checks?: { decision: string; reasons: string[] };
}

interface StubCall {
  component: string;
  descriptorId: string;
  artifactPath: string;
  digest: string;
  revision: string;
  remoteIdentity: { kind: string; id: string };
}

const outcomeRows = (path: string): OutcomeRow[] =>
  JSON.parse(JSON.stringify(readReleaseRecords(path))) as OutcomeRow[];

const stubCalls = (path: string): StubCall[] =>
  existsSync(path)
    ? (readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line)) as StubCall[])
    : [];

/** A temporary workspace holding a fixture descriptor, report and ledger. */
function fixtureWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), "kiero-deploy-adapter-"));
  return {
    directory,
    descriptor: join(directory, "descriptor.json"),
    checksReport: join(directory, "checks-report.json"),
    ledger: join(directory, "releases.jsonl"),
    outcomes: join(directory, "deploy-outcomes.json"),
    stubRecord: join(directory, "stub-calls.jsonl"),
  };
}

function writePassingChecksReport(path: string, requestedSha = REVISION) {
  // The exact report shape verify-checks.mjs writes for a pass.
  writeFileSync(
    path,
    `${JSON.stringify({
      generatedAtIso: new Date().toISOString(),
      source: "fixture",
      requestedSha,
      checksName: CHECKS_JOB_NAME,
      decision: "pass",
      reasons: [],
      observed: [{ name: CHECKS_JOB_NAME, status: "completed", conclusion: "success", headSha: requestedSha }],
    })}\n`,
  );
}

interface FixtureComponent {
  id: string;
  included?: boolean;
  build?: string | null;
  artifact?: string;
  requiredConfig?: string[];
}

function writeFixtureDescriptor(
  path: string,
  {
    components,
    stubRecord,
    target = "staging",
    githubEnvironment = "staging",
  }: { components: FixtureComponent[]; stubRecord: string; target?: string; githubEnvironment?: string },
) {
  writeFileSync(
    path,
    JSON.stringify({
      descriptorId: "fixture/adapter-test@2026-09-12",
      target,
      githubEnvironment,
      secretPrefix: target === "staging" ? "STAGING_" : "PRODUCTION_",
      checksName: CHECKS_JOB_NAME,
      components: components.map((component) => ({
        id: component.id,
        included: component.included ?? true,
        build: component.build ?? null,
        artifact: component.artifact ?? "artifact-dir",
        requiredConfig: component.requiredConfig ?? ["FIXTURE_CONFIG_A"],
        transport: { kind: "stub", recordPath: stubRecord },
      })),
    }),
  );
}

function runAdapter(paths: ReturnType<typeof fixtureWorkspace>, { env = {}, extraArgs = [] }: { env?: Record<string, string>; extraArgs?: string[] } = {}) {
  return spawnSync(
    process.execPath,
    [
      adapterCli,
      "--descriptor", paths.descriptor,
      "--revision", REVISION,
      "--checks-report", paths.checksReport,
      "--ledger", paths.ledger,
      "--outcomes", paths.outcomes,
      "--cwd", paths.directory,
      ...extraArgs,
    ],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        KIERO_ENVIRONMENT: "staging",
        FIXTURE_CONFIG_A: "present",
        ...env,
      },
    },
  );
}

const BUILD_FIXTURE_ASSET =
  "node -e \"require('node:fs').mkdirSync('artifact-dir',{recursive:true});require('node:fs').writeFileSync('artifact-dir/bundle.txt','fixture bytes')\"";

describe("digests and command execution (adapter primitives)", () => {
  it("digests a file tree deterministically and reacts to byte changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-digest-"));
    mkdirSync(join(directory, "artifact-dir"));
    writeFileSync(join(directory, "artifact-dir", "a.txt"), "one");
    writeFileSync(join(directory, "artifact-dir", "b.txt"), "two");
    const first = digestArtifactPath(join(directory, "artifact-dir"));
    const second = digestArtifactPath(join(directory, "artifact-dir"));
    expect(first.digest).toBe(second.digest);
    expect(first.fileCount).toBe(2);
    writeFileSync(join(directory, "artifact-dir", "b.txt"), "two changed");
    expect(digestArtifactPath(join(directory, "artifact-dir")).digest).not.toBe(first.digest);
  });

  it("runCommand reports exit codes and output tails", () => {
    expect(runCommand("node -e \"process.exit(0)\"")).toMatchObject({ ok: true, exitCode: 0 });
    const failure = runCommand("node -e \"console.error('boom');process.exit(3)\"");
    expect(failure).toMatchObject({ ok: false, exitCode: 3 });
    expect(failure.outputTail).toContain("boom");
  });

  it("the blocked-reason inventory is closed and documented", () => {
    expect(BLOCKED_REASONS).toEqual([
      "invalid-descriptor",
      "unauthorized-environment",
      "checks-missing",
      "checks-refused",
      "missing-configuration",
      "build-failed",
      "missing-artifact",
      "transport-failed",
    ]);
  });
});

describe("R6 deployed: config present, Checks passed, transport called for real", () => {
  it("deploys through the stub with the real artifact path, digest and descriptor id", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset", build: BUILD_FIXTURE_ASSET }],
    });
    const run = runAdapter(paths);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[deployed] fixture-asset");

    const calls = stubCalls(paths.stubRecord);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("the stub transport must have been called exactly once");
    }
    expect(call).toMatchObject({
      component: "fixture-asset",
      descriptorId: "fixture/adapter-test@2026-09-12",
      revision: REVISION,
      remoteIdentity: { kind: "stub", id: "stub:staging:fixture-asset" },
    });
    // The transport received a REAL artifact path that exists on disk...
    expect(existsSync(call.artifactPath)).toBe(true);
    // ...and the digest recorded is the digest of those very bytes.
    const recomputed = digestArtifactPath(call.artifactPath);
    expect(call.digest).toBe(recomputed.digest);

    const outcomes = JSON.parse(readFileSync(paths.outcomes, "utf8")) as { outcomes: OutcomeRow[] };
    expect(outcomes.outcomes[0]).toMatchObject({ component: "fixture-asset", outcome: "deployed" });
    const rows = outcomeRows(paths.ledger);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "component-outcome",
      component: "fixture-asset",
      outcome: "deployed",
      revision: REVISION,
      descriptorId: "fixture/adapter-test@2026-09-12",
      digest: recomputed.digest,
      remoteIdentity: { id: "stub:staging:fixture-asset" },
    });
  });
});

describe("R6 skipped: only when the target descriptor excludes the component", () => {
  it("records skipped without building or calling the transport", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [
        {
          id: "fixture-excluded",
          included: false,
          // If this build ever ran, the run would fail loudly.
          build: "node -e \"process.exit(9)\"",
          requiredConfig: [],
        },
      ],
    });
    const run = runAdapter(paths);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("[skipped] fixture-excluded");
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
    const rows = outcomeRows(paths.ledger);
    expect(rows[0]).toMatchObject({
      outcome: "skipped",
      component: "fixture-excluded",
      skipReason: "excluded-by-descriptor",
    });
  });
});

describe("R6 blocked: zero transport calls, names-only evidence, non-zero exit", () => {
  it("missing configuration blocks before transport and records names only", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset", requiredConfig: ["FIXTURE_CONFIG_A", "FIXTURE_ABSENT_NAME"] }],
    });
    const run = runAdapter(paths, { env: { FIXTURE_ABSENT_NAME: "" } });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("[blocked] fixture-asset: missing-configuration");
    expect(run.stdout).toContain("FIXTURE_ABSENT_NAME");
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
    const rows = outcomeRows(paths.ledger);
    expect(rows[0]).toMatchObject({
      outcome: "blocked",
      blockedReason: "missing-configuration",
      missingConfigNames: ["FIXTURE_ABSENT_NAME"],
    });
    // Names only: the record never carries the value of a configuration.
    expect(JSON.stringify(rows[0])).not.toContain("present");
  });

  it("a wrong runtime environment label blocks every component (unauthorized)", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset" }],
    });
    // The descriptor says staging; the runtime claims production.
    const run = runAdapter(paths, { env: { KIERO_ENVIRONMENT: "production" } });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("[blocked] fixture-asset: unauthorized-environment");
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
    const rows = outcomeRows(paths.ledger);
    expect(rows[0]).toMatchObject({
      blockedReason: "unauthorized-environment",
      observedEnvironmentLabel: "production",
      requiredEnvironmentLabel: "staging",
    });
  });

  it("a missing runtime label is unauthorized, not silently accepted", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset" }],
    });
    const run = runAdapter(paths, { env: { KIERO_ENVIRONMENT: "" } });
    expect(run.status).toBe(1);
    const rows = outcomeRows(paths.ledger);
    expect(rows[0]).toMatchObject({
      blockedReason: "unauthorized-environment",
      observedEnvironmentLabel: "(absent)",
    });
  });

  it("a failed Checks conclusion refuses every component before transport", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFileSync(
      paths.checksReport,
      JSON.stringify({
        source: "fixture",
        requestedSha: REVISION,
        checksName: CHECKS_JOB_NAME,
        decision: "refuse",
        reasons: ["check run concluded failure"],
        observed: [{ name: CHECKS_JOB_NAME, status: "completed", conclusion: "failure", headSha: REVISION }],
      }),
    );
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset" }],
    });
    const run = runAdapter(paths);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("[blocked] fixture-asset: checks-refused");
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
    const rows = outcomeRows(paths.ledger);
    expect(rows[0]?.checks).toMatchObject({ decision: "refuse" });
  });

  it("a Checks pass observed on another SHA refuses (exact-SHA rule, re-validated by the adapter)", () => {
    const paths = fixtureWorkspace();
    // The report itself claims a pass, but for a DIFFERENT revision.
    writePassingChecksReport(paths.checksReport, "4444444444444444444444444444444444444444");
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset" }],
    });
    const run = runAdapter(paths);
    expect(run.status).toBe(1);
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
    const rows = outcomeRows(paths.ledger);
    expect(String(rows[0]?.checks?.reasons)).toContain("requested");
  });

  it("a missing checks report blocks as checks-missing", () => {
    const paths = fixtureWorkspace();
    // No report written; the adapter must still record and refuse.
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset" }],
    });
    const run = runAdapter(paths);
    expect(run.status).toBe(1);
    const rows = outcomeRows(paths.ledger);
    expect(rows[0]).toMatchObject({ blockedReason: "checks-missing" });
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
  });

  it("a failing build blocks with the exit code and never reaches transport", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset", build: "node -e \"process.exit(3)\"" }],
    });
    const run = runAdapter(paths);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("[blocked] fixture-asset: build-failed");
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
    const rows = outcomeRows(paths.ledger);
    expect(rows[0]).toMatchObject({ blockedReason: "build-failed", buildExitCode: 3 });
  });

  it("an invalid descriptor refuses with the violations and no outcomes", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFileSync(paths.descriptor, JSON.stringify({ descriptorId: "nope" }));
    const run = runAdapter(paths);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("deploy REFUSED");
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
    expect(readReleaseRecords(paths.ledger)).toHaveLength(0);
  });

  it("an unreadable artifact (broken symlink in the tree) becomes a blocked outcome without losing the earlier component", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [
        { id: "fixture-good", build: BUILD_FIXTURE_ASSET },
        {
          id: "fixture-broken",
          artifact: "broken-artifact-dir",
          build:
            "node -e \"require('node:fs').mkdirSync('broken-artifact-dir',{recursive:true});require('node:fs').symlinkSync('/nonexistent/r6-dangling','broken-artifact-dir/dangling')\"",
        },
      ],
    });
    const run = runAdapter(paths);
    // The broken component blocks the run (exit 1)...
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("[blocked] fixture-broken: missing-artifact");
    // ...but the healthy component STILL reached the transport and BOTH
    // terminal outcomes reached the ledger (no crash swallows evidence).
    const calls = stubCalls(paths.stubRecord);
    expect(calls.map((call) => call.component)).toEqual(["fixture-good"]);
    const rows = outcomeRows(paths.ledger);
    expect(rows.map((row) => `${row.component}:${row.outcome}`)).toEqual([
      "fixture-good:deployed",
      "fixture-broken:blocked",
    ]);
    expect(rows[1]?.blockedReason).toBe("missing-artifact");
    expect(String(rows[1]?.artifactError)).toContain("dangling");
  });

  it("a committed-namespace descriptor using the stub transport is refused outright", () => {
    // The committed layout (infra/release/targets) recreated in a temp
    // workspace: a stub transport there could mint synthetic deployed
    // evidence, so the adapter refuses before any component runs.
    const directory = mkdtempSync(join(tmpdir(), "kiero-committed-stub-"));
    const targetsDirectory = join(directory, "infra", "release", "targets");
    mkdirSync(targetsDirectory, { recursive: true });
    const descriptor = join(targetsDirectory, "hostile.json");
    const checksReport = join(directory, "checks-report.json");
    const ledger = join(directory, "releases.jsonl");
    const stubRecord = join(directory, "stub-calls.jsonl");
    writePassingChecksReport(checksReport);
    writeFixtureDescriptor(descriptor, { stubRecord, components: [{ id: "fixture-asset" }] });
    const run = spawnSync(
      process.execPath,
      [
        adapterCli,
        "--descriptor", descriptor,
        "--revision", REVISION,
        "--checks-report", checksReport,
        "--ledger", ledger,
        "--outcomes", join(directory, "deploy-outcomes.json"),
        "--cwd", directory,
      ],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", KIERO_ENVIRONMENT: "staging", FIXTURE_CONFIG_A: "present" },
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("deploy REFUSED");
    expect(run.stderr).toContain("stub transport");
    expect(stubCalls(stubRecord)).toHaveLength(0);
    expect(readReleaseRecords(ledger)).toHaveLength(0);
  });
});

describe("the exact workflow command against the committed descriptor (local truthfulness)", () => {
  it("the release.yml deploy command blocks every unprovisioned component by name", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-committed-descriptor-"));
    // Identical to the release.yml staging deploy step: the committed
    // descriptor, the committed checks-report flow, the committed ledger
    // path redirected to a temporary ledger so local proof does not
    // pollute the canonical append-only evidence.
    const report = join(directory, "checks-report.json");
    const ledger = join(directory, "releases.jsonl");
    const outcomes = join(directory, "deploy-outcomes.json");
    writePassingChecksReport(report);
    const run = spawnSync(
      process.execPath,
      [
        adapterCli,
        "--descriptor", committedStagingDescriptor,
        "--revision", REVISION,
        "--checks-report", report,
        "--ledger", ledger,
        "--outcomes", outcomes,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "", KIERO_ENVIRONMENT: "staging" } },
    );
    expect(run.status).toBe(1);
    const rows = outcomeRows(ledger);
    expect(rows.map((row) => row.component)).toEqual([
      "web",
      "convex-functions",
      "gateway",
      "media-worker",
      "export-worker",
      "backup-worker",
    ]);
    for (const row of rows) {
      expect(row.outcome).toBe("blocked");
      expect(row.blockedReason).toBe("missing-configuration");
      if (row.component === "web") {
        expect(row.missingConfigNames).toEqual(["VITE_CONVEX_URL", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]);
      }
      if (row.component === "convex-functions") {
        expect(row.missingConfigNames).toEqual(["CONVEX_DEPLOYMENT"]);
      }
    }
  });

  it("a wrong --component id exits 2 naming the known components", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset" }],
    });
    const run = runAdapter(paths, { extraArgs: ["--component", "no-such-component"] });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("no-such-component");
    expect(run.stderr).toContain("fixture-asset");
  });

  it("an unknown flag is a usage error, never a weaker silent default", () => {
    const paths = fixtureWorkspace();
    writePassingChecksReport(paths.checksReport);
    writeFixtureDescriptor(paths.descriptor, {
      stubRecord: paths.stubRecord,
      components: [{ id: "fixture-asset" }],
    });
    const run = runAdapter(paths, { extraArgs: ["--checkz-report", paths.checksReport] });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown argument");
    expect(stubCalls(paths.stubRecord)).toHaveLength(0);
    expect(readReleaseRecords(paths.ledger)).toHaveLength(0);
  });
});
