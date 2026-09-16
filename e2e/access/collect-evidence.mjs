#!/usr/bin/env node
/**
 * The B5 evidence collector: merges the per-leg results.json files of one
 * or more runs into the committed qualification matrix
 * docs/evidence/access/qualification/results.json — the matrix is always
 * REGENERATED from the runs, never hand-edited.
 *
 * What it does:
 * - reads each run's per-leg results.json (from /tmp/kiero-smoke/b5/<run>,
 *   falling back to the committed runs/<run>/<leg>/results.json when /tmp
 *   was cleaned) and carries EACH RUN's OWN candidateSha into its rows
 *   (runs executed at different candidates stay correctly attributed);
 * - maps every case id to its acceptance criterion (issue B5 #134);
 * - consolidates a live GM entry walk (the four entry-mode rows of one
 *   gm-entry run) into the single `gm-entry-audited-walk` case the README
 *   documents — PASS exactly when all four legs PASS — and suppresses the
 *   static NOT-RUN row for it while a live walk exists;
 * - deduplicates rows by (leg, case id) when several runs carry the same
 *   leg — a LATER --run in the argument list wins (superseded runs like
 *   the first identity attempt are listed before their corrective run);
 * - copies sanitized text snapshots into runs/<run>/<leg>/ WITHOUT
 *   overwriting files already committed (idempotent regeneration);
 * - appends the static BLOCKED/NOT-RUN rows no live run can produce.
 *
 * Totals: `totals` counts the LIVE rows (the runs' own cases);
 * `totalsAll` counts every row in the matrix including the statics —
 * both are stated explicitly so prose and matrix cannot drift.
 *
 * Usage (run order matters: superseded runs first):
 *   node e2e/access/collect-evidence.mjs \
 *     --run b5-i2 --run b5-i4 --run b5-c3 --run b5-gm1 --run b5-gm-entry2 \
 *     --candidate-sha d43fc27
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};
const runs = args.flatMap((a, i) => (a === "--run" ? [args[i + 1]] : [])).filter(Boolean);
const candidateSha = argValue("--candidate-sha", "d43fc27");
if (runs.length === 0) throw new Error("at least one --run is required");

const COMMITTED = join("docs", "evidence", "access", "qualification");

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
  "member-authored-message": "ac3-invitations-membership",
  "invitation-revocation-hostile-acceptance": "ac3-invitations-membership",
  "invitation-second-acceptance-refused": "ac3-invitations-membership",
  "last-administrator-constraints": "ac3-last-administrator",
  "administrator-transfer": "ac3-last-administrator",
  "administrator-transfer-race": "ac3-last-administrator",
  "membership-removal-old-session-denial": "ac4-existing-session-denial",
  "logout-old-token-denied": "ac4-logout-and-changes",
  // The GM entry walk's four legs (README AC3: explicit GM entry, audited
  // author/action, ordinary read/activity metrics unchanged, exit).
  "gm-entry-non-designated-refused": "ac3-gm-entry-audit",
  "gm-entry-audited": "ac3-gm-entry-audit",
  "gm-inspect-audited": "ac3-gm-entry-audit",
  "gm-ordinary-metrics-unchanged": "ac3-gm-entry-audit",
  "gm-exit": "ac3-gm-entry-audit",
  "page-errors-zero": "cross-zero-page-errors",
};

/** The one consolidated case the README documents for a live GM walk. */
const GM_WALK_LEGS = ["gm-entry-audited", "gm-inspect-audited", "gm-ordinary-metrics-unchanged", "gm-exit"];

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
    // Suppressed while a live GM walk exists (see the consolidation above).
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

/** Where a run's leg artifacts live: /tmp first, the committed tree second. */
function legDirOf(run, dir) {
  const tmp = `/tmp/kiero-smoke/b5/${run}/${dir}`;
  if (existsSync(join(tmp, "results.json"))) return tmp;
  const committed = join(COMMITTED, "runs", run, dir);
  if (existsSync(join(committed, "results.json"))) return committed;
  return null;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const liveRows = new Map(); // key `${leg}:${id}` -> row; later runs override.
const environments = [];

for (const run of runs) {
  for (const { leg, dir, file } of LEGS) {
    const legDir = legDirOf(run, dir);
    if (legDir === null) continue;
    const parsed = JSON.parse(readFileSync(join(legDir, "results.json"), "utf8"));
    const runSha = parsed.candidateSha ?? candidateSha;
    environments.push({ run, leg, candidateSha: runSha, web: parsed.environment?.web, convexUrl: parsed.environment?.convexUrl });
    for (const result of parsed.results ?? []) {
      liveRows.set(`${leg}:${result.id}`, {
        run,
        leg,
        candidateSha: runSha,
        ...result,
        criterion: CRITERION[result.id] ?? "unmapped",
        repeatableCommand: `node e2e/access/${file} --run ${run} --candidate-sha ${runSha}`,
      });
    }
    // Sanitized snapshots: copy into the committed tree without overwriting
    // anything already committed (idempotent regeneration).
    const targetDir = join(COMMITTED, "runs", run, dir);
    mkdirSync(targetDir, { recursive: true });
    for (const name of readdirSafe(legDir)) {
      const target = join(targetDir, name);
      if (!existsSync(target) && (name.endsWith(".txt") || name === "results.json" || name === "state.json")) {
        cpSync(join(legDir, name), target);
      }
    }
  }
}

// Consolidate a live GM entry walk into the single documented case.
const walkRuns = new Map(); // run -> its four leg rows
for (const id of GM_WALK_LEGS) {
  const row = liveRows.get(`gm-entry:${id}`);
  if (row !== undefined) {
    const legs = walkRuns.get(row.run) ?? new Map();
    legs.set(id, row);
    walkRuns.set(row.run, legs);
    liveRows.delete(`gm-entry:${id}`);
  }
}
for (const [run, legs] of walkRuns) {
  if (legs.size < GM_WALK_LEGS.length) continue; // an incomplete walk stays out
  const all = GM_WALK_LEGS.map((id) => legs.get(id));
  const status = all.every((r) => r.status === "PASS")
    ? "PASS"
    : all.some((r) => r.status === "FAIL")
      ? "FAIL"
      : "BLOCKED";
  const staticText = STATIC_ROWS.find((r) => r.id === "gm-entry-audited-walk");
  liveRows.set("gm-entry:gm-entry-audited-walk", {
    run,
    leg: "gm-entry",
    candidateSha: all[0].candidateSha,
    id: "gm-entry-audited-walk",
    status,
    criterion: "ac3-gm-entry-audit",
    expected: staticText.expected,
    observed: `coordinator-executed walk at candidate ${all[0].candidateSha}: ${all
      .map((r) => `${r.id}=${r.status}`)
      .join("; ")} (banner with the stated basis; audited inspection; byte-identical boss metrics; honest inactive panel after exit)`,
    repeatableCommand: `node e2e/access/gm-entry-leg.mjs --run ${run} --mode entry --operator-mailbox <mailbox.json> --company-id <k78...> --candidate-sha ${all[0].candidateSha}`,
  });
}

const liveResults = [...liveRows.values()];
const statics = STATIC_ROWS.filter((row) => {
  // A live GM walk replaces the static NOT-RUN row for the same case.
  if (row.id === "gm-entry-audited-walk" && liveRows.has("gm-entry:gm-entry-audited-walk")) return false;
  return true;
});

const count = (rows) => rows.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
const merged = {
  defaultCandidateSha: candidateSha,
  collectedAt: new Date().toISOString(),
  note: "every live row carries its OWN run's candidateSha (runs executed at different candidates stay correctly attributed); totals counts the live rows, totalsAll counts every row in this matrix",
  environments,
  totals: count(liveResults),
  totalsAll: count([...liveResults, ...statics]),
  staticRows: statics.length,
  results: [...liveResults, ...statics],
};
mkdirSync(COMMITTED, { recursive: true });
writeFileSync(join(COMMITTED, "results.json"), `${JSON.stringify(merged, null, 2)}\n`);
console.log(
  `[collect] ${liveResults.length} live rows + ${statics.length} static rows; live totals ${JSON.stringify(merged.totals)}; all-row totals ${JSON.stringify(merged.totalsAll)}`,
);
