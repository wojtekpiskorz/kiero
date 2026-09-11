/**
 * Type surface for record-release-evidence.mjs (the append-only release
 * evidence ledger), so tests and any node consumer typecheck against the
 * real API.
 */

export declare const RELEASE_EVIDENCE_PATH: URL;

export interface ReleaseEvidenceRecord {
  readonly recordedAtIso: string;
  readonly target: string;
  readonly revision: string;
  readonly rehearsal: string;
  readonly runtimeVersion: string;
  readonly clientVersion: string;
  readonly migrationLedgerSha256?: string;
}

export declare function buildReleaseRecord(input: {
  target: string;
  revision: string;
  rehearsalPassed: boolean;
  rehearsalRows: number;
  runtimeVersion: string;
  clientVersion: string;
  migrationLedgerText?: string | null;
  recordedAtIso?: string;
}): ReleaseEvidenceRecord;

export declare function sha256Hex(text: string): string;

export declare function appendReleaseRecord(
  record: ReleaseEvidenceRecord,
  path?: string | URL,
): void;

export declare function readReleaseRecords(path?: string | URL): ReleaseEvidenceRecord[];
