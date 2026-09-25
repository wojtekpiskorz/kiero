/**
 * The Convex credential-target gate: resolves the deployment the
 * CONVEX_DEPLOY_KEY credential ACTUALLY authorizes and compares it with the
 * identity pinned in the target descriptor, BEFORE any mutating deploy
 * command runs.
 *
 * Why this gate exists: `convex deploy` of the pinned CLI
 * 1.45.0 selects its target through the credential, and a deployment-scoped
 * deploy key makes the CLI IGNORE CONVEX_DEPLOYMENT entirely (verified
 * against the CLI's own selection code and read-only probes; see
 * docs/evidence/release/verified-convex-target/README.md). A transport that
 * records the caller-provided CONVEX_DEPLOYMENT label therefore records a
 * name, never the credential-authorized target: with an inconsistent
 * key/label pair the CLI deploys elsewhere while the evidence claims
 * staging.
 *
 * The provider-observed identity surface of CLI 1.45.0 (read-only probes):
 *
 * - `convex deploy --dry-run` resolves the credential-selected deployment,
 *   prints the deployment announcement FIRST
 *     ▌ Deploying code to deployment:
 *     ▌ [Production] <team>:<project>:<reference> (dashboard: https://dashboard.convex.dev/t/<team>/<project>/<slug>)
 *     ▌ └─ https://<slug>.<region>.convex.cloud
 *   and then runs the pipeline with the server-side dryRun flag (the CLI's
 *   documented "without deploying" mode; preview keys skip their claim too).
 * - `convex env list --names-only` authenticates with the key but prints
 *   variable names only: NO identity surface.
 * - `convex logs` announces the same identity but never terminates; it is
 *   not usable as a release gate.
 *
 * Fields the provider exposes through the announcement: deployment type
 * (label), team slug, project slug, reference, the default alias marker
 * ((prod)/(dev) iff the deployment is the project default), the deployment
 * slug (dashboard URL / URL host) and the deployment URL (which embeds the
 * region). Fields the provider does NOT expose here: any explicit region
 * string (only the URL host segment), cloud account ids, project or
 * deployment uuids.
 *
 * Everything here is names-only: the deploy key VALUE is read solely to
 * classify its type prefix locally (no network, no logging), and captured
 * command output is redacted line-by-line against the secret-bearing
 * environment values before it may appear in any refusal detail.
 */

import { spawnSync } from "node:child_process";

/**
 * The read-only identity probe: `deploy --dry-run` with typecheck and
 * codegen disabled so the probe resolves identity only. Codegen stays off
 * deliberately: regenerating convex/_generated would mutate the checked-out
 * tree, which a verification probe must never do.
 */
export const CONVEX_IDENTITY_PROBE_ARGV = [
  "--yes",
  "convex@1.45.0",
  "deploy",
  "--dry-run",
  "--typecheck",
  "disable",
  "--codegen",
  "disable",
];

/** The announcement type labels the CLI renders, mapped to type slugs. */
const TYPE_LABELS = {
  Production: "prod",
  Development: "dev",
  Preview: "preview",
  Custom: "custom",
  Local: "local",
};

/** The refusal codes the gate can return (all details are names-only). */
export const CONVEX_TARGET_REFUSAL_CODES = [
  "expected-identity-unpinned",
  "missing-credential",
  "unsupported-credential",
  "identity-lookup-failed",
  "identity-mismatch",
];

/**
 * Classifies a deploy key by its prefix LOCALLY (mirrors the pinned CLI's
 * own decoding; no network, no value exposure):
 * - `preview:<team>:<project>|...` selects a branch-named preview deployment;
 * - `project:...|...` selects within a project (not deployment-pinned);
 * - anything else with a `|` separator is a deployment-scoped key whose
 *   prefix ends in its deployment slug (`prod:...:slug`, bare `slug`, ...);
 * - a value without the `|` separator cannot be a deploy key (the CLI
 *   itself refuses it with "set CONVEX_DEPLOY_KEY to a new key"). The
 *   CI placeholders (<ignore_deploy_key>, <missing_deploy_key:...>) land
 *   here too, which is the safe refusal: the CLI would silently fall back
 *   to CONVEX_DEPLOYMENT and target the project's DEFAULT production.
 */
export function classifyConvexDeployKey(key) {
  if (typeof key !== "string" || key === "") {
    return { kind: "missing" };
  }
  const separator = key.indexOf("|");
  if (separator === -1) {
    return { kind: "unparseable" };
  }
  const prefix = key.slice(0, separator);
  if (prefix.startsWith("preview:")) {
    return { kind: "preview" };
  }
  if (prefix.startsWith("project:")) {
    return { kind: "project" };
  }
  const segments = prefix.split(":");
  const slug = segments[segments.length - 1];
  if (slug === "") {
    return { kind: "unparseable" };
  }
  return {
    kind: "deployment",
    // The CLI treats a prefix without a type segment as a prod key.
    keyDeploymentType: segments.length === 1 ? "prod" : segments[0],
    slug,
  };
}

/** Strips CSI sequences and OSC8 hyperlinks the CLI emits on a TTY. */
function stripAnsi(text) {
  return text
    .replace(/\x1b\][0-9];[^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/**
 * The pinned CLI's non-TTY progress line (deploy2.ts:458): the deploy
 * pipeline shows the spinner message "Deploying to <url>..." plus
 * " [dry run]" under --dry-run. On a TTY that text is spinner frames; in CI
 * (no TTY) it reaches stderr verbatim AFTER the announcement block, with a
 * trailing "..." that URL regexes swallow. The staging release run
 * 34874172423 false-mismatched an exactly matching pinned identity because
 * the parser preferred this line over the announcement's own URL line
 * (observed url ".../convex.cloud...", region null), so a progress line is
 * never an announcement line.
 */
const PROGRESS_LINE_PATTERN = /^Deploying to \S+\.\.\.(?: ?\[dry run\])?$/;

/** True for the CLI's non-TTY progress lines; never announcement lines. */
function isProgressLine(line) {
  return PROGRESS_LINE_PATTERN.test(line.trim());
}

/**
 * Parses the CLI's deployment announcement (the "Deploying code to
 * deployment:" block) into the observed identity. Returns null when the
 * announcement is absent. Fields not present in the announcement are null,
 * never guessed.
 *
 * Progress lines are dropped from the announcement window before any field
 * is selected, and the URL carrier is the announcement's own tree-drawing
 * "└─ <url>" line: a generic URL-bearing line backs it up only when no
 * tree line exists. Spinner-only output carries no announcement header at
 * all, so it still parses to null (missing identity, refused).
 */
export function parseConvexAnnouncement(rawText) {
  const lines = stripAnsi(String(rawText ?? "")).split("\n");
  const headerIndex = lines.findIndex((line) => line.includes("Deploying code to deployment:"));
  if (headerIndex === -1) {
    return null;
  }
  const window = lines
    .slice(headerIndex + 1, headerIndex + 6)
    .filter((line) => !isProgressLine(line));
  const refLine = window.find((line) => /\[[A-Za-z]+\]/.test(line));
  if (refLine === undefined) {
    return null;
  }
  const label = /\[([A-Za-z]+)\]/.exec(refLine)?.[1] ?? null;
  const type = label === null ? null : TYPE_LABELS[label] ?? null;
  // team:project:reference, e.g. wojtek-piskorz-jr:kiero-dev-core:staging
  const referenceMatch = /([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*):([a-z0-9][a-z0-9-]*)/.exec(refLine);
  // The default alias marker appears iff the deployment is the project's
  // default of its type; a non-default deployment prints no alias.
  const isDefault = /\((dev|prod)\)/.test(refLine);
  // The deployment URL is the tree-drawing "└─ <url>" line below the
  // reference line; the reference line itself carries the DASHBOARD url,
  // which is not the deployment URL. A tree-drawing line is the
  // announcement's own URL carrier and wins over every other URL-bearing
  // line (run 34874172423: the non-TTY spinner line carried a convex.cloud
  // URL with a trailing "..." and beat the real announcement line under a
  // last-match selection); the generic fallback takes the FIRST match
  // because the announcement block leads the output and trailing lines are
  // more likely noise.
  const urlBearingLines = window.filter(
    (line) => /https?:\/\/\S*convex\.cloud/.test(line) && !line.includes("dashboard.convex.dev"),
  );
  const urlLine =
    urlBearingLines.find((line) => /└|┌/.test(line)) ??
    urlBearingLines[0] ??
    window.find((line) => /└|┌/.test(line) && /https?:\/\//.test(line));
  const url = urlLine === undefined ? null : /https?:\/\/[^\s)]+/.exec(urlLine)?.[0] ?? null;
  let slug = null;
  let region = null;
  if (url !== null) {
    const hostMatch = /^https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.convex\.cloud$/.exec(url);
    if (hostMatch !== null) {
      slug = hostMatch[1];
      region = hostMatch[2];
    }
  }
  if (slug === null) {
    // Fall back to the dashboard URL, which ends in the deployment slug.
    slug = /dashboard\.convex\.dev\/t\/[a-z0-9-]+\/[a-z0-9-]+\/([a-z0-9-]+)/.exec(refLine)?.[1] ?? null;
  }
  return {
    type,
    typeLabel: label,
    teamSlug: referenceMatch?.[1] ?? null,
    projectSlug: referenceMatch?.[2] ?? null,
    reference: referenceMatch?.[3] ?? null,
    isDefault,
    slug,
    url,
    region,
  };
}

/**
 * Compares the observed identity with the pinned expected identity. Returns
 * a list of differences (field names and the two non-secret values); empty
 * means the credential-authorized target IS the pinned target.
 */
export function compareConvexIdentity(observed, expected) {
  const differences = [];
  const field = (name, observedValue, expectedValue) => {
    if (observedValue !== expectedValue) {
      differences.push(
        `${name}: expected ${JSON.stringify(expectedValue)}, observed ${JSON.stringify(observedValue)}`,
      );
    }
  };
  field("type", observed.type, expected.type);
  field("teamSlug", observed.teamSlug, expected.teamSlug);
  field("projectSlug", observed.projectSlug, expected.projectSlug);
  field("reference", observed.reference, expected.reference);
  field("slug", observed.slug, expected.slug);
  field("url", observed.url, expected.url);
  if (expected.isDefault !== undefined) {
    field("isDefault", observed.isDefault, expected.isDefault);
  }
  return differences;
}

/**
 * Redacts every output line that contains a secret-bearing environment
 * VALUE (compared, never printed) and bounds the tail. Provider stdout and
 * stderr may only reach refusal evidence through this filter.
 */
export function sanitizeConvexOutput(env, text) {
  const secretValues = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === "string" && value !== "" && /(KEY|TOKEN|SECRET|PASSWORD)/i.test(name)) {
      secretValues.push(value);
    }
  }
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => (secretValues.some((secret) => line.includes(secret)) ? "<redacted line>" : line));
  const joined = lines.join("\n").trim();
  return joined.length > 600 ? joined.slice(-600) : joined;
}

/** The public, non-secret projection of an observed identity. */
function publicIdentity(identity) {
  return {
    type: identity.type,
    teamSlug: identity.teamSlug,
    projectSlug: identity.projectSlug,
    reference: identity.reference,
    slug: identity.slug,
    url: identity.url,
    region: identity.region,
    isDefault: identity.isDefault,
  };
}

/**
 * The gate. Resolves the credential-selected target through the read-only
 * probe and compares it with the pinned expected identity. Returns
 * { decision: "pass", identity } or
 * { decision: "refuse", refusalCode, ...names-only detail }.
 *
 * `options.env` is the deploy runtime environment (read for
 * CONVEX_DEPLOY_KEY classification and probe execution only; the key value
 * never appears in any result). `options.cwd` is the Convex app root the
 * probe bundles.
 */
export function verifyConvexTarget({ env, cwd, expectedIdentity }) {
  if (
    expectedIdentity === undefined ||
    expectedIdentity === null ||
    typeof expectedIdentity !== "object"
  ) {
    // No pinned identity means there is nothing verifiable to deploy to:
    // refuse rather than fall back to a caller label (the alpha production
    // descriptor intentionally ships unpinned until its deployment exists).
    return {
      decision: "refuse",
      refusalCode: "expected-identity-unpinned",
      reason:
        "the descriptor pins no expected Convex identity; refusing to deploy to an unverifiable target",
    };
  }
  const deployKey = env?.CONVEX_DEPLOY_KEY ?? "";
  const classification = classifyConvexDeployKey(deployKey);
  if (classification.kind === "missing") {
    return {
      decision: "refuse",
      refusalCode: "missing-credential",
      reason:
        "CONVEX_DEPLOY_KEY is not set; a CONVEX_DEPLOYMENT label alone selects the project's default production deployment, never a named deployment",
      expected: expectedIdentity,
    };
  }
  if (classification.kind !== "deployment") {
    // Preview keys address branch-named preview deployments and project
    // keys address a within-project selection: neither is a
    // deployment-pinned credential, so neither can prove the pinned target.
    // Refused WITHOUT spawning any CLI command.
    return {
      decision: "refuse",
      refusalCode: "unsupported-credential",
      reason: `CONVEX_DEPLOY_KEY is ${classification.kind === "unparseable" ? "an" : "a"} ${classification.kind} key; only a deployment-scoped key resolves one pinned deployment`,
      expected: expectedIdentity,
    };
  }
  const probe = spawnSync("npx", CONVEX_IDENTITY_PROBE_ARGV, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
  const identity = parseConvexAnnouncement(output);
  if (probe.status !== 0 || identity === null) {
    return {
      decision: "refuse",
      refusalCode: "identity-lookup-failed",
      reason:
        probe.status !== 0
          ? `the read-only identity probe exited ${String(probe.status)} before resolving the credential-selected deployment`
          : "the read-only identity probe completed without a deployment announcement",
      probeExitCode: probe.status,
      probeCommand: `npx ${CONVEX_IDENTITY_PROBE_ARGV.join(" ")}`,
      probeOutputTail: sanitizeConvexOutput(env, output),
      expected: expectedIdentity,
    };
  }
  const differences = compareConvexIdentity(identity, expectedIdentity);
  if (differences.length > 0) {
    return {
      decision: "refuse",
      refusalCode: "identity-mismatch",
      reason:
        "the credential-selected deployment is not the pinned target; no mutating command ran",
      observed: publicIdentity(identity),
      expected: expectedIdentity,
      differences,
    };
  }
  return { decision: "pass", identity: publicIdentity(identity) };
}
