/**
 * prepareChangeSet (C2): stage the checked plan with captured expectations.
 *
 * Runs inside ONE Convex mutation (through the checked dispatch, exactly
 * like D1's acceptance). Reference resolution happens in a SINGLE pass: the
 * loop over the planned revisions both validates every reference and builds
 * the normalized staged row — the resolved finding documents are in hand
 * exactly once, so the captured expectations come from the same read that
 * validated them. Nothing about any finding is written; the only writes are
 * the change set row and its staged group, after the pre-insert template
 * decode proves the receipt's shape.
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import { checkPlanConsistency, wouldCreateCycle } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { checkExtensionFindingValue } from "../extensions/validate";
import {
  companyDependencyEdges,
  findFindingByKey,
  normalizedCompany,
  requireFinding,
  requireProject,
  requireSource,
} from "./references";
import {
  encodeFindingValue,
  encodeKnowledgeState,
  encodeTemporalValue,
  prepareChangeSetEntry,
  TEMPLATE_ID,
  type PrepareChangeSetInput,
} from "./semantics";
import { plannedEdgesOf, planScopeOf, type NormalizedEvidence, type PlannedChangeRow } from "./plan";

/**
 * Prepares one change set: validates the source, every scope, every evidence
 * reference (source AND fragment tenant-checked), every derivation basis and
 * the whole plan's consistency + acyclicity against the live graph, then
 * stages the encoded plan with the expectations captured NOW.
 */
export async function performPrepareChangeSet(
  tx: MutationCtx,
  context: RequestContext,
  input: PrepareChangeSetInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const source = await requireSource(tx.db, input.sourceId, companyId);
  if (source === null) {
    return errorResult(notFoundError("sources"));
  }
  if (source.lifecycle !== "active") {
    return errorResult(conflictError("source_not_active", "sources", source._id));
  }

  // ONE pass: reference checks produce the normalized staged plan AND the
  // expectations captured from the same reads (no second resolution round).
  const staged: PlannedChangeRow[] = [];
  const expectedRevisions: { findingId: Id<"findings">; revision: number }[] = [];
  for (const entry of input.plannedRevisions) {
    let scopeProjectId: Id<"projects"> | undefined;
    if (entry.scope._tag === "project") {
      const resolved = await requireProject(tx.db, entry.scope.projectId, companyId);
      if (resolved === null) {
        return errorResult(notFoundError("projects", "project_scope_not_found"));
      }
      scopeProjectId = resolved;
    }
    let findingId: Id<"findings"> | undefined;
    if (entry.findingId !== null) {
      const finding = await requireFinding(tx.db, entry.findingId, companyId);
      if (finding === null) {
        return errorResult(notFoundError("findings"));
      }
      if (finding.semanticKey !== entry.semanticKey) {
        return errorResult(validationError("finding_id_semantic_key_mismatch"));
      }
      const sameScope =
        finding.scopeKind === entry.scope._tag &&
        (entry.scope._tag === "company" || finding.scopeProjectId === scopeProjectId);
      if (!sameScope) {
        return errorResult(validationError("finding_id_scope_mismatch"));
      }
      findingId = finding._id;
      // Captured NOW, from the read that just validated the reference.
      expectedRevisions.push({ findingId: finding._id, revision: finding.revisionCounter });
    } else {
      const existing = await findFindingByKey(
        tx.db,
        companyId,
        scopeProjectId,
        entry.semanticKey,
      );
      if (existing !== null) {
        return errorResult(validationError("existing_finding_requires_finding_id"));
      }
    }

    const evidence: NormalizedEvidence[] = [];
    for (const item of entry.evidence) {
      const evidenceSource = await requireSource(tx.db, item.sourceId, companyId);
      // A missing OR cross-tenant source: both refuse, without saying which.
      if (evidenceSource === null) {
        return errorResult(forbiddenError("evidence_source_not_in_company", "sources"));
      }
      let sourceFragmentId: Id<"sourceFragments"> | undefined;
      if (item.fragmentId !== null) {
        const normalizedFragment = tx.db.normalizeId("sourceFragments", item.fragmentId);
        const fragment =
          normalizedFragment === null ? null : await tx.db.get(normalizedFragment);
        if (fragment === null || fragment.sourceId !== evidenceSource._id) {
          return errorResult(validationError("evidence_fragment_mismatch"));
        }
        sourceFragmentId = normalizedFragment ?? undefined;
      }
      let extractionId: Id<"extractions"> | undefined;
      if (item.extractionId !== undefined) {
        const normalizedExtraction = tx.db.normalizeId("extractions", item.extractionId);
        const extraction =
          normalizedExtraction === null ? null : await tx.db.get(normalizedExtraction);
        if (extraction === null || extraction.sourceId !== evidenceSource._id) {
          return errorResult(validationError("evidence_extraction_mismatch"));
        }
        extractionId = normalizedExtraction ?? undefined;
      }
      evidence.push({
        sourceId: evidenceSource._id,
        ...(sourceFragmentId === undefined ? {} : { sourceFragmentId }),
        supportKind: item.supportKind,
        ...(extractionId === undefined ? {} : { extractionId }),
      });
    }

    const derivesFrom: Id<"findings">[] = [];
    for (const basis of entry.derivesFrom) {
      const basisFinding = await requireFinding(tx.db, basis, companyId);
      if (basisFinding === null) {
        return errorResult(forbiddenError("derivation_basis_not_in_company", "findings"));
      }
      derivesFrom.push(basisFinding._id);
    }

    // C3 seam (additive, flagged): extension values validate against their
    // exact stored definition version at prepare too — the plan is refused
    // before staging when the value cannot be interpreted under its version.
    const encodedValue = encodeFindingValue(entry.value);
    const extensionCheck = await checkExtensionFindingValue(tx.db, companyId, encodedValue);
    if (extensionCheck !== null && !extensionCheck.ok) {
      return errorResult(validationError(extensionCheck.code));
    }

    staged.push({
      ...(findingId === undefined ? {} : { findingId }),
      scopeKind: entry.scope._tag,
      ...(scopeProjectId === undefined ? {} : { scopeProjectId }),
      semanticKey: entry.semanticKey,
      value: encodedValue,
      knowledgeState: encodeKnowledgeState(entry.knowledgeState),
      ...(entry.effectiveFrom === null
        ? {}
        : { effectiveFrom: encodeTemporalValue(entry.effectiveFrom) }),
      evidence,
      derivesFrom,
    });
  }

  // Plan consistency over the normalized entries (basis presence, identity
  // uniqueness, within-plan cycles) — the pure core from @kiero/domain.
  // (planScopeKey/plannedEdgesOf round out the pure-check conversions.)
  const consistency = checkPlanConsistency(
    staged.map((change) => ({
      findingId: change.findingId ?? null,
      scope: planScopeOf(change),
      semanticKey: change.semanticKey,
      evidence: change.evidence.map((item) => ({ sourceId: item.sourceId })),
      derivesFrom: [...change.derivesFrom],
    })),
  );
  if (!consistency.ok) {
    return errorResult(validationError(consistency.code));
  }
  // Acyclicity over the LIVE graph plus the planned edges.
  if (
    wouldCreateCycle(await companyDependencyEdges(tx.db, companyId), plannedEdgesOf(staged))
  ) {
    return errorResult(validationError("planned_dependencies_cyclic"));
  }

  // Pre-insert decode templates (the receipt this transaction constructs).
  Schema.decodeUnknownSync(prepareChangeSetEntry.result)({
    changeSetId: TEMPLATE_ID,
    state: "prepared",
  });

  const changeSetId = await tx.db.insert("changeSets", {
    companyId,
    sourceId: source._id,
    state: "prepared",
    preparedAtMs: Date.now(),
  });
  await tx.db.insert("publicationGroups", {
    changeSetId,
    plannedChanges: staged,
    expectedRevisions,
    state: "prepared",
  });
  return okResult(
    Schema.decodeUnknownSync(prepareChangeSetEntry.result)({
      changeSetId,
      state: "prepared",
    }),
  );
}
