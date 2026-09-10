/**
 * The media access resolution (D3): the tenant-scoped, per-request
 * authorization record the gateway consults BEFORE any R2 read.
 *
 * This is the read-side counterpart of the D2 uploads channel, with the
 * same division of authority: Convex owns WHAT may be read and WHICH
 * representation serves the bytes; the Worker owns the byte stream. The
 * resolution walks the exact chain the issue names, in order:
 *
 *   caller (already resolved: live B1 session -> active membership ->
 *   company) -> attachment (or representation -> its attachment) ->
 *   accepted source (tenant scope + lifecycle) -> verified representation
 *   -> the recorded grant (object key, etag, byte length, media type).
 *
 * NON-DISCLOSURE (the issue's "compare errors" requirement): every
 * not-readable outcome — nonexistent row, another tenant's row, an
 * attachment not yet bound to an accepted source, a purged source, a
 * representation without a verified durable record — answers the SAME
 * closed `not_found` error. Existence, tenancy and storage layout are not
 * distinguishable from the outside; the object key never appears in any
 * refusal. (A malformed id — something that cannot even name a row — is a
 * typed validation error; it carries no existence information.)
 *
 * SOURCE LIFECYCLE (decided and documented): a `purged` source denies
 * reads (permanent deletion must make content inaccessible immediately);
 * a `withdrawn` source stays readable — CONTEXT.md's "Źródło wycofane"
 * keeps the message's earlier role and the correction reason as part of
 * history, and history reads (this seam, exports) serve exactly that.
 *
 * REPRESENTATION SELECTION (the retained-or-received rule): photo reads
 * target the verified `retained` normalized version; audio's `received`
 * representation IS the alpha streaming target (D1/D2 semantics — the
 * received representation is the streaming target until D5 replaces the
 * transform). The newest verified retained representation wins; without
 * one, the verified `received` record serves; without either, the uniform
 * not-found refusal. Historical evidence never silently moves to new
 * bytes: an EXACT representation id (the `representationId` input) serves
 * exactly that version when it is itself verified, which is what E4's
 * media anchors and I3/I5's export/backup readers address.
 *
 * LEDGER CONSISTENCY: the grant's `etag`, `bytes` and `contentType`
 * describe the CHOSEN representation — its own records when they exist
 * (D5's verified rows carry bytes/mimeType), with the D2 attachment
 * receipt (receivedBytes/r2ObjectEtag, and the kind-derived media type)
 * as the received-role fallback. The gateway additionally verifies etag
 * and size against the live R2 object before serving a byte, failing
 * closed on mismatch, so a retained representation of a different length
 * than the received one serves ITS OWN length, never a stale receipt.
 * D5's `removedAtMs` (received bytes cleaned up after a verified retained
 * representation) removes a row from selection entirely: its object is
 * deliberately gone, and an exact-representation read of a removed row
 * refuses like any missing one.
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { notFoundError, validationError, type RequestContext } from "@kiero/runtime";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { contentTypeForKind, MediaAccessGrant, MediaAccessInput } from "./protocol";

/** The uniform not-readable refusal (existence is not disclosed). */
export function mediaReferenceNotFound() {
  return notFoundError("media", "media_reference_not_found");
}

/** The representation fields the selection reads. */
export interface RepresentationRow {
  readonly _id: Id<"mediaRepresentations">;
  readonly attachmentId: Id<"attachments">;
  readonly role: "received" | "retained" | "thumbnail" | "processing";
  readonly objectKey: string;
  readonly contentHash: string;
  readonly transformVersion: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly verifiedAtMs?: number | undefined;
  readonly createdAtMs: number;
  /**
   * D5's verified-row records (optional until its rows land): the
   * representation's OWN byte length, media type and received-byte cleanup
   * marker. `removedAtMs` present means the object is deliberately gone
   * from R2 (the received bytes a retained representation replaced).
   */
  readonly bytes?: number | undefined;
  readonly mimeType?: string | undefined;
  readonly removedAtMs?: number | undefined;
}

/** The attachment fields the resolution needs. */
export interface AttachmentRow {
  readonly _id: Id<"attachments">;
  readonly uploadId: Id<"uploads">;
  readonly sourceId?: Id<"sources"> | undefined;
  readonly kind: "audio" | "image";
  readonly receivedBytes?: number | undefined;
  readonly r2ObjectEtag?: string | undefined;
}

/** The source fields the lifecycle check needs. */
export interface SourceRow {
  readonly _id: Id<"sources">;
  readonly companyId: Id<"companies">;
  readonly lifecycle: "active" | "withdrawn" | "purged";
}

/**
 * The slim reader surface the resolution walks. The real Convex db adapts
 * to it below; tests/d3 drive the SAME resolution through an in-memory
 * implementation (the D2 harness pattern — no deployment needed for the
 * decision matrix).
 */
export interface MediaAccessDb {
  normalizeId(table: "companies" | "attachments" | "mediaRepresentations", id: string): Id<any> | null;
  attachmentById(id: Id<"attachments">): Promise<AttachmentRow | null>;
  representationById(id: Id<"mediaRepresentations">): Promise<RepresentationRow | null>;
  sourceById(id: Id<"sources">): Promise<SourceRow | null>;
  representationsOfAttachment(attachmentId: Id<"attachments">): Promise<RepresentationRow[]>;
}

/** Adapts a Convex reader to the resolution surface (thin, one line each). */
export function mediaAccessDb(db: QueryCtx["db"]): MediaAccessDb {
  return {
    normalizeId: (table, id) => db.normalizeId(table, id),
    attachmentById: async (id) => (await db.get(id)) as AttachmentRow | null,
    representationById: async (id) => (await db.get(id)) as RepresentationRow | null,
    sourceById: async (id) => (await db.get(id)) as SourceRow | null,
    representationsOfAttachment: async (attachmentId) =>
      await db
        .query("mediaRepresentations")
        .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachmentId))
        .collect(),
  };
}

/** The ledger's etag record for one representation (unquoted). */
function etagOf(representation: RepresentationRow, attachment: AttachmentRow): string | null {
  const prefix = "r2:etag:";
  if (representation.contentHash.startsWith(prefix)) {
    return representation.contentHash.slice(prefix.length);
  }
  // The received representation's attachment receipt carries the R2 etag.
  if (representation.role === "received" && attachment.r2ObjectEtag !== undefined) {
    return attachment.r2ObjectEtag;
  }
  return null;
}

/**
 * The CHOSEN representation's own ledger-recorded byte length, with the
 * received-role fallback: D5's verified rows carry `bytes` themselves;
 * the received representation's D2 record is the attachment receipt
 * (`receivedBytes`, the manifest byte sum completed at acceptance). A
 * representation without either record fails closed (the gateway's
 * size/etag cross-check must never be fed a guess).
 */
function bytesOf(representation: RepresentationRow, attachment: AttachmentRow): number | null {
  if (representation.bytes !== undefined && representation.bytes > 0) {
    return representation.bytes;
  }
  if (representation.role === "received" && attachment.receivedBytes !== undefined) {
    return attachment.receivedBytes;
  }
  return null;
}

/** The chosen representation's media type, with the kind fallback. */
function contentTypeOf(representation: RepresentationRow, attachment: AttachmentRow): string {
  return representation.mimeType ?? contentTypeForKind(attachment.kind);
}

/** The newest verified, NOT-REMOVED representation of one servable role, if any. */
function newestVerified(
  rows: readonly RepresentationRow[],
  role: "received" | "retained",
): RepresentationRow | null {
  const candidates = rows.filter(
    (row) => row.role === role && row.verifiedAtMs !== undefined && row.removedAtMs === undefined,
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((newest, row) => (row.createdAtMs > newest.createdAtMs ? row : newest));
}

/**
 * Resolves one media read to its grant, or the uniform not-found refusal.
 * The `context` is the caller's already-authorized request context (live
 * session + active membership resolved by the command layer); tenant
 * scoping happens HERE against the accepted source's company.
 */
export async function resolveMediaAccess(
  db: MediaAccessDb,
  context: RequestContext,
  input: unknown,
): Promise<ResultEnvelope> {
  let decoded: MediaAccessInput;
  try {
    decoded = Schema.decodeUnknownSync(MediaAccessInput)(input);
  } catch {
    // The union already encodes exactly-one-id: both, neither and malformed
    // references all fail HERE (the shared home owns the invariant).
    return errorResult(validationError("media_reference_malformed"));
  }
  const companyId = db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }

  // --- resolve the attachment (directly, or through an exact representation)
  let attachment: AttachmentRow | null;
  let pinned: RepresentationRow | null = null;
  const attachmentInput = decoded.attachmentId;
  if (attachmentInput !== undefined) {
    const attachmentId = db.normalizeId("attachments", attachmentInput);
    if (attachmentId === null) {
      return errorResult(mediaReferenceNotFound());
    }
    attachment = await db.attachmentById(attachmentId);
  } else {
    const representationId = db.normalizeId("mediaRepresentations", decoded.representationId);
    if (representationId === null) {
      return errorResult(mediaReferenceNotFound());
    }
    pinned = await db.representationById(representationId);
    if (pinned === null) {
      return errorResult(mediaReferenceNotFound());
    }
    attachment = await db.attachmentById(pinned.attachmentId);
  }
  if (attachment === null) {
    return errorResult(mediaReferenceNotFound());
  }

  // --- the accepted-source chain: bound attachment -> source -> tenant + lifecycle
  if (attachment.sourceId === undefined) {
    // Not (yet) part of an accepted source: existence is not disclosed.
    return errorResult(mediaReferenceNotFound());
  }
  const source = await db.sourceById(attachment.sourceId);
  if (source === null || source.companyId !== companyId || source.lifecycle === "purged") {
    return errorResult(mediaReferenceNotFound());
  }

  // --- the representation that serves the bytes
  const representations = await db.representationsOfAttachment(attachment._id);
  const chosen =
    pinned ?? newestVerified(representations, "retained") ?? newestVerified(representations, "received");
  if (
    chosen === null ||
    chosen.verifiedAtMs === undefined ||
    // D5's received-byte cleanup: the object is deliberately gone.
    chosen.removedAtMs !== undefined
  ) {
    return errorResult(mediaReferenceNotFound());
  }
  const etag = etagOf(chosen, attachment);
  const bytes = bytesOf(chosen, attachment);
  if (etag === null || bytes === null) {
    return errorResult(mediaReferenceNotFound());
  }

  const grant: MediaAccessGrant = {
    attachmentId: attachment._id,
    sourceId: attachment.sourceId,
    representationId: chosen._id,
    role: chosen.role === "retained" ? "retained" : "received",
    kind: attachment.kind,
    objectKey: chosen.objectKey,
    etag,
    bytes,
    contentType: contentTypeOf(chosen, attachment),
    transformVersion: chosen.transformVersion,
    ...(chosen.width === undefined ? {} : { width: chosen.width }),
    ...(chosen.height === undefined ? {} : { height: chosen.height }),
    ...(chosen.durationMs === undefined ? {} : { durationMs: chosen.durationMs }),
  };
  // Decode the constructed grant against the ONE schema definition: drift
  // between the resolution and the channel's contract fails HERE, never at
  // the gateway with a half-valid grant.
  return okResult(Schema.decodeUnknownSync(MediaAccessGrant)(grant));
}
