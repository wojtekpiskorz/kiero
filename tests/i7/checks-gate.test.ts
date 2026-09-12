/**
 * R6 focused tests: the deterministic Checks gate. Deployment must be
 * refused unless the NAMED Checks job completed SUCCESS for the EXACT
 * revision. Covers success, wrong SHA, missing, pending (queued / in
 * progress), failure, and the CLI as the workflow invokes it (fixture and
 * token-missing modes; the live GitHub API is exercised only in CI).
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  evaluateChecksGate,
  fetchChecksObservations,
  observationsFromGitHubPayload,
} from "../../infra/release/verify-checks.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const verifyChecksCli = join(repoRoot, "infra", "release", "verify-checks.mjs");
const stagingDescriptor = join(repoRoot, "infra", "release", "targets", "staging.json");
const CHECKS_JOB_NAME = "npm ci, typecheck, test, build (Node 22.22.3)";
const REVISION = "1111111111111111111111111111111111111111";
const OTHER_REVISION = "2222222222222222222222222222222222222222";

interface Observation {
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
}

const observation = (overrides: Partial<Observation> = {}): Observation => ({
  name: CHECKS_JOB_NAME,
  status: "completed",
  conclusion: "success",
  headSha: REVISION,
  ...overrides,
});

function runGate(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [verifyChecksCli, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

interface ChecksReportFile {
  source: string;
  requestedSha: string;
  checksName: string | null;
  decision: string;
  reasons: string[];
  observed: Observation[];
}

const readReport = (path: string): ChecksReportFile =>
  JSON.parse(readFileSync(path, "utf8")) as ChecksReportFile;

describe("the pure gate decision", () => {
  it("passes only the exact-SHA completed success", () => {
    expect(
      evaluateChecksGate({ revision: REVISION, checksName: CHECKS_JOB_NAME, observations: [observation()] }),
    ).toEqual({ decision: "pass", reasons: [] });
  });

  it("refuses a success observed on another SHA (wrong SHA)", () => {
    const gate = evaluateChecksGate({
      revision: REVISION,
      checksName: CHECKS_JOB_NAME,
      observations: [observation({ headSha: OTHER_REVISION })],
    });
    expect(gate.decision).toBe("refuse");
    expect(gate.reasons.join(" ")).toContain(OTHER_REVISION.slice(0, 8));
    expect(gate.reasons.join(" ")).toContain("requested");
  });

  it("refuses when the named check is missing entirely", () => {
    const gate = evaluateChecksGate({
      revision: REVISION,
      checksName: CHECKS_JOB_NAME,
      observations: [observation({ name: "Advisory review" })],
    });
    expect(gate.decision).toBe("refuse");
    expect(gate.reasons.join(" ")).toContain("no check run named");
  });

  it("refuses when nothing was observed at all", () => {
    const gate = evaluateChecksGate({ revision: REVISION, checksName: CHECKS_JOB_NAME, observations: [] });
    expect(gate.decision).toBe("refuse");
    expect(gate.reasons.join(" ")).toContain("no check runs observed");
  });

  it("refuses pending observations (queued and in progress)", () => {
    for (const status of ["queued", "in_progress"]) {
      const gate = evaluateChecksGate({
        revision: REVISION,
        checksName: CHECKS_JOB_NAME,
        observations: [observation({ status, conclusion: null })],
      });
      expect(gate.decision).toBe("refuse");
      expect(gate.reasons.join(" ")).toContain(`pending (status ${status})`);
    }
  });

  it("refuses a completed failure or null conclusion", () => {
    for (const conclusion of ["failure", "cancelled", "startup_failure", null]) {
      const gate = evaluateChecksGate({
        revision: REVISION,
        checksName: CHECKS_JOB_NAME,
        observations: [observation({ conclusion })],
      });
      expect(gate.decision).toBe("refuse");
      expect(gate.reasons.join(" ")).toContain(`concluded ${String(conclusion)}`);
    }
  });

  it("refuses when one of two same-name observations is bad (no stale green pass)", () => {
    const gate = evaluateChecksGate({
      revision: REVISION,
      checksName: CHECKS_JOB_NAME,
      observations: [observation(), observation({ conclusion: "failure" })],
    });
    expect(gate.decision).toBe("refuse");
    expect(gate.reasons.join(" ")).toContain("concluded failure");
  });
});

describe("the GitHub payload mapping and fetch layer", () => {
  it("maps check_runs onto gate observations", () => {
    const mapped = observationsFromGitHubPayload({
      total_count: 1,
      check_runs: [{ name: CHECKS_JOB_NAME, status: "completed", conclusion: "success", head_sha: REVISION }],
    });
    expect(mapped).toEqual([{ name: CHECKS_JOB_NAME, status: "completed", conclusion: "success", headSha: REVISION }]);
    expect(observationsFromGitHubPayload({})).toEqual([]);
  });

  it("errors carry the HTTP status, never the response body", async () => {
    const fetchImpl = async () => new Response("internal noise", { status: 502 });
    await expect(
      fetchChecksObservations({ repo: "o/r", sha: REVISION, token: "x", fetchImpl }),
    ).rejects.toThrow("502");
  });

  it("passes the authorization header and maps a success payload", async () => {
    let seenAuthorization = "";
    let seenUrl = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        check_runs: [{ name: CHECKS_JOB_NAME, status: "completed", conclusion: "success", head_sha: REVISION }],
      });
    };
    const observations = await fetchChecksObservations({
      repo: "wojtekpiskorz/kiero",
      sha: REVISION,
      token: "fixture-token-never-logged",
      fetchImpl,
    });
    expect(observations[0]?.headSha).toBe(REVISION);
    expect(seenUrl).toContain(`/commits/${REVISION}/check-runs`);
    expect(seenAuthorization).toBe("Bearer fixture-token-never-logged");
  });
});

describe("the CLI (exact workflow invocation shapes)", () => {
  it("exits 0 and writes a passing report from a fixture (fixture mode)", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-checks-cli-"));
    const fixture = join(directory, "observations.json");
    const report = join(directory, "checks-report.json");
    writeFileSync(
      fixture,
      JSON.stringify([{ name: CHECKS_JOB_NAME, status: "completed", conclusion: "success", headSha: REVISION }]),
    );
    const run = runGate(["--descriptor", stagingDescriptor, "--fixture", fixture, "--sha", REVISION, "--out", report]);
    expect(run.status).toBe(0);
    const parsed = readReport(report);
    expect(parsed).toMatchObject({
      source: "fixture",
      requestedSha: REVISION,
      checksName: CHECKS_JOB_NAME,
      decision: "pass",
    });
    expect(parsed.observed).toHaveLength(1);
  });

  it("exits 1 and writes the refusing report for a failing observation", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-checks-cli-"));
    const fixture = join(directory, "observations.json");
    const report = join(directory, "checks-report.json");
    writeFileSync(
      fixture,
      JSON.stringify([{ name: CHECKS_JOB_NAME, status: "completed", conclusion: "failure", headSha: REVISION }]),
    );
    const run = runGate(["--descriptor", stagingDescriptor, "--fixture", fixture, "--sha", REVISION, "--out", report]);
    expect(run.status).toBe(1);
    const parsed = readReport(report);
    expect(parsed.decision).toBe("refuse");
    expect(parsed.reasons.join(" ")).toContain("concluded failure");
    expect(parsed.observed[0]).toMatchObject({ conclusion: "failure", headSha: REVISION });
  });

  it("the exact workflow token invocation without a token records the missing NAME and refuses", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-checks-cli-"));
    const report = join(directory, "checks-report.json");
    // Identical to the release.yml step (repo/sha/token-env/out), run in a
    // runtime that does not carry CHECKS_GITHUB_TOKEN: truthful blocked.
    const run = runGate([
      "--repo", "wojtekpiskorz/kiero",
      "--sha", REVISION,
      "--descriptor", stagingDescriptor,
      "--token-env", "CHECKS_GITHUB_TOKEN",
      "--out", report,
    ]);
    expect(run.status).toBe(1);
    const parsed = readReport(report);
    expect(parsed.source).toBe("token-missing");
    expect(parsed.reasons.join(" ")).toContain("CHECKS_GITHUB_TOKEN");
    expect(JSON.stringify(parsed)).not.toMatch(/Bearer|fixture-token/i);
  });

  it("an unknown flag is a usage error, never silently ignored", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-checks-cli-"));
    const report = join(directory, "checks-report.json");
    const run = runGate([
      "--descriptor", stagingDescriptor,
      "--sha", REVISION,
      "--out", report,
      "--renamed-flag", "x",
    ]);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown argument");
    expect(existsSync(report)).toBe(false);
  });

  it("an invalid descriptor refuses before anything else and still writes the report", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-checks-cli-"));
    const badDescriptor = join(directory, "bad.json");
    const report = join(directory, "checks-report.json");
    writeFileSync(badDescriptor, JSON.stringify({ descriptorId: "x" }));
    const run = runGate([
      "--descriptor", badDescriptor,
      "--fixture", join(directory, "none.json"),
      "--sha", REVISION,
      "--out", report,
    ]);
    expect(run.status).toBe(1);
    expect(existsSync(report)).toBe(true);
    expect(readReport(report).source).toBe("invalid-descriptor");
  });
});
