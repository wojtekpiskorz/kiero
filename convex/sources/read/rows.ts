/**
 * Conversation view rows (D1): the canonical read shape of an accepted
 * source in BOTH scopes.
 *
 * "Rozmowa firmy" is canonical history; "Rozmowa projektowa" is an ordered
 * projection of the same entries through source-project links — never an
 * editable copy (CONTEXT.md). Both views therefore decode every row through
 * ONE schema: the same source id, author, send snapshot and lifecycle
 * resolve identically wherever the entry is read.
 *
 * This module is the D1-produced canonical source/read contract for
 * D2-D6, C2/C5 and E3-E6 (issue 29 "Producer and consumer integration");
 * lifting it into @kiero/contracts is a later coordinated registration (J).
 *
 * The processing state is DERIVED from durable rows, never stored beside the
 * source, so it can never drift from the durable execution state:
 *
 * - no processing run  -> `accepted` (registered; nothing has run yet)
 * - latest run running -> `processing`
 * - latest run failed  -> `failed`
 * - latest run succeeded or superseded -> `processed`
 * - `partial` is reserved for multi-attachment sources where required
 *   segments are still pending (D5/D6/E3 own producing it; a text-only
 *   source can never be partial).
 */

import { Schema } from "effect";
import { tableIdSchema } from "@kiero/contracts";

/** Source lifecycle as read in a conversation (withdrawal keeps history). */
export const SourceLifecycle = Schema.Literals(["active", "withdrawn", "purged"]);
export type SourceLifecycle = Schema.Schema.Type<typeof SourceLifecycle>;

/** The honest processing state of one source, derived from durable rows. */
export const SourceProcessingState = Schema.Literals([
  "accepted",
  "processing",
  "partial",
  "processed",
  "failed",
]);
export type SourceProcessingState = Schema.Schema.Type<typeof SourceProcessingState>;

/** One conversation entry: identical in the company and the project view. */
export const SourceConversationRow = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  authorUserId: tableIdSchema("users"),
  /** The immutable original text; corrections are new sources. */
  authorText: Schema.String,
  /** First send intention (preserved across retries of the logical source). */
  sentAtMs: Schema.Number,
  sentAtTimezone: Schema.String,
  fullyAcceptedAtMs: Schema.Number,
  lifecycle: SourceLifecycle,
  processingState: SourceProcessingState,
  /** Every project this source is linked to, in both views alike. */
  projectIds: Schema.Array(tableIdSchema("projects")),
});
export type SourceConversationRow = Schema.Schema.Type<typeof SourceConversationRow>;

/** One page of a conversation view (Convex pagination shape). */
export const ConversationPage = Schema.Struct({
  page: Schema.Array(SourceConversationRow),
  isDone: Schema.Boolean,
  continueCursor: Schema.String,
});
export type ConversationPage = Schema.Schema.Type<typeof ConversationPage>;

/** The run-state fields the derivation needs (slim processingRuns row). */
export interface LatestRunState {
  readonly state: "running" | "succeeded" | "failed" | "superseded";
}

/** Derives the honest processing state of one source (pure, unit-tested). */
export function deriveProcessingState(
  latestRun: LatestRunState | null,
): SourceProcessingState {
  if (latestRun === null) {
    return "accepted";
  }
  switch (latestRun.state) {
    case "running":
      return "processing";
    case "failed":
      return "failed";
    case "succeeded":
    case "superseded":
      return "processed";
  }
}
