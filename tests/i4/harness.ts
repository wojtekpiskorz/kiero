/**
 * I4 test harness: the shared D2 in-memory Convex emulation (no deviation
 * needed - every query this lane's transactions use goes through indexed
 * eq chains), plus the table list the deletion lane touches.
 */

import { Schema } from "effect";
import { ActorContext } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import { fakeCtx, type FakeCtx } from "../d2/harness";
import type { DurableJobDoc } from "../../convex/platform/executors";

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
  "clarifications",
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

// --- shared purge-world fixtures (the consolidation every i4 file rides) ------------

const FIXTURE_SENT_AT_MS = Date.parse("2026-09-08T07:00:00.000Z");

/** One company with an admin boss session: the actor context every lane's world rides. */
export async function seedBossCompanyContext(
  ctx: FakeCtx,
): Promise<{ context: RequestContext; userId: string }> {
  const companyId = await ctx.db.insert("companies", { name: "Firma", timezone: "Europe/Warsaw" });
  const userId = await ctx.db.insert("users", { email: "szef@firma.invalid" });
  const sessionId = await ctx.db.insert("sessions", { userId, state: "live", createdAtMs: 1 });
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId,
    companyId,
    membershipRole: "admin",
    isGm: false,
    sessionId,
    via: "user",
  });
  return {
    context: { actor, resolvedAtMs: Date.now() } as RequestContext,
    userId: userId as string,
  };
}

/** One text source with an extraction and a whole-source fragment (kept when withdrawn). */
export async function seedWitnessedTextSource(
  ctx: FakeCtx,
  companyId: string,
  userId: string,
  text: string,
  lifecycle: "active" | "withdrawn" = "active",
): Promise<{ sourceId: string; fragmentId: string }> {
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: userId,
    authorText: text,
    sentAtMs: FIXTURE_SENT_AT_MS,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: FIXTURE_SENT_AT_MS,
    lifecycle,
    ...(lifecycle === "withdrawn"
      ? { withdrawnAtMs: FIXTURE_SENT_AT_MS + 5_400_000, withdrawnReason: "pomyłka" }
      : {}),
  });
  const extractionId = await ctx.db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: "text/1",
    model: "fixture",
    provider: "fixture",
    processingRunId: "kprocessingrunst0000000000000",
    createdAtMs: FIXTURE_SENT_AT_MS + 3_600_000,
  });
  const fragmentId = await ctx.db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor: { _tag: "whole_source" },
    createdAtMs: FIXTURE_SENT_AT_MS + 3_600_000,
  });
  return { sourceId: sourceId as string, fragmentId: fragmentId as string };
}

/** The synthetic purge job document every evidence replay hands the executor. */
export function fakePurgeJob(input: { sourceId: string; deletionRecordId: string }): DurableJobDoc {
  return {
    jobKey: `job-${input.deletionRecordId}`,
    kind: "deletion.purge_source",
    inputJson: JSON.stringify(input),
    attempts: 0,
    maxAttempts: 6,
    state: "running",
    createdAtMs: 1,
    updatedAtMs: 1,
  } as unknown as DurableJobDoc;
}
