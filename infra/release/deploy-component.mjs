/**
 * The checked deploy adapter (R6): the ONE executable the release
 * workflow uses to deploy components. It replaces the former echo
 * placeholders: no deploy step succeeds without deployed bytes, and no
 * refusal happens silently.
 *
 * Contract (issue #131): given an authorized target descriptor, the
 * expected revision and a checks report, for every selected component it
 *
 *   1. requires the deterministic Checks success for the EXACT revision
 *      (re-validates the report itself: a refused report can never
 *      reach a transport, even if the producing step failed);
 *   2. requires the runtime environment label (KIERO_ENVIRONMENT) to
 *      equal the descriptor target (authorization);
 *   3. validates configuration NAMES (presence only, never values);
 *   4. builds the checked-out tree and records the artifact digest;
 *   5. hands REAL artifact paths and the validated descriptor to the
 *      component's transport, which returns the remote identity;
 *   6. appends one truthful terminal outcome per component to the
 *      evidence ledger: deployed (digest + remote identity), skipped
 *      (only when the descriptor excludes the component) or blocked
 *      (missing/unauthorized configuration, refused Checks, failed
 *      build/transport: names only).
 *
 * Exit code is non-zero when ANY component is blocked; outcomes and the
 * ledger are still written, so a blocked run fails while uploading
 * evidence (the workflow uploads with if: always()).
 *
 * Importable (tests/i7) and runnable (release.yml).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTargetDescriptor, committedDescriptorViolations, isCommittedDescriptorPath } from "./target-descriptor.mjs";
import { parseCliFlags } from "./cli-flags.mjs";
import { evaluateChecksGate } from "./verify-checks.mjs";
import {
  appendReleaseRecord,
  buildComponentOutcomeRecord,
} from "./record-release-evidence.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The transport modules, resolved by the descriptor's kind field. */
const TRANSPORT_MODULES = {
  "wrangler-pages": "./transports/wrangler-pages.mjs",
  "wrangler-deploy": "./transports/wrangler-deploy.mjs",
  "convex-deploy": "./transports/convex-deploy.mjs",
  stub: "./transports/stub.mjs",
};

/** The blocked reasons the adapter can record (all names-only payloads). */
export const BLOCKED_REASONS = [
  "invalid-descriptor",
  "unauthorized-environment",
  "checks-missing",
  "checks-refused",
  "missing-configuration",
  "build-failed",
  "missing-artifact",
  "transport-failed",
];

/** Runs a shell command, capturing a bounded tail of its output. */
export function runCommand(command, { cwd, env, timeoutMs = 15 * 60_000 } = {}) {
  const result = spawnSync(command, {
    shell: true,
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    ok: result.status === 0,
    exitCode: result.status,
    outputTail: output.length > 2000 ? output.slice(-2000) : output,
  };
}

/**
 * Digests an artifact path (a file or a directory tree). Directories are
 * digested as a manifest: one `<sha256>  <relative-path>` line per file in
 * sorted order, then the manifest itself is hashed, so the recorded digest
 * covers every byte and every path.
 */
export function digestArtifactPath(artifactPath) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory).sort()) {
      const entryPath = join(directory, entry);
      if (statSync(entryPath).isDirectory()) {
        walk(entryPath, `${prefix}${entry}/`);
      } else {
        files.push({ relativePath: `${prefix}${entry}`, absolutePath: entryPath });
      }
    }
  };
  if (statSync(artifactPath).isDirectory()) {
    walk(artifactPath, "");
  } else {
    files.push({ relativePath: "", absolutePath: artifactPath });
  }
  const manifest = files
    .map((file) => {
      const digest = createHash("sha256").update(readFileSync(file.absolutePath)).digest("hex");
      return `${digest}  ${file.relativePath}`;
    })
    .join("\n");
  return {
    digest: createHash("sha256").update(manifest, "utf8").digest("hex"),
    fileCount: files.length,
  };
}

function loadTransport(kind) {
  const modulePath = TRANSPORT_MODULES[kind];
  if (modulePath === undefined) {
    throw new Error(`no transport module for kind "${kind}"`);
  }
  return import(modulePath);
}

async function runTransport({ component, descriptor, artifactPath, digest, revision, env, cwd }) {
  const transportModule = await loadTransport(component.transport.kind);
  return transportModule.run({
    component,
    descriptor,
    transport: component.transport,
    artifactPath,
    digest,
    revision,
    env,
    cwd,
  });
}

function blocked(componentId, blockedReason, detail = {}) {
  return { component: componentId, outcome: "blocked", blockedReason, ...detail };
}

/**
 * The full orchestration. `options.env` defaults to process.env;
 * `options.cwd` (build cwd) defaults to the repository root.
 * Returns { outcomes, exitCode }.
 */
export async function deployComponents({
  descriptorPath,
  revision,
  checksReportPath,
  componentIds = null,
  env = process.env,
  cwd = REPO_ROOT,
  ledgerPath = null,
  outcomesPath = null,
}) {
  const loaded = loadTargetDescriptor(descriptorPath);
  if (loaded.violations !== undefined) {
    return { violations: loaded.violations, outcomes: [], exitCode: 1 };
  }
  const descriptor = loaded.descriptor;
  // A COMMITTED descriptor (the files the workflow references under
  // infra/release/targets) may never use the stub transport: a stub there
  // could mint synthetic "deployed" evidence from a committed edit.
  if (isCommittedDescriptorPath(descriptorPath, cwd)) {
    const committedViolations = committedDescriptorViolations(descriptor);
    if (committedViolations.length > 0) {
      return { violations: committedViolations, outcomes: [], exitCode: 1 };
    }
  }
  const selected =
    componentIds === null
      ? descriptor.components
      : descriptor.components.filter((component) => componentIds.includes(component.id));
  if (componentIds !== null && selected.length !== componentIds.length) {
    const known = descriptor.components.map((component) => component.id);
    const unknown = componentIds.filter((id) => !known.includes(id));
    return { unknownComponents: unknown, knownComponents: known, exitCode: 2 };
  }

  // Whole-run refusals: every selected component is blocked identically
  // and NO transport is invoked.
  const runtimeLabel = env.KIERO_ENVIRONMENT ?? "";
  const unauthorizedEnvironment =
    runtimeLabel !== descriptor.target
      ? {
          observedEnvironmentLabel: runtimeLabel === "" ? "(absent)" : runtimeLabel,
          requiredEnvironmentLabel: descriptor.target,
        }
      : null;
  let checksSummary = null;
  let checksBlockedReason = null;
  let checksRefused = null;
  try {
    const report = JSON.parse(readFileSync(checksReportPath, "utf8"));
    const gate = evaluateChecksGate({
      revision,
      checksName: descriptor.checksName,
      observations: Array.isArray(report.observed) ? report.observed : [],
    });
    const reasons = [...gate.reasons];
    if (report.requestedSha !== revision) {
      reasons.push(
        `checks report was requested for ${String(report.requestedSha)}, deploy requested ${revision}`,
      );
    }
    checksSummary = {
      requestedSha: report.requestedSha ?? null,
      decision: reasons.length === 0 ? "pass" : "refuse",
      reasons,
    };
    if (checksSummary.decision === "refuse") {
      checksBlockedReason = "checks-refused";
      checksRefused = checksSummary;
    }
  } catch (error) {
    checksBlockedReason = "checks-missing";
    checksRefused = {
      requestedSha: null,
      decision: "refuse",
      reasons: [`checks report is missing or unreadable: ${error.message}`],
    };
  }

  const outcomes = [];
  // Every terminal outcome is appended to the ledger IMMEDIATELY, so an
  // unexpected throw in a later component can never lose an earlier
  // component's record: each component ends in exactly one outcome that
  // reaches the append-only evidence.
  const record = (outcome) => {
    outcomes.push(outcome);
    if (ledgerPath !== null) {
      appendReleaseRecord(
        buildComponentOutcomeRecord({
          target: descriptor.target,
          revision,
          descriptorId: descriptor.descriptorId,
          outcome,
        }),
        ledgerPath,
      );
    }
  };
  for (const component of selected) {
    if (unauthorizedEnvironment !== null) {
      record(blocked(component.id, "unauthorized-environment", unauthorizedEnvironment));
      continue;
    }
    if (checksRefused !== null) {
      record(blocked(component.id, checksBlockedReason ?? "checks-refused", { checks: checksRefused }));
      continue;
    }
    if (!component.included) {
      record({ component: component.id, outcome: "skipped", skipReason: "excluded-by-descriptor" });
      continue;
    }
    const missing = component.requiredConfig.filter(
      (name) => (env[name] ?? "") === "",
    );
    if (missing.length > 0) {
      record(blocked(component.id, "missing-configuration", { missingConfigNames: missing }));
      continue;
    }
    if (component.build !== null) {
      const build = runCommand(component.build, { cwd, env });
      if (!build.ok) {
        record(
          blocked(component.id, "build-failed", {
            buildExitCode: build.exitCode,
            buildOutputTail: build.outputTail,
          }),
        );
        continue;
      }
    }
    // Digesting the artifact can throw for reasons outside the adapter's
    // control (a vanished path, an unreadable file, a broken symlink in
    // the tree); such a throw is itself a terminal blocked outcome, never
    // a crash that would swallow the run's evidence.
    let artifactPath;
    let digest;
    let fileCount;
    try {
      artifactPath = resolve(cwd, component.artifact);
      if (!existsSync(artifactPath)) {
        throw new Error(`artifact path does not exist: ${component.artifact}`);
      }
      ({ digest, fileCount } = digestArtifactPath(artifactPath));
    } catch (error) {
      record(
        blocked(component.id, "missing-artifact", {
          artifactPath: component.artifact,
          artifactError: error.message,
        }),
      );
      continue;
    }
    try {
      const { remoteIdentity } = await runTransport({
        component,
        descriptor,
        artifactPath,
        digest,
        revision,
        env,
        cwd,
      });
      if (
        remoteIdentity === undefined ||
        typeof remoteIdentity !== "object" ||
        typeof remoteIdentity.id !== "string" ||
        remoteIdentity.id === ""
      ) {
        throw new Error("transport returned no remote identity");
      }
      record({
        component: component.id,
        outcome: "deployed",
        digest,
        fileCount,
        transportKind: component.transport.kind,
        remoteIdentity,
      });
    } catch (error) {
      record(blocked(component.id, "transport-failed", { transportError: error.message }));
    }
  }

  if (outcomesPath !== null) {
    mkdirSync(dirname(outcomesPath), { recursive: true });
    writeFileSync(
      outcomesPath,
      `${JSON.stringify({ descriptorId: descriptor.descriptorId, revision, outcomes }, null, 2)}\n`,
      "utf8",
    );
  }
  const exitCode = outcomes.some((outcome) => outcome.outcome === "blocked") ? 1 : 0;
  return { outcomes, exitCode };
}

// ---------------------------------------------------------------------------
// CLI (release.yml calls this for every deploy job)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const { args, error } = parseCliFlags(argv, {
    flags: ["descriptor", "revision", "checks-report", "component", "ledger", "outcomes", "cwd"],
    multi: ["component"],
  });
  if (error !== undefined) {
    return { error };
  }
  return { args };
}

const USAGE =
  "usage: deploy-component.mjs --descriptor <targets/x.json> --revision <sha> --checks-report <report.json> [--component <id>]... [--ledger <releases.jsonl>] [--outcomes <outcomes.json>] [--cwd <build workspace>]";

if (import.meta.url === `file://${process.argv[1]}`) {
  const parsed = parseArgs(process.argv.slice(2));
  const args = parsed.args ?? {};
  if (parsed.error !== undefined) {
    console.error(`deploy adapter USAGE ERROR: ${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  if (args.descriptor === undefined || args.revision === undefined || args.checksReport === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const result = await deployComponents({
    descriptorPath: args.descriptor,
    revision: args.revision,
    checksReportPath: args.checksReport,
    componentIds: args.component === undefined ? null : args.component,
    ledgerPath: args.ledger ?? null,
    outcomesPath: args.outcomes ?? null,
    ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
  });
  if (result.exitCode === 2) {
    console.error(
      `unknown component(s) ${result.unknownComponents.join(", ")}; the descriptor declares: ${result.knownComponents.join(", ")}`,
    );
    process.exit(2);
  }
  if (result.violations !== undefined) {
    console.error("deploy REFUSED: the target descriptor is invalid:");
    for (const violation of result.violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }
  const summarizeOutcome = (outcome) => {
    switch (outcome.outcome) {
      case "deployed":
        return `digest=${outcome.digest.slice(0, 12)}... files=${outcome.fileCount} remote=${outcome.remoteIdentity.id}`;
      case "skipped":
        return `reason=${outcome.skipReason}`;
      case "blocked": {
        if (outcome.blockedReason === "missing-configuration") {
          return `missing-configuration names=[${outcome.missingConfigNames.join(", ")}]`;
        }
        if (outcome.checks !== undefined) {
          return `${outcome.blockedReason} checks-decision=${outcome.checks.decision}`;
        }
        return outcome.blockedReason;
      }
      default:
        return outcome.outcome;
    }
  };
  for (const outcome of result.outcomes) {
    console.log(`[${outcome.outcome}] ${outcome.component}: ${summarizeOutcome(outcome)}`);
  }
  process.exit(result.exitCode);
}
