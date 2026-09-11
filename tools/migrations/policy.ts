/**
 * Release compatibility policy (I7): the ONE definition of the version,
 * support-window and repair rules every release surface shares.
 *
 * The web update module (apps/web/src/pwa/update) imports this file so the
 * client-side "unsupported old client" decision and the release tooling's
 * contract gate can never drift into two definitions.
 *
 * Rules encoded here (issue #59 bounded solution):
 *
 * - client support is a WINDOW, not a moment: the deployment names the
 *   current version and the oldest version it still supports; versions in
 *   between get "update-available" (polite), older ones "update-required";
 * - old support is REMOVED only after measured absence: a contract phase
 *   that runs while an older version was observed inside the absence
 *   window is rejected;
 * - security/session revocation is immediate for EVERY client age; update
 *   deferral never shields a revoked client;
 * - release repair is code-level (compatible rollback or forward fix):
 *   restoring an old database as release rollback is refused by
 *   construction, and so is resurrecting revoked access.
 */

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** A dotted numeric version; no prerelease vocabulary exists yet. */
export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION_PATTERN = /^(\d{1,4})(?:\.(\d{1,4}))?(?:\.(\d{1,4}))?$/;

/** Parses `1`, `1.2` or `1.2.3` (missing parts are zero); null otherwise. */
export function parseReleaseVersion(value: string): ReleaseVersion | null {
  const match = VERSION_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
  };
}

/** Negative when `a` is older, positive when newer, zero when equal. */
export function compareReleaseVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

// ---------------------------------------------------------------------------
// Client support decisions
// ---------------------------------------------------------------------------

/** What a deployment tells one connected client about its own version. */
export type ClientSupportDecision =
  | "current"
  | "update-available"
  | "update-required";

/** The deployment-side support window (names, never values). */
export interface ClientSupportPolicy {
  /** The version this deployment ships (equal = current). */
  readonly currentVersion: string;
  /** The oldest version this deployment still serves (inclusive). */
  readonly minSupportedVersion: string;
}

/**
 * Decides one observed client version against the window. Null means the
 * observed value is not a version this policy can speak about; callers
 * must treat that as a validation failure, never as "current".
 */
export function decideClientSupport(
  policy: ClientSupportPolicy,
  observedVersion: string,
): ClientSupportDecision | null {
  const observed = parseReleaseVersion(observedVersion);
  const current = parseReleaseVersion(policy.currentVersion);
  const minimum = parseReleaseVersion(policy.minSupportedVersion);
  if (observed === null || current === null || minimum === null) {
    return null;
  }
  if (compareReleaseVersions(observed, current) >= 0) {
    return "current";
  }
  if (compareReleaseVersions(observed, minimum) >= 0) {
    return "update-available";
  }
  return "update-required";
}

// ---------------------------------------------------------------------------
// Security events (revocation immediacy)
// ---------------------------------------------------------------------------

/**
 * The security-event answer is the SAME for every client age by
 * construction: revocation applies immediately, and no update state (a
 * pending prompt, a deferred reload, an unsupported client waiting for the
 * user to refresh) delays or shields it. Kept as an explicit function so
 * the rule is testable and consumed, not just documented.
 */
export interface SecurityEventPolicy {
  readonly revocationApplication: "immediate";
  readonly deferredByUpdateState: false;
}

export function securityEventPolicy(
  _decision: ClientSupportDecision | null,
): SecurityEventPolicy {
  return { revocationApplication: "immediate", deferredByUpdateState: false };
}

// ---------------------------------------------------------------------------
// The contract gate (measured absence)
// ---------------------------------------------------------------------------

/** One observed use of a version below the support window. */
export interface VersionObservation {
  readonly version: string;
  readonly observedAtMs: number;
}

/** When old support may be removed: only after measured absence. */
export interface ContractGate {
  /** The version becoming the new minimum after contraction. */
  readonly minSupportedVersion: string;
  /** How long the older versions must have been UNSEEN before removal. */
  readonly absenceWindowMs: number;
}

export type ContractDecision =
  | {
      readonly allowed: true;
      /** Age of the newest older-version observation, for the evidence row. */
      readonly newestOlderObservationAgeMs: number | null;
    }
  | {
      readonly allowed: false;
      /** The observation that blocks removal (inside the window). */
      readonly blocking: VersionObservation;
      readonly blockingAgeMs: number;
    };

/**
 * Decides whether the contract phase may run: every observation of a
 * version BELOW the gate's minimum must be older than the absence window.
 * Versions at or above the minimum are irrelevant (still supported).
 */
export function decideContractRemoval(
  gate: ContractGate,
  observations: readonly VersionObservation[],
  nowMs: number,
): ContractDecision {
  const minimum = parseReleaseVersion(gate.minSupportedVersion);
  if (minimum === null) {
    throw new Error(
      `contract gate: minSupportedVersion "${gate.minSupportedVersion}" is not a release version`,
    );
  }
  let newest: VersionObservation | null = null;
  for (const observation of observations) {
    const version = parseReleaseVersion(observation.version);
    if (version === null) {
      throw new Error(
        `contract gate: observed version "${observation.version}" is not a release version`,
      );
    }
    if (compareReleaseVersions(version, minimum) >= 0) {
      continue;
    }
    if (newest === null || observation.observedAtMs > newest.observedAtMs) {
      newest = observation;
    }
  }
  if (newest === null) {
    return { allowed: true, newestOlderObservationAgeMs: null };
  }
  const ageMs = nowMs - newest.observedAtMs;
  if (ageMs < gate.absenceWindowMs) {
    return { allowed: false, blocking: newest, blockingAgeMs: ageMs };
  }
  return { allowed: true, newestOlderObservationAgeMs: ageMs };
}

// ---------------------------------------------------------------------------
// Release repair planning
// ---------------------------------------------------------------------------

/** What an operator (or automation) asked the release system to do. */
export type RepairRequest =
  | { readonly kind: "restore_database_backup" }
  | {
      readonly kind: "rollback_code";
      readonly releaseId: string;
      readonly previousVersion: string;
    }
  | { readonly kind: "forward_fix"; readonly releaseId: string };

/** The planned repair; a refusal carries the load-bearing reason. */
export type RepairPlan =
  | {
      readonly kind: "rejected";
      readonly reason:
        | "database_restore_forbidden"
        | "revoked_access_resurrection_forbidden";
    }
  | {
      readonly kind: "compatible_rollback";
      readonly releaseId: string;
      readonly redeployVersion: string;
      /** What the rollback intentionally does NOT do. */
      readonly keeps: readonly string[];
    }
  | {
      readonly kind: "forward_fix";
      readonly releaseId: string;
      readonly steps: readonly string[];
    };

/**
 * Plans one repair. Two refusals are load-bearing (issue AC "Rollback /
 * forward repair does not restore an old database or resurrect revoked
 * access"):
 *
 * - `restore_database_backup` NEVER becomes a plan: restoring an old
 *   database would discard newer canonical data (a later correction) as a
 *   side effect of release recovery; backups serve disaster recovery, not
 *   routine releases;
 * - a code rollback may re-serve older code, but the older code keeps the
 *   EXPANDED schema support (that is what the expand phase bought), so no
 *   database change is part of the plan and no access row is rewritten.
 */
export function planReleaseRepair(request: RepairRequest): RepairPlan {
  switch (request.kind) {
    case "restore_database_backup":
      return { kind: "rejected", reason: "database_restore_forbidden" };
    case "rollback_code":
      return {
        kind: "compatible_rollback",
        releaseId: request.releaseId,
        redeployVersion: request.previousVersion,
        keeps: [
          "expanded schema (the old code still reads post-expansion data)",
          "migrated documents (no data is rewritten back)",
          "revoked access rows (revocation is never undone by a release)",
        ],
      };
    case "forward_fix":
      return {
        kind: "forward_fix",
        releaseId: request.releaseId,
        steps: [
          "ship the fix as a new compatible release",
          "run the release rehearsal before deploy",
          "record the repair in the release evidence ledger",
        ],
      };
  }
}
