/**
 * Type surface for target-descriptor.mjs (the shared release-target
 * descriptor format), so tests and any node consumer typecheck against
 * the real API.
 */

export declare const RELEASE_TARGETS: {
  readonly [target: string]: {
    readonly secretPrefix: string;
    readonly environmentName: string;
  };
};

export declare const TRANSPORT_KINDS: readonly string[];

export interface TargetDescriptorTransport {
  readonly kind: string;
  readonly [field: string]: unknown;
}

export interface TargetDescriptorComponent {
  readonly id: string;
  readonly included: boolean;
  readonly build: string | null;
  readonly artifact: string;
  readonly transport: TargetDescriptorTransport;
  readonly requiredConfig: readonly string[];
}

export interface TargetDescriptor {
  readonly descriptorId: string;
  readonly target: string;
  readonly githubEnvironment: string;
  readonly secretPrefix: string;
  readonly checksName: string;
  readonly components: readonly TargetDescriptorComponent[];
}

export declare function validateTargetDescriptor(value: unknown): string[];

export declare function parseTargetDescriptor(
  text: string,
): { descriptor: TargetDescriptor; violations?: undefined } | { descriptor?: undefined; violations: string[] };

export declare function loadTargetDescriptor(
  path: string,
): { descriptor: TargetDescriptor; violations?: undefined } | { descriptor?: undefined; violations: string[] };

export declare const COMMITTED_TARGETS_DIRECTORY: string;

export declare function isCommittedDescriptorPath(path: string, cwd?: string): boolean;

export declare function committedDescriptorViolations(descriptor: {
  readonly components: readonly { readonly id: string; readonly transport?: { readonly kind?: string } }[];
}): string[];
