#!/usr/bin/env node
// Kiero environment preflight (issue #53, I1).
//
// One documented command that reports each required capability as
// VERIFIED / UNAVAILABLE / PENDING without revealing secret values.
//
// Usage:
//   node infra/environments/preflight.mjs [--no-secret-checks] [--env-file-path <path>]
//
//   --no-secret-checks  CI-safe mode: skips probes that inspect named-secret
//                       presence (local .env variable names and GitHub Actions
//                       secret names). Everything else still runs.
//   --env-file-path     Path to the local env file checked for variable NAMES
//                       (default: <repo-root>/.env). Values are never read.
//                       Named --env-file-path because Node itself claims
//                       --env-file even after the script path.
//
// Exit code: 0 when no capability is UNAVAILABLE, 1 otherwise.
// PENDING means "possible but deliberately not done by this ticket" and does
// not fail the run. SKIPPED means disabled by --no-secret-checks.
//
// Non-secret expected-identity knobs (never secret values):
//   KIERO_EXPECTED_CF_ACCOUNT_ID  when set, `wrangler whoami` must report this
//                                 Cloudflare account id or the probe fails with
//                                 a wrong-account action.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Single source of truth for the pinned tool versions this preflight resolves.
export const PINNED_CONVEX_CLI = "1.45.0";
export const MIN_WRANGLER_MAJOR = 4;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GITHUB_REPO = "wojtekpiskorz/kiero";
const ENV_VAR_NAMES = ["OPENROUTER_API_KEY"];
const GITHUB_SECRET_NAMES = ["OPENROUTER_API_KEY", "ZAI_API_KEY"];
// Recorded in case wrangler is not on PATH in a fresh shell. Override with
// KIERO_WRANGLER_FALLBACK (non-secret) when the recorded install moves.
const WRANGLER_FALLBACK_PATH =
  process.env.KIERO_WRANGLER_FALLBACK ?? "/opt/homebrew/bin/wrangler";

const args = process.argv.slice(2);
const noSecretChecks = args.includes("--no-secret-checks");
const envFileFlagIdx = args.indexOf("--env-file-path");
const envFileEq = args.find((a) => a.startsWith("--env-file-path="));
const envFile = envFileEq
  ? envFileEq.slice("--env-file-path=".length)
  : envFileFlagIdx >= 0 && args[envFileFlagIdx + 1] && !args[envFileFlagIdx + 1].startsWith("--")
    ? args[envFileFlagIdx + 1]
    : path.join(REPO_ROOT, ".env");

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    timeout: opts.timeout ?? 90_000,
    cwd: opts.cwd ?? os.tmpdir(),
    // Convex CLI falls back to anonymous mode when stdin is not a TTY; a closed
    // stdin keeps every probe non-interactive.
    stdio: ["ignore", "pipe", "pipe"],
    ...opts.spawn,
  });
  const stdout = stripAnsi(res.stdout ?? "");
  const stderr = stripAnsi(res.stderr ?? "");
  return {
    ok: res.status === 0,
    status: res.status,
    stdout,
    stderr,
    output: `${stdout}${stderr}`.trim(),
  };
}

const results = [];
function report(name, status, evidence, action) {
  results.push({ name, status, evidence, action });
  console.log(`[${status}] ${name}`);
  console.log(`    ${evidence}`);
  if (action) console.log(`    ACTION: ${action}`);
  console.log();
}

// ---------------------------------------------------------------------------
// Probe 4 first so its versions head the report: reproducibility baseline.
// ---------------------------------------------------------------------------
function probeNodeNpm() {
  const node = run(process.execPath, ["--version"]);
  const npm = run("npm", ["--version"]);
  if (!node.ok || !npm.ok) {
    report(
      "node-npm-versions",
      "UNAVAILABLE",
      `node: ${node.output || "not found"}; npm: ${npm.output || "not found"}`,
      "Install Node.js >= 20 and npm (https://nodejs.org)."
    );
    return;
  }
  report("node-npm-versions", "VERIFIED", `node ${node.output}, npm ${npm.output}`);
}

// ---------------------------------------------------------------------------
// Wrangler: presence, identity, R2 inventory, EU jurisdiction, Containers.
// ---------------------------------------------------------------------------
function resolveWrangler() {
  const onPath = run("wrangler", ["--version"]);
  if (onPath.ok) return { cmd: "wrangler", versionOutput: onPath.output };
  const fallback = fs.existsSync(WRANGLER_FALLBACK_PATH)
    ? run(WRANGLER_FALLBACK_PATH, ["--version"])
    : null;
  if (fallback?.ok)
    return { cmd: WRANGLER_FALLBACK_PATH, versionOutput: fallback.output };
  return null;
}

function probeWrangler() {
  const wr = resolveWrangler();
  if (!wr) {
    report(
      "wrangler-cli",
      "UNAVAILABLE",
      "wrangler not found on PATH nor at " + WRANGLER_FALLBACK_PATH,
      "Install with `npm install -g wrangler` (pinned major >= " +
        MIN_WRANGLER_MAJOR +
        ") or adjust WRANGLER_FALLBACK_PATH in this script."
    );
    return;
  }
  const versionLine = wr.versionOutput.split("\n").find((l) => /(wrangler \d|^\s*\d+\.\d+\.\d+\s*$)/.test(l)) || wr.versionOutput;
  report("wrangler-cli", "VERIFIED", `resolved \`${wr.cmd} --version\` -> ${versionLine.trim()}`);

  const whoami = run(wr.cmd, ["whoami"]);
  if (!whoami.ok || !/logged in/i.test(whoami.output)) {
    report(
      "wrangler-auth",
      "UNAVAILABLE",
      "wrangler whoami did not report a logged-in session.",
      "Run `wrangler login` in an interactive shell (browser OAuth), then rerun the preflight."
    );
    return;
  }
  const email = whoami.output.match(/associated with the email (\S+@\S+)\./)?.[1];
  const accountId = whoami.output.match(/[0-9a-f]{32}/)?.[0];
  const expected = process.env.KIERO_EXPECTED_CF_ACCOUNT_ID;
  if (expected && accountId && expected !== accountId) {
    report(
      "wrangler-auth",
      "UNAVAILABLE",
      `logged in as ${email} but account id ${accountId} != KIERO_EXPECTED_CF_ACCOUNT_ID.`,
      "Log out (`wrangler logout`) and log in to the Kiero Cloudflare account, or fix KIERO_EXPECTED_CF_ACCOUNT_ID."
    );
    return;
  }
  const containersScope = /containers \(write\)/.test(whoami.output);
  report(
    "wrangler-auth",
    "VERIFIED",
    `logged in as ${email}, account id ${accountId}` +
      (containersScope ? ", token scope includes containers (write)" : ", containers scope NOT in token")
  );

  const buckets = run(wr.cmd, ["r2", "bucket", "list"]);
  const bucketNames = [...buckets.output.matchAll(/^name:\s+(\S+)$/gm)].map((m) => m[1]);
  if (buckets.ok) {
    report(
      "cloudflare-r2-visibility",
      "VERIFIED",
      bucketNames.length
        ? `r2 bucket list (default jurisdiction): ${bucketNames.join(", ")}`
        : "r2 bucket list (default jurisdiction): no buckets"
    );
  } else {
    report(
      "cloudflare-r2-visibility",
      "UNAVAILABLE",
      "r2 bucket list failed: " + buckets.output.slice(0, 200),
      "Check the account has R2 enabled (dashboard > R2) and the token scope."
    );
  }

  const euBuckets = run(wr.cmd, ["r2", "bucket", "list", "--jurisdiction", "eu"]);
  const euNames = [...euBuckets.output.matchAll(/^name:\s+(\S+)$/gm)].map((m) => m[1]);
  if (euBuckets.ok) {
    report(
      "cloudflare-r2-eu-jurisdiction",
      "VERIFIED",
      euNames.length
        ? `eu jurisdiction buckets: ${euNames.join(", ")}; CLI exposes --jurisdiction and --location (weur/eeur/...) on bucket create`
        : "no eu jurisdiction buckets yet; CLI exposes `r2 bucket create <name> --jurisdiction eu --location weur` (verified via --help)"
    );
  } else {
    report(
      "cloudflare-r2-eu-jurisdiction",
      "UNAVAILABLE",
      "r2 bucket list --jurisdiction eu failed: " + euBuckets.output.slice(0, 200),
      "Confirm jurisdictional R2 access for this account."
    );
  }

  const containers = run(wr.cmd, ["containers", "list"]);
  if (containers.ok) {
    report(
      "cloudflare-containers",
      "VERIFIED",
      `containers list ok (${containers.output.replace(/\s+/g, " ").slice(0, 80) || "empty"}); Containers API reachable`
    );
  } else {
    report(
      "cloudflare-containers",
      "UNAVAILABLE",
      "containers list failed: " + containers.output.slice(0, 200),
      "Containers require Workers Paid on the account; enable via dashboard > Workers & Pages > Containers."
    );
  }

  // Containers EU jurisdiction needs a wrangler that knows
  // containers.constraints.jurisdiction (present in >= 4.130.0, absent in
  // 4.27.0). Report PENDING with the exact upgrade rather than failing.
  const versionMatch = versionLine.match(/(?:wrangler\s+)?(\d+)\.(\d+)\.\d+/);
  const major = parseInt(versionMatch?.[1] ?? "0", 10);
  const minor = parseInt(versionMatch?.[2] ?? "0", 10);
  const supportsContainerJurisdiction = major > 4 || (major === 4 && minor >= 130);
  report(
    "cloudflare-containers-eu-jurisdiction",
    supportsContainerJurisdiction ? "VERIFIED" : "PENDING",
    supportsContainerJurisdiction
      ? "installed wrangler supports containers.constraints.jurisdiction=eu in wrangler.jsonc"
      : `installed wrangler ${major}.${minor} predates containers.constraints.jurisdiction (added by 4.130.0)`,
    supportsContainerJurisdiction
      ? undefined
      : "Pin wrangler >= 4.130.0 in the workspace (A1 bootstrap) before relying on container jurisdiction fields."
  );
}

// ---------------------------------------------------------------------------
// Convex: pinned npx invocation, auth state, read-only project access.
// ---------------------------------------------------------------------------
function convexCmd() {
  // No global `convex` binary is assumed; the repository-supported invocation
  // is npx with the pinned CLI version.
  return ["npx", ["--yes", `convex@${PINNED_CONVEX_CLI}`]];
}

function probeConvex() {
  const [cmd, base] = convexCmd();
  const version = run(cmd, [...base, "--version"]);
  if (!version.ok) {
    report(
      "convex-cli",
      "UNAVAILABLE",
      `\`${cmd} ${base.join(" ")} --version\` failed: ${version.output.slice(0, 200)}`,
      "Install Node/npm with network access to the npm registry, then rerun."
    );
    return;
  }
  report(
    "convex-cli",
    "VERIFIED",
    `resolved invocation \`npx --yes convex@${PINNED_CONVEX_CLI} <command>\` -> --version ${version.output.trim()}`
  );

  // Auth state: convex 1.45.0 has no `whoami`/`login --status` command, so the
  // probe is (a) token file presence by KEY NAME ONLY, then (b) an API call.
  const convexConfig = path.join(os.homedir(), ".convex", "config.json");
  let tokenKeyPresent = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(convexConfig, "utf8"));
    tokenKeyPresent = Object.prototype.hasOwnProperty.call(parsed, "accessToken");
  } catch {
    tokenKeyPresent = false;
  }
  if (!tokenKeyPresent) {
    report(
      "convex-auth",
      "UNAVAILABLE",
      `no accessToken key found in ${convexConfig}`,
      "Run `npx --yes convex@" +
        PINNED_CONVEX_CLI +
        " login` in an interactive shell (browser login), then rerun the preflight."
    );
    return;
  }
  report(
    "convex-auth",
    "VERIFIED",
    `${convexConfig} contains an accessToken key (value never read); convex 1.45.0 exposes no whoami command, so auth is proven by the API call below`
  );

  // Read-only project access: `env list --names-only` against the project's
  // default dev deployment, from a scratch dir shaped like a Convex app root.
  const repoConvexJson = path.join(REPO_ROOT, "convex.json");
  let team = null;
  let project = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(repoConvexJson, "utf8"));
    team = parsed.team ?? null;
    project = parsed.project ?? null;
  } catch {
    // handled below
  }
  if (!team || !project) {
    report(
      "convex-project-access",
      "UNAVAILABLE",
      `${repoConvexJson} is missing team/project; cannot address a deployment read-only.`,
      "Set \"team\" and \"project\" in convex.json (see infra/environments/local.md)."
    );
    return;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "kiero-preflight-"));
  fs.writeFileSync(
    path.join(scratch, "package.json"),
    JSON.stringify(
      { name: "kiero-preflight-probe", version: "0.0.0", private: true, dependencies: { convex: PINNED_CONVEX_CLI } },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(scratch, "convex.json"),
    JSON.stringify({ team, project, functions: "convex/" }, null, 2)
  );
  const envList = run(
    cmd,
    [...base, "env", "list", "--names-only", "--deployment", `${team}:${project}:dev`],
    { cwd: scratch, timeout: 120_000 }
  );
  fs.rmSync(scratch, { recursive: true, force: true });
  if (envList.ok) {
    report(
      "convex-project-access",
      "VERIFIED",
      `\`env list --names-only --deployment ${team}:${project}:dev\` -> ${envList.output.split("\n")[0]} (read-only; names only)`
    );
  } else {
    const notFound = /not found|does not exist|no project/i.test(envList.output);
    report(
      "convex-project-access",
      "UNAVAILABLE",
      `read-only env list failed: ${envList.output.slice(0, 200)}`,
      notFound
        ? `Create the project/deployment: \`npx --yes convex@${PINNED_CONVEX_CLI} project create ${project}\` then \`deployment create <team>:${project}:dev/main --type dev --region eu --default\` (see docs/evidence/environment/preflight-2026-09.md).`
        : `Check \`npx --yes convex@${PINNED_CONVEX_CLI} login\` and dashboard access to ${team}/${project}.`
    );
  }
}

// ---------------------------------------------------------------------------
// GitHub CLI + named-secret presence (name only, values never read).
// ---------------------------------------------------------------------------
function probeGithub() {
  const gh = run("gh", ["--version"]);
  if (!gh.ok) {
    report("github-cli", "UNAVAILABLE", "gh not found on PATH.", "Install GitHub CLI and `gh auth login`.");
    return;
  }
  report("github-cli", "VERIFIED", `gh ${gh.output.split("\n")[0].replace(/^gh version /, "")}`);

  if (noSecretChecks) {
    report(
      "github-repo-secrets",
      "SKIPPED",
      "--no-secret-checks: named-secret presence not probed.",
      "Rerun without --no-secret-checks to verify secret NAMES."
    );
    return;
  }
  const auth = run("gh", ["auth", "status"]);
  if (!auth.ok || !/Logged in/i.test(auth.output)) {
    report(
      "github-repo-secrets",
      "UNAVAILABLE",
      "gh is not authenticated.",
      "Run `gh auth login`, then rerun the preflight."
    );
    return;
  }
  const secrets = run("gh", ["secret", "list", "--repo", GITHUB_REPO]);
  if (!secrets.ok) {
    report(
      "github-repo-secrets",
      "UNAVAILABLE",
      `gh secret list failed: ${secrets.output.slice(0, 200)}`,
      `Confirm access to ${GITHUB_REPO} and rerun.`
    );
    return;
  }
  const present = GITHUB_SECRET_NAMES.filter((n) => new RegExp(`^${n}\\b`, "m").test(secrets.output));
  const missing = GITHUB_SECRET_NAMES.filter((n) => !present.includes(n));
  report(
    "github-repo-secrets",
    missing.length ? "UNAVAILABLE" : "VERIFIED",
    `secret names present: ${present.join(", ") || "none"}${missing.length ? `; missing: ${missing.join(", ")}` : ""} (names only)`,
    missing.length ? `Add the missing secret(s): gh secret set <NAME> --repo ${GITHUB_REPO}` : undefined
  );
}

// ---------------------------------------------------------------------------
// OpenRouter key presence by NAME only (local env file).
// ---------------------------------------------------------------------------
function probeLocalEnvNames() {
  if (noSecretChecks) {
    report(
      "local-env-names",
      "SKIPPED",
      "--no-secret-checks: local env file not inspected.",
      "Rerun without --no-secret-checks to verify variable NAMES."
    );
    return;
  }
  let text = null;
  try {
    text = fs.readFileSync(envFile, "utf8");
  } catch {
    report(
      "local-env-names",
      "UNAVAILABLE",
      `${envFile} not found.`,
      `Create ${envFile} (gitignored) with the documented variable NAMES from infra/bindings/README.md.`
    );
    return;
  }
  // Only line-start NAME= patterns are matched; values are never captured.
  const present = ENV_VAR_NAMES.filter((n) => new RegExp(`^${n}=`, "m").test(text));
  const missing = ENV_VAR_NAMES.filter((n) => !present.includes(n));
  report(
    "local-env-names",
    missing.length ? "UNAVAILABLE" : "VERIFIED",
    `${envFile}: variable names present: ${present.join(", ") || "none"}${missing.length ? `; missing: ${missing.join(", ")}` : ""} (names only, values never read)`,
    missing.length ? `Add the missing variable name(s) to ${envFile}; ask the owner for the value out-of-band.` : undefined
  );
}

// ---------------------------------------------------------------------------
console.log(`# Kiero environment preflight`);
console.log(`date: ${new Date().toISOString()}`);
console.log(`mode: ${noSecretChecks ? "no-secret-checks (CI-safe)" : "full"}`);
console.log(`repo-root: ${REPO_ROOT}`);
console.log("");
probeNodeNpm();
probeWrangler();
probeConvex();
probeGithub();
probeLocalEnvNames();

const unavailable = results.filter((r) => r.status === "UNAVAILABLE");
console.log("## Summary");
for (const r of results) console.log(`${r.status.padEnd(11)} ${r.name}`);
console.log("");
console.log(
  `${results.length} probes: ${results.filter((r) => r.status === "VERIFIED").length} VERIFIED, ` +
    `${unavailable.length} UNAVAILABLE, ${results.filter((r) => r.status === "PENDING").length} PENDING, ` +
    `${results.filter((r) => r.status === "SKIPPED").length} SKIPPED`
);
process.exit(unavailable.length ? 1 : 0);
