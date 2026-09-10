/**
 * E5 focused tests, part 2: the write transaction's FAILURE path over the
 * in-memory db (the d2 harness; the d5/G3 transaction-test precedent).
 * Round 2 found the failure exits untested at this layer: the pure
 * validators were pinned, but nothing drove recordIndexEntries itself, so
 * a broken failJob (self-recursion) reached the PR while every failure
 * answer the live proof had pinned predates it. These tests execute the
 * real failure path: the durable row must record the SAME closed kind the
 * envelope answers, or the typed refusal has silently become a crash.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recordIndexEntries } from "../../convex/search/records";
import { INDEX_CANDIDATE } from "@kiero/retrieval";
import { asTx, fakeCtx } from "../d2/harness";

let ctx: ReturnType<typeof fakeCtx>;

const tx = () => asTx(ctx);

interface Seeded {
  jobKey: string;
  generationId: string;
  companyId: string;
}

async function seedJobAndGeneration(): Promise<Seeded> {
  const companyId = await ctx.db.insert("companies", {
    name: "e5-records",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: 1,
  });
  // The schema's real shape: no companyId column, providerRouteVersion
  // required (independent review: the fixture must not drift from
  // convex/search/schema.ts, the fake db validates nothing).
  const generationId = await ctx.db.insert("searchIndexGenerations", {
    state: "building",
    embeddingModel: INDEX_CANDIDATE.embeddingModel,
    dimensions: INDEX_CANDIDATE.dimensions,
    textPreparationVersion: INDEX_CANDIDATE.textPreparationVersion,
    providerRouteVersion: "e2.embedding.route.v1",
    createdAtMs: 1,
  });
  const jobKey = "search-index-build:dk-1";
  await ctx.db.insert("durableJobs", {
    jobKey,
    kind: "search.index_generation",
    state: "in_flight",
    inputJson: "{}",
    dedupKey: "dk-1",
    attempts: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  return { jobKey, generationId, companyId };
}

async function jobRow(jobKey: string): Promise<Record<string, unknown>> {
  const row = await ctx.db
    .query("durableJobs")
    .withIndex("by_jobKey", (q) => q.eq("jobKey", jobKey))
    .first();
  if (row === null) {
    throw new Error("job row vanished");
  }
  return row;
}

beforeEach(() => {
  ctx = fakeCtx(["companies", "searchIndexGenerations", "durableJobs", "searchEntries", "outboxEvents"]);
});

describe("recordIndexEntries failure path (round 2)", () => {
  it("a wrong-dimension embedding fails the job with the same kind the envelope answers", async () => {
    const { jobKey, generationId, companyId } = await seedJobAndGeneration();

    const envelope = await recordIndexEntries(tx(), jobKey, [
      {
        generationId,
        companyId,
        sourceId: "k0001ttttttttttttttttttttt",
        preparedText: " szerokość pomieszczenia 3,60 m",
        embedding: [0.1, 0.2],
      },
    ]);

    // The invariant round 2 exposed: the envelope and the durable row
    // answer the SAME closed kind, asserted as one equality.
    expect(envelope._tag).toBe("error");
    const job = await jobRow(jobKey);
    expect(job.state).toBe("failed");
    const code = envelope._tag === "error" ? (envelope.error as { code?: string }).code : null;
    expect(code).toBe("embedding_dimension_mismatch");
    expect(job.lastErrorKind).toBe(code);
  });

  it("a missing generation fails the job and answers the same kind", async () => {
    const { jobKey, companyId } = await seedJobAndGeneration();

    const envelope = await recordIndexEntries(tx(), jobKey, [
      {
        generationId: "k0999ttttttttttttttttttttt",
        companyId,
        sourceId: "k0001ttttttttttttttttttttt",
        preparedText: "tekst",
      },
    ]);

    expect(envelope._tag).toBe("error");
    const job = await jobRow(jobKey);
    expect(job.state).toBe("failed");
    const code = envelope._tag === "error" ? (envelope.error as { code?: string }).code : null;
    expect(code).toBe("generation_not_found");
    expect(job.lastErrorKind).toBe(code);
  });

  it("an unknown job answers job_not_found and touches no row", async () => {
    const envelope = await recordIndexEntries(tx(), "search-index-build:none", []);
    expect(envelope._tag).toBe("error");
  });
});
