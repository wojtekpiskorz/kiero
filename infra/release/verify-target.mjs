/**
 * Release target verification (I7/R6): the wrong-environment guard every
 * deploy job runs BEFORE touching anything.
 *
 * Three layers, all deterministic and secret-free (names only, never
 * values):
 *
 * - WORKFLOW STRUCTURE: given the workflow text and a job id, extract
 *   every `${{ secrets.NAME }}` reference and require the environment's
 *   prefix (STAGING_ for the staging job, PRODUCTION_ for the production
 *   job). A post-review edit that smuggles a cross-environment secret
 *   into a job fails here, at deploy time, not only in review.
 * - RUNTIME LABEL: the environment label the run carries (KIERO_ENVIRONMENT)
 *   must equal the target; a staging deploy that believes it is "dev" or
 *   "alpha-production" refuses to start.
 * - TARGET DESCRIPTOR (R6): the shared descriptor (target-descriptor.mjs)
 *   must be valid, name the same target and GitHub environment, and pin a
 *   checksName that really is a job name in .github/workflows/checks.yml,
 *   so the Checks identity the deploy gate matches cannot drift silently.
 *
 * Used by .github/workflows/release.yml and by tests/i7 (imported).
 */

import {
  committedDescriptorViolations,
  isCommittedDescriptorPath,
  loadTargetDescriptor,
  RELEASE_TARGETS,
} from "./target-descriptor.mjs";
import { parseCliFlags } from "./cli-flags.mjs";

// RELEASE_TARGETS is defined ONCE, canonically in target-descriptor.mjs;
// it is re-exported here so the guard's historical import surface stays
// stable for tests and node consumers.
export { RELEASE_TARGETS };

/**
 * Extracts the block of one top-level job from workflow YAML text
 * (indentation-based; jobs live at two spaces under `jobs:`).
 */
export function extractJobBlock(workflowText, jobId) {
  const lines = workflowText.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    return null;
  }
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    // The job block ends at the next two-space-indented key or EOF.
    if (/^  [A-Za-z0-9_-]+:/.test(line)) {
      break;
    }
    block.push(line);
  }
  return block.join("\n");
}

/** Every `secrets.NAME` reference inside one job block. */
export function extractSecretReferences(jobBlock) {
  const names = new Set();
  for (const match of jobBlock.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/** The `environment:` value declared by the job block, when present. */
export function extractJobEnvironment(jobBlock) {
  const match = /(?:^|\n)\s+environment:\s*([A-Za-z0-9_.-]+)/.exec(jobBlock);
  return match === null ? null : match[1];
}

/**
 * The full check. Returns a list of violations (strings of NAMES and
 * prefixes only); empty means the target is verified.
 */
export function checkReleaseTarget({
  target,
  workflowText,
  jobId,
  environmentLabel,
}) {
  const violations = [];
  const spec = RELEASE_TARGETS[target];
  if (spec === undefined) {
    return [`unknown target "${target}" (expected one of ${Object.keys(RELEASE_TARGETS).join(", ")})`];
  }
  const block = extractJobBlock(workflowText, jobId);
  if (block === null) {
    return [`workflow declares no job "${jobId}"`];
  }
  const declaredEnvironment = extractJobEnvironment(block);
  if (declaredEnvironment !== spec.environmentName) {
    violations.push(
      `job ${jobId} must declare environment: ${spec.environmentName} (found ${String(declaredEnvironment)})`,
    );
  }
  for (const name of extractSecretReferences(block)) {
    if (!name.startsWith(spec.secretPrefix)) {
      violations.push(
        `job ${jobId} references secret ${name} without the required ${spec.secretPrefix} prefix`,
      );
    }
  }
  if (environmentLabel !== undefined && environmentLabel !== target) {
    violations.push(
      `runtime environment label is "${environmentLabel}" but the target is "${target}"`,
    );
  }
  return violations;
}

/** Escapes a literal string for embedding in a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cross-checks the shared target descriptor against the requested target
 * and the deterministic Checks workflow (R6). Returns violations; empty
 * means the descriptor agrees with both.
 */
export function checkDescriptorAgainstWorkflow({ descriptor, target, checksWorkflowText }) {
  const violations = [];
  if (descriptor.target !== target) {
    violations.push(
      `descriptor target is "${descriptor.target}" but the requested target is "${target}"`,
    );
  }
  const spec = RELEASE_TARGETS[target];
  if (spec === undefined) {
    return [`unknown target "${target}" (expected one of ${Object.keys(RELEASE_TARGETS).join(", ")})`];
  }
  if (descriptor.githubEnvironment !== spec.environmentName) {
    violations.push(
      `descriptor githubEnvironment is "${descriptor.githubEnvironment}" but ${target} requires "${spec.environmentName}"`,
    );
  }
  if (checksWorkflowText !== undefined) {
    const jobNamePattern = new RegExp(`name:\\s*["']?${escapeRegExp(descriptor.checksName)}["']?\\s*$`, "m");
    if (!jobNamePattern.test(checksWorkflowText)) {
      violations.push(
        `descriptor checksName "${descriptor.checksName}" is not a job name in the Checks workflow`,
      );
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// CLI (release.yml calls this before every deploy)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const { args, error } = parseCliFlags(argv, {
    flags: ["target", "workflow", "descriptor", "checks-workflow"],
  });
  if (error !== undefined) {
    return { error };
  }
  return { args };
}

const USAGE =
  "usage: verify-target.mjs --target <staging|production> --workflow <release.yml> [--descriptor <targets/x.json>] [--checks-workflow <checks.yml>]";

if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync } = await import("node:fs");
  const parsed = parseArgs(process.argv.slice(2));
  const args = parsed.args ?? {};
  const { target, workflow, descriptor: descriptorPath, checksWorkflow } = args;
  if (parsed.error !== undefined) {
    console.error(`release target verification USAGE ERROR: ${parsed.error}\n${USAGE}`);
    process.exit(2);
  }
  if (target === undefined || workflow === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const jobByTarget = { staging: "staging-deploy", production: "production-deploy" };
  const violations = checkReleaseTarget({
    target,
    workflowText: readFileSync(workflow, "utf8"),
    jobId: jobByTarget[target],
    environmentLabel: process.env.KIERO_ENVIRONMENT ?? target,
  });
  if (descriptorPath !== undefined) {
    const loaded = loadTargetDescriptor(descriptorPath);
    if (loaded.violations !== undefined) {
      violations.push(...loaded.violations.map((violation) => `descriptor: ${violation}`));
    } else {
      violations.push(
        ...checkDescriptorAgainstWorkflow({
          descriptor: loaded.descriptor,
          target,
          checksWorkflowText: checksWorkflow === undefined ? undefined : readFileSync(checksWorkflow, "utf8"),
        }).map((violation) => `descriptor: ${violation}`),
      );
      // A COMMITTED descriptor may never carry the stub transport: the
      // workflow references these files, and a stub there could mint
      // synthetic deployed evidence.
      if (isCommittedDescriptorPath(descriptorPath)) {
        violations.push(...committedDescriptorViolations(loaded.descriptor));
      }
    }
  }
  if (violations.length > 0) {
    console.error(`release target verification FAILED for ${target}:`);
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }
  console.log(`release target verified: ${target} (guards passed, no secret values read)`);
}
