/**
 * Type surface for verify-checks.mjs (the deterministic Checks gate), so
 * tests and any node consumer typecheck against the real API.
 */

export interface ChecksObservation {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headSha: string;
}

export interface ChecksReport {
  readonly generatedAtIso: string;
  readonly source: string;
  readonly requestedSha: string;
  readonly checksName: string | null;
  readonly decision: "pass" | "refuse";
  readonly reasons: readonly string[];
  readonly observed: readonly ChecksObservation[];
}

export declare function buildChecksReport(input: {
  requestedSha: string;
  checksName: string;
  source: string;
  observations: readonly ChecksObservation[];
  reasons: readonly string[];
  decision: "pass" | "refuse";
}): ChecksReport;

export declare function evaluateChecksGate(input: {
  revision: string;
  checksName: string;
  observations: readonly ChecksObservation[];
}): { decision: "pass" | "refuse"; reasons: string[] };

export declare function observationsFromGitHubPayload(
  payload: unknown,
): ChecksObservation[];

export declare function fetchChecksObservations(input: {
  repo: string;
  sha: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ChecksObservation[]>;
