/**
 * Sources and media module surface (architecture "Deep modules": Sources and
 * media). Implements lanes: D1 (accept), D2 (uploads), D3 (media reads),
 * D5 (photo normalization), D6 (audio), I3/I4 (export/deletion input).
 *
 * One immutable logical source, all-attachment acceptance, representation
 * versions, retained-image policy, dependent cleanup. Correcting a
 * statement happens by a NEW source; the original is never rewritten
 * (issue 8: "Korekta ustalenia ... Nie przepisuje wcześniejszej wiadomości").
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { UploadStage, MediaRepresentationRole } from "../media";
import { operationEntry, eventEntry } from "./registration";

export const sourcesOperations = {
  "sources.prepareUpload": operationEntry({
    kind: "operation",
    name: "sources.prepareUpload",
    input: Schema.Struct({
      draftId: Schema.String,
      parts: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
      mediaKinds: Schema.Array(Schema.Literals(["audio", "image"])),
    }),
    result: Schema.Struct({ uploadId: tableIdSchema("uploads"), stage: UploadStage }),
    errorKinds: ["forbidden", "validation"],
  }),
  "sources.resumeUpload": operationEntry({
    kind: "operation",
    name: "sources.resumeUpload",
    input: Schema.Struct({ uploadId: tableIdSchema("uploads") }),
    result: Schema.Struct({ uploadId: tableIdSchema("uploads"), stage: UploadStage }),
    errorKinds: ["not_found", "conflict"],
  }),
  "sources.acceptSource": operationEntry({
    kind: "operation",
    name: "sources.acceptSource",
    input: Schema.Struct({
      uploadId: tableIdSchema("uploads"),
      authorText: Schema.String,
      /** Intended send time and zone snapshot captured on the client, when available. */
      intendedSentAtIso: Schema.optionalKey(Schema.String),
      timezoneSnapshot: Schema.NonEmptyString,
      projectHints: Schema.Array(tableIdSchema("projects")),
    }),
    result: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      fullyAcceptedAtMs: Schema.Number,
    }),
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "sources.withdrawSource": operationEntry({
    kind: "operation",
    name: "sources.withdrawSource",
    input: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      reason: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ withdrawnAtMs: Schema.Number }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  "sources.purgeSource": operationEntry({
    kind: "operation",
    name: "sources.purgeSource",
    input: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      confirmation: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ deletionRecordId: tableIdSchema("deletionRecords") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
} as const;

export const sourcesEvents = {
  "sources.uploadFinalized": eventEntry({
    kind: "event",
    name: "sources.uploadFinalized",
    payload: Schema.Struct({ uploadId: tableIdSchema("uploads") }),
  }),
  "sources.sourceAccepted": eventEntry({
    kind: "event",
    name: "sources.sourceAccepted",
    payload: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      attachmentIds: Schema.Array(tableIdSchema("attachments")),
    }),
  }),
  "sources.sourceWithdrawn": eventEntry({
    kind: "event",
    name: "sources.sourceWithdrawn",
    payload: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      reason: Schema.NonEmptyString,
    }),
  }),
  "sources.sourcePurged": eventEntry({
    kind: "event",
    name: "sources.sourcePurged",
    payload: Schema.Struct({ sourceId: tableIdSchema("sources") }),
  }),
  "sources.representationRetained": eventEntry({
    kind: "event",
    name: "sources.representationRetained",
    payload: Schema.Struct({
      attachmentId: tableIdSchema("attachments"),
      representationId: tableIdSchema("mediaRepresentations"),
      role: MediaRepresentationRole,
    }),
  }),
} as const;
