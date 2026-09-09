/**
 * Firm export tables (A2 candidate, certified by A3).
 *
 * Owning implementer: I3 (consistent snapshots with protected downloads).
 * A firm export is a background archive (HTML index, versioned JSON,
 * history, retained media) at a consistent snapshot time. Downloads require
 * current administrator access, stay available 24 hours after completion,
 * and are invalidated immediately when a contained source is permanently
 * deleted. Platform backups and auth secrets are never part of a firm
 * export; other tenants never appear.
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
  }).index("by_company_state", ["companyId", "state"]),

  /** Which sources an archive contains; drives immediate invalidation. */
  exportSourceLinks: defineTable({
    exportId: shared.exportId,
    sourceId: shared.sourceId,
  })
    .index("by_export", ["exportId"])
    .index("by_source", ["sourceId"]),
} as const;
