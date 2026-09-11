/**
 * Type surface for verify-target.mjs (the wrong-environment guard), so
 * tests and any node consumer typecheck against the real API.
 */

export declare const RELEASE_TARGETS: {
  readonly [target: string]: {
    readonly secretPrefix: string;
    readonly environmentName: string;
  };
};

export declare function extractJobBlock(
  workflowText: string,
  jobId: string,
): string | null;

export declare function extractSecretReferences(jobBlock: string): string[];

export declare function extractJobEnvironment(jobBlock: string): string | null;

export declare function checkReleaseTarget(input: {
  target: string;
  workflowText: string;
  jobId: string;
  environmentLabel?: string;
}): string[];
