/**
 * searchExtensionCatalog (C3): the catalog lookup with similarity
 * candidates the agent consults BEFORE creating a definition.
 *
 * Read-only; runs inside ONE Convex mutation through the checked dispatch
 * (the memory dispatch is the single transactional entry). The candidate
 * set is the union of this firm's definitions and the shared definitions,
 * each with its CURRENT version snapshot and this firm's committed usage
 * statistics ("Statystyki ich wykorzystania wskazują powtarzające się
 * potrzeby", CONTEXT.md Katalog dodatkowych informacji). The typed verdicts
 * come from the pure domain assessment; only non-distinct candidates are
 * returned, best score first (usage breaks ties — the repeat-need signal).
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { validationError, type RequestContext } from "@kiero/runtime";
import { assessCatalogCandidate } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import { normalizedCompany } from "../findings/references";
import {
  companyUsageByDefinition,
  currentVersionOf,
} from "./references";
import { searchExtensionCatalogEntry, type SearchExtensionCatalogInput } from "./semantics";

export async function performSearchExtensionCatalog(
  tx: MutationCtx,
  context: RequestContext,
  input: SearchExtensionCatalogInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const own = await tx.db
    .query("extensionDefinitions")
    .withIndex("by_company_key", (q) => q.eq("companyId", companyId))
    .collect();
  const shared = await tx.db
    .query("extensionDefinitions")
    .filter((q) => q.eq(q.field("companyId"), undefined))
    .collect();
  const usage = await companyUsageByDefinition(tx.db, companyId);

  const candidates: {
    definitionId: string;
    versionId: string;
    version: number;
    name: string;
    fields: unknown;
    shared: boolean;
    usageCount: number;
    lastUsedAtMs: number | null;
    similarity: { score: number; verdict: string; structureCompatible: boolean | null };
  }[] = [];

  for (const definition of [...own, ...shared]) {
    const current = await currentVersionOf(tx.db, definition);
    if (current === null) {
      continue; // corrupt definition without a current version: not a candidate
    }
    const assessment = assessCatalogCandidate(
      { name: input.name, ...(input.fields === undefined ? {} : { fields: input.fields }) },
      { name: current.name, fields: current.fields },
    );
    if (assessment.verdict === "distinct") {
      continue;
    }
    const usageRow = usage.get(definition._id);
    candidates.push({
      definitionId: definition._id,
      versionId: current._id,
      version: current.version,
      name: current.name,
      fields: current.fields,
      shared: definition.companyId === undefined,
      usageCount: usageRow?.usageCount ?? 0,
      lastUsedAtMs: usageRow?.lastUsedAtMs ?? null,
      similarity: {
        score: assessment.score,
        verdict: assessment.verdict,
        structureCompatible: assessment.structureCompatible,
      },
    });
  }
  candidates.sort(
    (a, b) =>
      b.similarity.score - a.similarity.score ||
      b.usageCount - a.usageCount ||
      a.name.localeCompare(b.name, "pl"),
  );

  return okResult(
    Schema.decodeUnknownSync(searchExtensionCatalogEntry.result)({ candidates }),
  );
}
