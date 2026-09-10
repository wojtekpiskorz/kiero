/**
 * E4 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable; the D6 pattern — every entry resolves the CALLER's identity
 * from the caller's own verified Convex Auth credential INSIDE the
 * internal function that does the work, because actions carry identity but
 * no database reader).
 *
 * - `probeSeedE4Company`: a fresh proof company with its own user, session
 *   and project (deterministic evidence passes).
 * - `probeCoverageState`: the joined coverage snapshot of one source —
 *   every required input named with its honest status (the aggregate the
 *   evidence asserts on).
 * - `probeJoinState`: the tenant-scoped join inspection — run (versions,
 *   checkpoint), the E4 step journal, model attempts, transcript and
 *   vision order rows, extraction versions, fragments and the join job.
 * - `probeOrderVision`: the vision order transaction as the caller (both
 *   byte channels; the guarded proof channel is sha-pinned to the retained
 *   representation's content hash).
 * - `probeArmVisionUnavailable` / disarm: the deterministic fixture
 *   forcing BOTH vision routes unavailable — the live-proof channel for
 *   "the image pending".
 * - `probeResumeJoin`: the sanctioned bounded resume — re-registering the
 *   join job for one source (a definitely-failed row re-queues).
 * - `probeRestartJoin`: restart a failed join workflow from its journal.
 */

import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import {
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { notFoundError } from "@kiero/runtime";
import { vWorkflowId } from "@convex-dev/workflow";
import { resolveAccessContextFromConvexAuth } from "../../access/identity/resolution";
import { probeDisabled, probeGuardEnabled } from "../../sources/probe_shared";
import { registerDurableJob } from "../../platform/publish";
import { decideJoinedCompleteness, joinCoverage } from "@kiero/agent";
import {
  JOIN_VISION_MARKER_KIND,
  JOIN_MARKER_BASE,
  recordJoinStep,
} from "./journal";
import { loadCoverageSourceView } from "./coverageLoader";
import { orderVisionExtraction } from "./visionOrders";
import { restartJoinWorkflow } from "./join";

/** The read surface the caller resolution needs (query and mutation ctx fit). */
type CallerDb = Parameters<typeof resolveAccessContextFromConvexAuth>[0];
/** The auth surface the caller resolution needs (any Convex ctx fits). */
type CallerAuth = Parameters<typeof resolveAccessContextFromConvexAuth>[1];

/** Resolves the caller's read-side context, or the sanitized refusal. */
async function callerContextOrRefuse(
  db: CallerDb,
  auth: CallerAuth,
): Promise<
  | { ok: true; context: NonNullable<Awaited<ReturnType<typeof resolveAccessContextFromConvexAuth>>> }
  | { ok: false; result: ResultEnvelope }
> {
  const context = await resolveAccessContextFromConvexAuth(db, auth, Date.now());
  if (context === null) {
    return { ok: false, result: errorResult(notFoundError("session")) };
  }
  return { ok: true, context };
}

/** The caller's normalized company id, or the refusal envelope. */
async function callerCompanyId(
  db: CallerDb,
  auth: CallerAuth,
): Promise<
  | { ok: true; companyId: ReturnType<CallerDb["normalizeId"]> }
  | { ok: false; result: ResultEnvelope }
> {
  const resolved = await callerContextOrRefuse(db, auth);
  if (!resolved.ok) {
    return resolved;
  }
  const companyId = db.normalizeId("companies", resolved.context.actor.companyId);
  if (companyId === null) {
    return { ok: false, result: errorResult(notFoundError("companies")) };
  }
  return { ok: true, companyId };
}

// --- fresh proof company -------------------------------------------------------

/** Seeds a fresh proof company with its own user, session and project. */
export const seedE4Company = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const email = `e4-${args.nonce}@kiero.invalid`;
    const companyName = `Kiero E4 proof (${args.nonce})`;
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (existingUser !== null) {
      return errorResult(notFoundError("users", "nonce_already_seeded"));
    }
    const nowMs = Date.now();
    const userId = await ctx.db.insert("users", {
      email,
      displayName: `E4 proof ${args.nonce}`,
      createdAtMs: nowMs,
    });
    const companyId = await ctx.db.insert("companies", {
      name: companyName,
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
      createdAtMs: nowMs,
    });
    await ctx.db.insert("memberships", {
      companyId,
      userId,
      role: "admin",
      state: "active",
      createdAtMs: nowMs,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      startedAtMs: nowMs,
      lastSeenAtMs: nowMs,
      deviceLabel: "e4-proof-bridge",
    });
    const bananId = await ctx.db.insert("projects", {
      companyId,
      displayName: "Banan (E4)",
      stage: "inquiry",
      stageRevision: 1,
      createdAtMs: nowMs,
    });
    return okResult({ companyId, userId, sessionId, bananId });
  },
});

export const probeSeedE4Company = action({
  args: { nonce: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.multimodal.probe.seedE4Company, {
      nonce: args.nonce,
    });
  },
});

// --- the joined coverage inspection ---------------------------------------------

/** The caller-scoped joined coverage of one source (internal, tenant-checked). */
export const coverageOfSourceAsCaller = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerCompanyId(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const source = await ctx.db.get(args.sourceId);
    if (source === null || source.companyId !== resolved.companyId) {
      return errorResult(notFoundError("sources"));
    }
    const view = await loadCoverageSourceView(ctx.db, args.sourceId);
    const snapshot = joinCoverage(view);
    return okResult({
      sourceId: args.sourceId,
      inputs: snapshot.inputs,
      completeness: decideJoinedCompleteness(snapshot),
    });
  },
});

/** The guarded coverage read. */
export const probeCoverageState = action({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.processing.multimodal.probe.coverageOfSourceAsCaller, {
      sourceId: args.sourceId,
    });
  },
});

// --- the join state inspection ---------------------------------------------------

/** The caller-scoped join state (internal query; tenant-checked). */
export const joinStateOfSource = internalQuery({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerCompanyId(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const source = await ctx.db.get(args.sourceId);
    if (source === null || source.companyId !== resolved.companyId) {
      return errorResult(notFoundError("sources"));
    }
    const runs = await ctx.db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", args.sourceId))
      .collect();
    const selected = runs.slice().sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    if (selected === undefined) {
      return errorResult(notFoundError("processingRuns"));
    }
    const steps = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) => q.eq("runId", selected._id))
      .collect();
    const joinSteps = steps
      .filter((row) => row.stepKind.startsWith("e4_"))
      .sort((a, b) => a.sequence - b.sequence)
      .map((row) => ({
        sequence: row.sequence,
        kind: row.stepKind,
        state: row.state,
        output: parseJson(row.outputRef),
      }));
    const modelSteps = steps.filter((row) => row.stepKind === "e4_model_join");
    const attempts = (
      await Promise.all(
        modelSteps.map(async (step) => {
          const rows = await ctx.db
            .query("processingAttempts")
            .withIndex("by_step_attempt", (q) => q.eq("stepId", step._id))
            .collect();
          return rows.map((row) => ({
            model: row.model ?? null,
            outcome: row.outcome,
            errorKind: row.errorKind ?? null,
            latencyMs: (row.finishedAtMs ?? row.startedAtMs) - row.startedAtMs,
          }));
        }),
      )
    ).flat();
    const transcriptOrders = await ctx.db
      .query("audioTranscripts")
      .withIndex("by_source", (q) => q.eq("sourceId", args.sourceId))
      .collect();
    const visionOrders = await ctx.db
      .query("visionOrders")
      .withIndex("by_source", (q) => q.eq("sourceId", args.sourceId))
      .collect();
    const extractions = await ctx.db
      .query("extractions")
      .withIndex("by_source_kind", (q) => q.eq("sourceId", args.sourceId))
      .collect();
    const fragments = await ctx.db
      .query("sourceFragments")
      .withIndex("by_source", (q) => q.eq("sourceId", args.sourceId))
      .collect();
    const view = await loadCoverageSourceView(ctx.db, args.sourceId);
    const snapshot = joinCoverage(view);
    return okResult({
      run: {
        runId: selected._id,
        state: selected.state,
        kind: selected.kind,
        versions: {
          pipeline: selected.pipelineVersion,
          prompt: selected.promptVersion,
          schema: selected.schemaVersion,
          modelConfiguration: selected.modelConfigurationVersion,
        },
        checkpoint: parseJson(selected.checkpoint),
      },
      steps: joinSteps,
      attempts,
      transcripts: transcriptOrders.map((order) => ({
        transcriptId: order._id,
        attachmentId: order.attachmentId,
        state: order.state,
        lastErrorKind: order.lastErrorKind ?? null,
        extractionId: order.extractionId ?? null,
        bytesChannel: order.bytesChannel,
        segmentCount: order.segmentCount,
      })),
      visionOrders: visionOrders.map((order) => ({
        orderId: order._id,
        attachmentId: order.attachmentId,
        representationId: order.representationId,
        state: order.state,
        lastErrorKind: order.lastErrorKind ?? null,
        extractionId: order.extractionId ?? null,
        bytesChannel: order.bytesChannel,
        observations: observationsCountOf(order.observationsJson),
      })),
      extractions: extractions.map((row) => ({
        extractionId: row._id,
        kind: row.kind,
        representationId: row.representationId ?? null,
        model: row.model,
        confidence: row.confidence ?? null,
      })),
      fragments: fragments.map((fragment) => ({
        fragmentId: fragment._id,
        extractionId: fragment.extractionId,
        anchor: fragment.anchor,
      })),
      coverage: { inputs: snapshot.inputs, completeness: decideJoinedCompleteness(snapshot) },
    });
  },
});

/** JSON.parse with a null fallback (never throws on inspection reads). */
function parseJson(value: string | undefined): unknown {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The recorded-observation count of one order row. */
function observationsCountOf(observationsJson: string | undefined): number {
  const parsed = parseJson(observationsJson);
  return Array.isArray(parsed) ? parsed.length : 0;
}

/** The guarded join-state read. */
export const probeJoinState = action({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runQuery(internal.processing.multimodal.probe.joinStateOfSource, {
      sourceId: args.sourceId,
    });
  },
});

// --- the vision order entry (as the caller) ---------------------------------------

export const orderVisionAsCaller = internalMutation({
  args: {
    attachmentId: v.string(),
    bytesChannel: v.string(),
    proofImageBase64: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerContextOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    if (args.bytesChannel !== "media_worker" && args.bytesChannel !== "proof_inline") {
      return errorResult(notFoundError("visionOrders", "probe_malformed_channel"));
    }
    return orderVisionExtraction(ctx, resolved.context, {
      attachmentId: args.attachmentId,
      bytesChannel: args.bytesChannel,
      ...(args.proofImageBase64 === undefined ? {} : { proofImageBase64: args.proofImageBase64 }),
    });
  },
});

/** Orders (or idempotently replays) one vision extraction as the CALLER. */
export const probeOrderVision = action({
  args: {
    attachmentId: v.string(),
    bytesChannel: v.string(),
    proofImageBase64: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.multimodal.probe.orderVisionAsCaller, args);
  },
});

// --- the deterministic vision-unavailable fixture ---------------------------------

/** Arms/disarms the BOTH-ROUTES-UNAVAILABLE marker on one run (internal). */
export const setVisionUnavailable = internalMutation({
  args: { sourceId: v.id("sources"), arm: v.boolean() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerCompanyId(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const source = await ctx.db.get(args.sourceId);
    if (source === null || source.companyId !== resolved.companyId) {
      return errorResult(notFoundError("sources"));
    }
    const runs = await ctx.db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", args.sourceId))
      .collect();
    const initial = runs.slice().sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
    if (initial === undefined) {
      return errorResult(notFoundError("processingRuns"));
    }
    const existing = await ctx.db
      .query("processingSteps")
      .withIndex("by_run_sequence", (q) =>
        q.eq("runId", initial._id).eq("sequence", JOIN_MARKER_BASE),
      )
      .collect();
    const ours = existing.find((row) => row.stepKind === JOIN_VISION_MARKER_KIND);
    if (args.arm && ours === undefined) {
      await ctx.db.insert("processingSteps", {
        runId: initial._id,
        stepKind: JOIN_VISION_MARKER_KIND,
        sequence: JOIN_MARKER_BASE,
        state: "failed",
        outputRef: "armed",
        startedAtMs: Date.now(),
        finishedAtMs: Date.now(),
      });
    }
    if (!args.arm && ours !== undefined) {
      await ctx.db.delete(ours._id);
    }
    return okResult({ armed: args.arm });
  },
});

export const probeArmVisionUnavailable = action({
  args: { sourceId: v.id("sources"), arm: v.boolean() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.multimodal.probe.setVisionUnavailable, {
      sourceId: args.sourceId,
      arm: args.arm,
    });
  },
});

// --- the sanctioned resume + workflow restart --------------------------------------

/** Re-registers the join job for one source (the bounded resume). */
export const resumeJoinForSource = internalMutation({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerContextOrRefuse(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const companyId = ctx.db.normalizeId("companies", resolved.context.actor.companyId);
    const source = await ctx.db.get(args.sourceId);
    if (source === null || companyId === null || source.companyId !== companyId) {
      return errorResult(notFoundError("sources"));
    }
    const runs = await ctx.db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", args.sourceId))
      .collect();
    const initial = runs.slice().sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
    if (initial === undefined) {
      return errorResult(notFoundError("processingRuns"));
    }
    await registerDurableJob(ctx, {
      kind: "processing.join_multimodal",
      input: { sourceId: args.sourceId, processingRunId: null, reanalysisOfRunId: null },
      companyId: source.companyId,
      sourceId: args.sourceId,
      processingRunId: initial._id,
      policy: { maxAttempts: 3, backoffBaseMs: 2_000 },
      dedupKey: `processing.join_multimodal:${args.sourceId}`,
    });
    return okResult({ resumed: true });
  },
});

export const probeResumeJoin = action({
  args: { sourceId: v.id("sources") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.multimodal.probe.resumeJoinForSource, {
      sourceId: args.sourceId,
    });
  },
});

// --- the vision completion diagnostic (guarded, E4-owned) -------------------------

/**
 * Runs ONE vision adapter call over an order's pinned stash and records the
 * SANITIZED completion head (first 240 chars, no image bytes) — the
 * diagnostic for `vision_routes_failed:output_rejected` investigations.
 */
export const probeVisionDiagnostic = action({
  args: { orderId: v.id("visionOrders") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const { runVisionExtraction } = await import("@kiero/providers");
    const { VisionExtractionOutput } = await import("@kiero/agent");
    const { VISION_INSTRUCTION } = await import("./vision");
    const order = await ctx.runQuery(internal.processing.multimodal.vision.visionWork, {
      orderId: args.orderId,
    });
    if (order.order === null || order.order.proofImageBase64 === undefined) {
      return errorResult(notFoundError("visionOrders", "order_or_stash_missing"));
    }
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      return errorResult(notFoundError("env", "provider_key_not_configured"));
    }
    const mimeType = order.representation?.mimeType;
    const mime =
      mimeType === "image/png" || mimeType === "image/jpeg" || mimeType === "image/webp"
        ? mimeType
        : "image/webp";
    const call = await runVisionExtraction({ apiKey }, {
      images: [{ base64: order.order.proofImageBase64, mimeType: mime }],
      instruction: VISION_INSTRUCTION,
      outputSchema: VisionExtractionOutput,
    });
    if (call.outcome.outcome === "failed") {
      // One PLAIN chat turn with the same image: does the deployed runtime
      // get sane TEXT back at all (isolating structured-output issues)?
      const { runChatTurn } = await import("@kiero/providers");
      const plain = await runChatTurn({ apiKey }, {
        messages: [
          {
            role: "user",
            content: [
              { kind: "text", text: "Opisz w jednym zdaniu, co widzisz na tym zdjęciu." },
              { kind: "image", base64: order.order.proofImageBase64, mimeType: mime },
            ],
          },
        ],
      });
      const plainText =
        plain.outcome.outcome === "failed"
          ? `plain_failed:${plain.outcome.failure.kind}`
          : plain.outcome.value.text.slice(0, 240);
      return okResult({
        outcome: "failed",
        kind: call.outcome.failure.kind,
        plainTextHead: plainText,
      });
    }
    const value = call.outcome.value;
    if (!("readConfidence" in value)) {
      // The chat-turn shape: record the sanitized text head.
      const text = "text" in value ? String(value.text) : JSON.stringify(value);
      return okResult({ outcome: "chat_turn", textHead: text.slice(0, 240) });
    }
    return okResult({
      outcome: "decoded",
      readConfidence: value.readConfidence,
      observations: value.observations.length,
    });
  },
});

/** Restarts a failed join workflow from its journal (internal, tenant-checked). */
export const restartJoinAsCaller = internalMutation({
  args: { workflowId: vWorkflowId, from: v.string(), runId: v.id("processingRuns") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const resolved = await callerCompanyId(ctx.db, ctx.auth);
    if (!resolved.ok) {
      return resolved.result;
    }
    const run = await ctx.db.get(args.runId);
    if (run === null || run.companyId !== resolved.companyId) {
      return errorResult(notFoundError("processingRuns"));
    }
    if (args.from !== "evaluate" && args.from !== "model" && args.from !== "group") {
      return errorResult(notFoundError("processingSteps", "unknown_restart_target"));
    }
    await restartJoinWorkflow(ctx, args.workflowId, args.from);
    await recordJoinStep(ctx.db, args.runId, JOIN_MARKER_BASE + 1, "e4_probe_restart", {
      state: "succeeded",
      output: { from: args.from },
    });
    return okResult({ restarted: true });
  },
});

/** The guarded restart entry. */
export const probeRestartJoin = action({
  args: { workflowId: vWorkflowId, from: v.string(), runId: v.id("processingRuns") },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.processing.multimodal.probe.restartJoinAsCaller, {
      workflowId: args.workflowId,
      from: args.from,
      runId: args.runId,
    });
  },
});
