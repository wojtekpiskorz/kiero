/**
 * D1 conversation-view dev proofs (guarded by KIERO_PROBE_ENABLED, like the
 * A3 platform probes; shared plumbing lives in
 * convex/sources/probe_shared.ts).
 *
 * Each action resolves the default service session (or an explicitly seeded
 * session) and runs the SAME internal view query the Worker bridge would,
 * so the evidence exercises the real authorization and projection path — no
 * development-auth shortcut, no client-supplied identity.
 */

import { v } from "convex/values";
import { action, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unsupportedError } from "@kiero/runtime";
import {
  probeDisabled,
  probeGuardEnabled,
  resolveProbeSession,
  serviceIdentityUnavailable,
} from "../probe_shared";

/** Company conversation page (guarded; service or seeded session). */
export const probeCompanyConversation = action({
  args: { sessionId: v.optional(v.string()), numItems: v.number(), cursor: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.read.views.companyConversationFor, {
      serviceSessionId: sessionId,
      paginationOpts: { numItems: args.numItems, cursor: args.cursor ?? null },
    });
  },
});

/** Project conversation page (guarded; service or seeded session). */
export const probeProjectConversation = action({
  args: {
    sessionId: v.optional(v.string()),
    projectId: v.id("projects"),
    numItems: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.read.views.projectConversationFor, {
      serviceSessionId: sessionId,
      projectId: args.projectId,
      paginationOpts: { numItems: args.numItems, cursor: args.cursor ?? null },
    });
  },
});

/** One immutable source detail (guarded; service or seeded session). */
export const probeSourceDetail = action({
  args: { sessionId: v.optional(v.string()), sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.read.views.sourceDetailFor, {
      serviceSessionId: sessionId,
      sourceId: args.sourceId,
    });
  },
});

// --- H3 exposition probes (additive, flagged; the same guard) ------------------
//
// The dossier + evidence reads and this lane's own fixture seeds: an image
// OCR fixture (attachment + verified retained representation + completed
// vision order with pixel-anchored observations + fragments) in the E5
// transcript-fixture style — honestly labeled proof rows, never reachable
// as client inputs. Reads stay under KIERO_PROBE_ENABLED; the seeds that
// WRITE rows additionally need this lane's KIERO_H3_PROOF_ENABLED.

/** This lane's own fixture guard (writes labeled proof rows). */
function h3FixturesEnabled(): boolean {
  return process.env.KIERO_H3_PROOF_ENABLED === "1";
}

const h3FixturesDisabled = (): ResultEnvelope =>
  errorResult(unsupportedError("sources.read.probe", "h3_fixtures_disabled"));

/** The full dossier of one source (guarded; service or seeded session). */
export const probeSourceExposition = action({
  args: { sessionId: v.optional(v.string()), sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.read.views.sourceExpositionFor, {
      serviceSessionId: sessionId,
      sourceId: args.sourceId,
    });
  },
});

/** The paginated evidence chain of one source (guarded; service/seeded). */
export const probeSourceEvidence = action({
  args: {
    sessionId: v.optional(v.string()),
    sourceId: v.id("sources"),
    numItems: v.number(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.sources.read.views.sourceEvidenceFor, {
      serviceSessionId: sessionId,
      sourceId: args.sourceId,
      paginationOpts: { numItems: args.numItems, cursor: args.cursor ?? null },
    });
  },
});

/**
 * Seeds the minimal COMPLETED image-OCR fixture for one source (honestly
 * labeled proof rows): an image attachment, a verified RETAINED normalized
 * representation with its own pixel dimensions, the completed vision order
 * with verbatim observations, and the image_region fragments carrying the
 * same regions. This makes the live dossier actually cover OCR evidence
 * and coordinate anchors through the real read path.
 */
export const seedImageOcr = internalMutation({
  args: {
    sourceId: v.id("sources"),
    observations: v.array(
      v.object({
        text: v.string(),
        region: v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() }),
      }),
    ),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const source = await ctx.db.get(args.sourceId);
    if (source === null) {
      return errorResult(forbiddenError("source_not_in_company", "sources"));
    }
    const run = await ctx.db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", args.sourceId))
      .order("desc")
      .first();
    if (run === null) {
      return errorResult(unsupportedError("sources.read.probe", "processing_run_missing"));
    }
    const uploadId = await ctx.db.insert("uploads", {
      companyId: source.companyId,
      userId: source.authorUserId,
      stage: "finalized",
      partCount: 1,
      finalizedAtMs: Date.now(),
      acceptedSourceId: args.sourceId,
      createdAtMs: Date.now(),
    });
    const attachmentId = await ctx.db.insert("attachments", {
      uploadId,
      sourceId: args.sourceId,
      kind: "image",
      objectKey: `h3-proof/${args.sourceId}`,
      createdAtMs: Date.now(),
      completedAtMs: Date.now(),
    });
    // The retained normalized image: verified durable, with its OWN
    // dimensions defining the coordinate space the anchors resolve in, and
    // the r2:etag-prefixed content hash D3's grant resolution reads (the
    // ledger receipt that lets the channel cross-check the live object).
    const representationId = await ctx.db.insert("mediaRepresentations", {
      attachmentId,
      role: "retained",
      objectKey: `h3-proof/${args.sourceId}/retained`,
      contentHash: "r2:etag:h3-proof-retained",
      transformVersion: "h3-proof-vision",
      width: 1024,
      height: 768,
      mimeType: "image/webp",
      bytes: 2048,
      verifiedAtMs: Date.now(),
      createdAtMs: Date.now(),
    });
    const extractionId = await ctx.db.insert("extractions", {
      sourceId: args.sourceId,
      representationId,
      kind: "vision",
      pipelineVersion: "h3-proof-vision",
      model: "proof-vision",
      provider: "kiero-proof",
      processingRunId: run._id,
      createdAtMs: Date.now(),
    });
    const orderId = await ctx.db.insert("visionOrders", {
      companyId: source.companyId,
      sourceId: args.sourceId,
      attachmentId,
      representationId,
      processingRunId: run._id,
      pipelineVersion: "h3-proof-vision",
      visionRoutingVersion: "h3-proof",
      bytesChannel: "proof_inline",
      state: "complete",
      extractionId,
      observationsJson: JSON.stringify(args.observations),
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      finishedAtMs: Date.now(),
    });
    for (const observation of args.observations) {
      await ctx.db.insert("sourceFragments", {
        extractionId,
        sourceId: args.sourceId,
        anchor: { _tag: "image_region", ...observation.region },
        createdAtMs: Date.now(),
      });
    }
    return okResult({ orderId, extractionId, attachmentId, representationId });
  },
});

export const probeSeedImageOcr = action({
  args: {
    sourceId: v.id("sources"),
    observations: v.array(
      v.object({
        text: v.string(),
        region: v.object({ x: v.number(), y: v.number(), width: v.number(), height: v.number() }),
      }),
    ),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled() || !h3FixturesEnabled()) {
      return h3FixturesDisabled();
    }
    return ctx.runMutation(internal.sources.read.probe.seedImageOcr, {
      sourceId: args.sourceId,
      observations: args.observations,
    });
  },
});
