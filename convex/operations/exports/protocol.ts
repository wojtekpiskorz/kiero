/**
 * The firm-export protocol (I3): the ONE definition of the export lane's
 * vocabulary on every side of the deployment boundary. The Convex boundary
 * (./http.ts, ./access.ts, ./executor.ts), the export Worker
 * (apps/export-worker) and the gateway download route
 * (apps/gateway/src/exports) import it directly, the D2/D3 shared-home
 * ruling: mirrors of these schemas anywhere else are hazards, not copies.
 *
 * It stays out of @kiero/contracts because it is this lane's boundary
 * vocabulary, not the certified client surface (the client surface is
 * `operations.requestExport` plus the authenticated status query).
 *
 * BOUNDS (the "bounded archive" rule): a snapshot above any bound fails
 * closed with a typed kind; no partial archive is ever published. The
 * bounds are alpha-scale (a micro construction firm's year), well inside
 * one Convex transaction's read budget, and they are declared here so the
 * status screen, the tests and the evidence name the same numbers.
 */

/** The archive format the published bytes declare (bump on any layout change). */
export const ARCHIVE_SCHEMA_VERSION = "kiero-export/1" as const;

/** Downloads stay available this long after completion (issue #55). */
export const EXPORT_AVAILABILITY_MS = 24 * 60 * 60 * 1000;

/** Per-snapshot bounds; exceeding any one fails the build closed. */
export const EXPORT_BOUNDS = {
  maxSources: 2_000,
  maxRecordsPerCollection: 4_000,
  /** Sum over every collection; stays inside one transaction's read budget. */
  maxTotalRecords: 12_000,
  maxMediaItems: 1_500,
  maxMediaBytesTotal: 3 * 1024 * 1024 * 1024,
  /** The encoded snapshot must fit one function result. */
  maxSnapshotJsonBytes: 6 * 1024 * 1024,
} as const;

/** The archive's media type and the download's suggested file name stem. */
export const ARCHIVE_CONTENT_TYPE = "application/zip" as const;

// ---------------------------------------------------------------------------
// The snapshot the executor reads in ONE transaction and the Worker renders.
// Plain TypeScript: produced and consumed by this lane's own code only.
// ---------------------------------------------------------------------------

/** One retained media representation the archive must contain. */
export interface SnapshotMediaItem {
  readonly representationId: string;
  readonly attachmentId: string;
  readonly sourceId: string;
  readonly role: "received" | "retained";
  readonly kind: "audio" | "image";
  readonly objectKey: string;
  /** Ledger etag (unquoted) and byte length the Worker verifies before copying. */
  readonly etag: string;
  readonly bytes: number;
  readonly contentType: string;
  /** Archive-relative path, already sanitized (see `mediaArchivePath`). */
  readonly archivePath: string;
}

/** A generic record collection: rows are plain JSON documents. */
export type SnapshotRow = Readonly<Record<string, unknown>>;

/** The consistent company snapshot (one transaction, one `snapshotAtMs`). */
export interface CompanySnapshot {
  readonly schemaVersion: typeof ARCHIVE_SCHEMA_VERSION;
  readonly snapshotAtMs: number;
  readonly exportId: string;
  readonly company: {
    readonly companyId: string;
    readonly name: string;
    readonly timezone: string;
    readonly defaultCurrency: string;
  };
  /** Authors (users) referenced by the records: display data only. */
  readonly people: readonly SnapshotRow[];
  readonly memberships: readonly SnapshotRow[];
  readonly projects: readonly SnapshotRow[];
  readonly projectAliases: readonly SnapshotRow[];
  readonly contacts: readonly SnapshotRow[];
  readonly contactRoles: readonly SnapshotRow[];
  readonly sources: readonly SnapshotRow[];
  readonly sourceProjectLinks: readonly SnapshotRow[];
  readonly extractions: readonly SnapshotRow[];
  readonly sourceFragments: readonly SnapshotRow[];
  /** Attachment rows with the archive path of the copied representation (or null). */
  readonly attachments: readonly SnapshotRow[];
  readonly findings: readonly SnapshotRow[];
  readonly findingRevisions: readonly SnapshotRow[];
  readonly evidenceLinks: readonly SnapshotRow[];
  readonly findingDependencies: readonly SnapshotRow[];
  readonly clarifications: readonly SnapshotRow[];
  readonly extensionDefinitions: readonly SnapshotRow[];
  readonly extensionVersions: readonly SnapshotRow[];
  readonly tasks: readonly SnapshotRow[];
  readonly checklistItems: readonly SnapshotRow[];
  readonly events: readonly SnapshotRow[];
  readonly workRevisions: readonly SnapshotRow[];
  readonly media: readonly SnapshotMediaItem[];
}

/** The typed refusal of a snapshot read (bounds, missing row, stale token). */
export type SnapshotRefusal =
  | { readonly kind: "export_not_found" }
  | { readonly kind: "build_token_stale" }
  | { readonly kind: "export_not_building" }
  | { readonly kind: "bound_exceeded"; readonly bound: keyof typeof EXPORT_BOUNDS };

// ---------------------------------------------------------------------------
// Pure helpers shared by every side.
// ---------------------------------------------------------------------------

/** The R2 object key of one build attempt's archive (never caller-supplied). */
export function archiveObjectKey(companyId: string, exportId: string, buildToken: string): string {
  return `exports/${companyId}/${exportId}/${buildToken}.zip`;
}

/** The download's suggested file name, from the declared snapshot time (UTC). */
export function archiveFileName(snapshotAtMs: number): string {
  const stamp = new Date(snapshotAtMs).toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `kiero-eksport-${stamp}.zip`;
}

/**
 * HTML escaping for every user-controlled string that lands in the index:
 * the five characters that can open a tag, an attribute or an entity.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Archive path discipline: paths are BUILT from server-owned ids, never
 * from user-supplied names. This helper is the last line of defense for
 * any component (extension, mime subtype) that could carry hostile
 * characters: it keeps `[A-Za-z0-9._-]`, refuses dot-only segments and
 * separators, so `../`, absolute paths and NUL bytes can never form.
 */
export function safePathSegment(value: string, fallback = "plik"): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // No dot runs survive: a lone cleaned segment can never be (or contain)
    // a parent-reference, so traversal never forms even after joining.
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "");
  return cleaned.length === 0 ? fallback : cleaned.slice(0, 120);
}

/** The archive-relative media path of one representation. */
export function mediaArchivePath(
  sourceId: string,
  representationId: string,
  contentType: string,
): string {
  const extension = extensionForContentType(contentType);
  return `media/${safePathSegment(sourceId)}/${safePathSegment(representationId)}.${extension}`;
}

/** File extension for the media types this lane records (closed fallback). */
export function extensionForContentType(contentType: string): string {
  const lowered = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  switch (lowered) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "audio/webm":
      return "webm";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
    case "audio/m4a":
      return "m4a";
    case "audio/ogg":
      return "ogg";
    default:
      return "bin";
  }
}

/** Polish labels of the export lifecycle for the barebones status screen. */
export const EXPORT_STATE_LABELS: Readonly<Record<
  "requested" | "building" | "available" | "expired" | "invalidated" | "failed",
  string
>> = {
  requested: "Zlecony",
  building: "W przygotowaniu",
  available: "Gotowy do pobrania",
  expired: "Wygasł",
  invalidated: "Unieważniony",
  failed: "Nieudany",
};
