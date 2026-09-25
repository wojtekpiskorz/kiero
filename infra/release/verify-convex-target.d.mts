/**
 * Type surface for verify-convex-target.mjs (the credential-target
 * gate), so tests and any node consumer typecheck against the real API.
 */

export interface ConvexKeyClassification {
  readonly kind: "missing" | "unparseable" | "preview" | "project" | "deployment";
  readonly keyDeploymentType?: string;
  readonly slug?: string;
}

export interface ConvexObservedIdentity {
  readonly type: string | null;
  readonly typeLabel: string | null;
  readonly teamSlug: string | null;
  readonly projectSlug: string | null;
  readonly reference: string | null;
  readonly isDefault: boolean;
  readonly slug: string | null;
  readonly url: string | null;
  readonly region: string | null;
}

export interface ConvexExpectedIdentity {
  readonly teamSlug: string;
  readonly projectSlug: string;
  readonly reference: string;
  readonly type: string;
  readonly slug: string;
  readonly url: string;
  readonly isDefault?: boolean;
}

export type ConvexTargetVerification =
  | { readonly decision: "pass"; readonly identity: Omit<ConvexObservedIdentity, "typeLabel"> }
  | {
      readonly decision: "refuse";
      readonly refusalCode: string;
      readonly reason: string;
      readonly expected?: ConvexExpectedIdentity;
      readonly observed?: Omit<ConvexObservedIdentity, "typeLabel">;
      readonly differences?: readonly string[];
      readonly probeExitCode?: number | null;
      readonly probeCommand?: string;
      readonly probeOutputTail?: string;
    };

export declare const CONVEX_IDENTITY_PROBE_ARGV: readonly string[];

export declare const CONVEX_TARGET_REFUSAL_CODES: readonly string[];

export declare function classifyConvexDeployKey(key: string | undefined): ConvexKeyClassification;

export declare function parseConvexAnnouncement(rawText: string): ConvexObservedIdentity | null;

export declare function compareConvexIdentity(
  observed: ConvexObservedIdentity,
  expected: ConvexExpectedIdentity,
): string[];

export declare function sanitizeConvexOutput(
  env: Record<string, string | undefined>,
  text: string,
): string;

export declare function verifyConvexTarget(options: {
  env: Record<string, string | undefined>;
  cwd: string;
  expectedIdentity?: ConvexExpectedIdentity | null;
}): ConvexTargetVerification;
