/**
 * Firm export tables (A2 candidate, certified by A3; completed by I3 for
 * consistent snapshots with protected downloads, issue #55).
 *
 * Owning implementer: I3.
 * A firm export is a background archive (HTML index, versioned JSON,
 * history, retained media) at a consistent snapshot time. Downloads require
 * current administrator access, stay available 24 hours after completion,
 * and are invalidated immediately when a contained source is permanently
 * deleted. Platform backups and auth secrets are never part of a firm
 * export; other tenants never appear.
 *
 * I3 completion of the candidate fragment (every added column is OPTIONAL so
 * earlier rows stay valid):
 *
 * - `buildToken`: the identity of the build attempt currently allowed to
 *   publish. Every executor attempt mints a fresh token before it leaves
 *   the transaction; the publish transaction accepts only the current one,
 *   so a late attempt can never overwrite a published snapshot (the
 *   "retry does not create divergent published snapshots" rule). The
 *   object key carries the token as well, so two attempts never write the
 *   same object.
 * - `schemaVersion`: the archive format the published bytes declare
 *   (`ARCHIVE_SCHEMA_VERSION` in ./protocol.ts).
 * - `etag`/`bytes`: the published object's ledger record; the download
 *   gateway verifies the live R2 object against them and serves nothing on
 *   drift (the D3 discipline).
 * - `completedAtMs`, `invalidatedAtMs`, `failedAtMs`, `cleanedAtMs` and the
 *   sanitized closed `failureKind`/`invalidationReason`: the auditable
 *   lifecycle after `available` (the status stays readable after the bytes
 *   are gone).
 * - `sourceCount`/`mediaCount`: bounded counts for the status screen and
 *   the audit; never content.
 * - Index `by_company_created`: the administrator's status list, newest
 *   first; `by_state_until`: the expiry sweep's range.
 *
 * Tables: exports, exportSourceLinks.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../../schema/shared";
import { ExportState } from "@kiero/contracts";

// Vocabulary pin: the archive lifecycle must equal the contracts-side
// ExportState literals exactly, or this file fails typecheck.
const exportState: ValueValidator<Encoded<typeof ExportState>> = v.union(
  v.literal("requested"),
  v.literal("building"),
  v.literal("available"),
  v.literal("expired"),
  v.literal("invalidated"),
  v.literal("failed"),
);

export const exportsTables = {
  /** One firm export archive lifecycle. */
  exports: defineTable({
    companyId: shared.companyId,
    state: exportState,
    requestedByUserId: shared.userId,
    snapshotAtMs: v.optional(shared.tsMs),
    availableUntilMs: v.optional(shared.tsMs),
    objectKey: v.optional(v.string()),
    createdAtMs: shared.tsMs,
    /** The build attempt allowed to publish (see the module docstring). */
    buildToken: v.optional(v.string()),
    buildStartedAtMs: v.optional(shared.tsMs),
    schemaVersion: v.optional(v.string()),
    /** Ledger record of the published object (unquoted etag, byte length). */
    etag: v.optional(v.string()),
    bytes: v.optional(v.float64()),
    sourceCount: v.optional(shared.counter),
    mediaCount: v.optional(shared.counter),
    completedAtMs: v.optional(shared.tsMs),
    /** Sanitized closed kind of the terminal build failure. */
    failureKind: v.optional(v.string()),
    failedAtMs: v.optional(shared.tsMs),
    /** Closed reason of an invalidation (source purge, admin action). */
    invalidationReason: v.optional(v.string()),
    invalidatedAtMs: v.optional(shared.tsMs),
    /** Present once the archive bytes were deleted from storage. */
    cleanedAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_state", ["companyId", "state"])
    .index("by_company_created", ["companyId", "createdAtMs"])
    .index("by_state_until", ["state", "availableUntilMs"]),

  /** Which sources an archive contains; drives immediate invalidation. */
  exportSourceLinks: defineTable({
    exportId: shared.exportId,
    sourceId: shared.sourceId,
  })
    .index("by_export", ["exportId"])
    .index("by_source", ["sourceId"]),
} as const;
