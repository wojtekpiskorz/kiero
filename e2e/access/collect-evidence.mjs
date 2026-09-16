#!/usr/bin/env node
/**
 * The B5 evidence collector: merges the per-leg results.json files of one
 * or more runs (under /tmp/kiero-smoke/b5/<run>/...) into the committed
 * qualification matrix docs/evidence/access/qualification/results.json,
 * maps every case to its acceptance criterion, appends the static
 * BLOCKED/NOT-RUN rows (Google leg, GM entry pending, 30-day inactivity)
 * and copies the sanitized text snapshots into
 * docs/evidence/access/qualification/runs/<run>/<leg>/.
 *
 * Usage:
 *   node e2e/access/collect-evidence.mjs --run b5-i2 --run b5-c2 --run b5-gm1 \
 *     --candidate-sha d43fc27
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const runs = args.flatMap((a, i) => (a === "--run" ? [args[i + 1]] : [])).filter(Boolean);
const candidateSha = args[args.indexOf("--candidate-sha") + 1] ?? "d43fc27";
if (runs.length === 0) throw new Error("at least one --run is required");

const LEGS = [
  { leg: "identity-email", dir: "identity", file: "identity-email-leg.mjs" },
  { leg: "company-access", dir: "company", file: "company-access-leg.mjs" },
  { leg: "gm-entry", dir: "gm", file: "gm-entry-leg.mjs" },
];

/** Case id -> the acceptance criterion (issue B5 #134) it evidences. */
const CRITERION = {
  "google-entry-present": "ac1-google-sign-in-real-callback",
  "otp-delivery": "ac1-email-code-delivery",
  "otp-issuance-limit": "ac1-rate-limits",
  "otp-limiter-mails-really-delivered": "ac1-rate-limits",
  "otp-verification-failure-limit": "ac1-rate-limits",
  "otp-wrong-code": "ac1-wrong-code",
  "otp-onetime-use-replay-refused": "ac1-one-time-use-replay",
  "otp-expiry": "ac1-expiry",
  "session-recovery-reload": "ac2-session-recovery",
  "sameemail-resume-second-device": "ac2-same-email-both-directions",
  "sameemail-cross-method-signin": "ac2-same-email-both-directions",
  "independent-browser-sessions": "ac2-session-recovery",
  "device-revocation-immediate-denial": "ac4-existing-session-denial",
  "link-concurrent-begin": "ac2-conflicting-concurrent-linking",
  "link-ceremony-opened": "ac2-explicit-linking",
  "link-wrong-code-unstaged": "ac2-explicit-linking",
  "link-email-leg-delivered": "ac2-explicit-linking",
  "link-email-target-already-attached": "ac2-refuse-unauthorized-merges",
  "link-google-oauth-commit": "ac2-explicit-linking",
  "emailchange-confirm": "ac2-email-account-method-changes",
  "account-continuity-after-change": "ac2-email-account-method-changes",
  "emailchange-old-address-detached": "ac2-email-account-method-changes",
  "calendar-entry-absent": "ac5-calendar-disconnect-sign-in-usable",
  "company-founded-first-admin": "ac3-invitations-membership",
  "invitation-targeted-delivery": "ac3-invitations-membership",
  "invitation-acceptance-member": "ac3-invitations-membership",
  "invitation-revocation-hostile-acceptance": "ac3-invitations-membership",
  "invitation-second-acceptance-refused": "ac3-invitations-membership",
  "last-administrator-constraints": "ac3-last-administrator",
  "administrator-transfer": "ac3-last-administrator",
  "administrator-transfer-race": "ac3-last-administrator",
  "membership-removal-old-session-denial": "ac4-existing-session-denial",
  "logout-old-token-denied": "ac4-logout-and-changes",
  "gm-entry-non-designated-refused": "ac3-gm-entry-audit",
  "page-errors-zero": "cross-zero-page-errors",
};

/** Static rows no live run can produce on this candidate. */
const STATIC_ROWS = [
  {
    id: "google-signin-completion",
    leg: "google",
    status: "BLOCKED",
    criterion: "ac1-google-sign-in-real-callback",
    expected:
      "a real Google authorization completes the OAuth callback on the live origin and lands in an authenticated session (redirect already proven: issue #15 checkpoint 2026-09-15 session 3)",
    observed:
      "NOT executed: requires a real tester Google login (owner credentials). The Google button renders live (google-entry-present PASS) and the redirect was proven at the #15 checkpoint; only the credential-backed completion remains",
    blocked: {
      responsibleActor: "owner (Wojtek Piskorz)",
      nextAction: "one tester Google login on the staged noVNC browser (Google project kiero-508611, External/Testing, one test user) or owner-relayed test credentials",
      resumptionTrigger: "the Google sign-in completion leg executed against staging; then also execute sameemail-cross-method-signin and link-google-oauth-commit",
    },
  },
  {
    id: "gm-entry-audited-walk",
    leg: "gm-entry",
    status: "NOT RUN",
    criterion: "ac3-gm-entry-audit",
    expected:
      "the designated operator enters GM mode with a stated basis (audited grant: actor, reason, time), inspects a target company through the audited command, ordinary boss read/activity metrics stay unchanged, and exit ends access immediately",
    observed:
      "driver ready (e2e/access/gm-entry-leg.mjs --mode entry), NOT executed: the KIERO_GM_EMAILS Convex env var is the coordinator-serialized allow-list mutation and this lane must not touch it. The fail-closed side IS proven live (gm-entry-non-designated-refused)",
    blocked: {
      responsibleActor: "implementation coordinator",
      nextAction: "add the operator address to KIERO_GM_EMAILS on wojtek-piskorz-jr:kiero-dev-core:staging (serialized between lanes), then run the entry mode with a stated basis against the B5 company",
      resumptionTrigger: "allow-list mutation window granted to this lane",
    },
  },
  {
    id: "inactivity-30-day",
    leg: "identity-email",
    status: "NOT RUN",
    criterion: "ac4-30-day-inactivity",
    expected:
      "a session with 30 days of inactivity stops resolving on every protected read ('Sesja wygasła po 30 dniach nieaktywności.'), while 30-days-minus-one stays live",
    observed:
      "real-time requirement: 30 elapsed days cannot be compressed on the live staging candidate, and the dev-only aging fixtures (convex/access/identity/probe.ts b1ProofAgeSession, gated by KIERO_B1_PROOF_ENABLED) are disabled on the prod-type staging deployment. The boundary itself is pinned by the accepted deterministic fixtures: tests/b1/cores.test.ts (SESSION_INACTIVITY_LIMIT_MS - 1 -> live, + 1 -> inactive, 31 days -> inactive) and tests/b1/resolution.test.ts; Convex Auth session totalDurationMs/inactiveDurationMs are pinned to the same 30 days in convex/access/identity/authEntry.ts",
    notRunReason: "explicit real-time requirement (30 elapsed days)",
  },
  {
    id: "invitation-expiry-7-day",
    leg: "company-access",
    status: "NOT RUN",
    criterion: "ac3-invitations-membership",
    expected: "an invitation older than seven days is refused at acceptance ('invitation_expired')",
    observed:
      "real-time requirement: 7 elapsed days; the expiry boundary (expired only AFTER the expiry instant) is pinned deterministically in tests/b3; live revocation-before-acceptance IS proven (invitation-revocation-hostile-acceptance)",
    notRunReason: "explicit real-time requirement (7 elapsed days)",
  },
];

const allResults = [];
const environments = [];
for (const run of runs) {
  for (const { leg, dir, file } of LEGS) {
    const resultsPath = `/tmp/kiero-smoke/b5/${run}/${dir}/results.json`;
    if (!existsSync(resultsPath)) continue;
    const parsed = JSON.parse(readFileSync(resultsPath, "utf8"));
    environments.push({ run, leg, web: parsed.environment?.web, convexUrl: parsed.environment?.convexUrl });
    for (const result of parsed.results ?? []) {
      allResults.push({
        run,
        leg,
        ...result,
        criterion: CRITERION[result.id] ?? "unmapped",
        repeatableCommand: `node e2e/access/${file} --run ${run} --candidate-sha ${candidateSha}`,
      });
    }
    // Sanitized text snapshots into the committed evidence tree.
    const sourceDir = `/tmp/kiero-smoke/b5/${run}/${dir}`;
    const targetDir = join("docs", "evidence", "access", "qualification", "runs", run, dir);
    mkdirSync(targetDir, { recursive: true });
    for (const name of readdirSafe(sourceDir)) {
      if (name.endsWith(".txt") || name === "results.json" || name === "state.json" || name.endsWith("-limit.txt")) {
        cpSync(join(sourceDir, name), join(targetDir, name));
      }
    }
  }
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const merged = {
  candidateSha,
  collectedAt: new Date().toISOString(),
  environments,
  totals: allResults.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}),
  staticRows: STATIC_ROWS.length,
  results: [...allResults, ...STATIC_ROWS],
};
mkdirSync(join("docs", "evidence", "access", "qualification"), { recursive: true });
writeFileSync(
  join("docs", "evidence", "access", "qualification", "results.json"),
  `${JSON.stringify(merged, null, 2)}\n`,
);
console.log(`[collect] ${allResults.length} live rows + ${STATIC_ROWS.length} static rows; totals ${JSON.stringify(merged.totals)}`);
