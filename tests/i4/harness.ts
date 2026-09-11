/**
 * I4 test harness: the shared D2 in-memory Convex emulation (no deviation
 * needed - every query this lane's transactions use goes through indexed
 * eq chains), plus the table list the deletion lane touches.
 */

import { fakeCtx, type FakeCtx } from "../d2/harness";

export { fakeCtx };
export type { FakeCtx, Row } from "../d2/harness";

/** The tables the deletion transactions and their reactions touch. */
export const DELETION_TABLES = [
  "companies",
  "users",
  "sessions",
  "sources",
  "sourceProjectLinks",
  "attachments",
  "mediaRepresentations",
  "audioTranscripts",
  "audioSegments",
  "visionOrders",
  "extractions",
  "sourceFragments",
  "changeSets",
  "findings",
  "findingRevisions",
  "evidenceLinks",
  "findingDependencies",
  "notificationIntents",
  "searchEntries",
  "exports",
  "exportSourceLinks",
  "deletionRecords",
  "deletionPurgeStages",
  "durableJobs",
  "outboxEvents",
  "diagnosticEvents",
] as const;

/** The fake ctx as the MutationCtx the transactions take. */
export function asTx(ctx: FakeCtx): never {
  return ctx as unknown as never;
}
