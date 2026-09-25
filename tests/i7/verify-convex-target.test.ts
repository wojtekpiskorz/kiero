/**
 * R9 focused tests: the Convex credential-target gate. Deterministic and
 * network-free: a PATH-shim `npx` replays the independently recorded
 * provider responses (tests/i7/fixtures/convex-identity) and records every
 * invocation it receives. That recording boundary is the proof of the
 * issue's core acceptance: on every refusal the ONLY Convex command that
 * ran is the read-only `deploy --dry-run` identity probe (zero mutating
 * deploy commands), and on success the recorded remote identity is the
 * provider-observed one, never the caller-provided CONVEX_DEPLOYMENT label.
 *
 * The fixture keys are fabricated strings (never real credentials); the
 * recorded announcements are the non-secret identity blocks observed from
 * the pinned CLI 1.45.0 (docs/evidence/release/verified-convex-target).
 */

import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CONVEX_IDENTITY_PROBE_ARGV,
  CONVEX_TARGET_REFUSAL_CODES,
  classifyConvexDeployKey,
  compareConvexIdentity,
  parseConvexAnnouncement,
  sanitizeConvexOutput,
  verifyConvexTarget,
} from "../../infra/release/verify-convex-target.mjs";
import type { ConvexExpectedIdentity } from "../../infra/release/verify-convex-target.mjs";
import { parseTargetDescriptor, validateTargetDescriptor } from "../../infra/release/target-descriptor.mjs";
import { readReleaseRecords } from "../../infra/release/record-release-evidence.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const adapterCli = join(repoRoot, "infra", "release", "deploy-component.mjs");
const fixturesDir = join(repoRoot, "tests", "i7", "fixtures", "convex-identity");
const workflow = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
const CHECKS_JOB_NAME = "npm ci, typecheck, test, build (Node 22.22.3)";
const REVISION = "5555555555555555555555555555555555555555";

const fixtureText = (name: string): string => readFileSync(join(fixturesDir, name), "utf8");

/** AC2: the exact identity the staging descriptor pins. Updated by the
 * 2026-09-22 re-provisioning lane together with the descriptor itself
 * (docs/evidence/staging/reprovision-2026-09-22.md). */
const PINNED_STAGING_IDENTITY: ConvexExpectedIdentity = {
  teamSlug: "wojtek-piskorz-jr",
  projectSlug: "kiero-dev-core",
  reference: "staging",
  type: "prod",
  slug: "outgoing-marlin-429",
  url: "https://outgoing-marlin-429.eu-west-1.convex.cloud",
  isDefault: false,
};

/** The identity the RECORDED fixture outputs captured (the pre-teardown
 * `fiery-raven-417` staging deployment, 2026-09-14 releases). Kept in sync
 * with the recording fixtures, never with the live descriptor: the
 * recordings are history and are not rewritten. */
const RECORDED_STAGING_IDENTITY: ConvexExpectedIdentity = {
  teamSlug: "wojtek-piskorz-jr",
  projectSlug: "kiero-dev-core",
  reference: "staging",
  type: "prod",
  slug: "fiery-raven-417",
  url: "https://fiery-raven-417.eu-west-1.convex.cloud",
  isDefault: false,
};

/** Fabricated deploy keys (fixture strings, never real credentials). */
const STAGING_FIXTURE_KEY = "prod:fiery-raven-417|fixture-deploy-key-not-a-real-credential";
const PROJECT_FIXTURE_KEY = "project:eu:kiero-dev-core|fixture-project-key-not-a-real-credential";
const PREVIEW_FIXTURE_KEY = "preview:wojtek-piskorz-jr:kiero-dev-core|fixture-preview-key-not-a-real-credential";

interface PublicIdentity {
  type: string | null;
  teamSlug: string | null;
  projectSlug: string | null;
  reference: string | null;
  slug: string | null;
  url: string | null;
  region: string | null;
  isDefault: boolean;
}

type Verification =
  | { decision: "pass"; identity: PublicIdentity }
  | {
      decision: "refuse";
      refusalCode: string;
      reason: string;
      expected?: ConvexExpectedIdentity;
      observed?: PublicIdentity;
      differences?: string[];
      probeExitCode?: number | null;
      probeCommand?: string;
      probeOutputTail?: string;
    };

// ---------------------------------------------------------------------------
// The recording command boundary: a fake `npx` that replays recorded
// provider responses and logs every invocation it receives.
// ---------------------------------------------------------------------------

/** Installs the PATH-shim npx; returns the invocation-record path. */
function installNpxShim(directory: string): string {
  const record = join(directory, "npx-invocations.log");
  const shim = join(directory, "npx");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `[ -n "$KIERO_FIXTURE_NPX_RECORD" ] && printf '%s\\n' "$*" >> "$KIERO_FIXTURE_NPX_RECORD"`,
      `case " $* " in`,
      `  *" --dry-run "*)`,
      `    [ -n "$KIERO_FIXTURE_PROBE_OUT" ] && cat "$KIERO_FIXTURE_PROBE_OUT" >&2`,
      `    exit "\${KIERO_FIXTURE_PROBE_EXIT:-0}"`,
      `    ;;`,
      `  *)`,
      `    [ -n "$KIERO_FIXTURE_DEPLOY_OUT" ] && cat "$KIERO_FIXTURE_DEPLOY_OUT" >&2`,
      `    exit "\${KIERO_FIXTURE_DEPLOY_EXIT:-0}"`,
      `    ;;`,
      `esac`,
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(shim, 0o700);
  return record;
}

interface FixtureScenario {
  probeOut?: string;
  probeExit?: string;
  deployOut?: string;
  deployExit?: string;
  deployKey?: string;
}

function shimEnv(shimDirectory: string, record: string, scenario: FixtureScenario = {}): Record<string, string> {
  return {
    PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
    KIERO_ENVIRONMENT: "staging",
    KIERO_FIXTURE_NPX_RECORD: record,
    CONVEX_DEPLOYMENT: "wojtek-piskorz-jr:kiero-dev-core:staging",
    CONVEX_DEPLOY_KEY: scenario.deployKey ?? STAGING_FIXTURE_KEY,
    ...(scenario.probeOut === undefined ? {} : { KIERO_FIXTURE_PROBE_OUT: scenario.probeOut }),
    ...(scenario.probeExit === undefined ? {} : { KIERO_FIXTURE_PROBE_EXIT: scenario.probeExit }),
    ...(scenario.deployOut === undefined ? {} : { KIERO_FIXTURE_DEPLOY_OUT: scenario.deployOut }),
    ...(scenario.deployExit === undefined ? {} : { KIERO_FIXTURE_DEPLOY_EXIT: scenario.deployExit }),
  };
}

const recordedInvocations = (record: string): string[] =>
  existsSync(record)
    ? readFileSync(record, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
    : [];

/** A mutating deploy invocation: `deploy` without `--dry-run`. */
const mutatingDeployInvocations = (record: string): string[] =>
  recordedInvocations(record).filter(
    (line) => /(^|\s)deploy(\s|$)/.test(line) && !/(^|\s)--dry-run(\s|$)/.test(line),
  );

/** A gate scenario workspace with the shim installed. */
function gateWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), "kiero-convex-gate-"));
  const record = installNpxShim(directory);
  return { directory, record };
}

function runGate(
  { directory, record }: ReturnType<typeof gateWorkspace>,
  scenario: FixtureScenario = {},
  // Pass null explicitly to exercise the unpinned-identity refusal. The
  // default is the RECORDED identity because every recorded scenario below
  // replays the 2026-09-14 fixtures; the LIVE pairing (descriptor pin) has
  // its own test further down.
  expectedIdentity: ConvexExpectedIdentity | null = RECORDED_STAGING_IDENTITY,
): Verification {
  return verifyConvexTarget({
    env: shimEnv(directory, record, scenario),
    cwd: directory,
    ...(expectedIdentity === null ? {} : { expectedIdentity }),
  }) as Verification;
}

/** Spawns the deploy adapter over a fixture descriptor whose Convex component rides the shim. */
function runAdapterWithConvexComponent(scenario: FixtureScenario, expectedIdentity?: ConvexExpectedIdentity) {
  const directory = mkdtempSync(join(tmpdir(), "kiero-convex-adapter-"));
  const record = installNpxShim(directory);
  const descriptor = join(directory, "descriptor.json");
  writeFileSync(
    descriptor,
    JSON.stringify({
      descriptorId: "fixture/convex-gate-test@2026-09-14",
      target: "staging",
      githubEnvironment: "staging",
      secretPrefix: "STAGING_",
      checksName: CHECKS_JOB_NAME,
      components: [
        {
          id: "convex-functions",
          included: true,
          build: null,
          artifact: "convex-fixture",
          requiredConfig: ["CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY"],
          transport:
            expectedIdentity === undefined
              ? { kind: "convex-deploy" }
              : { kind: "convex-deploy", expectedIdentity },
        },
      ],
    }),
    "utf8",
  );
  const checksReport = join(directory, "checks-report.json");
  writeFileSync(
    checksReport,
    `${JSON.stringify({
      source: "fixture",
      requestedSha: REVISION,
      checksName: CHECKS_JOB_NAME,
      decision: "pass",
      reasons: [],
      observed: [{ name: CHECKS_JOB_NAME, status: "completed", conclusion: "success", headSha: REVISION }],
    })}\n`,
    "utf8",
  );
  mkdirSync(join(directory, "convex-fixture"));
  writeFileSync(join(directory, "convex-fixture", "functions.ts"), "fixture bytes", "utf8");
  const ledger = join(directory, "releases.jsonl");
  const outcomes = join(directory, "deploy-outcomes.json");
  const run = spawnSync(
    process.execPath,
    [
      adapterCli,
      "--descriptor", descriptor,
      "--revision", REVISION,
      "--checks-report", checksReport,
      "--ledger", ledger,
      "--outcomes", outcomes,
      "--cwd", directory,
    ],
    { encoding: "utf8", env: shimEnv(directory, record, scenario) },
  );
  return { run, record, ledger, outcomes, directory };
}

// ---------------------------------------------------------------------------
// The pinned CLI's key decoding, verified locally without any network.
// ---------------------------------------------------------------------------

describe("the deploy key classifier (local prefix decode, no network)", () => {
  it("classifies deployment-scoped keys and decodes their slug", () => {
    expect(classifyConvexDeployKey("prod:fiery-raven-417|x")).toMatchObject({
      kind: "deployment",
      slug: "fiery-raven-417",
      keyDeploymentType: "prod",
    });
    // Region-aware prefixes keep the slug as the last segment.
    expect(classifyConvexDeployKey("prod:eu:fiery-raven-417|x")).toMatchObject({
      kind: "deployment",
      slug: "fiery-raven-417",
    });
    expect(classifyConvexDeployKey("dev:steady-basilisk-613|x")).toMatchObject({
      kind: "deployment",
      slug: "steady-basilisk-613",
      keyDeploymentType: "dev",
    });
    // A bare legacy prefix is a deployment key of type prod in the CLI.
    expect(classifyConvexDeployKey("fiery-raven-417|x")).toMatchObject({
      kind: "deployment",
      slug: "fiery-raven-417",
      keyDeploymentType: "prod",
    });
  });

  it("classifies preview and project keys as non-deployment-pinned", () => {
    expect(classifyConvexDeployKey(PREVIEW_FIXTURE_KEY).kind).toBe("preview");
    expect(classifyConvexDeployKey(PROJECT_FIXTURE_KEY).kind).toBe("project");
  });

  it("classifies missing, separator-less and CI-placeholder values safely", () => {
    expect(classifyConvexDeployKey("").kind).toBe("missing");
    expect(classifyConvexDeployKey(undefined).kind).toBe("missing");
    // No "|" separator: the CLI itself refuses such keys; the CI placeholders
    // land here too, where the gate refuses instead of letting the CLI fall
    // back to the CONVEX_DEPLOYMENT label path (which targets the project's
    // DEFAULT production deployment).
    expect(classifyConvexDeployKey("just-a-string").kind).toBe("unparseable");
    expect(classifyConvexDeployKey("<ignore_deploy_key>").kind).toBe("unparseable");
    expect(classifyConvexDeployKey("<missing_deploy_key:set the secret>x").kind).toBe("unparseable");
  });
});

// ---------------------------------------------------------------------------
// The recorded provider responses parse to the observed identity.
// ---------------------------------------------------------------------------

describe("the recorded provider announcements parse to observed identity", () => {
  it("parses the recorded staging announcement into every provider-observed field", () => {
    const identity = parseConvexAnnouncement(fixtureText("staging-announcement.txt"));
    expect(identity).toMatchObject({
      type: "prod",
      typeLabel: "Production",
      teamSlug: "wojtek-piskorz-jr",
      projectSlug: "kiero-dev-core",
      reference: "staging",
      slug: "fiery-raven-417",
      url: "https://fiery-raven-417.eu-west-1.convex.cloud",
      region: "eu-west-1",
      isDefault: false,
    });
  });

  it("parses the recorded default-production announcement (the wrong-target shape)", () => {
    const identity = parseConvexAnnouncement(fixtureText("default-production-announcement.txt"));
    expect(identity).toMatchObject({
      type: "prod",
      reference: "production",
      slug: "wary-coyote-511",
      url: "https://wary-coyote-511.convex.cloud",
      isDefault: true,
    });
    // The legacy default-production URL carries no region segment: the
    // region is absent (null), never guessed.
    expect(identity?.region).toBeNull();
  });

  it("parses a TTY-styled announcement (ANSI and OSC8 links stripped)", () => {
    const esc = String.fromCharCode(27);
    const url = "https://fiery-raven-417.eu-west-1.convex.cloud";
    const styled = [
      "▌ Deploying code to deployment:",
      `▌ [Production] wojtek-piskorz-jr:kiero-dev-core:staging (dashboard: ${esc}]8;;https://dashboard.convex.dev/t/wojtek-piskorz-jr/kiero-dev-core/fiery-raven-417${esc}\\dashboard${esc}]8;;${esc}\\)`,
      `▌ └─ ${esc}]8;;${url}${esc}\\${esc}[2m${url}${esc}[22m`,
      "",
    ].join("\n");
    expect(parseConvexAnnouncement(styled)).toMatchObject({
      slug: "fiery-raven-417",
      reference: "staging",
      url,
    });
  });

  it("returns null for output without an announcement (env-list style)", () => {
    expect(parseConvexAnnouncement(fixtureText("no-announcement.txt"))).toBeNull();
    expect(parseConvexAnnouncement("")).toBeNull();
  });

  it("parses the CI stderr shape of release run 34874172423 with no false mismatch", () => {
    // In non-TTY CI the pinned CLI's progress line (deploy2.ts:458,
    // "Deploying to <url>..." plus " [dry run]") reaches stderr after the
    // announcement block. The pre-fix parser preferred it over the
    // announcement's own URL line and false-mismatched the exact pin.
    const identity = parseConvexAnnouncement(fixtureText("staging-announcement-ci-spinner.txt"));
    expect(identity).toMatchObject({
      type: "prod",
      teamSlug: "wojtek-piskorz-jr",
      projectSlug: "kiero-dev-core",
      reference: "staging",
      slug: "fiery-raven-417",
      url: "https://fiery-raven-417.eu-west-1.convex.cloud",
      region: "eu-west-1",
      isDefault: false,
    });
    if (identity === null) {
      throw new Error("the CI-shape fixture must parse");
    }
    // The comparison the live run failed now comes out clean: the
    // spinner's trailing "..." never reaches the url field.
    expect(compareConvexIdentity(identity, RECORDED_STAGING_IDENTITY)).toEqual([]);
  });

  it("never prefers a progress line without the dry-run marker (the real-deploy shape)", () => {
    // The transport's mutating deploy re-parses the same announcement, and
    // its progress line carries no "[dry run]" marker.
    const realDeployShape = fixtureText("staging-announcement-ci-spinner.txt").replace(" [dry run]", "");
    expect(parseConvexAnnouncement(realDeployShape)).toMatchObject({
      slug: "fiery-raven-417",
      url: "https://fiery-raven-417.eu-west-1.convex.cloud",
      region: "eu-west-1",
    });
  });

  it("returns null for spinner-only output: a progress line is never an announcement", () => {
    expect(parseConvexAnnouncement(fixtureText("spinner-progress-only.txt"))).toBeNull();
  });

  it("the comparison names every differing field with both values", () => {
    const observed = parseConvexAnnouncement(fixtureText("default-production-announcement.txt"));
    if (observed === null) {
      throw new Error("the wrong-target fixture must parse");
    }
    const differences = compareConvexIdentity(observed, RECORDED_STAGING_IDENTITY);
    expect(differences.join("\n")).toContain('reference: expected "staging"');
    expect(differences.join("\n")).toContain('slug: expected "fiery-raven-417"');
    expect(differences.join("\n")).toContain("url:");
    expect(differences.join("\n")).toContain("isDefault:");
    const identity = parseConvexAnnouncement(fixtureText("staging-announcement.txt"));
    if (identity === null) {
      throw new Error("the staging fixture must parse");
    }
    expect(compareConvexIdentity(identity, RECORDED_STAGING_IDENTITY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gate itself, exercised through the recording command boundary.
// ---------------------------------------------------------------------------

describe("the gate against the recorded provider responses (recording boundary)", () => {
  it("passes when the credential resolves the pinned staging deployment", () => {
    const workspace = gateWorkspace();
    const verification = runGate(workspace, { probeOut: join(fixturesDir, "staging-announcement.txt") });
    expect(verification.decision).toBe("pass");
    if (verification.decision !== "pass") {
      throw new Error("unreachable");
    }
    expect(verification.identity).toMatchObject({
      type: "prod",
      teamSlug: "wojtek-piskorz-jr",
      projectSlug: "kiero-dev-core",
      reference: "staging",
      slug: "fiery-raven-417",
      url: "https://fiery-raven-417.eu-west-1.convex.cloud",
      isDefault: false,
    });
    // The only command the boundary saw is the read-only probe.
    expect(mutatingDeployInvocations(workspace.record)).toEqual([]);
    expect(recordedInvocations(workspace.record)).toHaveLength(1);
    expect(recordedInvocations(workspace.record)[0]).toContain("--dry-run");
  });

  it("passes the pinned staging target when CI stderr carries the non-TTY spinner line", () => {
    // The exact probe output of release run 34874172423: the announcement
    // block followed by the CLI's progress line. Pre-fix, this very input
    // refused identity-mismatch on the url field alone.
    const workspace = gateWorkspace();
    const verification = runGate(workspace, {
      probeOut: join(fixturesDir, "staging-announcement-ci-spinner.txt"),
    });
    expect(verification.decision).toBe("pass");
    if (verification.decision !== "pass") {
      throw new Error("unreachable");
    }
    expect(verification.identity).toMatchObject({
      slug: "fiery-raven-417",
      url: "https://fiery-raven-417.eu-west-1.convex.cloud",
      region: "eu-west-1",
      isDefault: false,
    });
    // The only command the boundary saw is the read-only probe.
    expect(mutatingDeployInvocations(workspace.record)).toEqual([]);
    expect(recordedInvocations(workspace.record)).toHaveLength(1);
  });

  it("passes the live pairing: a fabricated announcement of the descriptor-pinned deployment", () => {
    // The recorded fixtures replay the 2026-09-14 deployment; this test
    // proves the LIVE descriptor pin (outgoing-marlin-429) pairs end to end
    // with an announcement of exactly that deployment.
    const directory = mkdtempSync(join(tmpdir(), "kiero-convex-live-pin-"));
    const announcement = join(directory, "live-pin-announcement.txt");
    writeFileSync(
      announcement,
      [
        "▌ Deploying code to deployment:",
        "▌ [Production] wojtek-piskorz-jr:kiero-dev-core:staging (dashboard: https://dashboard.convex.dev/t/wojtek-piskorz-jr/kiero-dev-core/outgoing-marlin-429)",
        "▌ └─ https://outgoing-marlin-429.eu-west-1.convex.cloud",
        "",
      ].join("\n"),
      "utf8",
    );
    const workspace = gateWorkspace();
    const verification = runGate(workspace, { probeOut: announcement }, PINNED_STAGING_IDENTITY);
    expect(verification.decision).toBe("pass");
    if (verification.decision !== "pass") {
      throw new Error("unreachable");
    }
    expect(verification.identity).toMatchObject({
      slug: "outgoing-marlin-429",
      url: "https://outgoing-marlin-429.eu-west-1.convex.cloud",
      region: "eu-west-1",
    });
    expect(mutatingDeployInvocations(workspace.record)).toEqual([]);
  });

  it("refuses spinner-only probe output as a failed identity lookup", () => {
    // Progress without an announcement block is still missing identity: the
    // gate must not mint an observed identity from a progress line.
    const workspace = gateWorkspace();
    const verification = runGate(workspace, {
      probeOut: join(fixturesDir, "spinner-progress-only.txt"),
    });
    expect(verification).toMatchObject({
      decision: "refuse",
      refusalCode: "identity-lookup-failed",
    });
    if (verification.decision === "refuse") {
      expect(verification.reason).toContain("without a deployment announcement");
    }
    expect(mutatingDeployInvocations(workspace.record)).toEqual([]);
  });

  it("refuses a wrong key target with zero mutating deploy commands", () => {
    const workspace = gateWorkspace();
    // The credential resolves the project's DEFAULT production deployment
    // while the pinned target is staging: the exact false-evidence shape.
    const verification = runGate(workspace, {
      probeOut: join(fixturesDir, "default-production-announcement.txt"),
    });
    expect(verification.decision).toBe("refuse");
    if (verification.decision !== "refuse") {
      throw new Error("unreachable");
    }
    expect(verification.refusalCode).toBe("identity-mismatch");
    expect(verification.observed).toMatchObject({ reference: "production", slug: "wary-coyote-511", isDefault: true });
    expect(verification.expected).toMatchObject({ reference: "staging", slug: "fiery-raven-417" });
    expect(verification.reason).toContain("no mutating command ran");
    // The boundary proves it: exactly one invocation, the dry-run probe.
    expect(mutatingDeployInvocations(workspace.record)).toEqual([]);
    expect(recordedInvocations(workspace.record)).toHaveLength(1);
  });

  it("refuses a failed identity lookup (invalid key, 401) with sanitized evidence", () => {
    const workspace = gateWorkspace();
    const verification = runGate(workspace, {
      probeOut: join(fixturesDir, "invalid-key-401.txt"),
      probeExit: "1",
    });
    expect(verification.decision).toBe("refuse");
    if (verification.decision !== "refuse") {
      throw new Error("unreachable");
    }
    expect(verification.refusalCode).toBe("identity-lookup-failed");
    expect(verification.probeExitCode).toBe(1);
    expect(verification.probeCommand).toContain("--dry-run");
    expect(verification.probeOutputTail).toContain("Invalid Convex deploy key");
    // No credential value anywhere in the refusal evidence.
    expect(JSON.stringify(verification)).not.toContain(STAGING_FIXTURE_KEY);
    expect(mutatingDeployInvocations(workspace.record)).toEqual([]);
  });

  it("refuses a probe that completes without any identity announcement", () => {
    const workspace = gateWorkspace();
    const verification = runGate(workspace, {
      probeOut: join(fixturesDir, "no-announcement.txt"),
    });
    expect(verification.decision).toBe("refuse");
    if (verification.decision !== "refuse") {
      throw new Error("unreachable");
    }
    expect(verification.refusalCode).toBe("identity-lookup-failed");
    expect(verification.reason).toContain("without a deployment announcement");
    expect(mutatingDeployInvocations(workspace.record)).toEqual([]);
  });

  it("refuses a missing credential before spawning any command at all", () => {
    const workspace = gateWorkspace();
    const verification = runGate(workspace, { deployKey: "" });
    expect(verification).toMatchObject({
      decision: "refuse",
      refusalCode: "missing-credential",
    });
    if (verification.decision === "refuse") {
      expect(verification.reason).toContain("default production deployment");
    }
    // The boundary saw NOTHING: not even the probe ran.
    expect(existsSync(workspace.record)).toBe(false);
  });

  it("refuses unsupported key types (project, preview) without spawning any command", () => {
    for (const key of [PROJECT_FIXTURE_KEY, PREVIEW_FIXTURE_KEY]) {
      const workspace = gateWorkspace();
      const verification = runGate(workspace, { deployKey: key });
      expect(verification).toMatchObject({ decision: "refuse", refusalCode: "unsupported-credential" });
      expect(existsSync(workspace.record)).toBe(false);
    }
  });

  it("refuses an unpinned expected identity (no verifiable target)", () => {
    const workspace = gateWorkspace();
    const verification = runGate(workspace, {}, null);
    expect(verification).toMatchObject({
      decision: "refuse",
      refusalCode: "expected-identity-unpinned",
    });
    expect(existsSync(workspace.record)).toBe(false);
  });

  it("redacts output lines that carry a secret-bearing environment value", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-convex-redact-"));
    const leaked = join(directory, "leaked.txt");
    writeFileSync(
      leaked,
      [
        "▌ Deploying code to deployment:",
        `some hostile line echoing the credential ${STAGING_FIXTURE_KEY}`,
        "",
      ].join("\n"),
      "utf8",
    );
    const workspace = gateWorkspace();
    const verification = runGate(workspace, { probeOut: leaked, probeExit: "1" });
    expect(verification.decision).toBe("refuse");
    if (verification.decision !== "refuse") {
      throw new Error("unreachable");
    }
    expect(verification.probeOutputTail).toContain("<redacted line>");
    expect(verification.probeOutputTail).not.toContain(STAGING_FIXTURE_KEY);
    // The pure sanitizer behaves the same way directly.
    expect(
      sanitizeConvexOutput({ CONVEX_DEPLOY_KEY: STAGING_FIXTURE_KEY }, `line one\nkey ${STAGING_FIXTURE_KEY}`),
    ).not.toContain(STAGING_FIXTURE_KEY);
  });

  it("the refusal code inventory is closed and the probe argv is the dry-run shape", () => {
    expect(CONVEX_TARGET_REFUSAL_CODES).toEqual([
      "expected-identity-unpinned",
      "missing-credential",
      "unsupported-credential",
      "identity-lookup-failed",
      "identity-mismatch",
    ]);
    expect(CONVEX_IDENTITY_PROBE_ARGV.join(" ")).toContain("deploy --dry-run");
    // The probe disables typecheck and codegen: it resolves identity only
    // and must never mutate the checked-out tree.
    expect(CONVEX_IDENTITY_PROBE_ARGV.join(" ")).toContain("--codegen disable");
    expect(CONVEX_IDENTITY_PROBE_ARGV.join(" ")).toContain("--typecheck disable");
  });
});

// ---------------------------------------------------------------------------
// The adapter runs the gate before any build or transport command.
// ---------------------------------------------------------------------------

describe("the deploy adapter gates the Convex component before any mutating command", () => {
  it("blocks a wrong key target as target-verification-failed with zero mutating commands", () => {
    const result = runAdapterWithConvexComponent({
      probeOut: join(fixturesDir, "default-production-announcement.txt"),
    }, RECORDED_STAGING_IDENTITY);
    expect(result.run.status).toBe(1);
    expect(result.run.stdout).toContain("[blocked] convex-functions: target-verification-failed");
    const rows = readReleaseRecords(result.ledger) as { outcome: string; blockedReason?: string; targetVerification?: { refusalCode: string; observed?: { slug?: string } } }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.blockedReason).toBe("target-verification-failed");
    expect(rows[0]?.targetVerification?.refusalCode).toBe("identity-mismatch");
    expect(rows[0]?.targetVerification?.observed?.slug).toBe("wary-coyote-511");
    // The boundary proof: only the read-only probe ran.
    expect(mutatingDeployInvocations(result.record)).toEqual([]);
    expect(recordedInvocations(result.record)).toHaveLength(1);
  });

  it("deploys and records the provider-observed identity (never the caller label)", () => {
    const result = runAdapterWithConvexComponent(
      {
        probeOut: join(fixturesDir, "staging-announcement.txt"),
        deployOut: join(fixturesDir, "staging-announcement.txt"),
      },
      RECORDED_STAGING_IDENTITY,
    );
    expect(result.run.status).toBe(0);
    expect(result.run.stdout).toContain("[deployed] convex-functions");
    const rows = readReleaseRecords(result.ledger) as { outcome: string; remoteIdentity?: Record<string, unknown> }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("deployed");
    expect(rows[0]?.remoteIdentity).toMatchObject({
      kind: "convex-deployment",
      id: "wojtek-piskorz-jr:kiero-dev-core:staging",
      slug: "fiery-raven-417",
      url: "https://fiery-raven-417.eu-west-1.convex.cloud",
      type: "prod",
      region: "eu-west-1",
      isDefault: false,
      identitySource: "provider-observed",
    });
    // The boundary saw the probe first, then exactly one mutating deploy.
    const invocations = recordedInvocations(result.record);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain("--dry-run");
    expect(mutatingDeployInvocations(result.record)).toHaveLength(1);
  });

  it("deploys end to end when both the probe and the deploy output carry the CI spinner line", () => {
    // The shape the real CI run produces on every leg: the announcement
    // block plus the non-TTY progress line, on the gate probe AND on the
    // transport's deploy output (the marker-less progress line the real
    // deploy prints is pinned by the parser test above).
    const ciShape = join(fixturesDir, "staging-announcement-ci-spinner.txt");
    const result = runAdapterWithConvexComponent(
      { probeOut: ciShape, deployOut: ciShape },
      RECORDED_STAGING_IDENTITY,
    );
    expect(result.run.status).toBe(0);
    expect(result.run.stdout).toContain("[deployed] convex-functions");
    const rows = readReleaseRecords(result.ledger) as { outcome?: string; remoteIdentity?: Record<string, unknown> }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("deployed");
    // The recorded remote identity is the exact pinned URL: no trailing
    // spinner ellipsis anywhere in the ledger row.
    expect(rows[0]?.remoteIdentity).toMatchObject({
      kind: "convex-deployment",
      slug: "fiery-raven-417",
      url: "https://fiery-raven-417.eu-west-1.convex.cloud",
      region: "eu-west-1",
      identitySource: "provider-observed",
    });
    expect(JSON.stringify(rows[0]?.remoteIdentity)).not.toContain("...");
    const invocations = recordedInvocations(result.record);
    expect(invocations).toHaveLength(2);
    expect(invocations[0]).toContain("--dry-run");
    expect(mutatingDeployInvocations(result.record)).toHaveLength(1);
  });

  it("the transport itself re-verifies the deploy announcement (defense in depth)", () => {
    // The gate passes (probe announces staging) but the deploy output
    // announces a different deployment: the transport refuses to claim the
    // identity and the adapter records transport-failed.
    const result = runAdapterWithConvexComponent(
      {
        probeOut: join(fixturesDir, "staging-announcement.txt"),
        deployOut: join(fixturesDir, "default-production-announcement.txt"),
      },
      RECORDED_STAGING_IDENTITY,
    );
    expect(result.run.status).toBe(1);
    expect(result.run.stdout).toContain("[blocked] convex-functions: transport-failed");
    const rows = readReleaseRecords(result.ledger) as { blockedReason?: string; transportError?: string }[];
    expect(rows[0]?.blockedReason).toBe("transport-failed");
    expect(rows[0]?.transportError).toContain("not the pinned target");
    // Honest boundary: the mutating command DID run here (the transport
    // caught the wrong landing after the fact); the error says so.
    expect(mutatingDeployInvocations(result.record)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The committed descriptors and the workflow mapping.
// ---------------------------------------------------------------------------

describe("the committed descriptors pin the verified Convex identity", () => {
  it("the staging descriptor pins exactly the AC2 identity", () => {
    const parsed = parseTargetDescriptor(
      readFileSync(join(repoRoot, "infra", "release", "targets", "staging.json"), "utf8"),
    );
    expect(parsed.violations).toBeUndefined();
    const component = parsed.descriptor?.components.find((entry) => entry.id === "convex-functions");
    expect(component?.transport.expectedIdentity).toEqual(PINNED_STAGING_IDENTITY);
    expect(component?.requiredConfig).toEqual(["CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY"]);
  });

  it("the production descriptor stays unpinned but requires the deploy key by name", () => {
    const parsed = parseTargetDescriptor(
      readFileSync(join(repoRoot, "infra", "release", "targets", "production.json"), "utf8"),
    );
    expect(parsed.violations).toBeUndefined();
    const component = parsed.descriptor?.components.find((entry) => entry.id === "convex-functions");
    expect(component?.transport.expectedIdentity).toBeUndefined();
    expect(component?.requiredConfig).toEqual(["CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY"]);
  });

  it("the validator refuses malformed pinned identities", () => {
    const base = {
      descriptorId: "fixture/x@2026-09-14",
      target: "staging",
      githubEnvironment: "staging",
      secretPrefix: "STAGING_",
      checksName: CHECKS_JOB_NAME,
      components: [
        {
          id: "convex-functions",
          included: true,
          build: null,
          artifact: "convex",
          requiredConfig: ["CONVEX_DEPLOYMENT", "CONVEX_DEPLOY_KEY"],
          transport: { kind: "convex-deploy" },
        },
      ],
    };
    const withIdentity = (expectedIdentity: unknown) => ({
      ...base,
      components: [{ ...base.components[0], transport: { kind: "convex-deploy", expectedIdentity } }],
    });
    expect(validateTargetDescriptor(withIdentity(PINNED_STAGING_IDENTITY))).toEqual([]);
    // URL host disagrees with the pinned slug.
    expect(
      validateTargetDescriptor(withIdentity({ ...PINNED_STAGING_IDENTITY, url: "https://other-slug-999.eu-west-1.convex.cloud" })),
    ).toContainEqual(expect.stringMatching(/url host must match the pinned slug/));
    // A preview target cannot be pinned by reference.
    expect(
      validateTargetDescriptor(withIdentity({ ...PINNED_STAGING_IDENTITY, type: "preview" })),
    ).toContainEqual(expect.stringMatching(/type must be "prod" or "dev"/));
    // Unknown fields and missing fields refuse.
    expect(
      validateTargetDescriptor(withIdentity({ ...PINNED_STAGING_IDENTITY, region: "eu-west-1" })),
    ).toContainEqual(expect.stringMatching(/unknown field "region"/));
    expect(
      validateTargetDescriptor(withIdentity({ ...PINNED_STAGING_IDENTITY, slug: "" })),
    ).toContainEqual(expect.stringMatching(/non-empty slug/));
  });

  it("the release workflow maps the deploy keys by name for both targets", () => {
    expect(workflow).toContain("CONVEX_DEPLOY_KEY: ${{ secrets.STAGING_CONVEX_DEPLOY_KEY }}");
    expect(workflow).toContain("CONVEX_DEPLOY_KEY: ${{ secrets.PRODUCTION_CONVEX_DEPLOY_KEY }}");
    // Names only: no literal credential value in the workflow text.
    expect(workflow).not.toMatch(/\|(fixture|ey)[A-Za-z0-9|-]{8,}/);
  });
});
