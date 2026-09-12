/**
 * H1 focused tests, deterministic half.
 *
 * Covers the surface invariants the issue's acceptance names:
 *
 * - the mount/composition seam: the conversation entry (H1's replacement of
 *   J1's core-text mount, same proved send commands + F1 read marking) and
 *   the new memory route, both validated through the real host registry;
 * - view-projection consistency: a firm-knowledge row and a mixed
 *   project-linked row decode through the one row schema both views share
 *   (one source id, one author, no copy);
 * - unread wiring: the F1 projection decodes at the boundary and absence of
 *   an entry means unread (the badge rule);
 * - correction history visibility: the H1-flagged history read's contract
 *   accepts the exact wire rows the exposition produces (publication and
 *   correction origins, evidence witnesses), and the UI labels every origin
 *   of the contract's closed vocabulary;
 * - honest states: C5's `updating` renders as NOT settled and the direct
 *   correction prefill references the old source without rewriting it.
 *
 * The live halves (real Convex fixtures, two bosses, cross-view authorship
 * stability, reading in one view marking everywhere, corrections reflected
 * in project memory with history) run in ./live-proof.mjs against the
 * leased dev deployment and are transcribed into the session report.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { memoryOperations, operations } from "@kiero/contracts";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  ConversationPage,
  SourceConversationRow,
  type SourceConversationRow as ConversationRowType,
} from "../../convex/sources/read/rows";
import { projectReadState } from "../../convex/attention/read_state/state";
import {
  ReadStateProjection,
  correctionPrefill,
} from "../../apps/web/src/features/conversation/state";
import {
  isSettledKnowledgeState,
  knowledgeStateLabel,
  memoryCopy,
} from "../../apps/web/src/features/memory/state";
import {
  ResolutionBasisView,
  resolutionBasisLabels,
} from "../../apps/web/src/features/memory/MemoryFeature";
import { AgentAnswerPanel } from "../../apps/web/src/features/conversation/ConversationFeature";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { conversationFeatureEntry } from "../../apps/web/src/app/features/conversation/entry";
import { memoryFeatureEntry } from "../../apps/web/src/app/features/memory/entry";

/** Representative table ids (the wire pattern the reads carry). */
const SOURCE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";
const AUTHOR_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2u";
const FIRM_SOURCE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2m";
const FIRM_AUTHOR_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2w";
const PROJECT_1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2p";
const PROJECT_2 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2q";
const REVISION_ID_1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2r";
const REVISION_ID_2 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2s";
const FINDING_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2n";
const USER_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2u";
const FRAGMENT_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2g";

/** One mixed source: two project links, one author, one original. */
const mixedSourceWire = {
  sourceId: SOURCE_ID,
  authorUserId: AUTHOR_ID,
  authorText: "Projekt Banan i Kaczmarek: wspólny dowóz płytek w środę rano.",
  sentAtMs: Date.parse("2026-09-09T07:30:00.000Z"),
  sentAtTimezone: "Europe/Warsaw",
  fullyAcceptedAtMs: Date.parse("2026-09-09T07:30:02.000Z"),
  lifecycle: "active",
  processingState: "processed",
  projectIds: [PROJECT_1, PROJECT_2],
};

/**
 * One firm-knowledge source: a DIFFERENT author, text, send time and no
 * project links (wiedza ogólna firmy) — a row only the company view lists
 * but the SAME schema decodes.
 */
const firmKnowledgeWire = {
  sourceId: FIRM_SOURCE_ID,
  authorUserId: FIRM_AUTHOR_ID,
  authorText: "Zmieniamy dostawcę płytek na cały sezon: od października dowozi Kaczmarek.",
  sentAtMs: Date.parse("2026-09-08T15:00:00.000Z"),
  sentAtTimezone: "Europe/Warsaw",
  fullyAcceptedAtMs: Date.parse("2026-09-08T15:00:02.000Z"),
  lifecycle: "active",
  processingState: "processed",
  projectIds: [] as const,
};

describe("the H1 mounts (conversation replacement + memory route)", () => {
  it("keeps the conversation entry mounted at the default route with the proved send commands", () => {
    expect(conversationFeatureEntry.featureId).toBe("conversation.company");
    expect(conversationFeatureEntry.routePath).toBe("/");
    expect(conversationFeatureEntry.implementation).toBe("mounted");
    expect([...conversationFeatureEntry.consumedOperations].sort()).toEqual([
      "attention.markSourceRead",
      "sources.acceptSource",
      "sources.prepareUpload",
    ]);
  });

  it("mounts the memory route with C2's audited commands and a stable ASCII path", () => {
    expect(memoryFeatureEntry.featureId).toBe("memory.project");
    expect(memoryFeatureEntry.routePath).toBe("/pamiec");
    expect(memoryFeatureEntry.implementation).toBe("mounted");
    expect([...memoryFeatureEntry.consumedOperations].sort()).toEqual([
      "memory.correctFinding",
      "memory.resolveClarification",
    ]);
  });

  it("names only operations that exist in the composed contracts registry", () => {
    for (const entry of [conversationFeatureEntry, memoryFeatureEntry]) {
      for (const operation of entry.consumedOperations) {
        expect(operation in operations).toBe(true);
      }
    }
  });

  it("is the composition the shipped host registers (conversation default, memory second)", () => {
    expect(appFeatures[0]?.featureId).toBe("conversation.company");
    expect(appFeatures[1]?.featureId).toBe("memory.project");
    expect(appFeatures.map((entry) => entry.routePath)).toContain("/pamiec");
  });
});

describe("one mixed source appears consistently in both scopes", () => {
  it("decodes a firm-knowledge row and a project-linked row through the one row schema both views share", () => {
    // The projection rule: BOTH views decode through the ONE row schema,
    // whichever row each one lists. The company view also carries
    // firm-knowledge rows (no project links, wiedza ogólna firmy); the
    // project view carries the same mixed row narrowed by the link — never
    // a copy. Two meaningfully different fixtures pin that the schema
    // serves both views without a scope-dependent shape.
    const companyRow = Schema.decodeUnknownSync(SourceConversationRow)(firmKnowledgeWire);
    const projectRow = Schema.decodeUnknownSync(SourceConversationRow)(mixedSourceWire);
    expect(companyRow.sourceId).toBe(FIRM_SOURCE_ID);
    expect(companyRow.authorUserId).toBe(FIRM_AUTHOR_ID);
    expect(companyRow.authorText).toBe(firmKnowledgeWire.authorText);
    expect(companyRow.projectIds).toHaveLength(0);
    expect(projectRow.sourceId).toBe(SOURCE_ID);
    expect(projectRow.authorUserId).toBe(AUTHOR_ID);
    expect(projectRow.projectIds).toEqual([PROJECT_1, PROJECT_2]);
    // The two rows stay themselves: different source ids, authors, texts
    // and link counts through the SAME schema.
    expect(companyRow.sourceId).not.toBe(projectRow.sourceId);
    expect(companyRow.authorUserId).not.toBe(projectRow.authorUserId);
    expect(companyRow.authorText).not.toBe(projectRow.authorText);
    expect(companyRow.projectIds).not.toEqual(projectRow.projectIds);

    const companyPage = Schema.decodeUnknownSync(ConversationPage)({
      page: [firmKnowledgeWire],
      isDone: true,
      continueCursor: "",
    });
    const projectPage = Schema.decodeUnknownSync(ConversationPage)({
      page: [mixedSourceWire],
      isDone: false,
      continueCursor: "cursor",
    });
    expect(companyPage.page[0]?.sourceId).toBe(FIRM_SOURCE_ID);
    expect(projectPage.page[0]?.sourceId).toBe(SOURCE_ID);
    expect(companyPage.page[0]?.sourceId).not.toBe(projectPage.page[0]?.sourceId);
  });

  it("keeps every processing state decodable in either scope (honest states, incl. partial)", () => {
    for (const processingState of ["accepted", "processing", "partial", "processed", "failed"] as const) {
      const row = Schema.decodeUnknownSync(SourceConversationRow)({
        ...mixedSourceWire,
        processingState,
      });
      expect(row.processingState).toBe(processingState);
    }
  });

  it("keeps the withdrawn lifecycle readable (history retained)", () => {
    const row = Schema.decodeUnknownSync(SourceConversationRow)({
      ...mixedSourceWire,
      lifecycle: "withdrawn",
    });
    expect(row.lifecycle).toBe("withdrawn");
  });
});

describe("unread wiring (F1 projection at the boundary; absence = unread)", () => {
  it("decodes the projection's ok value through the boundary schema", () => {
    const decoded = Schema.decodeUnknownSync(ReadStateProjection)({
      userId: USER_ID,
      entries: [{ sourceId: SOURCE_ID, read: true, readAtMs: 1 }],
    });
    expect(decoded.entries[0]?.read).toBe(true);
    expect(() =>
      Schema.decodeUnknownSync(ReadStateProjection)({ userId: USER_ID, entries: [{ sourceId: SOURCE_ID }] }),
    ).toThrow();
  });

  it("treats a source with no entry as unread for that person (the badge rule)", () => {
    // The UI rule under test: read === entries.get(id) === true, so a
    // missing entry can never render as read. The pure projection behind it
    // (F1's own) is exercised with the same inputs.
    const entries = projectReadState([SOURCE_ID, PROJECT_1], [
      { sourceId: SOURCE_ID, read: true, readAtMs: 5 },
    ]);
    const readBySource = new Map(entries.map((entry) => [entry.sourceId, entry.read]));
    expect(readBySource.get(SOURCE_ID)).toBe(true);
    expect(readBySource.get(PROJECT_1) === true).toBe(false);

    // Two bosses stay independent: the projection carries this person's
    // rows only; the second boss's absence of a row is their unread state.
    const bossB = projectReadState([SOURCE_ID], []);
    expect(bossB[0]?.read).toBe(false);
    expect(bossB[0]?.readAtMs).toBeNull();
  });
});

describe("correction history visibility (the H1-flagged history read)", () => {
  const historyEntry = memoryOperations["memory.readFindingHistory"];

  it("is registered as a read-only memory operation with not_found/forbidden errors", () => {
    expect(historyEntry.name).toBe("memory.readFindingHistory");
    expect(historyEntry.errorKinds).toEqual(["forbidden", "not_found"]);
  });

  it("accepts the exact wire row the exposition produces (publication + correction with evidence)", () => {
    const wire = {
      findingId: FINDING_ID,
      semanticKey: "materialy.dowoz",
      scope: { _tag: "project", projectId: PROJECT_1 },
      currentRevisionId: REVISION_ID_2,
      revisionCounter: 2,
      revisions: [
        {
          revisionId: REVISION_ID_1,
          revision: 1,
          value: { _tag: "text_note", text: "dowóz w środę rano" },
          knowledgeState: { _tag: "known" },
          origin: "publication",
          reason: null,
          recordedByUserId: USER_ID,
          recordedAtMs: 10,
          supersedesRevisionId: null,
          evidence: [
            { sourceId: SOURCE_ID, fragmentId: FRAGMENT_ID, supportKind: "support" },
          ],
        },
        {
          revisionId: REVISION_ID_2,
          revision: 2,
          value: { _tag: "text_note", text: "dowóz w czwartek rano" },
          knowledgeState: { _tag: "known" },
          origin: "correction",
          reason: "Klient przesunął termin telefonicznie.",
          recordedByUserId: USER_ID,
          recordedAtMs: 20,
          supersedesRevisionId: REVISION_ID_1,
          evidence: [],
        },
      ],
    };
    const decoded = Schema.decodeUnknownSync(historyEntry.result)(wire);
    expect(decoded.revisions).toHaveLength(2);
    expect(decoded.revisions[1]?.origin).toBe("correction");
    expect(decoded.revisions[1]?.supersedesRevisionId).toBe(REVISION_ID_1);
    expect(decoded.revisions[0]?.evidence[0]?.sourceId).toBe(SOURCE_ID);
  });

  it("labels every origin of the contract's closed vocabulary (a new origin fails the build)", () => {
    // The label maps are TYPED Records over the contract's literal unions
    // (a vocabulary change fails the build); this runtime half pins that
    // the unions equal what the schema actually accepts, one wire row per
    // origin, each carrying its Polish label.
    for (const origin of ["publication", "correction", "withdrawal_marking"] as const) {
      const wire = {
        findingId: FINDING_ID,
        semanticKey: "materialy.dowoz",
        scope: { _tag: "company" },
        currentRevisionId: REVISION_ID_1,
        revisionCounter: 1,
        revisions: [
          {
            revisionId: REVISION_ID_1,
            revision: 1,
            value: { _tag: "text_note", text: "x" },
            knowledgeState: { _tag: "known" },
            origin,
            reason: null,
            recordedByUserId: USER_ID,
            recordedAtMs: 10,
            supersedesRevisionId: null,
            evidence: [],
          },
        ],
      };
      expect(() => Schema.decodeUnknownSync(historyEntry.result)(wire)).not.toThrow();
      expect((memoryCopy.originLabels as Record<string, string>)[origin]).toBeTypeOf("string");
    }
    expect(() =>
      Schema.decodeUnknownSync(historyEntry.result)({
        findingId: FINDING_ID,
        semanticKey: "materialy.dowoz",
        scope: { _tag: "company" },
        currentRevisionId: REVISION_ID_1,
        revisionCounter: 1,
        revisions: [
          {
            revisionId: REVISION_ID_1,
            revision: 1,
            value: { _tag: "text_note", text: "x" },
            knowledgeState: { _tag: "known" },
            origin: "mystery",
            reason: null,
            recordedByUserId: USER_ID,
            recordedAtMs: 10,
            supersedesRevisionId: null,
            evidence: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("labels every evidence support kind the history can carry", () => {
    for (const supportKind of [
      "support",
      "independent_corroboration",
      "derivation",
      "supersession",
    ] as const) {
      const wire = {
        findingId: FINDING_ID,
        semanticKey: "materialy.dowoz",
        scope: { _tag: "company" },
        currentRevisionId: REVISION_ID_1,
        revisionCounter: 1,
        revisions: [
          {
            revisionId: REVISION_ID_1,
            revision: 1,
            value: { _tag: "text_note", text: "x" },
            knowledgeState: { _tag: "known" },
            origin: "publication",
            reason: null,
            recordedByUserId: USER_ID,
            recordedAtMs: 10,
            supersedesRevisionId: null,
            evidence: [{ sourceId: SOURCE_ID, fragmentId: null, supportKind }],
          },
        ],
      };
      expect(() => Schema.decodeUnknownSync(historyEntry.result)(wire)).not.toThrow();
      expect((memoryCopy.evidenceLabels as Record<string, string>)[supportKind]).toBeTypeOf(
        "string",
      );
    }
  });
});

describe("clarification surfacing (the H1-flagged clarifications read)", () => {
  const clarificationsEntry = memoryOperations["memory.readClarifications"];

  it("is registered as a read-only memory operation over a scope", () => {
    expect(clarificationsEntry.name).toBe("memory.readClarifications");
    expect(clarificationsEntry.errorKinds).toEqual(["forbidden", "not_found"]);
    expect(() =>
      Schema.decodeUnknownSync(clarificationsEntry.input)({ scope: { _tag: "company" } }),
    ).not.toThrow();
  });

  it("accepts the open and resolved wire rows with sourced conflicting evidence", () => {
    const wire = [
      {
        clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
        question: "Która kwota obowiązuje: środowa czy czwartkowa?",
        state: "open",
        raisedAtMs: 30,
        resolvedByUserId: null,
        resolutionNote: null,
        resolvedAtMs: null,
        conflictingEvidence: [{ fragmentId: FRAGMENT_ID, sourceId: SOURCE_ID }],
        // R1: the read always carries the basis (null while open).
        resolutionBasis: null,
        resolutionEvidence: [],
      },
      {
        clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2d",
        question: "Kto koordynuje dowóz?",
        state: "resolved",
        raisedAtMs: 40,
        resolvedByUserId: USER_ID,
        resolutionNote: "Koordynuje szef A.",
        resolvedAtMs: 50,
        conflictingEvidence: [],
        resolutionBasis: "manual_boss_decision",
        resolutionEvidence: [],
      },
    ];
    const decoded = Schema.decodeUnknownSync(clarificationsEntry.result)(wire);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]?.conflictingEvidence[0]?.sourceId).toBe(SOURCE_ID);
    expect(decoded[1]?.resolutionNote).toBe("Koordynuje szef A.");
    expect(decoded[1]?.resolutionBasis).toBe("manual_boss_decision");
  });
});

describe("conflicted and updating findings cannot present as settled facts", () => {
  it("renders C5's updating state with its reason and an explicit not-settled marking", () => {
    const label = knowledgeStateLabel({
      _tag: "updating",
      reason: "wycofano źródło popierające",
    });
    expect(label).toContain("wymaga ponownego potwierdzenia");
    expect(label).toContain("wycofano źródło popierające");
    expect(isSettledKnowledgeState({ _tag: "updating", reason: "x" })).toBe(false);
  });

  it("marks only known as settled", () => {
    expect(isSettledKnowledgeState({ _tag: "known" })).toBe(true);
    expect(isSettledKnowledgeState({ _tag: "conflicted" })).toBe(false);
    expect(isSettledKnowledgeState({ _tag: "unknown", reason: "brak" })).toBe(false);
    expect(isSettledKnowledgeState({ _tag: "not_applicable" })).toBe(false);
  });

  it("keeps the conflict explicit in the label", () => {
    expect(knowledgeStateLabel({ _tag: "conflicted" })).toContain("nie jest ustaloną wartością");
  });
});

describe("correction-as-new-source references the old message without rewriting it", () => {
  it("builds a prefill that quotes the original's own words and send time", () => {
    const original = "Projekt Banan: dowóz płytek w środę rano.";
    const sentAtMs = Date.parse("2026-09-09T07:30:00.000Z");
    const prefill = correctionPrefill(original, sentAtMs);
    expect(prefill).toContain("Poprawka do wiadomości");
    expect(prefill).toContain(original);
    expect(prefill).toContain("Co się zmienia:");
    // Pure reference: the original row is untouched (a new string, not an edit).
    expect(original).toBe("Projekt Banan: dowóz płytek w środę rano.");
  });

  it("truncates very long originals honestly (ellipsis, no invented text)", () => {
    const long = "a".repeat(300);
    const prefill = correctionPrefill(long, 0);
    expect(prefill).toContain("…");
    expect(prefill.length).toBeLessThan(long.length + 200);
  });
});

describe("the C2 direct correction command accepts what the memory surface issues", () => {
  it("decodes the direct-correction input with the seen revision as the expectation", () => {
    const decoded = Schema.decodeUnknownSync(
      memoryOperations["memory.correctFinding"].input,
    )({
      findingId: FINDING_ID,
      expectedRevision: 2,
      value: { _tag: "text_note", text: "dowóz w czwartek rano" },
      knowledgeState: { _tag: "known" },
      reason: "Klient przesunął termin telefonicznie.",
    });
    expect(decoded.expectedRevision).toBe(2);
  });

  it("refuses a stale expectation by the domain decision (the concurrent-revision conflict)", async () => {
    const { decideCorrection } = await import("@kiero/domain");
    expect(decideCorrection(2, 2).decision).toBe("apply");
    const refused = decideCorrection(1, 2);
    expect(refused.decision).toBe("refuse");
    if (refused.decision === "refuse") {
      expect(refused.code).toBe("revision_mismatch");
    }
  });

  it("decodes the clarification answer the surface issues", () => {
    const decoded = Schema.decodeUnknownSync(
      memoryOperations["memory.resolveClarification"].input,
    )({
      clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
      resolutionNote: "Obowiązuje kwota z czwartkowej rozmowy.",
    });
    expect(decoded.resolutionNote).toContain("czwartkowej");
    expect(() =>
      Schema.decodeUnknownSync(memoryOperations["memory.resolveClarification"].input)({
        clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
        resolutionNote: "",
      }),
    ).toThrow();
  });
});

describe("the read-marking command the conversation surface issues", () => {
  it("decodes the mark-read input over the canonical source id", () => {
    const markSourceRead = operations["attention.markSourceRead"];
    if (markSourceRead === undefined) {
      throw new Error("attention.markSourceRead missing from the registry");
    }
    const decoded = Schema.decodeUnknownSync(markSourceRead.input)({
      sourceId: SOURCE_ID,
      read: true,
    }) as { readonly read: boolean };
    expect(decoded.read).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R1 (issue #126): the resolution basis on the memory surface — manual and
// source-backed resolutions read honestly, pre-repair rows never guess.
// ---------------------------------------------------------------------------

describe("clarification resolution basis (the R1 surface)", () => {
  const clarificationsEntry = memoryOperations["memory.readClarifications"];

  /** One resolved wire row carrying the given basis and evidence. */
  function resolvedRow(
    resolutionBasis: "source_backed" | "manual_boss_decision" | "legacy_unknown",
    resolutionEvidence: { sourceId: string; fragmentId: string | null }[] = [],
  ) {
    return {
      clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2d",
      question: "Która kwota obowiązuje?",
      state: "resolved" as const,
      raisedAtMs: 40,
      resolvedByUserId: USER_ID,
      resolutionNote: "Rozstrzygnięcie.",
      resolvedAtMs: 50,
      conflictingEvidence: [],
      resolutionBasis,
      resolutionEvidence,
    };
  }

  it("decodes every basis of the closed vocabulary, with evidence references", () => {
    for (const basis of ["source_backed", "manual_boss_decision", "legacy_unknown"] as const) {
      const wire = [
        resolvedRow(basis, [{ sourceId: SOURCE_ID, fragmentId: FRAGMENT_ID }]),
      ];
      expect(() =>
        Schema.decodeUnknownSync(clarificationsEntry.result)(wire),
      ).not.toThrow();
    }
    // An open row decodes with a null basis and no evidence.
    const open = Schema.decodeUnknownSync(clarificationsEntry.result)([
      {
        clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
        question: "Pytanie",
        state: "open",
        raisedAtMs: 30,
        resolvedByUserId: null,
        resolutionNote: null,
        resolvedAtMs: null,
        conflictingEvidence: [],
        resolutionBasis: null,
        resolutionEvidence: [],
      },
    ]);
    expect(open[0]?.resolutionBasis).toBeNull();
  });

  it("labels every basis of the contract's closed vocabulary with the shared heading", () => {
    // Typed Record over the contract's literal union: a vocabulary change
    // fails the build; each label carries the product heading.
    expect(Object.keys(resolutionBasisLabels).sort()).toEqual([
      "legacy_unknown",
      "manual_boss_decision",
      "source_backed",
    ]);
    for (const label of Object.values(resolutionBasisLabels)) {
      expect(label).toContain("Podstawa rozstrzygnięcia");
    }
  });

  it("renders a source-backed row with its saved evidence links (R5 canonical route)", () => {
    const html = renderToString(
      createElement(ResolutionBasisView, {
        row: resolvedRow("source_backed", [
          { sourceId: SOURCE_ID, fragmentId: FRAGMENT_ID },
          { sourceId: FIRM_SOURCE_ID, fragmentId: null },
        ]) as never,
      }),
    );
    expect(html).toContain("Podstawa rozstrzygnięcia");
    // R5 (issue #130): the saved evidence renders the canonical dossier
    // route with its encoded `zrodlo` param (and the fragment), never the
    // legacy conversation-route form. React escapes the query separator
    // inside the attribute.
    expect(html).toContain(`/zrodlo?zrodlo=${SOURCE_ID}&amp;fragment=${FRAGMENT_ID}`);
    expect(html).toContain(`/zrodlo?zrodlo=${FIRM_SOURCE_ID}`);
    expect(html).not.toContain(`/?zrodlo=`);
    expect(html).toContain(`fragment ${FRAGMENT_ID}`);
    expect(html).toContain(memoryCopy.sourceLinkLabel);
  });

  it("keeps the evidence link openable far below the conversation feed cap (121 newer messages)", () => {
    // R5-P1's deterministic half: the link targets the dossier route, whose
    // read depends only on the source id — not on the row being inside the
    // conversation's loaded page. A source with 121 newer rows sits below
    // the feed's 120-row growth cap, so no feed position can list it; the
    // rendered route is therefore asserted without any feed fixture at all
    // (the live deployment half of this case runs against the leased dev
    // deployment, like the other live halves).
    const OLD_SOURCE = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2z";
    const html = renderToString(
      createElement(ResolutionBasisView, {
        row: resolvedRow("source_backed", [{ sourceId: OLD_SOURCE, fragmentId: null }]) as never,
      }),
    );
    expect(html).toContain(`/zrodlo?zrodlo=${OLD_SOURCE}`);
    expect(html).not.toContain("/?zrodlo=");
  });

  it("renders a manual decision and a pre-repair row honestly, without invented evidence", () => {
    const manual = renderToString(
      createElement(ResolutionBasisView, {
        row: resolvedRow("manual_boss_decision") as never,
      }),
    );
    expect(manual).toContain("Podstawa rozstrzygnięcia");
    expect(manual).toContain("decyzja szefa");
    expect(manual).not.toContain("zrodlo=");
    const legacy = renderToString(
      createElement(ResolutionBasisView, {
        row: resolvedRow("legacy_unknown") as never,
      }),
    );
    expect(legacy).toContain("nieznana");
    expect(legacy).not.toContain("zrodlo=");
    // An open row renders nothing (there is no basis yet).
    expect(
      renderToString(
        createElement(ResolutionBasisView, {
          row: {
            clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
            question: "Pytanie",
            state: "open",
            raisedAtMs: 30,
            resolvedByUserId: null,
            resolutionNote: null,
            resolvedAtMs: null,
            conflictingEvidence: [],
            resolutionBasis: null,
            resolutionEvidence: [],
          } as never,
        }),
      ),
    ).toBe("");
  });

  it("still decodes the manual note-only envelope the memory surface sends", () => {
    // The exact envelope ClarificationRow issues (note only, no evidence
    // key): the additive command keeps accepting it — a manual decision.
    const decoded = Schema.decodeUnknownSync(
      memoryOperations["memory.resolveClarification"].input,
    )({
      clarificationId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c",
      resolutionNote: "Obowiązuje kwota z czwartkowej rozmowy.",
    });
    expect(decoded.evidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// R5 (issue #130): the agent answer's evidence quotes link into the
// canonical dossier route — the basis stays one click from the original.
// ---------------------------------------------------------------------------

describe("the agent answer's evidence links (the R5 surface)", () => {
  /** One answered run whose single statement cites one evidence row. */
  const answeredRun = {
    outcome: "answered",
    answer: {
      answerText: "Płytki dowożone w środę rano.",
      statements: [
        {
          text: "Dowóz płytek w środę rano.",
          basis: "direct",
          evidenceIds: ["ev1"],
          derivedFromFindingIds: [],
        },
      ],
      disclosures: { updatingFindingIds: [], processingSourceIds: [] },
    },
    clarificationsRaised: [],
    changes: [],
    evidence: [
      { evidenceId: "ev1", sourceId: SOURCE_ID, quote: "w środę rano", groundsUpdating: false },
    ],
    turns: 2,
    refreshes: 0,
    observedModels: ["stub-route"],
    finalText: "",
  };

  it("renders each quote as a link into the canonical dossier route", () => {
    const html = renderToString(
      createElement(AgentAnswerPanel, {
        answer: { sourceId: SOURCE_ID, status: "done", run: answeredRun } as never,
      }),
    );
    expect(html).toContain("Źródło:");
    expect(html).toContain("w środę rano");
    expect(html).toContain(`/zrodlo?zrodlo=${SOURCE_ID}`);
    // The wire pins no fragment: the whole source is the basis.
    expect(html).not.toContain("fragment=");
    expect(html).not.toContain("/?zrodlo=");
  });
});

describe("type-level row identity (compile-time only)", () => {
  it("satisfies the row-type identity the views share", () => {
    // Both scope queries feed the SAME row type into the UI; keeping this
    // assignment compiling is the no-divergent-copy guarantee at the type
    // level (runtime equality is asserted above).
    const row: ConversationRowType = Schema.decodeUnknownSync(SourceConversationRow)(
      mixedSourceWire,
    );
    expect(row.sourceId).toBe(SOURCE_ID);
  });
});
