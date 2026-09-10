/**
 * D6 keyspace regression (review round 1, finding 1): D6 and E3 share ONE
 * step journal — the source's initial analysis run — so D6's segment steps
 * and probe markers must live at sequence bases OUTSIDE every E3 range, and
 * every (run, sequence) lookup must be `stepKind`-guarded.
 *
 * The ranges pinned here are E3's OWN exported constants from
 * convex/processing/text (merged main): extract step 10, stages 20/30,
 * clarifications 500+, groups 1000+, marker bases 100_000 and 200_000. If
 * either lane moves its constants, this file fails and forces a
 * re-coordination instead of a silent collision.
 */

import { describe, expect, it } from "vitest";
import {
  SEGMENT_MARKER_BASE,
  SEGMENT_STEP_BASE,
  SEGMENT_STEP_KIND,
  PROBE_FAILURE_MARKER_KIND,
  ensureSegmentFailureMarker,
  recordSegmentOutcomeTransaction,
  removeSegmentFailureMarker,
  segmentFailureMarkerRow,
} from "../../convex/processing/audio/executor";
import { FAILURE_MARKER_BASE, OUTCOME_MARKER_BASE } from "../../convex/processing/text/journal";
import { EXTRACT_STEP_SEQUENCE } from "../../convex/processing/text/extract";
import {
  LOAD_CONTEXT_SEQUENCE,
  MODEL_ANALYSIS_SEQUENCE,
  CLARIFICATION_SEQUENCE_BASE,
  GROUP_SEQUENCE_BASE,
} from "../../convex/processing/text/analyze";
import { fakeCtx, asTx, type FakeCtx, type Row } from "../d2/harness";

/**
 * fakeCtx plus a `delete` (the D2 harness models a ledger that never
 * deletes; D6's disarm does). Local to tests/d6 — the sibling harness is
 * not edited.
 */
function fakeCtxWithDelete(tableNames: readonly string[]): FakeCtx {
  const ctx = fakeCtx(tableNames);
  (ctx.db as unknown as { delete(id: string): Promise<void> }).delete = async (id: string) => {
    for (const rows of ctx.db.tables.values()) {
      const index = rows.findIndex((row: Row) => row._id === id);
      if (index !== -1) {
        rows.splice(index, 1);
        return;
      }
    }
    throw new Error(`delete: no row ${id}`);
  };
  return ctx;
}

/** A realistic upper bound for indexes inside E3's +index ranges. */
const E3_INDEX_BOUND = 10_000;

describe("D6/E3 step keyspace disjointness", () => {
  it("D6's bases sit outside every fixed E3 stage sequence", () => {
    for (const stage of [
      EXTRACT_STEP_SEQUENCE,
      LOAD_CONTEXT_SEQUENCE,
      MODEL_ANALYSIS_SEQUENCE,
    ]) {
      expect(stage).toBeLessThan(SEGMENT_STEP_BASE);
    }
  });

  it("D6's bases sit outside E3's +index ranges even at generous bounds", () => {
    expect(CLARIFICATION_SEQUENCE_BASE + E3_INDEX_BOUND).toBeLessThan(SEGMENT_STEP_BASE);
    expect(GROUP_SEQUENCE_BASE + E3_INDEX_BOUND).toBeLessThan(SEGMENT_STEP_BASE);
    expect(FAILURE_MARKER_BASE + E3_INDEX_BOUND).toBeLessThan(SEGMENT_STEP_BASE);
    expect(OUTCOME_MARKER_BASE + E3_INDEX_BOUND).toBeLessThan(SEGMENT_STEP_BASE);
  });

  it("D6's segment range cannot reach its own marker base at any plausible duration", () => {
    // 24 h at the 30 s default target = 2880 segments; even 10^6 segments
    // (≈ 347 days) stays inside the 4 000 000-wide guard band.
    expect(SEGMENT_STEP_BASE + 2880).toBeLessThan(SEGMENT_MARKER_BASE);
    expect(SEGMENT_MARKER_BASE - SEGMENT_STEP_BASE).toBeGreaterThanOrEqual(4_000_000);
  });
});

describe("D6 never touches E3's rows at colliding indexes", () => {
  it("a segment step lands at the D6 base; an E3 row at the same index is untouched", async () => {
    const ctx = fakeCtx([
      "companies",
      "sources",
      "processingRuns",
      "processingSteps",
      "processingAttempts",
      "extractions",
      "sourceFragments",
      "audioTranscripts",
      "audioSegments",
    ]);
    const runId = await ctx.db.insert("processingRuns", {
      companyId: "k0companies0000000000000",
      sourceId: "k0sources000000000000000",
      kind: "initial_analysis",
      pipelineVersion: "x",
      promptVersion: "none",
      schemaVersion: "none",
      modelConfigurationVersion: "none",
      state: "running",
      startedAtMs: Date.now(),
    });
    const transcriptId = await ctx.db.insert("audioTranscripts", {
      companyId: "k0companies0000000000000",
      sourceId: "k0sources000000000000000",
      attachmentId: "k0attachments00000000000",
      representationId: "k0mediarepresentations0",
      processingRunId: runId,
      pipelineVersion: "d6.stt/1",
      sttRoutingVersion: "e2.0",
      segmentationConfigJson: JSON.stringify({ targetSegmentMs: 1, minTailSegmentMs: 1 }),
      bytesChannel: "proof_inline",
      segmentCount: 2,
      state: "pending",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    await ctx.db.insert("audioSegments", {
      transcriptId,
      segmentIndex: 20, // E3's MODEL_ANALYSIS_SEQUENCE under the OLD scheme
      startMs: 0,
      endMs: 1,
      durationMs: 1,
      state: "pending",
      attempts: 0,
    });
    // E3's stage row exactly where the old D6 scheme would have collided.
    await ctx.db.insert("processingSteps", {
      runId,
      stepKind: "e3_model_analysis",
      sequence: LOAD_CONTEXT_SEQUENCE + MODEL_ANALYSIS_SEQUENCE, // 50, arbitrary E3-ish
      state: "succeeded",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    const e3Row = await ctx.db.insert("processingSteps", {
      runId,
      stepKind: "e3_stage",
      sequence: 20,
      state: "succeeded",
      outputRef: "e3",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });

    await recordSegmentOutcomeTransaction(asTx(ctx), {
      transcriptId: transcriptId as never,
      segmentIndex: 20,
      outcome: {
        kind: "succeeded",
        text: "t",
        servedModels: ["m"],
        providerAttempts: [
          { model: "m", outcome: "succeeded", startedAtMs: 0, finishedAtMs: 1 },
        ],
      },
    });

    const steps = ctx.db.rows("processingSteps");
    const d6Step = steps.find(
      (step) => step.sequence === SEGMENT_STEP_BASE + 20 && step.stepKind === SEGMENT_STEP_KIND,
    );
    expect(d6Step).toBeDefined();
    // The E3 row at the raw index is untouched, and no second row was
    // written at sequence 20.
    const e3Untouched = steps.find((step) => step._id === e3Row);
    expect(e3Untouched).toMatchObject({ stepKind: "e3_stage", state: "succeeded" });
    expect(steps.filter((step) => step.sequence === 20)).toHaveLength(1);
    // The D6 attempts attach to the D6 step only.
    const attempts = ctx.db.rows("processingAttempts");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.stepId).toBe(d6Step?._id);
  });

  it("arm/disarm markers are stepKind-guarded: a foreign marker at the same sequence is never deleted", async () => {
    const ctx = fakeCtxWithDelete(["processingRuns", "processingSteps"]);
    const runId = await ctx.db.insert("processingRuns", {
      companyId: "k0companies0000000000000",
      sourceId: "k0sources000000000000000",
      kind: "initial_analysis",
      pipelineVersion: "x",
      promptVersion: "none",
      schemaVersion: "none",
      modelConfigurationVersion: "none",
      state: "running",
      startedAtMs: Date.now(),
    });
    // A foreign marker sitting exactly at D6's marker sequence.
    await ctx.db.insert("processingSteps", {
      runId,
      stepKind: "e3_marker",
      sequence: SEGMENT_MARKER_BASE + 2,
      state: "failed",
      outputRef: "armed",
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });

    // Disarm first: the foreign row must survive.
    await removeSegmentFailureMarker(asTx(ctx), runId as never, 2);
    expect(
      ctx.db.rows("processingSteps").filter((step) => step.stepKind === "e3_marker"),
    ).toHaveLength(1);

    // Arm: D6 inserts its OWN marker next to the foreign one; the lookup
    // sees only the D6 row; disarm removes only that one.
    await ensureSegmentFailureMarker(asTx(ctx), runId as never, 2);
    const marker = await segmentFailureMarkerRow(ctx.db as never, runId as never, 2);
    expect(marker?.stepKind).toBe(PROBE_FAILURE_MARKER_KIND);
    await removeSegmentFailureMarker(asTx(ctx), runId as never, 2);
    expect(await segmentFailureMarkerRow(ctx.db as never, runId as never, 2)).toBeNull();
    expect(
      ctx.db.rows("processingSteps").filter((step) => step.stepKind === "e3_marker"),
    ).toHaveLength(1);
  });

  it("the old colliding constants are gone from the D6 surface", () => {
    // The pre-fix marker base (E3's FAILURE_MARKER_BASE) must not appear in
    // D6's exported vocabulary anymore.
    expect(SEGMENT_MARKER_BASE).not.toBe(FAILURE_MARKER_BASE);
    expect(SEGMENT_MARKER_BASE).not.toBe(OUTCOME_MARKER_BASE);
    expect(SEGMENT_STEP_BASE).not.toBe(FAILURE_MARKER_BASE);
  });
});
