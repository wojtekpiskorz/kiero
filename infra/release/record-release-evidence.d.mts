/**
 * Type surface for record-release-evidence.mjs (the append-only release
 * evidence ledger), so tests and any node consumer typecheck against the
 * real API.
 */

export declare const RELEASE_EVIDENCE_PATH: URL;

export declare const COMPONENT_OUTCOMES: readonly string[];

export interface ReleaseAttemptRecord {
  readonly kind: "release-attempt";
  readonly recordedAtIso: string;
  readonly target: string;
  readonly revision: string;
  readonly descriptorId?: string;
  readonly notes?: string;
  readonly rehearsal: string;
  readonly runtimeVersion: string;
  readonly clientVersion: string;
  readonly migrationLedgerSha256?: string;
}

export interface ComponentOutcomeRecord {
  readonly kind: "component-outcome";
  readonly recordedAtIso: string;
  readonly target: string;
  readonly revision: string;
  readonly descriptorId: string;
  readonly component: string;
  readonly outcome: "deployed" | "skipped" | "blocked";
  readonly [field: string]: unknown;
}

export type ReleaseEvidenceRecord = ReleaseAttemptRecord | ComponentOutcomeRecord;

export declare function buildReleaseRecord(input: {
  target: string;
  revision: string;
  rehearsalPassed: boolean;
  rehearsalRows: number;
  runtimeVersion: string;
  clientVersion: string;
  descriptorId?: string | null;
  notes?: string | null;
  migrationLedgerText?: string | null;
  recordedAtIso?: string;
}): ReleaseAttemptRecord;

export declare function buildComponentOutcomeRecord(input: {
  target: string;
  revision: string;
  descriptorId: string;
  outcome: {
    readonly component: string;
    readonly outcome: "deployed" | "skipped" | "blocked";
    readonly [field: string]: unknown;
  };
  recordedAtIso?: string;
}): ComponentOutcomeRecord;

export declare function sha256Hex(text: string): string;

export declare function appendReleaseRecord(
  record: ReleaseEvidenceRecord,
  path?: string | URL,
): void;

export declare function readReleaseRecords(path?: string | URL): ReleaseEvidenceRecord[];
