/**
 * Type surface for deploy-component.mjs (the checked deploy adapter), so
 * tests and any node consumer typecheck against the real API.
 */

export interface DeployOutcomeDeployed {
  readonly component: string;
  readonly outcome: "deployed";
  readonly digest: string;
  readonly fileCount: number;
  readonly transportKind: string;
  readonly remoteIdentity: { readonly kind: string; readonly id: string; readonly [field: string]: unknown };
}

export interface DeployOutcomeSkipped {
  readonly component: string;
  readonly outcome: "skipped";
  readonly skipReason: "excluded-by-descriptor";
}

export interface DeployOutcomeBlocked {
  readonly component: string;
  readonly outcome: "blocked";
  readonly blockedReason: string;
  readonly [field: string]: unknown;
}

export type DeployOutcome = DeployOutcomeDeployed | DeployOutcomeSkipped | DeployOutcomeBlocked;

export interface DeployComponentsResult {
  readonly outcomes?: readonly DeployOutcome[];
  readonly exitCode: number;
  readonly violations?: readonly string[];
  readonly unknownComponents?: readonly string[];
  readonly knownComponents?: readonly string[];
}

export declare const BLOCKED_REASONS: readonly string[];

export declare function runCommand(
  command: string,
  options?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
): { ok: boolean; exitCode: number | null; outputTail: string };

export declare function digestArtifactPath(
  artifactPath: string,
): { digest: string; fileCount: number };

export declare function deployComponents(options: {
  descriptorPath: string;
  revision: string;
  checksReportPath: string;
  componentIds?: readonly string[] | null;
  env?: Record<string, string | undefined>;
  cwd?: string;
  ledgerPath?: string | null;
  outcomesPath?: string | null;
}): Promise<DeployComponentsResult>;
