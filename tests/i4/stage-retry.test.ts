/**
 * I4 focused verification, part 5 (R2 purge legs, issue #127): the
 * per-stage retry evidence surface. The live purge legs on the dev/i4 lease
 * must prove that a purge stage RETRIES without restored content and
 * without duplicate audit metadata; once the 24-hour window has already
 * closed successfully, the only honest way back to the retryable state is
 * the guarded fixture control `replayPurgeStageForRecord` (the
 * probeAgeUpload precedent).
 *
 * These tests pin the core's contract directly (the guarded wrapper is the
 * standard caller-credential pattern proven by the deletion probes):
 *
 * - A completed record's stage returns to the visible failed state and the
 *   REAL executor replay drives it back to purged.
 * - The replay redacts nothing twice: stored clarification rows are
 *   byte-identical, the purge audit keeps exactly one redacted source id
 *   and its FIRST redaction timestamps.
 * - An unknown record or stage kind refuses typed, committing nothing.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ActorContext, type ResultEnvelope } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import { performPurgeSource, PURGE_CONFIRMATION_PHRASE } from "../../convex/operations/deletion/purge";
import { purgeSourceExecutor } from "../../convex/operations/deletion/executor";
import { replayPurgeStageForRecord } from "../../convex/operations/deletion/probe";
import { REDACTED_CLARIFICATION_QUESTION_COPY } from "../../convex/memory/findings/references";
import { DELETION_TABLES, asTx, fakeCtx, type FakeCtx } from "./harness";
import type { DurableJobDoc } from "../../convex/platform/executors";

const RAISED_AT_MS = Date.parse("2026-09-08T09:00:00.000Z");

/** Seeds one company/admin session context (the clarification-purge pattern). */
async function seedBossContext(ctx: FakeCtx): Promise<RequestContext> {
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
  return { actor, resolvedAtMs: Date.now() } as RequestContext;
}

/** One active text source with a whole-source fragment. */
async function seedSourceWithFragment(
  ctx: FakeCtx,
  companyId: string,
  userId: string,
  text: string,
): Promise<{ sourceId: string; fragmentId: string }> {
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: userId,
    authorText: text,
    sentAtMs: RAISED_AT_MS - 7_200_000,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: RAISED_AT_MS - 7_200_000,
    lifecycle: "active",
  });
  const extractionId = await ctx.db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: "text/1",
    model: "fixture",
    provider: "fixture",
    processingRunId: "kprocessingrunst0000000000000",
    createdAtMs: RAISED_AT_MS - 3_600_000,
  });
  const fragmentId = await ctx.db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor: { _tag: "whole_source" },
    createdAtMs: RAISED_AT_MS - 3_600_000,
  });
  return { sourceId: sourceId as string, fragmentId: fragmentId as string };
}

interface RetryWorld {
  readonly ctx: FakeCtx;
  readonly context: RequestContext;
  readonly sourceId: string;
  readonly clarificationId: string;
  readonly deletionRecordId: string;
}

/** Seeds, raises the canary case, purges fully and runs the executor. */
async function seedCompletedPurge(): Promise<RetryWorld> {
  const ctx = fakeCtx(DELETION_TABLES);
  const context = await seedBossContext(ctx);
  const companyId = context.actor.companyId as string;
  const userId = context.actor.userId as string;
  const doomed = await seedSourceWithFragment(ctx, companyId, userId, "Kaczmarek wpłacił zaliczkę 5000 zł w piątek");
  const clarificationId = (await ctx.db.insert("clarifications", {
    companyId,
    scopeKind: "company",
    question: "Ile zaliczki wpłacił Kaczmarek — 5000 zł z piątkowej wiadomości?",
    conflictingFragmentIds: [doomed.fragmentId],
    state: "open",
    raisedAtMs: RAISED_AT_MS,
  })) as string;
  const record = (await performPurgeSource(asTx(ctx), context, {
    sourceId: doomed.sourceId as never,
    confirmation: PURGE_CONFIRMATION_PHRASE,
  }) as ResultEnvelope & { value: { deletionRecordId: string } }).value;
  const input = { sourceId: doomed.sourceId, deletionRecordId: record.deletionRecordId };
  const job = {
    jobKey: `job-${record.deletionRecordId}`,
    kind: "deletion.purge_source",
    inputJson: JSON.stringify(input),
    attempts: 0,
    maxAttempts: 6,
    state: "running",
    createdAtMs: 1,
    updatedAtMs: 1,
  } as unknown as DurableJobDoc;
  const outcome = await purgeSourceExecutor.execute(asTx(ctx), job, input);
  if (outcome.outcome !== "succeeded") {
    throw new Error(`purge executor failed: ${JSON.stringify(outcome)}`);
  }
  return { ctx, context, sourceId: doomed.sourceId, clarificationId, deletionRecordId: record.deletionRecordId };
}

describe("replayPurgeStageForRecord (the R2 per-stage retry core)", () => {
  it("re-runs a completed stage to purged with byte-identical clarifications and a single first-timestamp audit", async () => {
    const world = await seedCompletedPurge();
    const before = JSON.stringify(world.ctx.db.rows("clarifications"));
    const stageBefore = world.ctx.db
      .rows("deletionPurgeStages")
      .find((row) => row.stageKind === "transcripts");
    expect(stageBefore?.state).toBe("purged");
    // rows() hands out live references: snapshot the primitive now.
    const attemptsBefore = stageBefore?.attempts as number;

    const result = await replayPurgeStageForRecord(asTx(world.ctx) as never, {
      deletionRecordId: world.deletionRecordId as never,
      stageKind: "transcripts",
    });

    expect(result._tag).toBe("ok");
    if (result._tag !== "ok") {
      return;
    }
    const value = result.value as {
      outcome: string;
      stages: { stageKind: string; state: string; attempts: number }[];
    };
    expect(value.outcome).toBe("succeeded");
    expect(value.stages.every((stage) => stage.state === "purged")).toBe(true);
    const transcripts = value.stages.find((stage) => stage.stageKind === "transcripts");
    expect(transcripts?.attempts).toBe(attemptsBefore + 1);

    // No restored content and no duplicate audit: the stored row is
    // byte-identical to before the retry.
    expect(JSON.stringify(world.ctx.db.rows("clarifications"))).toBe(before);
    const row = world.ctx.db.rows("clarifications").find((candidate) => candidate._id === world.clarificationId)!;
    expect(row.question).toBe(REDACTED_CLARIFICATION_QUESTION_COPY);
    const audit = row.purgeAudit as { redactedSourceIds: string[]; questionRedactedAtMs: number };
    expect(audit.redactedSourceIds).toEqual([world.sourceId]);
    expect(audit.questionRedactedAtMs).toBeTypeOf("number");
  });

  it("refuses typed for an unknown record, committing nothing", async () => {
    const world = await seedCompletedPurge();
    const before = JSON.stringify(world.ctx.db.rows("deletionPurgeStages"));

    const missingRecord = await replayPurgeStageForRecord(asTx(world.ctx) as never, {
      deletionRecordId: "k1234567890123456789zz" as never,
      stageKind: "transcripts",
    });
    expect(missingRecord._tag).toBe("error");
    if (missingRecord._tag === "error") {
      expect(missingRecord.error._tag).toBe("not_found");
    }
    expect(JSON.stringify(world.ctx.db.rows("deletionPurgeStages"))).toBe(before);
  });
});
