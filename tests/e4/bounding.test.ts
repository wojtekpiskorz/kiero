/**
 * E4 focused verification, part 3: completeness-based BOUNDING and the
 * inspection-honesty invariants (issue #38: "Publish independently
 * supported groups while leaving groups that depend on missing media
 * pending"; "Independent text facts may publish during image failure, but
 * image-dependent amounts or dimensions cannot"; the text-only fallback
 * can never claim to have inspected a pending image).
 */

import { describe, expect, it } from "vitest";
import {
  JOIN_PROMPT_VERSION,
  JOIN_SCHEMA_VERSION,
  MULTIMODAL_JOIN_PIPELINE_VERSION,
  boundMultimodalGroups,
  emptyMultimodalState,
  groupEvidenceKinds,
  mediaClaimsBackedByCompleteInputs,
  proposalGroundingComplete,
  applyMultimodalCall,
  type AnalysisContext,
  type JoinAnalysisContext,
  type MultimodalFindingProposal,
} from "@kiero/agent";

/** 2026-09-08 is a Tuesday; 18:30 Warsaw time. */
const SENT_AT_MS = Date.parse("2026-09-08T16:30:00.000Z");

const TEXT = [
  "Dowóz płytek na Buniewice w środę rano.",
  "Klient Kaczmarek potwierdza odbiór.",
].join(" ");

/** A minimal E3 analysis context (the tests/e3 fixture shape). */
function baseContext(): AnalysisContext {
  return {
    source: {
      sourceId: "sources_mixed",
      authorText: TEXT,
      sentAtMs: SENT_AT_MS,
      sentAtTimezone: "Europe/Warsaw",
      lifecycle: "active",
      hintProjectIds: [],
    },
    coverage: { extractedKinds: ["text"], pendingSegments: ["image", "audio"] },
    projects: [
      { projectId: "projects_banan", displayName: "Banan", codename: null },
    ],
    findings: [],
    recentSources: [],
    run: { runId: "runs_join", kind: "initial_analysis", reanalysisOfRunId: null },
  };
}

const SEGMENTS = [
  {
    transcriptId: "audioTranscripts_t",
    extractionId: "extractions_stt_v1",
    segmentIndex: 0,
    startMs: 0,
    endMs: 2_000,
    text: "Wycena dwanaście tysięcy netto",
  },
];

const OBSERVATIONS = [
  {
    observationId: "obs:mediaRep_img1:0",
    attachmentId: "attachments_img1",
    representationId: "mediaRep_img1",
    extractionId: "extractions_vision_img1",
    text: "12 400",
    region: { x: 40, y: 60, width: 300, height: 80 },
  },
];

/** The joined context: the base plus the COMPLETED transcript + vision. */
function joinedContext(): JoinAnalysisContext {
  return {
    base: baseContext(),
    coverage: {
      inputs: [
        {
          attachmentId: null,
          kind: "text",
          status: "complete",
          extractionId: "extractions_text",
          representationId: null,
          lastErrorKind: null,
        },
        {
          attachmentId: "attachments_audio",
          kind: "audio",
          status: "complete",
          extractionId: "extractions_stt_v1",
          representationId: null,
          lastErrorKind: null,
        },
        {
          attachmentId: "attachments_img1",
          kind: "image",
          status: "complete",
          extractionId: "extractions_vision_img1",
          representationId: "mediaRep_img1",
          lastErrorKind: null,
        },
      ],
    },
    transcriptSegments: SEGMENTS,
    visionObservations: OBSERVATIONS,
  };
}

/** The joined context with the image PENDING (vision routes failed). */
function imagePendingContext(): JoinAnalysisContext {
  const context = joinedContext();
  return {
    ...context,
    visionObservations: [],
    coverage: {
      inputs: context.coverage.inputs.map((input) =>
        input.kind === "image"
          ? {
              ...input,
              status: "pending" as const,
              extractionId: null,
              lastErrorKind: "vision_routes_failed:output_rejected",
            }
          : input,
      ),
    },
  };
}

function upsertCall(args: Record<string, unknown>) {
  return {
    id: "call_1",
    name: "memory_upsert_finding",
    arguments: {
      intent: "record",
      semanticKey: "wycena",
      scopeKind: "company",
      projectId: null,
      value: { _tag: "text_note", text: "notatka" },
      quotes: [],
      transcriptQuotes: [],
      imageObservationIds: [],
      replacesFindingId: null,
      derivesFromFindingIds: [],
      readConfidence: 0.9,
      ...args,
    },
  };
}

describe("the joined reducer accumulates multimodal evidence", () => {
  it("grounds a transcript quote as an original-time audio interval anchor", () => {
    const outcome = applyMultimodalCall(
      emptyMultimodalState(),
      joinedContext(),
      upsertCall({ transcriptQuotes: ["dwanaście tysięcy netto"] }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(1);
    const evidence = outcome.state.proposals[0]?.evidence[0];
    expect(evidence).toMatchObject({
      _tag: "audio_interval",
      startMs: 0,
      endMs: 2_000,
      extractionId: "extractions_stt_v1",
    });
  });

  it("grounds an image observation as a region anchor pinned to the representation", () => {
    const outcome = applyMultimodalCall(
      emptyMultimodalState(),
      joinedContext(),
      upsertCall({ imageObservationIds: ["obs:mediaRep_img1:0"] }),
      "PLN",
    );
    const evidence = outcome.state.proposals[0]?.evidence[0];
    expect(evidence).toMatchObject({
      _tag: "image_region",
      representationId: "mediaRep_img1",
      extractionId: "extractions_vision_img1",
      region: { x: 40, y: 60, width: 300, height: 80 },
    });
  });

  it("refuses a hallucinated observation handle — the whole call, never partially", () => {
    const outcome = applyMultimodalCall(
      emptyMultimodalState(),
      joinedContext(),
      upsertCall({
        quotes: ["Klient Kaczmarek potwierdza odbiór."],
        imageObservationIds: ["obs:mediaRep_img1:9"],
      }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });

  it("refuses a transcript quote that does not exist verbatim", () => {
    const outcome = applyMultimodalCall(
      emptyMultimodalState(),
      joinedContext(),
      upsertCall({ transcriptQuotes: ["tego nie ma w nagraniu"] }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
  });
});

describe("THE invariant: a text-only fallback never claims image inspection", () => {
  it("with the image pending there are NO observation handles, so an image claim is refused", () => {
    const outcome = applyMultimodalCall(
      emptyMultimodalState(),
      imagePendingContext(),
      upsertCall({ imageObservationIds: ["obs:mediaRep_img1:0"] }),
      "PLN",
    );
    expect(outcome.state.proposals).toHaveLength(0);
    expect(outcome.toolResult).toContain("ODRZUCONO");
  });

  it("the pure predicate rejects any plan carrying evidence the coverage does not report complete", () => {
    const fabricated: MultimodalFindingProposal[] = [
      {
        intent: "record",
        semanticKey: "kwota_ze_zdjecia",
        scope: { kind: "company" },
        valueWire: { _tag: "text_note", text: "12 400" },
        knowledgeStateWire: "known",
        evidence: [
          {
            _tag: "image_region",
            observationId: "obs:mediaRep_img1:0",
            region: { x: 40, y: 60, width: 300, height: 80 },
            representationId: "mediaRep_img1",
            extractionId: "extractions_vision_img1",
          },
        ],
        replacesFindingId: null,
        derivesFromFindingIds: [],
        readConfidence: 0.9,
      },
    ];
    // Against the ALL-COMPLETE coverage the claim stands.
    expect(mediaClaimsBackedByCompleteInputs({ proposals: fabricated }, joinedContext().coverage)).toBe(
      true,
    );
    // Against the image-pending coverage the same claim is dishonest.
    expect(
      mediaClaimsBackedByCompleteInputs({ proposals: fabricated }, imagePendingContext().coverage),
    ).toBe(false);
  });
});

describe("bounding by evidence completeness (the partial-safe split)", () => {
  /** One text-grounded and one image-grounded proposal in the SAME scope. */
  function mixedPlan(context: JoinAnalysisContext) {
    let state = emptyMultimodalState();
    const textOutcome = applyMultimodalCall(
      state,
      context,
      upsertCall({
        semanticKey: "potwierdzenie_odbioru",
        quotes: ["Klient Kaczmarek potwierdza odbiór."],
        imageObservationIds: [],
      }),
      "PLN",
    );
    state = textOutcome.state;
    const imageOutcome = applyMultimodalCall(
      state,
      context,
      upsertCall({
        semanticKey: "kwota_ze_zdjecia",
        quotes: [],
        imageObservationIds: context.visionObservations.map((o) => o.observationId),
      }),
      "PLN",
    );
    return imageOutcome.state;
  }

  it("all-present: one scope group carries both proposals and publishes", () => {
    const state = mixedPlan(joinedContext());
    const bounded = boundMultimodalGroups(state, joinedContext());
    expect(bounded.groups).toHaveLength(1);
    expect(bounded.groups[0]?.waitForMedia).toBe(false);
    expect(groupEvidenceKinds(bounded.groups[0] ?? { proposals: [] })).toEqual(
      expect.arrayContaining(["text", "image"]),
    );
  });

  it("image pending: the SAME scope splits — the text group publishes, the image group waits", () => {
    // The plan was accumulated while everything was inspectable (the
    // reducer only admits grounded evidence). The coverage REGRESSED before
    // bounding/publish (a mid-run re-normalization superseded the vision
    // version, or a journaled plan replays against newer coverage): the
    // split keeps the text group publishable and the image group waiting.
    const state = mixedPlan(joinedContext());
    const regressed = imagePendingContext();
    const bounded = boundMultimodalGroups(state, regressed);
    expect(bounded.groups).toHaveLength(2);
    const waiting = bounded.groups.find((group) => group.waitForMedia);
    const publishing = bounded.groups.find((group) => !group.waitForMedia);
    expect(waiting?.proposals.map((p) => p.semanticKey)).toEqual(["kwota_ze_zdjecia"]);
    expect(publishing?.proposals.map((p) => p.semanticKey)).toEqual(["potwierdzenie_odbioru"]);
    // Waiting never blocks publishing and publishing never drags the
    // ungrounded claim along:
    expect(waiting && publishing && waiting.key.kind === publishing.key.kind).toBe(true);
  });

  it("a group needing ONLY unavailable media contains no publishable proposal", () => {
    const context = imagePendingContext();
    let state = emptyMultimodalState();
    const outcome = applyMultimodalCall(
      state,
      context,
      upsertCall({
        semanticKey: "wycena_z_transkrypcji",
        transcriptQuotes: ["dwanaście tysięcy netto"],
      }),
      "PLN",
    );
    state = outcome.state;
    const audioPending = {
      ...context,
      coverage: {
        inputs: context.coverage.inputs.map((input) =>
          input.kind === "audio"
            ? { ...input, status: "pending" as const, extractionId: null }
            : input,
        ),
      },
      transcriptSegments: [],
    };
    // With the transcript also unavailable the quote cannot even locate
    // (no segment text), so nothing accumulates: the model must fall back
    // to text or a clarification — never a fabricated audio claim.
    const refused = applyMultimodalCall(
      emptyMultimodalState(),
      audioPending,
      upsertCall({ semanticKey: "wycena2", transcriptQuotes: ["dwanaście tysięcy netto"] }),
      "PLN",
    );
    expect(refused.state.proposals).toHaveLength(0);
    // And the previously-accumulated audio proposal, bounded against the
    // pending coverage, waits.
    const bounded = boundMultimodalGroups(state, audioPending);
    expect(bounded.groups.every((group) => group.waitForMedia)).toBe(true);
  });

  it("proposalGroundingComplete pins the extraction VERSION, not just the kind", () => {
    const state = mixedPlan(joinedContext());
    const proposal = state.proposals.find((p) => p.semanticKey === "kwota_ze_zdjecia");
    expect(proposal && proposalGroundingComplete(proposal, joinedContext().coverage)).toBe(true);
    // A coverage whose image input completed under a NEWER version (the old
    // one superseded) no longer backs the old anchor.
    const supersededCoverage = {
      inputs: joinedContext().coverage.inputs.map((input) =>
        input.kind === "image"
          ? { ...input, extractionId: "extractions_vision_img1_v2" }
          : input,
      ),
    };
    expect(
      proposal && proposalGroundingComplete(proposal, supersededCoverage),
    ).toBe(false);
  });
});

describe("E4 version labels are pinned", () => {
  it("the join's pipeline/prompt/schema versions are deliberate constants", () => {
    expect(MULTIMODAL_JOIN_PIPELINE_VERSION).toBe("e4.join/1");
    expect(JOIN_PROMPT_VERSION).toBe("e4.prompt-pl/1");
    expect(JOIN_SCHEMA_VERSION).toBe("e4.schema/1");
  });
});
