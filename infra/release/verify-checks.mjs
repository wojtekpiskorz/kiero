/**
 * The deterministic Checks gate (R6): deployment must be refused unless the
 * NAMED Checks job of .github/workflows/checks.yml has concluded SUCCESS
 * for the EXACT release revision (GITHUB_SHA).
 *
 * The gate never trusts a green job on a neighbouring commit: every
 * observation must carry the requested SHA as its head SHA, be completed
 * and conclude success. Missing, pending (queued / in progress), failed,
 * null-conclusion and wrong-SHA observations all refuse.
 *
 * The CLI writes a checks report JSON (requested SHA, check name, observed
 * conclusions and head SHAs: public metadata, no tokens) BEFORE deciding
 * its exit code, so a refusal still leaves machine-readable evidence.
 *
 * Two observation sources:
 * - GitHub API (CI): --repo owner/name --sha <sha> --token-env <NAME>.
 *   The token is read from the named environment variable and used only
 *   in the Authorization header; its value is never logged or recorded.
 * - Fixture (tests/local rehearsal): --fixture observations.json.
 *
 * Used by .github/workflows/release.yml (before the deploy adapter) and by
 * tests/i7 (imported and spawned).
 */

/** The report fields every checks report carries (names only, never tokens). */
export function buildChecksReport({ requestedSha, checksName, source, observations, reasons, decision }) {
  return {
    generatedAtIso: new Date().toISOString(),
    source,
    requestedSha,
    checksName,
    decision,
    reasons,
    observed: observations.map((observation) => ({
      name: observation.name,
      status: observation.status,
      conclusion: observation.conclusion,
      headSha: observation.headSha,
    })),
  };
}

/**
 * The pure decision. `observations` are GitHub check runs for the commit:
 * { name, status, conclusion, headSha }. decision is "pass" only when the
 * named check exists, matches the exact revision, completed and succeeded.
 */
export function evaluateChecksGate({ revision, checksName, observations }) {
  const reasons = [];
  const matching = observations.filter((observation) => observation.name === checksName);
  if (observations.length > 0 && matching.length === 0) {
    reasons.push(
      `no check run named "${checksName}" observed (observed names: ${[...new Set(observations.map((o) => o.name))].join(", ") || "none"})`,
    );
  }
  if (observations.length === 0) {
    reasons.push(`no check runs observed for the requested revision (requested ${revision})`);
  }
  for (const observation of matching) {
    if (observation.headSha !== revision) {
      reasons.push(
        `check run "${checksName}" observed on head SHA ${String(observation.headSha)}, requested ${revision}`,
      );
    }
    if (observation.status === "queued" || observation.status === "in_progress") {
      reasons.push(`check run "${checksName}" is pending (status ${observation.status})`);
    } else if (observation.status !== "completed") {
      reasons.push(`check run "${checksName}" has non-terminal status ${String(observation.status)}`);
    }
    if (observation.conclusion !== "success") {
      reasons.push(
        `check run "${checksName}" concluded ${String(observation.conclusion)} (required: success)`,
      );
    }
  }
  return { decision: reasons.length === 0 ? "pass" : "refuse", reasons };
}

/** Maps a GitHub check-runs API payload onto gate observations. */
export function observationsFromGitHubPayload(payload) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  return runs.map((run) => ({
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
  }));
}

/**
 * Fetches the check runs of one commit. `token` is used only in the
 * Authorization header; errors carry the HTTP status, never the body.
 */
export async function fetchChecksObservations({ repo, sha, token, fetchImpl }) {
  const doFetch = fetchImpl ?? fetch;
  const response = await doFetch(
    `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${token}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`GitHub check-runs API answered ${response.status} for ${repo}@${sha.slice(0, 12)}`);
  }
  return observationsFromGitHubPayload(await response.json());
}

// ---------------------------------------------------------------------------
// CLI (release.yml calls this before every deploy)
// ---------------------------------------------------------------------------

const USAGE =
  "usage: verify-checks.mjs --descriptor <targets/x.json> --sha <full-sha> --out report.json (--repo o/r --token-env NAME | --fixture obs.json)";

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadTargetDescriptor } = await import("./target-descriptor.mjs");
  const { parseCliFlags } = await import("./cli-flags.mjs");
  const { readFileSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const parsed = parseCliFlags(process.argv.slice(2), {
    flags: ["descriptor", "repo", "sha", "token-env", "fixture", "out"],
  });
  const args = parsed.args ?? {};
  if (parsed.error !== undefined) {
    console.error(`checks gate USAGE ERROR: ${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  if (args.descriptor === undefined || args.out === undefined || args.sha === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const loaded = loadTargetDescriptor(args.descriptor);
  const writeReport = (report) => {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  };
  if (loaded.violations !== undefined) {
    const report = buildChecksReport({
      requestedSha: args.sha,
      checksName: null,
      source: "invalid-descriptor",
      observations: [],
      reasons: loaded.violations,
      decision: "refuse",
    });
    writeReport(report);
    console.error(`checks gate REFUSED: descriptor invalid (${loaded.violations.length} violations)`);
    process.exit(1);
  }
  const checksName = loaded.descriptor.checksName;
  let source;
  let observations;
  let reasons = [];
  if (args.fixture !== undefined) {
    source = "fixture";
    observations = JSON.parse(readFileSync(args.fixture, "utf8"));
  } else if (args.repo === undefined || args.tokenEnv === undefined) {
    console.error(`provide --repo and --token-env, or --fixture for tests\n${USAGE}`);
    process.exit(2);
  } else {
    const token = process.env[args.tokenEnv] ?? "";
    if (token === "") {
      source = "token-missing";
      observations = [];
      reasons = [
        `configuration ${args.tokenEnv} is not present in the runtime (name recorded, value never read)`,
      ];
    } else {
      try {
        source = "github-api";
        observations = await fetchChecksObservations({ repo: args.repo, sha: args.sha, token });
      } catch (error) {
        source = "github-api";
        observations = [];
        reasons = [`checks observations unavailable: ${error.message}`];
      }
    }
  }
  const gate = evaluateChecksGate({ revision: args.sha, checksName, observations });
  const decision = reasons.length > 0 ? "refuse" : gate.decision;
  const report = buildChecksReport({
    requestedSha: args.sha,
    checksName,
    source,
    observations,
    reasons: [...reasons, ...gate.reasons],
    decision,
  });
  writeReport(report);
  if (decision === "pass") {
    console.log(
      `checks gate PASSED: "${checksName}" completed success for ${args.sha.slice(0, 12)} (source ${source})`,
    );
    process.exit(0);
  }
  console.error(`checks gate REFUSED for ${args.sha.slice(0, 12)} (source ${source}):`);
  for (const reason of report.reasons) {
    console.error(`  - ${reason}`);
  }
  process.exit(1);
}
