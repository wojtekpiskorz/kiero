/**
 * E4 keyspace regression (the D6 precedent): the join anchors its steps to
 * the SAME run row E3's text stages and D6's segment steps journal — the
 * source's initial analysis run — so E4's stage bases, vision slots and
 * probe markers must live at sequence bases OUTSIDE every E3 and D6 range,
 * and every (run, sequence) lookup must be `stepKind`-guarded (it is, in
 * convex/processing/multimodal/journal.ts).
 *
 * The ranges pinned here are E3's OWN exported constants (extract step 10,
 * stages 20/30, clarifications 500+, groups 1000+, marker bases 100_000
 * and 200_000) and D6's (segment steps 1_000_000+, markers 5_000_000+).
 * If any lane moves its constants, this file fails and forces a
 * re-coordination instead of a silent collision.
 */

import { describe, expect, it } from "vitest";
import { FAILURE_MARKER_BASE, OUTCOME_MARKER_BASE } from "../../convex/processing/text/journal";
import { EXTRACT_STEP_SEQUENCE } from "../../convex/processing/text/extract";
import {
  CLARIFICATION_SEQUENCE_BASE,
  GROUP_SEQUENCE_BASE,
  LOAD_CONTEXT_SEQUENCE,
  MODEL_ANALYSIS_SEQUENCE,
} from "../../convex/processing/text/analyze";
import { SEGMENT_MARKER_BASE, SEGMENT_STEP_BASE } from "../../convex/processing/audio/executor";
import {
  JOIN_CLARIFICATION_BASE,
  JOIN_EVALUATE_SEQUENCE,
  JOIN_GROUP_BASE,
  JOIN_LOAD_CONTEXT_SEQUENCE,
  JOIN_MODEL_SEQUENCE,
} from "../../convex/processing/multimodal/join";
import {
  JOIN_MARKER_BASE,
  JOIN_STEP_BASE,
  JOIN_VISION_STEP_OFFSET,
} from "../../convex/processing/multimodal/journal";

describe("the E4 step keyspace stays outside every E3 and D6 range", () => {
  it("E4's stage base sits above all E3 sequences and markers", () => {
    const e3Max = Math.max(
      EXTRACT_STEP_SEQUENCE,
      LOAD_CONTEXT_SEQUENCE,
      MODEL_ANALYSIS_SEQUENCE,
      CLARIFICATION_SEQUENCE_BASE + 50,
      GROUP_SEQUENCE_BASE + 100,
      FAILURE_MARKER_BASE + 300_000,
      OUTCOME_MARKER_BASE + 300_000,
    );
    expect(JOIN_STEP_BASE).toBeGreaterThan(e3Max);
    expect(JOIN_MARKER_BASE).toBeGreaterThan(e3Max);
  });

  it("E4's stage bases sit outside D6's segment and marker bases by a wide margin", () => {
    for (const e4Base of [JOIN_STEP_BASE, JOIN_MARKER_BASE]) {
      expect(Math.abs(e4Base - SEGMENT_STEP_BASE)).toBeGreaterThan(2_000_000);
      expect(Math.abs(e4Base - SEGMENT_MARKER_BASE)).toBeGreaterThan(2_000_000);
    }
  });

  it("E4's own slots order strictly: evaluate < load < model < vision slots < clarify < groups", () => {
    expect(JOIN_EVALUATE_SEQUENCE).toBe(JOIN_STEP_BASE + 1);
    expect(JOIN_LOAD_CONTEXT_SEQUENCE).toBe(JOIN_STEP_BASE + 2);
    expect(JOIN_MODEL_SEQUENCE).toBe(JOIN_STEP_BASE + 3);
    expect(JOIN_STEP_BASE + JOIN_VISION_STEP_OFFSET).toBeGreaterThan(JOIN_MODEL_SEQUENCE);
    expect(JOIN_CLARIFICATION_BASE).toBeGreaterThan(JOIN_MODEL_SEQUENCE);
    expect(JOIN_GROUP_BASE).toBeGreaterThan(JOIN_CLARIFICATION_BASE);
    expect(JOIN_MARKER_BASE).toBeGreaterThan(JOIN_GROUP_BASE + 1_000);
  });
});
