/**
 * Index generation lifecycle transactions (E5): start and verified cutover.
 *
 * `search.startIndexGeneration` refuses anything but the pinned initial
 * candidate (model, dimensions, preparation; @kiero/retrieval candidate
 * gate): building a generation from an unproved configuration would mix
 * incompatible vectors later. One generation may build at a time (a second
 * start while one is building is a typed conflict). The generation row, the
 * canonical `search.indexGenerationStarted` event and the durable build job
 * commit atomically (the no-orphan property).
 *
 * `search.cutOverIndexGeneration` is the VERIFIED cutover: the generation
 * must still be building, its build job must have SUCCEEDED (the durable row
 * is the evidence, looked up through the registration's dedup key), and its
 * dimensions must still equal the pinned baseline. Only then does the
 * previous active generation retire and the new one activate atomically, so
 * two generations coexist (building + active) for as long as verification
 * takes and queries keep serving the old one until the switch.
 */

import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { conflictError, notFoundError, type RequestContext } from "@kiero/runtime";
import { INDEX_CANDIDATE, isCompatibleCandidate } from "@kiero/retrieval";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { publishEvent, registerDurableJob } from "../platform/publish";

/** The dedup identity of one generation's build job (the cutover's evidence key). */
export function buildDedupKey(generationId: string): string {
  return `search.index_generation:build:${generationId}`;
}

/** The retry policy of the durable build registration. */
const BUILD_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

/**
 * A build whose external pass died unrecorded (provider window, crash)
 * leaves the generation building and the one-at-a-time gate refusing
 * every later generation forever - the exact uncertain-outcome class the
 * platform protocol reconciles. A building generation whose build job is
 * terminally dead (failed/cancelled/absent) or has not updated within the
 * staleness window retires here (it was never active, so serving is
 * untouched); a fresh or SUCCEEDED build keeps the gate closed (the
 * succeeded-awaiting-cutover coexistence is the designed state).
 */
const STALE_BUILD_JOB_MS = 15 * 60 * 1000;

async function retireInterruptedBuilding(
  tx: MutationCtx,
  building: Doc<"searchIndexGenerations">,
): Promise<boolean> {
  const job = await tx.db
    .query("durableJobs")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", buildDedupKey(building._id)))
    .first();
  const dead =
    job === null ||
    job.state === "failed" ||
    job.state === "cancelled" ||
    ((job.state === "queued" || job.state === "running") &&
      Date.now() - (job.updatedAtMs ?? job.createdAtMs ?? 0) > STALE_BUILD_JOB_MS);
  if (!dead) {
    return false;
  }
  await tx.db.patch(building._id, { state: "retired", retiredAtMs: Date.now() });
  return true;
}

/** Starts one generation: candidate check, building row, event, build job. */
export async function performStartIndexGeneration(
  tx: MutationCtx,
  context: RequestContext,
  input: { embeddingModel: string; textPreparationVersion: string; dimensions: number },
): Promise<ResultEnvelope> {
  const verdict = isCompatibleCandidate(input);
  if (!verdict.ok) {
    return errorResult(conflictError(verdict.reason));
  }
  const building = await tx.db
    .query("searchIndexGenerations")
    .withIndex("by_state", (q) => q.eq("state", "building"))
    .first();
  if (building !== null) {
    const retired = await retireInterruptedBuilding(tx, building);
    if (!retired) {
      return errorResult(conflictError("generation_already_building"));
    }
  }
  const generationId = await tx.db.insert("searchIndexGenerations", {
    embeddingModel: input.embeddingModel,
    textPreparationVersion: input.textPreparationVersion,
    dimensions: input.dimensions,
    providerRouteVersion: INDEX_CANDIDATE.providerRouteVersion,
    state: "building",
    createdAtMs: Date.now(),
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "search.indexGenerationStarted",
    payload: { generationId },
    dedupKey: `search.indexGenerationStarted:${generationId}`,
  });
  await registerDurableJob(tx, {
    kind: "search.index_generation",
    input: { generationId, mode: "build", sourceId: null, findingId: null },
    companyId: context.actor.companyId,
    policy: BUILD_RETRY_POLICY,
    dedupKey: buildDedupKey(generationId),
  });
  return okResult({ generationId });
}

/** The verified cutover: build evidence checked, then the atomic switch. */
export async function performCutOverIndexGeneration(
  tx: MutationCtx,
  context: RequestContext,
  input: { generationId: string },
): Promise<ResultEnvelope> {
  const generationId = tx.db.normalizeId("searchIndexGenerations", input.generationId);
  if (generationId === null) {
    return errorResult(notFoundError("searchIndexGenerations", "generation_id_invalid"));
  }
  const generation = await tx.db.get(generationId);
  if (generation === null) {
    return errorResult(notFoundError("searchIndexGenerations", "generation_not_found"));
  }
  if (generation.state !== "building") {
    return errorResult(conflictError("generation_not_building"));
  }
  if (generation.dimensions !== INDEX_CANDIDATE.dimensions) {
    return errorResult(conflictError("dimensions_not_supported"));
  }
  const buildJob = await tx.db
    .query("durableJobs")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", buildDedupKey(generationId)))
    .first();
  if (buildJob === null || buildJob.state !== "succeeded") {
    // An interrupted or unfinished build never cuts over: the previous
    // active generation (if any) keeps serving until verification passes.
    return errorResult(conflictError("build_not_verified"));
  }
  const active = await tx.db
    .query("searchIndexGenerations")
    .withIndex("by_state", (q) => q.eq("state", "active"))
    .collect();
  for (const current of active) {
    await tx.db.patch(current._id, { state: "retired", retiredAtMs: Date.now() });
  }
  await tx.db.patch(generationId, { state: "active", activatedAtMs: Date.now() });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "search.indexGenerationCutOver",
    payload: { generationId },
    dedupKey: `search.indexGenerationCutOver:${generationId}`,
  });
  return okResult({ generationId });
}

/** Resolves the ACTIVE generation (the query scope; null = coverage degraded). */
export async function activeGenerationId(
  ctx: Pick<QueryCtx, "db">,
): Promise<Id<"searchIndexGenerations"> | null> {
  const active = await ctx.db
    .query("searchIndexGenerations")
    .withIndex("by_state", (q) => q.eq("state", "active"))
    .first();
  return active === null ? null : active._id;
}
