/**
 * E4 focused verification, part 1: the JOINED COVERAGE decisions from
 * packages/agent/extraction — partial-safe honesty over D5/D6 producer
 * states (issue #38 acceptance: "The aggregate status names every required
 * input and never marks the source fully processed while a required
 * segment or image remains unresolved").
 */

import { describe, expect, it } from "vitest";
import {
  allInputsComplete,
  audioAttachmentStatus,
  decideJoinedCompleteness,
  imageAttachmentStatus,
  inputWorthWaiting,
  isCompleteTranscript,
} from "./helpers.js";
import {
  joinCoverage,
  type CoverageSourceView,
  type ImageInputView,
  type TranscriptOrderView,
} from "@kiero/agent";

/** One text+audio+images source view factory. */
function mixedView(overrides: {
  transcriptOrders?: TranscriptOrderView[];
  imageInputs?: ImageInputView[];
} = {}): CoverageSourceView {
  return {
    textExtractionId: "extractions_text",
    attachments: [
      { attachmentId: "attachments_audio", kind: "audio" },
      { attachmentId: "attachments_img1", kind: "image" },
      { attachmentId: "attachments_img2", kind: "image" },
    ],
    transcriptOrders: overrides.transcriptOrders ?? [],
    imageInputs:
      overrides.imageInputs ?? [
        {
          attachmentId: "attachments_img1",
          representationId: null,
          visionExtractionIds: [],
          supersededVisionExtractionIds: [],
          pendingReason: "photo_normalization_in_progress",
          visionFailureKind: null,
        },
        {
          attachmentId: "attachments_img2",
          representationId: null,
          visionExtractionIds: [],
          supersededVisionExtractionIds: [],
          pendingReason: "photo_normalization_in_progress",
          visionFailureKind: null,
        },
      ],
  };
}

const COMPLETE_TRANSCRIPT: TranscriptOrderView = {
  transcriptId: "audioTranscripts_done",
  attachmentId: "attachments_audio",
  state: "complete",
  lastErrorKind: null,
  extractionId: "extractions_stt_v1",
  finishedAtMs: 1_000,
};

const COMPLETE_IMAGE = (attachmentId: string, representationId: string): ImageInputView => ({
  attachmentId,
  representationId,
  visionExtractionIds: [`extractions_vision_${attachmentId}`],
  supersededVisionExtractionIds: [],
  pendingReason: null,
  visionFailureKind: null,
});

describe("joined coverage: every required input is named", () => {
  it("names the author text plus every audio and image attachment, whatever their state", () => {
    const snapshot = joinCoverage(mixedView());
    expect(snapshot.inputs.map((input) => input.kind)).toEqual([
      "text",
      "audio",
      "image",
      "image",
    ]);
    expect(snapshot.inputs[0]).toMatchObject({
      attachmentId: null,
      kind: "text",
      status: "complete",
      extractionId: "extractions_text",
    });
  });

  it("keeps the text input honestly pending when the D1 extraction is absent", () => {
    const snapshot = joinCoverage({ ...mixedView(), textExtractionId: null });
    expect(snapshot.inputs[0]).toMatchObject({
      kind: "text",
      status: "pending",
      lastErrorKind: "text_extraction_missing",
    });
  });
});

describe("joined coverage: all-present", () => {
  it("complete transcript + both images extracted => the aggregate is complete", () => {
    const snapshot = joinCoverage(
      mixedView({
        transcriptOrders: [COMPLETE_TRANSCRIPT],
        imageInputs: [
          COMPLETE_IMAGE("attachments_img1", "mediaRep_img1"),
          COMPLETE_IMAGE("attachments_img2", "mediaRep_img2"),
        ],
      }),
    );
    expect(allInputsComplete(snapshot)).toBe(true);
    expect(decideJoinedCompleteness(snapshot)).toBe("complete");
  });
});

describe("joined coverage: partial (one image and one segment failing/pending)", () => {
  it("an un-normalized image stays pending and blocks completeness, by name", () => {
    const snapshot = joinCoverage(
      mixedView({
        transcriptOrders: [COMPLETE_TRANSCRIPT],
        imageInputs: [
          COMPLETE_IMAGE("attachments_img1", "mediaRep_img1"),
          {
            attachmentId: "attachments_img2",
            representationId: null,
            visionExtractionIds: [],
            supersededVisionExtractionIds: [],
            pendingReason: "photo_normalization_in_progress",
            visionFailureKind: null,
          },
        ],
      }),
    );
    expect(decideJoinedCompleteness(snapshot)).toBe("partial_unresolved_inputs");
    const pendingImage = snapshot.inputs.find((i) => i.attachmentId === "attachments_img2");
    expect(pendingImage).toMatchObject({
      kind: "image",
      status: "pending",
      lastErrorKind: "photo_normalization_in_progress",
    });
  });

  it("a partial transcript (one segment failing) is pending, never complete", () => {
    const status = audioAttachmentStatus([
      {
        transcriptId: "audioTranscripts_partial",
        attachmentId: "attachments_audio",
        state: "partial",
        lastErrorKind: "provider_failed",
        extractionId: null,
        finishedAtMs: null,
      },
    ]);
    expect(status).toMatchObject({ kind: "audio", status: "pending" });
    expect(inputWorthWaiting(status)).toBe(true);
  });

  it("both vision routes failing leaves the image pending with the sanitized reason (resumable)", () => {
    const status = imageAttachmentStatus({
      attachmentId: "attachments_img1",
      representationId: "mediaRep_img1",
      visionExtractionIds: [],
      supersededVisionExtractionIds: [],
      pendingReason: null,
      visionFailureKind: "vision_routes_failed:output_rejected",
    });
    expect(status).toMatchObject({
      status: "pending",
      lastErrorKind: "vision_routes_failed:output_rejected",
      representationId: "mediaRep_img1",
    });
  });
});

describe("joined coverage: planning-blocked = externally blocked, resumable", () => {
  it("D6's honest production state (planning + lastErrorKind) is externally_blocked and never waited on", () => {
    const status = audioAttachmentStatus([
      {
        transcriptId: "audioTranscripts_blocked",
        attachmentId: "attachments_audio",
        state: "planning",
        lastErrorKind: "media_worker_not_configured",
        extractionId: null,
        finishedAtMs: null,
      },
    ]);
    expect(status).toMatchObject({
      kind: "audio",
      status: "externally_blocked",
      lastErrorKind: "media_worker_not_configured",
    });
    expect(inputWorthWaiting(status)).toBe(false);
  });

  it("planning WITHOUT an error kind is ordinary progress (pending, waited on)", () => {
    const status = audioAttachmentStatus([
      {
        transcriptId: "audioTranscripts_just_ordered",
        attachmentId: "attachments_audio",
        state: "planning",
        lastErrorKind: null,
        extractionId: null,
        finishedAtMs: null,
      },
    ]);
    expect(status.status).toBe("pending");
    expect(inputWorthWaiting(status)).toBe(true);
  });

  it("a source whose every unresolved input is blocked reports blocked_external", () => {
    const snapshot = joinCoverage(
      mixedView({
        transcriptOrders: [
          {
            transcriptId: "audioTranscripts_blocked",
            attachmentId: "attachments_audio",
            state: "planning",
            lastErrorKind: "media_worker_not_configured",
            extractionId: null,
            finishedAtMs: null,
          },
        ],
      }),
    );
    expect(decideJoinedCompleteness(snapshot)).not.toBe("complete");
    expect(snapshot.inputs.some((i) => i.status === "externally_blocked")).toBe(true);
  });
});

describe("joined coverage: replaced by a newer extraction version", () => {
  it("a newer completed transcript version reports the input as superseded-but-usable", () => {
    const status = audioAttachmentStatus([
      { ...COMPLETE_TRANSCRIPT, finishedAtMs: 1_000 },
      {
        transcriptId: "audioTranscripts_v2",
        attachmentId: "attachments_audio",
        state: "complete",
        lastErrorKind: null,
        extractionId: "extractions_stt_v2",
        finishedAtMs: 2_000,
      },
    ]);
    expect(status).toMatchObject({
      status: "replaced_by_newer_version",
      // The NEWEST completed version is the selected extraction.
      extractionId: "extractions_stt_v2",
    });
  });

  it("a vision version over an OLDER representation does not satisfy the current pixels", () => {
    const status = imageAttachmentStatus({
      attachmentId: "attachments_img1",
      representationId: "mediaRep_v2",
      visionExtractionIds: [],
      supersededVisionExtractionIds: ["extractions_vision_over_v1"],
      pendingReason: null,
      visionFailureKind: null,
    });
    expect(status).toMatchObject({
      status: "pending",
      lastErrorKind: "vision_superseded_representation",
      representationId: "mediaRep_v2",
    });
  });
});

describe("joined coverage: terminal failure", () => {
  it("a failed transcript order with no alternatives is failed", () => {
    const status = audioAttachmentStatus([
      {
        transcriptId: "audioTranscripts_failed",
        attachmentId: "attachments_audio",
        state: "failed",
        lastErrorKind: "attachment_withdrawn",
        extractionId: null,
        finishedAtMs: null,
      },
    ]);
    expect(status.status).toBe("failed");
    expect(inputWorthWaiting(status)).toBe(false);
  });

  it("an audio attachment with no order yet is pending (the join orders it)", () => {
    expect(audioAttachmentStatus([])).toMatchObject({
      status: "pending",
      lastErrorKind: "transcript_not_ordered",
    });
    // But it is NOT worth the bounded wait: the join's own evaluate stage is
    // the production orderer, so an unordered transcript at wait time means
    // this run could not order it (no author context) — waiting is dead.
    expect(inputWorthWaiting(audioAttachmentStatus([]))).toBe(false);
  });
});

describe("the E3 text-side snapshot stays the text-only authority", () => {
  it("isCompleteTranscript (E3) still governs the text-side run label", () => {
    // The text-only predicate from E3's planning surface, unchanged: this
    // lane must not have forked its meaning.
    expect(isCompleteTranscript({ extractedKinds: ["text"], pendingSegments: [] })).toBe(true);
    expect(
      isCompleteTranscript({ extractedKinds: ["text"], pendingSegments: ["image"] }),
    ).toBe(false);
  });
});
