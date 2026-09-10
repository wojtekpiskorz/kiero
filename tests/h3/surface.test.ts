/**
 * H3 focused tests, deterministic half.
 *
 * Covers the surface invariants the issue's acceptance names:
 *
 * - the mount/composition seam: the search and source-detail entries,
 *   validated through the real host registry (consumed operations exist;
 *   the shipped composition mounts both, conversation default first);
 * - real integration fixtures in wire form: text, long-audio segments,
 *   normalized-image OCR coordinates, a revised finding's evidence row,
 *   a withdrawn source's dossier, and the paginated history page all
 *   decode through the schemas the public reads carry;
 * - stale-evidence honesty: E5's keep rules are the server authority
 *   (tests/e5), and this half pins the client's side of the contract —
 *   the coverage literals render VERBATIM with the semantic-gap
 *   disclosure, and every kind/matchedVia label of the closed vocabulary
 *   renders (a vocabulary change fails the build);
 * - failure paths: the authorized media loader refuses closed on
 *   401/403/404 and on a missing token, degrades honestly on network
 *   failure, always sends the bearer header (and the range header on
 *   probes), and never builds a public URL; region geometry refuses an
 *   unknown coordinate space instead of guessing.
 *
 * The live halves (real Convex fixtures, index generation cutover, two
 * companies, withdrawal with recomputation, media access resolution,
 * range re-authorization) run in ./live-proof.mjs against the leased dev
 * deployment and are transcribed into the session report.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { operations, searchOperations } from "@kiero/contracts";
import {
  FragmentAnchor,
  SourceEvidencePage,
  SourceEvidenceRow,
  SourceExpositionRow,
} from "../../convex/sources/read/exposition";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { searchFeatureEntry } from "../../apps/web/src/app/features/search/entry";
import { sourceDetailFeatureEntry } from "../../apps/web/src/app/features/source-detail/entry";
import {
  attachmentMediaUrl,
  bearerOf,
  loadAuthorizedMedia,
  mediaTimestamp,
  probeAuthorizedRange,
  regionBoxStyle,
  representationMediaUrl,
} from "../../apps/web/src/features/source-detail/media";
import {
  anchorLabel,
  lifecycleLabels,
  processingStateLabels,
  representationRoleLabels,
  sourceDetailCopy,
  textRangeExcerpt,
  transcriptStateLabels,
  visionStateLabels,
} from "../../apps/web/src/features/source-detail/state";
import {
  coverageLine,
  dayToEndMs,
  dayToMs,
  isDegradedCoverage,
  searchCopy,
} from "../../apps/web/src/features/search/state";

/** Representative table ids (the wire pattern the reads carry). */
const SOURCE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";
const AUTHOR_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2u";
const PROJECT_1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2p";
const USER_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2u";
const FINDING_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2n";
const REVISION_1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2r";
const REVISION_2 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2s";
const FRAGMENT_TEXT = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2g";
const FRAGMENT_AUDIO = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2h";
const FRAGMENT_IMAGE = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2i";
const ATTACHMENT_AUDIO = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2a";
const ATTACHMENT_IMAGE = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2b";
const REPRESENTATION_1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c";
const REPRESENTATION_2 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2d";
const TRANSCRIPT_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2e";
const EXTRACTION_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2j";
const VISION_ORDER_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2k";

/** A controlled fetch stub recording every request it serves. */
function recordingFetch(
  respond: (url: string, init: RequestInit) => { status: number; body?: Blob } | null,
): { fetch: typeof fetch; requests: { url: string; init: RequestInit }[] } {
  const requests: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const answer = respond(url, init);
    if (answer === null) {
      throw new TypeError("network down");
    }
    return new Response(answer.body ?? new Blob([]), { status: answer.status });
  }) as unknown as typeof fetch;
  return { fetch: impl, requests };
}

describe("the H3 mounts (search + source detail)", () => {
  it("mounts the search route with E5's public query operation", () => {
    expect(searchFeatureEntry.featureId).toBe("search.evidence");
    expect(searchFeatureEntry.routePath).toBe("/szukaj");
    expect(searchFeatureEntry.implementation).toBe("mounted");
    expect([...searchFeatureEntry.consumedOperations]).toEqual(["search.queryEvidence"]);
  });

  it("mounts the source-detail route with C5's withdrawal and F1's read marking", () => {
    expect(sourceDetailFeatureEntry.featureId).toBe("source.detail");
    expect(sourceDetailFeatureEntry.routePath).toBe("/zrodlo");
    expect(sourceDetailFeatureEntry.implementation).toBe("mounted");
    expect([...sourceDetailFeatureEntry.consumedOperations].sort()).toEqual([
      "attention.markSourceRead",
      "sources.withdrawSource",
    ]);
  });

  it("names only operations that exist in the composed contracts registry", () => {
    for (const entry of [searchFeatureEntry, sourceDetailFeatureEntry]) {
      for (const operation of entry.consumedOperations) {
        expect(operation in operations).toBe(true);
      }
    }
  });

  it("is the composition the shipped host registers (conversation default first)", () => {
    const ids = appFeatures.map((entry) => entry.featureId);
    expect(ids[0]).toBe("conversation.company");
    expect(ids).toContain("search.evidence");
    expect(ids).toContain("source.detail");
    expect(appFeatures.map((entry) => entry.routePath)).toContain("/zrodlo");
  });
});

describe("the dossier fixture decodes through the public read's schema", () => {
  it("accepts a text source with whole-source and text-range fragments", () => {
    const wire = {
      sourceId: SOURCE_ID,
      authorUserId: AUTHOR_ID,
      authorText: "Projekt Banan: dowóz płytek w środę rano, klient potwierdził.",
      sentAtMs: Date.parse("2026-09-09T07:30:00.000Z"),
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: Date.parse("2026-09-09T07:30:02.000Z"),
      lifecycle: "active",
      processingState: "processed",
      projectIds: [PROJECT_1],
      withdrawnReason: null,
      withdrawnByUserId: null,
      withdrawnAtMs: null,
      attachments: [],
      transcripts: [],
      visionOrders: [],
      fragments: [
        { fragmentId: FRAGMENT_TEXT, extractionId: EXTRACTION_ID, anchor: { _tag: "text_range", startOffset: 15, endOffset: 40 } },
        { fragmentId: FRAGMENT_IMAGE, extractionId: EXTRACTION_ID, anchor: { _tag: "whole_source" } },
      ],
    };
    const row = Schema.decodeUnknownSync(SourceExpositionRow)(wire);
    expect(row.lifecycle).toBe("active");
    expect(row.fragments[0]?.anchor).toEqual({ _tag: "text_range", startOffset: 15, endOffset: 40 });
    expect(textRangeExcerpt(row.authorText, row.fragments[0]!.anchor)).toContain("dowóz płytek");
  });

  it("accepts a long-audio source with transcript segments and time anchors", () => {
    const wire = {
      sourceId: SOURCE_ID,
      authorUserId: AUTHOR_ID,
      authorText: "Nagranie z budowy.",
      sentAtMs: 10,
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: 12,
      lifecycle: "active",
      processingState: "processed",
      projectIds: [],
      withdrawnReason: null,
      withdrawnByUserId: null,
      withdrawnAtMs: null,
      attachments: [
        {
          attachmentId: ATTACHMENT_AUDIO,
          kind: "audio",
          representations: [
            {
              representationId: REPRESENTATION_1,
              role: "received",
              verifiedAtMs: 20,
              removedAtMs: 91, // D5 cleanup: received bytes deliberately gone
              width: null,
              height: null,
              durationMs: 120_000,
              mimeType: "audio/webm",
              bytes: 480_000,
              exceptionKind: null,
            },
            {
              representationId: REPRESENTATION_2,
              role: "retained",
              verifiedAtMs: 90,
              removedAtMs: null,
              width: null,
              height: null,
              durationMs: 120_000,
              mimeType: "audio/ogg",
              bytes: 90_000,
              exceptionKind: null,
            },
          ],
        },
      ],
      transcripts: [
        {
          transcriptId: TRANSCRIPT_ID,
          state: "complete",
          audioDurationMs: 120_000,
          pipelineVersion: "d6/1",
          segmentCount: 2,
          segments: [
            { segmentIndex: 0, startMs: 0, endMs: 1_000, state: "succeeded", text: "Dowóz płytek w środę." },
            { segmentIndex: 1, startMs: 1_000, endMs: 119_000, state: "succeeded", text: "Klient potwierdza odbiór." },
          ],
        },
      ],
      visionOrders: [],
      fragments: [
        { fragmentId: FRAGMENT_AUDIO, extractionId: EXTRACTION_ID, anchor: { _tag: "audio_interval", startMs: 0, endMs: 1_000 } },
      ],
    };
    const row = Schema.decodeUnknownSync(SourceExpositionRow)(wire);
    expect(row.transcripts[0]?.segments).toHaveLength(2);
    expect(row.transcripts[0]?.segments[1]?.endMs).toBe(119_000);
    expect(row.attachments[0]?.representations).toHaveLength(2);
    expect(representationRoleLabels.received).toContain("odebrana");
    expect(mediaTimestamp(119_000)).toBe("1:59");
    expect(anchorLabel(row.fragments[0]!.anchor)).toContain("zakres nagrania");
  });

  it("accepts a normalized-image OCR source with pixel-coordinate anchors", () => {
    const wire = {
      sourceId: SOURCE_ID,
      authorUserId: AUTHOR_ID,
      authorText: "Zdjęcie faktury.",
      sentAtMs: 10,
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: 12,
      lifecycle: "active",
      processingState: "processed",
      projectIds: [],
      withdrawnReason: null,
      withdrawnByUserId: null,
      withdrawnAtMs: null,
      attachments: [
        {
          attachmentId: ATTACHMENT_IMAGE,
          kind: "image",
          representations: [
            {
              representationId: REPRESENTATION_2,
              role: "retained",
              verifiedAtMs: 30,
              removedAtMs: null,
              width: 1024,
              height: 768,
              durationMs: null,
              mimeType: "image/webp",
              bytes: 2_048,
              exceptionKind: null,
            },
          ],
        },
      ],
      transcripts: [],
      visionOrders: [
        {
          orderId: VISION_ORDER_ID,
          state: "complete",
          pipelineVersion: "e4/1",
          representationId: REPRESENTATION_2,
          spaceWidth: 1024,
          spaceHeight: 768,
          observations: [
            { text: "FV/2026/09/12", region: { x: 64, y: 48, width: 256, height: 32 } },
          ],
        },
      ],
      fragments: [
        { fragmentId: FRAGMENT_IMAGE, extractionId: EXTRACTION_ID, anchor: { _tag: "image_region", x: 64, y: 48, width: 256, height: 32 } },
      ],
    };
    const row = Schema.decodeUnknownSync(SourceExpositionRow)(wire);
    const order = row.visionOrders[0]!;
    expect(order.observations[0]?.text).toBe("FV/2026/09/12");
    // The highlight resolves against the pinned representation's own space.
    const box = regionBoxStyle(order.observations[0]!.region, {
      width: order.spaceWidth,
      height: order.spaceHeight,
    });
    expect(box).not.toBeNull();
    const asPercent = (value: string | undefined): number => parseFloat(value?.replace("%", "") ?? "NaN");
    expect(asPercent(box?.left)).toBeCloseTo(6.25, 10);
    expect(asPercent(box?.top)).toBeCloseTo(6.25, 10);
    expect(asPercent(box?.width)).toBeCloseTo(25, 10);
    expect(asPercent(box?.height)).toBeCloseTo((32 / 768) * 100, 10);
    // An unknown space refuses geometry instead of guessing.
    expect(regionBoxStyle(order.observations[0]!.region, { width: null, height: null })).toBeNull();
    expect(anchorLabel(row.fragments[0]!.anchor)).toContain("obszar zdjęcia");
  });

  it("labels every anchor family of the fragment contract", () => {
    for (const anchor of [
      { _tag: "text_range", startOffset: 0, endOffset: 5 },
      { _tag: "audio_interval", startMs: 0, endMs: 1_000 },
      { _tag: "image_region", x: 1, y: 2, width: 3, height: 4 },
      { _tag: "whole_source" },
    ] as const) {
      const decoded = Schema.decodeUnknownSync(FragmentAnchor)(anchor);
      expect(anchorLabel(decoded)).toBeTypeOf("string");
      expect(anchorLabel(decoded).length).toBeGreaterThan(3);
    }
    expect(() =>
      Schema.decodeUnknownSync(FragmentAnchor)({ _tag: "mystery_anchor" }),
    ).toThrow();
  });

  it("labels every lifecycle, processing, transcript, vision and representation vocabulary", () => {
    for (const lifecycle of ["active", "withdrawn", "purged"] as const) {
      expect(lifecycleLabels[lifecycle]).toBeTypeOf("string");
    }
    for (const state of ["accepted", "processing", "partial", "processed", "failed"] as const) {
      expect(processingStateLabels[state]).toBeTypeOf("string");
    }
    for (const state of ["planning", "pending", "partial", "complete", "failed"] as const) {
      expect(transcriptStateLabels[state]).toBeTypeOf("string");
    }
    for (const state of ["pending", "complete", "failed"] as const) {
      expect(visionStateLabels[state]).toBeTypeOf("string");
    }
    for (const role of ["received", "retained", "thumbnail", "processing"] as const) {
      expect(representationRoleLabels[role]).toBeTypeOf("string");
    }
  });
});

describe("withdrawal stays history, never deletion", () => {
  it("decodes a withdrawn source with its full record and non-deletion copy", () => {
    const wire = {
      sourceId: SOURCE_ID,
      authorUserId: AUTHOR_ID,
      authorText: "Wiadomość wycofana z powodu pomyłki.",
      sentAtMs: 10,
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: 12,
      lifecycle: "withdrawn",
      processingState: "processed",
      projectIds: [],
      withdrawnReason: "Pomyłka: dotyczyło innego projektu.",
      withdrawnByUserId: USER_ID,
      withdrawnAtMs: 99,
      attachments: [],
      transcripts: [],
      visionOrders: [],
      fragments: [],
    };
    const row = Schema.decodeUnknownSync(SourceExpositionRow)(wire);
    expect(row.lifecycle).toBe("withdrawn");
    expect(row.withdrawnReason).toContain("Pomyłka");
    expect(lifecycleLabels.withdrawn).toContain("historia zachowana");
    expect(lifecycleLabels.withdrawn).not.toContain("usunięta");
    expect(sourceDetailCopy.withdrawnDisclosedNote).toContain("nie jest trwałym usunięciem");
  });
});

describe("the evidence chain pages and shows recomputation status", () => {
  it("decodes a revised finding's row: cited revision superseded, current is the correction", () => {
    const wire = {
      findingId: FINDING_ID,
      semanticKey: "materialy.dowoz",
      scope: { _tag: "project", projectId: PROJECT_1 },
      supportKind: "support",
      citedRevisionId: REVISION_1,
      citedRevision: 1,
      citedOrigin: "publication",
      citedRecordedAtMs: 100,
      fragmentId: FRAGMENT_TEXT,
      fragmentAnchor: { _tag: "text_range", startOffset: 16, endOffset: 41 },
      currentRevisionId: REVISION_2,
      currentRevision: 2,
      currentKnowledgeState: { _tag: "known" },
      currentValue: { _tag: "text_note", text: "dowóz w czwartek rano" },
      currentOrigin: "correction",
      currentReason: "Klient przesunął termin telefonicznie.",
      currentRecordedAtMs: 200,
      supersededByNewerRevision: true,
    };
    const row = Schema.decodeUnknownSync(SourceEvidenceRow)(wire);
    expect(row.supersededByNewerRevision).toBe(true);
    expect(row.currentOrigin).toBe("correction");
    expect(row.currentReason).toContain("przesunął");
    expect(row.fragmentAnchor).toEqual({ _tag: "text_range", startOffset: 16, endOffset: 41 });
  });

  it("decodes a withdrawal-marked dependent: updating, recomputation visible", () => {
    const wire = {
      findingId: FINDING_ID,
      semanticKey: "materialy.dowoz",
      scope: { _tag: "company" },
      supportKind: "support",
      citedRevisionId: REVISION_1,
      citedRevision: 1,
      citedOrigin: "publication",
      citedRecordedAtMs: 100,
      fragmentId: null,
      fragmentAnchor: null,
      currentRevisionId: REVISION_2,
      currentRevision: 2,
      currentKnowledgeState: { _tag: "updating", reason: "wycofano źródło popierające" },
      currentValue: { _tag: "text_note", text: "dowóz w środę rano" },
      currentOrigin: "withdrawal_marking",
      currentReason: "wycofano źródło popierające",
      currentRecordedAtMs: 300,
      supersededByNewerRevision: true,
    };
    const row = Schema.decodeUnknownSync(SourceEvidenceRow)(wire);
    expect(row.currentOrigin).toBe("withdrawal_marking");
    expect((row.currentKnowledgeState as { _tag: string })._tag).toBe("updating");
  });

  it("decodes one interrupted page of the paginated history (isDone false keeps paging honest)", () => {
    const page = Schema.decodeUnknownSync(SourceEvidencePage)({
      page: [],
      isDone: false,
      continueCursor: "cursor-1",
    });
    expect(page.isDone).toBe(false);
    expect(page.continueCursor).toBe("cursor-1");
    const done = Schema.decodeUnknownSync(SourceEvidencePage)({
      page: [],
      isDone: true,
      continueCursor: "",
    });
    expect(done.isDone).toBe(true);
  });
});

describe("coverage disclosure renders verbatim with the semantic-gap honesty", () => {
  const entry = searchOperations["search.queryEvidence"];

  it("keeps the contract's coverage literals and labels them all", () => {
    for (const coverage of ["full", "text_only", "degraded"] as const) {
      const line = coverageLine(coverage);
      expect(line.startsWith(coverage)).toBe(true);
      expect(searchCopy.coverageLabels[coverage]).toBeTypeOf("string");
    }
    expect(coverageLine("text_only")).toContain("nie dowodzi braku faktu");
    expect(coverageLine("degraded")).toContain("Brak aktywnego indeksu");
    expect(isDegradedCoverage("text_only")).toBe(true);
    expect(isDegradedCoverage("degraded")).toBe(true);
    expect(isDegradedCoverage("full")).toBe(false);
  });

  it("labels every kind and matchedVia the result schema can carry", () => {
    for (const kind of ["source_fragment", "finding"] as const) {
      for (const matchedVia of ["text", "semantic", "text_and_semantic"] as const) {
        const decoded = Schema.decodeUnknownSync(entry.result)({
          entries: [
            {
              searchEntryId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2x",
              kind,
              ...(kind === "source_fragment" ? { sourceId: SOURCE_ID, sourceFragmentId: FRAGMENT_TEXT } : { findingId: FINDING_ID }),
              score: 0.5,
              matchedVia,
            },
          ],
          coverage: "full",
          isDone: true,
        });
        expect(decoded.entries[0]?.kind).toBe(kind);
        expect(searchCopy.kindLabels[kind]).toBeTypeOf("string");
        expect(searchCopy.matchedViaLabels[matchedVia]).toBeTypeOf("string");
      }
    }
    // The filter inputs the surface issues decode through the contract.
    const input = Schema.decodeUnknownSync(entry.input)({
      query: "dowóz płytek",
      limit: 10,
      projectId: PROJECT_1,
      authorUserId: AUTHOR_ID,
      sentFromMs: 1,
      sentToMs: 2,
      cursor: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2x",
    });
    expect(input.projectId).toBe(PROJECT_1);
  });

  it("converts day filters to inclusive millisecond bounds", () => {
    const from = dayToMs("2026-09-01");
    expect(from).toBe(Date.parse("2026-09-01T00:00:00Z"));
    expect(dayToMs("  ")).toBeNull();
    expect(dayToMs("not-a-day")).toBeNull();
    expect(dayToEndMs("2026-09-01")).toBe(from! + 86_399_999);
  });
});

describe("the authorized media loader (failure paths and request shape)", () => {
  const GATEWAY = "https://gateway.example";
  const audioUrl = attachmentMediaUrl(GATEWAY, ATTACHMENT_AUDIO);

  it("never builds a public URL: ids are encoded into the channel paths", () => {
    expect(audioUrl).toBe(`${GATEWAY}/media/attachments/${ATTACHMENT_AUDIO}`);
    expect(representationMediaUrl(GATEWAY, REPRESENTATION_2)).toBe(
      `${GATEWAY}/media/representations/${REPRESENTATION_2}`,
    );
    expect(bearerOf("tok")).toBe("Bearer tok");
  });

  it("sends the bearer credential on every load", async () => {
    const { fetch: impl, requests } = recordingFetch(() => ({
      status: 200,
      body: new Blob(["abc"]),
    }));
    const outcome = await loadAuthorizedMedia(impl, audioUrl, "tok");
    expect(outcome.state).toBe("loaded");
    if (outcome.state === "loaded") {
      expect(outcome.bytes).toBe(3);
      expect(outcome.objectUrl).toBeTypeOf("string");
    }
    expect(requests[0]?.init.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("refuses closed on 401/403/404 (revocation, tenancy, lifecycle)", async () => {
    for (const status of [401, 403, 404]) {
      const { fetch: impl } = recordingFetch(() => ({ status }));
      const outcome = await loadAuthorizedMedia(impl, audioUrl, "tok");
      expect(outcome).toEqual({ state: "denied" });
    }
  });

  it("refuses closed without a live token and degrades honestly on network failure", async () => {
    const { fetch: impl } = recordingFetch(() => ({ status: 200, body: new Blob(["abc"]) }));
    expect(await loadAuthorizedMedia(impl, audioUrl, null)).toEqual({ state: "denied" });
    expect(await loadAuthorizedMedia(impl, audioUrl, "")).toEqual({ state: "denied" });
    const down = recordingFetch(() => null);
    expect(await loadAuthorizedMedia(down.fetch, audioUrl, "tok")).toEqual({ state: "unavailable" });
  });

  it("sends the range header on probes and reports the satisfied content-range", async () => {
    const { fetch: impl, requests } = recordingFetch(() => ({ status: 206 }));
    const outcome = await probeAuthorizedRange(impl, audioUrl, "tok", "bytes=0-1");
    expect(outcome.state).toBe("satisfied");
    expect(requests[0]?.init.headers).toMatchObject({
      authorization: "Bearer tok",
      range: "bytes=0-1",
    });
    const denied = recordingFetch(() => ({ status: 403 }));
    expect(await probeAuthorizedRange(denied.fetch, audioUrl, "tok", "bytes=0-1")).toEqual({
      state: "denied",
    });
    const down = recordingFetch(() => null);
    expect(await probeAuthorizedRange(down.fetch, audioUrl, "tok", "bytes=0-1")).toEqual({
      state: "unavailable",
    });
  });
});
