/**
 * The index-write authority (E5): the one transactional path derived search
 * rows are written or deleted through.
 *
 * Every write re-validates against the generation it claims:
 * - the generation's dimensions must equal the pinned initial candidate's
 *   (4096): a generation that disagrees with the baseline is incompatible
 *   and refuses all writes;
 * - every embedding must be a non-empty, finite, exactly-generation-
 *   dimensioned vector. A wrong-dimension or malformed vector FAILS THE
 *   INDEX WRITE (issue #39 focused verification): nothing from the batch
 *   commits, the job records the typed failure, and incompatible vectors
 *   are never mixed into one index;
 * - every row's tenant linkage is re-checked against the canonical record
 *   (source/fragment/finding ownership), so no write can plant a row that
 *   hydrates into another company.
 *
 * Rows without embeddings commit: during an embedding outage the index
 * still serves full-text retrieval and the query-side coverage literal
 * discloses the semantic gap (never a silent claim).
 */

import { v } from "convex/values";
import { INDEX_CANDIDATE } from "@kiero/retrieval";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { validationError } from "@kiero/runtime";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/** One index write row as it crosses the action-to-mutation boundary. */
export interface IndexRowInput {
  generationId: string;
  companyId: string;
  sourceFragmentId?: string;
  sourceId?: string;
  findingId?: string;
  findingRevisionId?: string;
  preparedText: string;
  embedding?: number[];
}

/** The typed verdict of the pure write validation (unit-pinned in tests/e5). */
export type WriteVerdict = { readonly ok: true } | { readonly ok: false; readonly errorKind: WriteErrorKind };

export type WriteErrorKind =
  | "generation_dimensions_incompatible"
  | "embedding_dimension_mismatch"
  | "embedding_not_finite"
  | "prepared_text_empty";

/** Validates one embedding against the generation it claims (pure). */
export function validateEmbeddingForGeneration(
  generationDimensions: number,
  embedding: readonly number[],
): WriteVerdict {
  if (generationDimensions !== INDEX_CANDIDATE.dimensions) {
    return { ok: false, errorKind: "generation_dimensions_incompatible" };
  }
  if (embedding.length !== generationDimensions) {
    return { ok: false, errorKind: "embedding_dimension_mismatch" };
  }
  if (embedding.some((value) => !Number.isFinite(value))) {
    return { ok: false, errorKind: "embedding_not_finite" };
  }
  return { ok: true };
}

/** Validates one row's prepared text (pure). */
export function validatePreparedText(preparedText: string): WriteVerdict {
  if (preparedText.trim() === "") {
    return { ok: false, errorKind: "prepared_text_empty" };
  }
  return { ok: true };
}

interface JobLike {
  readonly _id: Id<"durableJobs">;
  readonly state: string;
}

/** Patches the job row's terminal outcome (the echo outcome-recording shape). */
async function completeJob(
  tx: MutationCtx,
  job: JobLike,
  outcome: { readonly state: "succeeded" | "failed"; readonly errorKind?: string },
): Promise<void> {
  await tx.db.patch(job._id, {
    state: outcome.state,
    ...(outcome.state === "succeeded"
      ? { externalOutcome: "succeeded" as const }
      : { externalOutcome: "failed" as const }),
    ...(outcome.errorKind === undefined ? {} : { lastErrorKind: outcome.errorKind }),
    updatedAtMs: Date.now(),
    finishedAtMs: Date.now(),
  });
}

/**
 * Fails the job and answers the envelope with the SAME closed kind, so the
 * durable row and the caller's error can never diverge.
 */
async function failJob(
  tx: MutationCtx,
  job: JobLike,
  kind: string,
): Promise<ResultEnvelope> {
  await completeJob(tx, job, { state: "failed", errorKind: kind });
  return errorResult(validationError(kind));
}

/**
 * Writes one batch of validated rows for a job: all rows validate FIRST
 * (nothing commits on any failure), then each writes idempotently.
 */
export async function recordIndexEntries(
  tx: MutationCtx,
  jobKey: string,
  rows: readonly IndexRowInput[],
): Promise<ResultEnvelope> {
  const job = await tx.db
    .query("durableJobs")
    .withIndex("by_jobKey", (q) => q.eq("jobKey", jobKey))
    .first();
  if (job === null) {
    return errorResult(validationError("job_not_found"));
  }
  if (job.state === "succeeded" || job.state === "cancelled") {
    return okResult({ written: 0, patched: 0, skipped: 0, replay: true });
  }
  const generationIds = new Set(rows.map((row) => row.generationId));
  const generations = new Map<string, Doc<"searchIndexGenerations">>();
  for (const generationId of generationIds) {
    const normalized = tx.db.normalizeId("searchIndexGenerations", generationId);
    const generation = normalized === null ? null : await tx.db.get(normalized);
    if (generation === null) {
      return failJob(tx, job, "generation_not_found");
    }
    if (generation.state === "retired") {
      return failJob(tx, job, "generation_retired");
    }
    generations.set(generationId, generation);
  }
  // Validate everything first: a wrong-dimension vector fails the WHOLE
  // write, never a partial commit.
  for (const row of rows) {
    const generation = generations.get(row.generationId);
    if (generation === undefined) {
      return failJob(tx, job, "generation_not_found");
    }
    const textVerdict = validatePreparedText(row.preparedText);
    if (!textVerdict.ok) {
      return failJob(tx, job, textVerdict.errorKind);
    }
    if (row.embedding !== undefined) {
      const verdict = validateEmbeddingForGeneration(generation.dimensions, row.embedding);
      if (!verdict.ok) {
        return failJob(tx, job, verdict.errorKind);
      }
    }
  }
  // Canonical tenant re-checks per row, then idempotent writes.
  let written = 0;
  let patched = 0;
  let skipped = 0;
  for (const row of rows) {
    const companyId = tx.db.normalizeId("companies", row.companyId);
    if (companyId === null) {
      return failJob(tx, job, "company_id_invalid");
    }
    const generationId = tx.db.normalizeId("searchIndexGenerations", row.generationId);
    if (generationId === null) {
      return failJob(tx, job, "generation_id_invalid");
    }
    if (row.findingId !== undefined) {
      const findingId = tx.db.normalizeId("findings", row.findingId);
      const finding = findingId === null ? null : await tx.db.get(findingId);
      if (finding === null || finding.companyId !== companyId) {
        return failJob(tx, job, "finding_tenant_mismatch");
      }
      if (row.findingRevisionId === undefined) {
        return failJob(tx, job, "finding_revision_missing");
      }
      const revisionId = tx.db.normalizeId("findingRevisions", row.findingRevisionId);
      const revision = revisionId === null ? null : await tx.db.get(revisionId);
      if (revision === null || revision.findingId !== finding._id) {
        return failJob(tx, job, "finding_revision_mismatch");
      }
      const existing = await tx.db
        .query("searchEntries")
        .withIndex("by_finding", (q) => q.eq("findingId", finding._id))
        .collect();
      const mine = existing.filter((entry) => entry.generationId === generationId);
      const same = mine.find((entry) => entry.findingRevisionId === revision._id);
      if (same !== undefined) {
        if (same.embedding === undefined && row.embedding !== undefined) {
          await tx.db.patch(same._id, { embedding: row.embedding });
          patched += 1;
        } else {
          skipped += 1;
        }
        continue;
      }
      for (const stale of mine) {
        await tx.db.delete(stale._id);
      }
      await tx.db.insert("searchEntries", {
        companyId,
        generationId,
        findingId: finding._id,
        findingRevisionId: revision._id,
        preparedText: row.preparedText,
        ...(row.embedding === undefined ? {} : { embedding: row.embedding }),
        createdAtMs: Date.now(),
      });
      written += 1;
      continue;
    }
    const sourceId =
      row.sourceId === undefined ? null : tx.db.normalizeId("sources", row.sourceId);
    const source = sourceId === null ? null : await tx.db.get(sourceId);
    if (source === null || source.companyId !== companyId) {
      return failJob(tx, job, "source_tenant_mismatch");
    }
    const fragmentId =
      row.sourceFragmentId === undefined
        ? null
        : tx.db.normalizeId("sourceFragments", row.sourceFragmentId);
    const fragment = fragmentId === null ? null : await tx.db.get(fragmentId);
    if (fragment !== null && fragment.sourceId !== source._id) {
      return failJob(tx, job, "fragment_source_mismatch");
    }
    if (fragmentId !== null) {
      const existing = await tx.db
        .query("searchEntries")
        .withIndex("by_fragment", (q) => q.eq("sourceFragmentId", fragmentId))
        .collect();
      const same = existing.find((entry) => entry.generationId === generationId);
      if (same !== undefined) {
        if (same.embedding === undefined && row.embedding !== undefined) {
          await tx.db.patch(same._id, { embedding: row.embedding });
          patched += 1;
        } else {
          skipped += 1;
        }
        continue;
      }
    }
    await tx.db.insert("searchEntries", {
      companyId,
      generationId,
      ...(fragmentId === null ? {} : { sourceFragmentId: fragmentId }),
      sourceId: source._id,
      preparedText: row.preparedText,
      ...(row.embedding === undefined ? {} : { embedding: row.embedding }),
      createdAtMs: Date.now(),
    });
    written += 1;
  }
  await completeJob(tx, job, { state: "succeeded" });
  return okResult({ written, patched, skipped, replay: false });
}

/** Deletes every derived row of one source (the withdrawal/purge refresh). */
export async function deleteSourceEntries(tx: MutationCtx, sourceId: Id<"sources">): Promise<number> {
  const rows = await tx.db
    .query("searchEntries")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  for (const row of rows) {
    await tx.db.delete(row._id);
  }
  return rows.length;
}

/** Deletes every derived row of one finding (the revision refresh's first half). */
export async function deleteFindingEntries(tx: MutationCtx, findingId: Id<"findings">): Promise<number> {
  const rows = await tx.db
    .query("searchEntries")
    .withIndex("by_finding", (q) => q.eq("findingId", findingId))
    .collect();
  for (const row of rows) {
    await tx.db.delete(row._id);
  }
  return rows.length;
}

/** The callable transactional write entry (the embedding action's target). */
export const recordEntries = internalMutation({
  args: { jobKey: v.string(), rows: v.array(v.any()) },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    recordIndexEntries(ctx, args.jobKey, args.rows as IndexRowInput[]),
});
