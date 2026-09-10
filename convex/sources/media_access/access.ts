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
 * LEDGER CONSISTENCY: the grant's `etag` and `bytes` come from the ledger
 * (D2's completion receipts); the gateway additionally verifies them
 * against the live R2 object before serving a byte, failing closed on
 * mismatch. When D5 adds retained representations with their own byte
 * lengths, its lane records them on the representation row; until then the
 * attachment's verified `receivedBytes` is the exact value for the
 * received representation this seam serves.
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { notFoundError, validationError, type RequestContext } from "@kiero/runtime";
import type { QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { contentTypeForKind, type MediaAccessGrant, MediaAccessInput } from "./protocol";

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

/** The newest verified representation of one servable role, if any. */
function newestVerified(
  rows: readonly RepresentationRow[],
  role: "received" | "retained",
): RepresentationRow | null {
  const candidates = rows.filter((row) => row.role === role && row.verifiedAtMs !== undefined);
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
    return errorResult(validationError("media_reference_malformed"));
  }
  const both = decoded.attachmentId !== undefined && decoded.representationId !== undefined;
  const neither = decoded.attachmentId === undefined && decoded.representationId === undefined;
  if (both || neither) {
    return errorResult(validationError("media_reference_malformed"));
  }
  const companyId = db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }

  // --- resolve the attachment (directly, or through an exact representation)
  let attachment: AttachmentRow | null;
  let pinned: RepresentationRow | null = null;
  const representationInput = decoded.representationId;
  const attachmentInput = decoded.attachmentId;
  if (representationInput !== undefined) {
    const representationId = db.normalizeId("mediaRepresentations", representationInput);
    if (representationId === null) {
      return errorResult(mediaReferenceNotFound());
    }
    pinned = await db.representationById(representationId);
    if (pinned === null) {
      return errorResult(mediaReferenceNotFound());
    }
    attachment = await db.attachmentById(pinned.attachmentId);
  } else {
    const attachmentId = db.normalizeId("attachments", attachmentInput!);
    if (attachmentId === null) {
      return errorResult(mediaReferenceNotFound());
    }
    attachment = await db.attachmentById(attachmentId);
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
  if (chosen === null || chosen.verifiedAtMs === undefined) {
    return errorResult(mediaReferenceNotFound());
  }
  const etag = etagOf(chosen, attachment);
  if (etag === null || attachment.receivedBytes === undefined) {
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
    bytes: attachment.receivedBytes,
    contentType: contentTypeForKind(attachment.kind),
    transformVersion: chosen.transformVersion,
    ...(chosen.width === undefined ? {} : { width: chosen.width }),
    ...(chosen.height === undefined ? {} : { height: chosen.height }),
    ...(chosen.durationMs === undefined ? {} : { durationMs: chosen.durationMs }),
  };
  return okResult(grant);
}
