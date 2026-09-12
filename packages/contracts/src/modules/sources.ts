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

/** Kind of media an attachment carries; a source may mix text, audio and images. */
export const MediaKind = Schema.Literals(["audio", "image"]);
export type MediaKind = Schema.Schema.Type<typeof MediaKind>;

export const sourcesOperations = {
  "sources.prepareUpload": operationEntry({
    kind: "operation",
    name: "sources.prepareUpload",
    input: Schema.Struct({
      draftId: Schema.String,
      parts: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
      mediaKinds: Schema.Array(MediaKind),
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
  /**
   * E7 amendment (additive, flagged; issue #115): the per-source project
   * reassignment write H3's dossier named as its missing prerequisite. The
   * boss moves one "Wiadomość źródłowa" between projects or to/from
   * company-general by declaring the COMPLETE new project set (an empty
   * array means company-general). The source keeps its identity: read state,
   * evidence and the immutable original stay; only `sourceProjectLinks`
   * move, and dependent findings re-assess through the C5 recomputation
   * seam. A set equal to the current links is a typed conflict (nothing to
   * change), so client retries can never double-fire the reaction.
   *
   * R4 repair (issue #129): the complete replacement carries an
   * observed-placement precondition. `expectedProjectIds` is the COMPLETE
   * project set the editor saw on the read that populated the form, captured
   * from the same snapshot as the dossier's `projectIds`. The transaction
   * compares it with the current committed set BEFORE any write: a mismatch
   * refuses as the typed `source_placement_stale` conflict, so a stale
   * editor form can never silently overwrite another boss's newer
   * reassignment. The key is REQUIRED on purpose: a pre-repair client that
   * omits it fails the input decode (a typed validation refusal) instead of
   * bypassing concurrency protection — an optional or defaulted
   * precondition is exactly the hole R4 closes.
   */
  "sources.reassignSource": operationEntry({
    kind: "operation",
    name: "sources.reassignSource",
    input: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      /** The complete new project set; empty means company-general knowledge. */
      projectIds: Schema.Array(tableIdSchema("projects")),
      /**
       * R4 precondition (REQUIRED, issue #129): the complete project set the
       * editor observed when the form was loaded. Comparison ignores
       * ordering and duplicates; a mismatch from the current committed set
       * refuses `source_placement_stale` before any write, event or
       * recomputation job.
       */
      expectedProjectIds: Schema.Array(tableIdSchema("projects")),
    }),
    result: Schema.Struct({
      reassignedAtMs: Schema.Number,
      /** The committed link set (deduplicated, input order preserved). */
      projectIds: Schema.Array(tableIdSchema("projects")),
    }),
    errorKinds: ["forbidden", "not_found", "conflict", "validation"],
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
  /**
   * E7 amendment (additive, flagged; issue #115): the canonical publication
   * record of one project reassignment. The payload carries the COMMITTED
   * link set so downstream consumers (audit, search refresh, J joins) see
   * the placement after the move without re-deriving it. Drains into the
   * C5 recomputation edge; the reassignment transaction registers that job
   * itself under the same dedup identity, so the drain projection collapses
   * onto the publisher's row (the D1/withdrawal discipline).
   */
  "sources.sourceReassigned": eventEntry({
    kind: "event",
    name: "sources.sourceReassigned",
    payload: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      projectIds: Schema.Array(tableIdSchema("projects")),
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
