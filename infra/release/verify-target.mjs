/**
 * Release target verification (I7): the wrong-environment guard every
 * deploy job runs BEFORE touching anything.
 *
 * Two layers, both deterministic and secret-free (names only, never
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
 *
 * Used by .github/workflows/release.yml and by tests/i7 (imported).
 */

/** The allowed deployment targets and their secret-name prefixes. */
export const RELEASE_TARGETS = {
  staging: { secretPrefix: "STAGING_", environmentName: "staging" },
  production: { secretPrefix: "PRODUCTION_", environmentName: "alpha-production" },
};

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

// ---------------------------------------------------------------------------
// CLI (release.yml calls this before every deploy)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { target: null, workflow: null };
  for (let index = 2; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--target") {
      args.target = argv[index + 1];
      index += 1;
    } else if (current === "--workflow") {
      args.workflow = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { target, workflow } = parseArgs(process.argv);
  if (target === null || workflow === null) {
    console.error("usage: verify-release-target.mjs --target <staging|production> --workflow <release.yml>");
    process.exit(2);
  }
  const { readFileSync } = await import("node:fs");
  const jobByTarget = { staging: "staging-deploy", production: "production-deploy" };
  const violations = checkReleaseTarget({
    target,
    workflowText: readFileSync(workflow, "utf8"),
    jobId: jobByTarget[target],
    environmentLabel: process.env.KIERO_ENVIRONMENT ?? target,
  });
  if (violations.length > 0) {
    console.error(`release target verification FAILED for ${target}:`);
    for (const violation of violations) {
      console.error(`  - ${violation}`);
    }
    process.exit(1);
  }
  console.log(`release target verified: ${target} (guards passed, no secret values read)`);
}
