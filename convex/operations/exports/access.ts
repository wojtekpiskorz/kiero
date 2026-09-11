/**
 * The export download access resolution (I3): the per-request authorization
 * record the gateway consults BEFORE any R2 read (the D3 seam, applied to
 * archives).
 *
 * The chain, in order: the caller's live B1 session -> active membership ->
 * company (resolved by the HTTP boundary, never client input) -> the B3
 * `administer` policy (a CURRENT administrator; a member or a revoked admin
 * refuses `forbidden` here) -> the export row (must belong to the caller's
 * company, else the uniform `not_found`) -> the lifecycle gate
 * (`decideDownload`: available, inside its 24-hour window, no linked source
 * purged) -> the ledger grant (object key, etag, byte length).
 *
 * NON-DISCLOSURE: a nonexistent export, another company's export and an
 * expired/invalidated/failed one all answer the SAME closed `not_found`;
 * the object key never appears in a refusal. Only the admin refusal is
 * distinct (`forbidden`), because it concerns the caller, not the row.
 *
 * IMMEDIACY: every request re-reads the linked sources. A purge that landed
 * after the archive was published refuses the next request with zero
 * bucket calls, whether or not I4's eager invalidation has run yet; the
 * boundary then marks the row so the status list says why.
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  membershipPolicy,
  notFoundError,
  unauthenticatedError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { ARCHIVE_CONTENT_TYPE, archiveFileName } from "./protocol";
import { ExportAccessGrant, ExportAccessInput } from "./channel";
import { decideDownload } from "./lifecycle";

/** The uniform not-readable refusal (existence is not disclosed). */
export function exportNotFound() {
  return notFoundError("exports", "export_not_found");
}

/** The slim reader surface the resolution walks (in-memory in tests/i3). */
export interface ExportAccessDb {
  normalizeId(table: "companies" | "exports", id: string): Id<any> | null;
  exportById(id: Id<"exports">): Promise<Doc<"exports"> | null>;
  linkedSources(exportId: Id<"exports">): Promise<{ readonly lifecycle: string | null }[]>;
}

/** Adapts a Convex reader to the resolution surface. */
export function exportAccessDb(db: QueryCtx["db"]): ExportAccessDb {
  return {
    normalizeId: (table, id) => db.normalizeId(table, id),
    exportById: (id) => db.get(id),
    linkedSources: async (exportId) => {
      const links = await db.query("exportSourceLinks").withIndex("by_export", (q) => q.eq("exportId", exportId)).collect();
      const out: { lifecycle: string | null }[] = [];
      for (const link of links) {
        const source = await db.get(link.sourceId);
        out.push({ lifecycle: source === null ? null : source.lifecycle });
      }
      return out;
    },
  };
}

/** What the boundary learns beside the envelope (to mark a purge-invalidated row). */
export interface ExportAccessOutcome {
  readonly result: ResultEnvelope;
  /** Set when the refusal was a linked purge: the boundary marks the row. */
  readonly invalidateExportId?: Id<"exports">;
}

/**
 * Resolves one download to its grant, or a closed refusal. `context` is
 * the caller's already-resolved request context (null = no live session).
 */
export async function resolveExportAccess(
  db: ExportAccessDb,
  context: RequestContext | null,
  input: unknown,
  nowMs: number,
): Promise<ExportAccessOutcome> {
  if (context === null) {
    return { result: errorResult(unauthenticatedError()) };
  }
  const decision = await membershipPolicy.authorize(context, { intent: "administer" });
  if (!decision.allowed) {
    return { result: errorResult(decision.error) };
  }
  let decoded: { readonly exportId: string };
  try {
    decoded = Schema.decodeUnknownSync(ExportAccessInput)(input);
  } catch {
    return { result: errorResult(validationError("export_reference_malformed")) };
  }
  const companyId = db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return { result: errorResult(validationError("company_scope_unresolved")) };
  }
  const exportId = db.normalizeId("exports", decoded.exportId);
  if (exportId === null) {
    return { result: errorResult(exportNotFound()) };
  }
  const row = await db.exportById(exportId);
  if (row === null || row.companyId !== companyId) {
    return { result: errorResult(exportNotFound()) };
  }
  const gate = decideDownload(row, await db.linkedSources(exportId), nowMs);
  if (gate.decision === "refuse") {
    return {
      result: errorResult(exportNotFound()),
      ...(gate.reason === "source_purged" ? { invalidateExportId: exportId } : {}),
    };
  }
  const grant = {
    exportId: row._id,
    companyId: row.companyId,
    objectKey: row.objectKey,
    etag: row.etag,
    bytes: row.bytes,
    contentType: ARCHIVE_CONTENT_TYPE,
    fileName: archiveFileName(row.snapshotAtMs ?? row.createdAtMs),
    snapshotAtMs: row.snapshotAtMs ?? row.createdAtMs,
    schemaVersion: row.schemaVersion ?? "unknown",
    availableUntilMs: row.availableUntilMs,
  };
  // Decode against the ONE schema: drift between resolution and channel
  // fails HERE, never at the gateway with a half-valid grant.
  return { result: okResult(Schema.decodeUnknownSync(ExportAccessGrant)(grant)) };
}
