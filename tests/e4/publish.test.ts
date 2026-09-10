/**
 * E4 focused verification, part 4: the publish transaction over the
 * in-memory Convex emulation (the D6 precedent of driving the REAL
 * transaction functions without a deployment).
 *
 * Proven here:
 * - a media-waiting group is recorded pending_segments and publishes
 *   NOTHING (no fragment, no C2 call);
 * - the fresh-coverage gate refuses a group whose evidence extraction is
 *   no longer a complete input (a mid-run re-normalization must never move
 *   coordinates beneath a publishing finding);
 * - a foreign-source (cross-tenant) extraction id is a TYPED refusal;
 * - an image region outside the pinned representation's coordinate space
 *   is a TYPED refusal (region_outside_representation);
 * - a WELL-FORMED image-grounded group mints fragments with the EXACT
 *   region coordinates of the LocatedEvidence wire (one flat shape: the
 *   evidence carries the fragment-anchor fields verbatim, so a mismatch
 *   cannot arise between the two);
 * - TWO completed vision orders over one representation (the round-2
 *   version-pairing case): the loader pins the NEWEST order's observations
 *   to that order's OWN extraction id, the coverage selects the same
 *   newest version (the older marked replaced), the fresh gate accepts a
 *   newest-pinned group and fragments mint on the newest extraction, while
 *   an older-pinned group is honestly refused;
 * - re-running the transaction is idempotent per (run, sequence, kind):
 *   the fragment is ensured, never duplicated.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { publishJoinGroupTransaction } from "../../convex/processing/multimodal/publish";
import {
  loadCompletedVisionObservations,
  loadCoverageSourceView,
} from "../../convex/processing/multimodal/coverageLoader";
import { JOIN_GROUP_BASE } from "../../convex/processing/multimodal/journal";
import { asReaderDb, asTx, fakeCtx, type FakeCtx } from "../d2/harness";

const TABLES = [
  "companies",
  "users",
  "sessions",
  "memberships",
  "sources",
  "processingRuns",
  "processingSteps",
  "processingAttempts",
  "extractions",
  "sourceFragments",
  "uploads",
  "attachments",
  "mediaRepresentations",
  "projects",
  "visionOrders",
  "audioTranscripts",
  "audioSegments",
  "findings",
  "changeSets",
  "findingRevisions",
];

let ctx: FakeCtx;
/** The seeded mixed source's ids (company scope, one image attachment). */
let seed: {
  companyId: string;
  sourceId: string;
  runId: string;
  attachmentId: string;
  representationId: string;
  visionExtractionId: string;
  textExtractionId: string;
};

const REGION = { x: 40, y: 60, width: 300, height: 80 };
const SPACE = { width: 1_200, height: 900 };

/** The company-scoped image-grounded group the publish stage receives. */
function imageGroup(evidenceRegion = REGION, extractionId = seed.visionExtractionId) {
  return {
    key: { kind: "company", projectId: null },
    proposals: [
      {
        intent: "record",
        semanticKey: "kwota_ze_zdjecia",
        evidence: [
          {
            _tag: "image_region",
            observationId: `obs:${seed.representationId}:0`,
            ...evidenceRegion,
            representationId: seed.representationId,
            extractionId,
          },
        ],
        replacesFindingId: null,
        derivesFromFindingIds: [],
        readConfidence: 0.9,
        valueWire: { _tag: "text_note", text: "12 400" },
      },
    ],
    analysisRevisions: [],
    waitForMedia: false,
  };
}

beforeEach(async () => {
  ctx = fakeCtx(TABLES);
  const companyId = await ctx.db.insert("companies", {
    name: "c",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: Date.now(),
  });
  const userId = await ctx.db.insert("users", {
    email: "e4@kiero.invalid",
    createdAtMs: Date.now(),
  });
  const sourceId = await ctx.db.insert("sources", {
    companyId,
    authorUserId: userId,
    authorText: "Faktura na zdjęciu.",
    sentAtMs: Date.now(),
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: Date.now(),
    lifecycle: "active",
  });
  const runId = await ctx.db.insert("processingRuns", {
    companyId,
    sourceId,
    kind: "initial_analysis",
    pipelineVersion: "e3.plan/1",
    promptVersion: "e3.prompt-pl/1",
    schemaVersion: "e3.schema/1",
    modelConfigurationVersion: "e3.model/1",
    state: "running",
    startedAtMs: Date.now(),
  });
  const uploadId = await ctx.db.insert("uploads", {
    companyId,
    state: "finalized",
    createdAtMs: Date.now(),
  });
  const attachmentId = await ctx.db.insert("attachments", {
    uploadId,
    kind: "image",
    sourceId,
    createdAtMs: Date.now(),
  });
  const representationId = await ctx.db.insert("mediaRepresentations", {
    attachmentId,
    role: "retained",
    objectKey: "companies/x/retained.webp",
    contentHash: "sha256:ab".padEnd(71, "0"),
    transformVersion: "d5.normalize/1",
    width: SPACE.width,
    height: SPACE.height,
    mimeType: "image/webp",
    verifiedAtMs: Date.now(),
    createdAtMs: Date.now(),
  });
  const textExtractionId = await ctx.db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: "d1.accept/1",
    model: "none",
    provider: "none",
    processingRunId: runId,
    createdAtMs: Date.now(),
  });
  const visionExtractionId = await ctx.db.insert("extractions", {
    sourceId,
    representationId,
    kind: "vision",
    pipelineVersion: "e4.vision/1",
    model: "z-ai/glm-5.3-flash",
    provider: "openrouter",
    processingRunId: runId,
    createdAtMs: Date.now(),
  });
  // The COMPLETED vision order over the retained representation (the
  // coverage loader's source of observations).
  await ctx.db.insert("visionOrders", {
    companyId,
    sourceId,
    attachmentId,
    representationId,
    processingRunId: runId,
    pipelineVersion: "e4.vision/1",
    visionRoutingVersion: "e2.0",
    bytesChannel: "proof_inline",
    state: "complete",
    extractionId: visionExtractionId,
    observationsJson: JSON.stringify([
      { text: "12 400", region: REGION },
    ]),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    finishedAtMs: Date.now(),
  });
  // NOTE: no session row for the author — the C2 dispatch section then
  // refuses actor_session_unavailable AFTER fragments were minted, which is
  // exactly the assertion point for the anchor shapes (the full C2 path is
  // the live proof's territory).
  seed = {
    companyId,
    sourceId,
    runId,
    attachmentId,
    representationId,
    visionExtractionId,
    textExtractionId,
  };
});

const publish = (group: unknown, index = 0) =>
  publishJoinGroupTransaction(asTx(ctx), {
    runId: seed.runId as never,
    index,
    group,
  });

/** The step outcome payload of one publish call. */
async function stepOutput(index = 0): Promise<Record<string, unknown>> {
  const rows = await ctx.db
    .query("processingSteps")
    .withIndex("by_run_sequence", (q) =>
      q.eq("runId", seed.runId).eq("sequence", JOIN_GROUP_BASE + index),
    )
    .collect();
  const ours = rows.find((row) => row.stepKind === "e4_publish_group");
  expect(ours).toBeDefined();
  return JSON.parse(String(ours?.outputRef ?? "{}")) as Record<string, unknown>;
}

describe("the publish transaction's partial-safe refusals", () => {
  it("a media-waiting group records pending_segments and mints NOTHING", async () => {
    const result = await publish({ ...imageGroup(), waitForMedia: true });
    expect(result).toMatchObject({ _tag: "ok" });
    const output = await stepOutput();
    expect(output.outcome).toBe("pending_segments");
    expect(ctx.db.rows("sourceFragments")).toHaveLength(0);
  });

  it("a fresh-coverage regression (a mid-run re-normalization) refuses the group", async () => {
    // A NEWER verified retained representation appears (transform version
    // precedence): the deterministic selection moves to it, the pinned
    // vision extraction becomes superseded for the CURRENT pixels, and the
    // fresh coverage no longer reports the image input complete — the group
    // waits for a re-join over the new representation instead of publishing
    // anchors whose coordinate space silently moved.
    const newerRepresentation = await ctx.db.insert("mediaRepresentations", {
      attachmentId: seed.attachmentId,
      role: "retained",
      objectKey: "companies/x/retained-v2.webp",
      contentHash: "sha256:cd".padEnd(71, "0"),
      transformVersion: "d5.normalize/2",
      width: SPACE.width,
      height: SPACE.height,
      mimeType: "image/webp",
      verifiedAtMs: Date.now(),
      createdAtMs: Date.now(),
    });
    expect(newerRepresentation).not.toBe(seed.representationId);
    const result = await publish(imageGroup());
    expect(result).toMatchObject({ _tag: "ok" });
    const output = await stepOutput();
    expect(output.outcome).toBe("pending_segments");
    expect(output.fresh).toBe(true);
    expect(ctx.db.rows("sourceFragments")).toHaveLength(0);
  });

  it("a foreign-source extraction id never publishes (the injection is refused with nothing minted)", async () => {
    // A vision extraction belonging to ANOTHER source (the injection the
    // focused verification asks for). The fresh-coverage gate catches it
    // FIRST: no complete input carries that extraction id, so the group is
    // refused as pending-claiming — never published, no fragment minted.
    // (The per-evidence `extraction_not_in_source` check in the loop below
    // the gate is the second line for journal-replayed shapes; from a
    // self-consistent DB state the gate is the authority by construction.)
    const otherCompanyId = await ctx.db.insert("companies", {
      name: "other",
      createdAtMs: Date.now(),
    });
    const otherSource = await ctx.db.insert("sources", {
      companyId: otherCompanyId,
      authorUserId: "k0user0user0user0user0user00",
      authorText: "x",
      sentAtMs: Date.now(),
      sentAtTimezone: "Europe/Warsaw",
      fullyAcceptedAtMs: Date.now(),
      lifecycle: "active",
    });
    const foreignExtraction = await ctx.db.insert("extractions", {
      sourceId: otherSource,
      representationId: seed.representationId,
      kind: "vision",
      pipelineVersion: "e4.vision/1",
      model: "z-ai/glm-5.3-flash",
      provider: "openrouter",
      processingRunId: seed.runId,
      createdAtMs: Date.now(),
    });
    const group = imageGroup();
    const evidence = group.proposals[0]?.evidence[0];
    if (evidence === undefined) {
      throw new Error("fixture evidence missing");
    }
    (evidence as { extractionId: string }).extractionId = foreignExtraction;
    const result = await publish(group);
    expect(result).toMatchObject({ _tag: "ok" });
    const output = await stepOutput();
    expect(output.outcome).toBe("pending_segments");
    expect(output.fresh).toBe(true);
    expect(ctx.db.rows("sourceFragments")).toHaveLength(0);
  });

  it("an image region outside the representation's own space is a typed refusal", async () => {
    // The region crosses the pinned representation's right edge
    // (1200x900): 1000+400 > 1200.
    const result = await publish(imageGroup({ x: 1_000, y: 0, width: 400, height: 100 }));
    expect(result).toMatchObject({ _tag: "ok" });
    const output = await stepOutput();
    expect(output.outcome).toBe("failed");
    expect(output.error).toBe("image_region_invalid:region_outside_representation");
    expect(ctx.db.rows("sourceFragments")).toHaveLength(0);
  });
});

describe("the publish transaction's anchor minting (the wire-shape regression)", () => {
  it("a well-formed image-grounded group mints fragments with the EXACT region coordinates", async () => {
    await publish(imageGroup());
    // The C2 section refuses (no author session in the fixture) — but the
    // fragments were already minted with the exact coordinates.
    const output = await stepOutput();
    expect(output.outcome).toBe("failed");
    expect(output.error).toBe("actor_session_unavailable");
    const fragments = ctx.db.rows("sourceFragments");
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({
      extractionId: seed.visionExtractionId,
      sourceId: seed.sourceId,
      anchor: { _tag: "image_region", ...REGION },
    });
  });

  it("replaying the same group ENSURES the fragment instead of duplicating it", async () => {
    await publish(imageGroup());
    await publish(imageGroup());
    const fragments = ctx.db.rows("sourceFragments");
    expect(fragments).toHaveLength(1);
  });
});

describe("the vision version pairing: two completed orders over one representation", () => {
  const NEWEST_REGION = { x: 50, y: 70, width: 280, height: 90 };

  /**
   * Seeds the round-2 divergence case: the proof order (the beforeEach
   * seed) was created and completed FIRST; this LATER media_worker order
   * completes last, so newest-by-finishedAtMs and first-created point at
   * DIFFERENT orders.
   */
  async function seedNewerCompletedOrder(): Promise<string> {
    const newestExtractionId = await ctx.db.insert("extractions", {
      sourceId: seed.sourceId,
      representationId: seed.representationId,
      kind: "vision",
      pipelineVersion: "e4.vision/1",
      model: "z-ai/glm-5.3-flash",
      provider: "openrouter",
      processingRunId: seed.runId,
      createdAtMs: Date.now() + 5_000,
    });
    await ctx.db.insert("visionOrders", {
      companyId: seed.companyId,
      sourceId: seed.sourceId,
      attachmentId: seed.attachmentId,
      representationId: seed.representationId,
      processingRunId: seed.runId,
      pipelineVersion: "e4.vision/1",
      visionRoutingVersion: "e2.0",
      bytesChannel: "media_worker",
      state: "complete",
      extractionId: newestExtractionId,
      observationsJson: JSON.stringify([{ text: "12 900", region: NEWEST_REGION }]),
      createdAtMs: Date.now() + 4_000,
      updatedAtMs: Date.now() + 5_000,
      finishedAtMs: Date.now() + 5_000,
    });
    return newestExtractionId;
  }

  it("the loader returns the NEWEST order's observations pinned to that order's OWN extraction", async () => {
    const newestExtractionId = await seedNewerCompletedOrder();
    const db = asReaderDb(ctx);
    const view = await loadCoverageSourceView(db, seed.sourceId as never);
    const observations = await loadCompletedVisionObservations(db, view);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      observationId: `obs:${seed.representationId}:0`,
      extractionId: newestExtractionId,
      text: "12 900",
      x: NEWEST_REGION.x,
      y: NEWEST_REGION.y,
      width: NEWEST_REGION.width,
      height: NEWEST_REGION.height,
    });
  });

  it("a newest-pinned group passes the fresh gate and mints its fragment on the NEWEST extraction", async () => {
    const newestExtractionId = await seedNewerCompletedOrder();
    const result = await publish(imageGroup(NEWEST_REGION, newestExtractionId));
    expect(result).toMatchObject({ _tag: "ok" });
    const output = await stepOutput();
    // Past the fresh gate: the coverage selects the NEWEST completed
    // version (the older marked replaced) and the evidence pin agrees. The
    // C2 section then refuses (no author session in the fixture) AFTER the
    // fragment was minted, which is exactly the assertion point.
    expect(output.outcome).toBe("failed");
    expect(output.error).toBe("actor_session_unavailable");
    const fragments = ctx.db.rows("sourceFragments");
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({
      extractionId: newestExtractionId,
      sourceId: seed.sourceId,
      anchor: { _tag: "image_region", ...NEWEST_REGION },
    });
  });

  it("a group still pinned to the SUPERSEDED extraction is refused pending (the re-join trigger)", async () => {
    await seedNewerCompletedOrder();
    const result = await publish(imageGroup());
    expect(result).toMatchObject({ _tag: "ok" });
    const output = await stepOutput();
    expect(output.outcome).toBe("pending_segments");
    expect(output.fresh).toBe(true);
    expect(ctx.db.rows("sourceFragments")).toHaveLength(0);
  });
});
