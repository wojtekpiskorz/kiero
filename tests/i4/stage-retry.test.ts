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
 * - A FULLY PURGED record's stage returns to the visible failed state and
 *   the REAL executor replay drives it back to purged.
 * - The replay redacts nothing twice: stored clarification rows are
 *   byte-identical, the purge audit keeps exactly one redacted source id
 *   and its FIRST redaction timestamps.
 * - A record whose stages are not all purged refuses typed: its retry
 *   belongs to the real durable job, never to a probe.
 * - An unknown record refuses typed, committing nothing.
 */

import { describe, expect, it } from "vitest";
import type { ResultEnvelope } from "@kiero/contracts";
import { performPurgeSource, PURGE_CONFIRMATION_PHRASE } from "../../convex/operations/deletion/purge";
import { purgeSourceExecutor } from "../../convex/operations/deletion/executor";
import { replayPurgeStageForRecord } from "../../convex/operations/deletion/probe";
import { REDACTED_CLARIFICATION_QUESTION_COPY } from "../../convex/memory/findings/references";
import {
  DELETION_TABLES,
  asTx,
  fakeCtx,
  fakePurgeJob,
  seedBossCompanyContext,
  seedWitnessedTextSource,
} from "./harness";

const RAISED_AT_MS = Date.parse("2026-09-08T09:00:00.000Z");

interface RetryWorld {
  readonly sourceId: string;
  readonly clarificationId: string;
  readonly deletionRecordId: string;
}

interface SeededWorld extends RetryWorld {
  readonly ctx: ReturnType<typeof fakeCtx>;
  readonly context: Awaited<ReturnType<typeof seedBossCompanyContext>>["context"];
}

/** Seeds the boss world, raises the canary case and tombstones the source. */
async function seedTombstonedWorld(): Promise<SeededWorld> {
  const ctx = fakeCtx(DELETION_TABLES);
  const { context, userId } = await seedBossCompanyContext(ctx);
  const companyId = context.actor.companyId as string;
  const doomed = await seedWitnessedTextSource(ctx, companyId, userId, "Kaczmarek wpłacił zaliczkę 5000 zł w piątek");
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
  return {
    ctx,
    context,
    sourceId: doomed.sourceId,
    clarificationId,
    deletionRecordId: record.deletionRecordId,
  };
}

/** Runs the full executor once so every stage reaches purged. */
async function runPurgeOnce(world: SeededWorld): Promise<void> {
  const input = { sourceId: world.sourceId, deletionRecordId: world.deletionRecordId };
  const outcome = await purgeSourceExecutor.execute(asTx(world.ctx), fakePurgeJob(input), input);
  if (outcome.outcome !== "succeeded") {
    throw new Error(`purge executor failed: ${JSON.stringify(outcome)}`);
  }
}

describe("replayPurgeStageForRecord (the R2 per-stage retry core)", () => {
  it("re-runs a completed stage to purged with byte-identical clarifications and a single first-timestamp audit", async () => {
    const world = await seedTombstonedWorld();
    await runPurgeOnce(world);
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

  it("refuses typed while any stage is not purged: an in-flight record's retry belongs to the durable job", async () => {
    const world = await seedTombstonedWorld();
    // No executor run: the stage rows are still pending.
    const result = await replayPurgeStageForRecord(asTx(world.ctx) as never, {
      deletionRecordId: world.deletionRecordId as never,
      stageKind: "transcripts",
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
      expect(result.error.code).toBe("purge_record_not_complete");
    }
    const stages = world.ctx.db.rows("deletionPurgeStages");
    expect(stages.every((stage) => stage.state === "pending")).toBe(true);
  });

  it("refuses typed for an unknown record, committing nothing", async () => {
    const world = await seedTombstonedWorld();
    await runPurgeOnce(world);
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
