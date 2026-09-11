/**
 * J2 flagged cross-lane repair (E5's generation lock): a build whose
 * external pass died unrecorded leaves the generation building forever and
 * the one-at-a-time gate refuses every later generation (observed live on
 * dev/j2 after a provider window killed runIndexPass between the job going
 * running and recordEntries). Drives the REAL performStartIndexGeneration
 * over the in-memory db (the d2 harness) through the four gate cases.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { performStartIndexGeneration, STALE_BUILD_JOB_MS } from "../../convex/search/generations";
import { EMBED_HEARTBEAT_BATCH } from "../../convex/search/executor";
import { EMBEDDING_ATTEMPT_DEADLINE_MS } from "@kiero/providers";

import { asTx, fakeCtx } from "../d2/harness";

describe("the liveness arithmetic (heartbeat vs staleness window)", () => {
  it("keeps a heartbeating pass inside the window even at the worst per-attempt deadline", () => {
    // The liveness guarantee is this inequality: two full batches at the
    // worst-case per-attempt deadline must stay under the staleness
    // window, or a live whole-corpus pass gets retired again (round 2).
    expect(EMBED_HEARTBEAT_BATCH * EMBEDDING_ATTEMPT_DEADLINE_MS * 2).toBeLessThan(STALE_BUILD_JOB_MS);
  });
});


let ctx: ReturnType<typeof fakeCtx>;

const tx = () => asTx(ctx);

const COMPANY = "k0001ttttttttttttttttttttt";

interface Seeded {
  readonly generationId: string;
}

/** One building generation plus its build job in the given state. */
async function seedBuilding(job: {
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly updatedAtMs: number;
  /** The job's start time (the pass's total age, which the gate must NOT read). */
  readonly createdAtMs?: number;
}): Promise<Seeded> {
  const companyId = await ctx.db.insert("companies", {
    name: "j2-stale-generation",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: 1,
  });
  const generationId = await ctx.db.insert("searchIndexGenerations", {
    state: "building",
    embeddingModel: "qwen/qwen3-embedding-8b",
    textPreparationVersion: "e5.fold.v1",
    dimensions: 4096,
    providerRouteVersion: "e2.embedding.route.v1",
    createdAtMs: 1,
  });
  await ctx.db.insert("durableJobs", {
    jobKey: `search.index_generation:build:${generationId}`,
    kind: "search.index_generation",
    state: job.state,
    inputJson: "{}",
    dedupKey: `search.index_generation:build:${generationId}`,
    attempts: 1,
    maxAttempts: 3,
    createdAtMs: job.createdAtMs ?? 1,
    updatedAtMs: job.updatedAtMs,
  });
  void companyId;
  return { generationId };
}

async function start(): Promise<unknown> {
  return await performStartIndexGeneration(tx() as never, {
    actor: { companyId: COMPANY, userId: COMPANY },
  } as never, {
    embeddingModel: "qwen/qwen3-embedding-8b",
    textPreparationVersion: "e5.fold.v1",
    dimensions: 4096,
  });
}

beforeEach(() => {
  ctx = fakeCtx([
    "companies",
    "searchIndexGenerations",
    "durableJobs",
    "outboxEvents",
    "searchEntries",
  ]);
});

describe("the interrupted-build reconciliation (the dev/j2 stuck lock)", () => {
  it("retires the building generation when its build job terminally failed", async () => {
    await seedBuilding({ state: "failed", updatedAtMs: Date.now() });

    const started = await start();

    expect(started).toMatchObject({ _tag: "ok" });
    const states = ctx.db
      .rows("searchIndexGenerations")
      .map((row) => row.state)
      .sort();
    expect(states).toEqual(["building", "retired"]);
  });

  it("retires the building generation when the running job went stale", async () => {
    await seedBuilding({ state: "running", updatedAtMs: Date.now() - 16 * 60 * 1000 });

    const started = await start();

    expect(started).toMatchObject({ _tag: "ok" });
    expect(ctx.db.rows("searchIndexGenerations").some((row) => row.state === "retired")).toBe(true);
  });

  it("keeps the gate closed for a fresh running build", async () => {
    await seedBuilding({ state: "running", updatedAtMs: Date.now() });

    const started = await start();

    expect(started).toMatchObject({ _tag: "error" });
    expect(ctx.db.rows("searchIndexGenerations")).toHaveLength(1);
  });

  it("keeps the gate closed for a long-running build whose pass heartbeats within the window", async () => {
    // A whole-corpus embed pass legitimately outlasts the staleness
    // window; runIndexPass heartbeats the job row per embedded batch, so
    // the window must mean NO PROGRESS, not total age. This job STARTED
    // 20 minutes ago (past the window) but its last heartbeat landed
    // 5 minutes ago: the pass is alive and the gate stays closed.
    await seedBuilding({
      state: "running",
      updatedAtMs: Date.now() - 5 * 60 * 1000,
      createdAtMs: Date.now() - 20 * 60 * 1000,
    });

    const started = await start();

    expect(started).toMatchObject({ _tag: "error" });
    expect(ctx.db.rows("searchIndexGenerations")).toHaveLength(1);
  });

  it("keeps the gate closed for a succeeded build awaiting cutover (the designed coexistence)", async () => {
    await seedBuilding({ state: "succeeded", updatedAtMs: Date.now() - 60 * 60 * 1000 });

    const started = await start();

    expect(started).toMatchObject({ _tag: "error" });
    expect(ctx.db.rows("searchIndexGenerations")).toHaveLength(1);
  });
});
