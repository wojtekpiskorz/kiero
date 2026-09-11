/**
 * The export channel's wire schemas (I3): the Effect-Schema definitions the
 * Convex boundary and the gateway route decode against. They live beside
 * the pure protocol (./protocol.ts) so the worker container's zero-dependency
 * half can import the constants and helpers WITHOUT pulling `effect` into
 * the container image (the D6 zero-dependency ruling, applied to exports).
 */

import { Schema } from "effect";
import { ARCHIVE_CONTENT_TYPE } from "./protocol";

// ---------------------------------------------------------------------------
// Gateway -> Convex: the per-request download authorization channel.
// ---------------------------------------------------------------------------

/** What the gateway asks access for (the id only; keys never cross in). */
export const ExportAccessInput = Schema.Struct({
  exportId: Schema.NonEmptyString,
});
export type ExportAccessInput = Schema.Schema.Type<typeof ExportAccessInput>;

/**
 * The authorized download grant: the LEDGER's recorded object identity.
 * Constructed and decoded by the Convex resolution, decoded again by the
 * gateway route (no hand-written twin to drift).
 */
export const ExportAccessGrant = Schema.Struct({
  exportId: Schema.NonEmptyString,
  companyId: Schema.NonEmptyString,
  objectKey: Schema.NonEmptyString,
  /** Unquoted strong etag of the published object (served quoted). */
  etag: Schema.NonEmptyString,
  bytes: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0))),
  contentType: Schema.Literal(ARCHIVE_CONTENT_TYPE),
  fileName: Schema.NonEmptyString,
  snapshotAtMs: Schema.Number,
  schemaVersion: Schema.NonEmptyString,
  availableUntilMs: Schema.Number,
});
export type ExportAccessGrant = Schema.Schema.Type<typeof ExportAccessGrant>;

// ---------------------------------------------------------------------------
// Export Worker <-> Convex: the service-credentialed build channel.
// ---------------------------------------------------------------------------

/** The Worker asks for the snapshot of one build attempt. */
export const BuildSnapshotRequest = Schema.Struct({
  exportId: Schema.NonEmptyString,
  buildToken: Schema.NonEmptyString,
});
export type BuildSnapshotRequest = Schema.Schema.Type<typeof BuildSnapshotRequest>;

/** The Worker publishes the assembled object (the ONE transition to available). */
export const PublishArchiveRequest = Schema.Struct({
  exportId: Schema.NonEmptyString,
  buildToken: Schema.NonEmptyString,
  objectKey: Schema.NonEmptyString,
  etag: Schema.NonEmptyString,
  bytes: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0))),
  snapshotAtMs: Schema.Number,
  schemaVersion: Schema.NonEmptyString,
  sourceIds: Schema.Array(Schema.NonEmptyString),
  mediaCount: Schema.Number,
});
export type PublishArchiveRequest = Schema.Schema.Type<typeof PublishArchiveRequest>;

/** The Worker reports a build that cannot produce an archive. */
export const FailBuildRequest = Schema.Struct({
  exportId: Schema.NonEmptyString,
  buildToken: Schema.NonEmptyString,
  failureKind: Schema.NonEmptyString,
});
export type FailBuildRequest = Schema.Schema.Type<typeof FailBuildRequest>;

/** The Worker confirms the object bytes are gone (expiry/invalidation cleanup). */
export const CleanupDoneRequest = Schema.Struct({
  exportId: Schema.NonEmptyString,
});
export type CleanupDoneRequest = Schema.Schema.Type<typeof CleanupDoneRequest>;

/** The build-channel operations (the Worker's bridge body `op`). */
export const BuildChannelOp = Schema.Literals(["snapshot", "publish", "fail", "cleanupDone"]);
export type BuildChannelOp = Schema.Schema.Type<typeof BuildChannelOp>;
