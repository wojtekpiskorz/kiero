/**
 * The backup executor's ports (I5): the three external systems the pipeline
 * touches, as small typed interfaces so the SAME pipeline runs:
 *
 * - in the EU backup Container against real R2 S3 endpoints + the pinned
 *   Convex CLI export (production path; typed `not_configured` refusals
 *   until the owner injects the per-bucket tokens, the honest-pending
 *   pattern proved by D6), and
 * - in live proofs/tests against in-memory or CLI transports.
 *
 * The Convex protocol (lease/complete/fail/sweep) is also a port: the
 * container talks to the verified HTTP boundary, proofs to the guarded
 * probe actions - both run the REAL server-side decisions.
 */

export interface ExportResult {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly sha256Hex: string;
}

/** The pinned documented export mechanism (npx convex@1.45.0 export). */
export interface DatabaseExporter {
  export(): Promise<ExportResult | { readonly ok: false; readonly code: "export_not_configured" | "export_failed"; readonly exitCode?: number }>;
}

export interface MediaReadResult {
  readonly ok: true;
  readonly bytes: Uint8Array;
  readonly sha256Hex: string;
}

/** Read-only access to the retained-media pool (the copy source). */
export interface MediaReader {
  get(objectKey: string): Promise<MediaReadResult | { readonly ok: false; readonly code: "media_not_configured" | "media_object_missing" }>;
}

export interface HeadResult {
  readonly present: boolean;
  readonly sha256Hex?: string;
  readonly bytes?: number;
}

export interface PutResult {
  readonly ok: true;
  readonly skipped: boolean;
}

/** The private EU backup bucket (the ONLY credential that writes sets). */
export interface BackupStore {
  head(key: string): Promise<HeadResult | { readonly ok: false; readonly code: "store_not_configured" }>;
  put(key: string, bytes: Uint8Array, sha256Hex: string): Promise<PutResult | { readonly ok: false; readonly code: "store_not_configured" | "store_write_failed" }>;
  get(key: string): Promise<{ readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly code: "store_not_found" | "store_not_configured" }>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<readonly { key: string; bytes: number; lastModifiedMs: number }[]>;
}

// --- the Convex protocol port (typed to the server's result shapes) --------

export interface ProtocolBeginMediaEntry {
  readonly objectKey: string;
  readonly contentHash: string;
  readonly bytes: number | null;
  readonly sourceId: string | null;
}

export interface ProtocolBegin {
  readonly status: "acquired" | "refused";
  readonly manifestId?: string;
  readonly attempt?: number;
  readonly slotMs?: number;
  readonly snapshotAtMs?: number;
  readonly tier?: "frequent" | "daily";
  readonly leaseExpiresAtMs?: number;
  readonly media?: readonly ProtocolBeginMediaEntry[];
  readonly purgedDrops?: readonly { objectKey: string; sourceId: string }[];
  readonly ledger?: readonly {
    recordId: string;
    companyId: string;
    kind: "source_purge" | "data_revocation";
    targetSourceId: string | null;
    scopeSummary: string;
    createdAtMs: number;
  }[];
  readonly reason?: string;
}

export interface ProtocolCompleteInput {
  readonly manifestId: string;
  readonly attempt: number;
  readonly database: { readonly sha256: string; readonly bytes: number };
  readonly media: readonly { objectKey: string; sha256: string; bytes: number }[];
  readonly ledger: { readonly sha256: string; readonly bytes: number; readonly count: number };
  readonly manifestHash: string;
  readonly droppedPurged: readonly { objectKey: string; sourceId: string }[];
}

export interface ProtocolSweepPlan {
  readonly plan: {
    readonly expiredSets: readonly { manifestId: string; slotMs: number; mediaObjectKeys: readonly string[] }[];
    readonly survivingReferences: readonly string[];
    readonly deletableObjectKeys: readonly string[];
  };
  readonly referencedByAnyManifest: readonly string[];
}

/** The Convex side of the protocol (HTTP boundary or guarded probe actions). */
export interface BackupProtocol {
  begin(): Promise<ProtocolBegin>;
  complete(input: ProtocolCompleteInput): Promise<{ readonly ok: boolean; readonly reason?: string; readonly tier?: string; readonly expiresAtMs?: number }>;
  fail(manifestId: string, attempt: number, reason: string): Promise<{ readonly ok: boolean }>;
  sweep(): Promise<ProtocolSweepPlan>;
  sweepComplete(input: {
    collectedManifestIds: readonly string[];
    deletedObjectKeys: readonly string[];
    orphanKeysRemoved: readonly string[];
  }): Promise<{ readonly collected: number; readonly replayed: number; readonly prunedFailed: number; readonly skipped: number }>;
}

// --- the assembled dependency bundle -----------------------------------------

export interface BackupDeps {
  readonly protocol: BackupProtocol;
  readonly exporter: DatabaseExporter;
  readonly media: MediaReader;
  readonly store: BackupStore;
}

/** The full runtime env (vars + secret NAMES) the worker/container read. */
export interface BackupWorkerEnv {
  readonly ENVIRONMENT?: string;
  readonly KIERO_SERVICE_TOKEN?: string;
  readonly CONVEX_SITE_URL?: string;
  readonly CONVEX_EXPORT_DEPLOYMENT?: string;
  readonly CONVEX_BACKUP_ADMIN_KEY?: string;
  readonly R2_BACKUP_ENDPOINT?: string;
  readonly R2_BACKUP_BUCKET?: string;
  readonly R2_BACKUP_ACCESS_KEY_ID?: string;
  readonly R2_BACKUP_SECRET_ACCESS_KEY?: string;
  readonly R2_MEDIA_ENDPOINT?: string;
  readonly R2_MEDIA_BUCKET?: string;
  readonly R2_MEDIA_READ_ACCESS_KEY_ID?: string;
  readonly R2_MEDIA_READ_SECRET_ACCESS_KEY?: string;
}

/** The closed run-failure vocabulary the pipeline reports to the server. */
export type PipelineFailureCode =
  | "export_not_configured"
  | "export_failed"
  | "media_not_configured"
  | "media_object_missing"
  | "media_hash_mismatch"
  | "media_verify_failed"
  | "store_not_configured"
  | "store_write_failed"
  | "store_verify_failed"
  | "complete_rejected"
  | "interrupted";

/** Deterministic interrupt points (proofs simulate mid-run crashes). */
export type InterruptPoint =
  | "after_lease"
  | "after_export"
  | "mid_media"
  | "after_media"
  | "before_manifest"
  | "after_manifest"
  | "before_sweep";

export class PipelineInterrupt extends Error {
  constructor(readonly at: InterruptPoint) {
    super(`pipeline interrupted at ${at}`);
  }
}
