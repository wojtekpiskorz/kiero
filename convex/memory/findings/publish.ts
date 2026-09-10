/**
 * publishChangeSet (C2): the ONE atomic commit of a logically dependent group.
 *
 * Runs inside ONE Convex mutation. ATOMICITY IS STRUCTURAL, not
 * write-order-dependent: everything that can throw or refuse runs BEFORE
 * the first insert, and the validating pass COLLECTS the resolved documents
 * it checks — the commit loop consumes that array and resolves nothing
 * itself, so "only pre-validated writes remain" is literal and the two
 * loops cannot drift. Any abort leaves nothing committed; a crash after the
 * writes rolls back everything ("A publication group either commits
 * revisions, provenance and all authoritative projections together or
 * writes none"). Pure decisions (stale-plan guard, plan consistency, cycle
 * checks) come from @kiero/domain/findings, against the then-current graph
 * and counters: precedence is decided by expected revisions, never by
 * arrival or completion time (issue 8).
 */

import { Schema } from "effect";
import { errorResult, events, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import { checkPlanConsistency, decidePublish, wouldCreateCycle } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import { checkExtensionFindingValue, recordExtensionValueUsage } from "../extensions/validate";
import {
  companyDependencyEdges,
  findFindingByKey,
  normalizedActor,
  normalizedCompany,
  requireFinding,
  requireProject,
  requireSource,
} from "./references";
import {
  decodeFindingValue,
  decodeKnowledgeState,
  decodeTemporalValue,
  publishChangeSetEntry,
  TEMPLATE_ID,
  type PublishChangeSetInput,
} from "./semantics";
import {
  failChangeSet,
  plannedEdgesOf,
  planScopeOf,
  type ResolvedChange,
} from "./plan";

/**
 * Publishes one prepared change set in a single transaction: recheck the set
 * (tenant, still prepared), the stored source and every evidence source (a
 * withdrawn source is no witness), the captured AND caller expected
 * revisions against the current counters (the stale-plan guard), and the
 * staged plan's invariants plus graph acyclicity as they are NOW — then
 * write revisions + evidence links + dependencies + the current projections
 * + the group/set state + the canonical events, all together or not at all.
 */
export async function performPublishChangeSet(
  tx: MutationCtx,
  context: RequestContext,
  input: PublishChangeSetInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const changeSetId = tx.db.normalizeId("changeSets", input.changeSetId);
  if (changeSetId === null) {
    return errorResult(notFoundError("changeSets"));
  }
  const changeSet = await tx.db.get(changeSetId);
  if (changeSet === null || changeSet.companyId !== companyId) {
    return errorResult(notFoundError("changeSets"));
  }
  const group = await tx.db
    .query("publicationGroups")
    .withIndex("by_change_set", (q) => q.eq("changeSetId", changeSetId))
    .first();
  if (group === null) {
    // The stored set is corrupt (its staged plan is gone): unpublishable.
    return failChangeSet(
      tx,
      changeSetId,
      null,
      "publication_group_missing",
      notFoundError("publicationGroups"),
    );
  }

  // Idempotent-republish guard FIRST, before any write: the loser of a
  // concurrent publish (or its OCC retry) must not overwrite the winner's
  // state. No recordTable: "changeSets" is outside the closed vocabulary and
  // an unconstructible envelope would itself be sanitized away.
  if (changeSet.state !== "prepared") {
    return errorResult(conflictError("change_set_not_prepared"));
  }

  // Source validity recheck: a withdrawn/purged source supports no new truth.
  const source = await requireSource(tx.db, changeSet.sourceId, companyId);
  if (source === null) {
    return failChangeSet(
      tx,
      changeSetId,
      group,
      "set_source_missing",
      notFoundError("sources"),
    );
  }
  if (source.lifecycle !== "active") {
    return failChangeSet(
      tx,
      changeSetId,
      group,
      "source_no_longer_active",
      conflictError("source_not_active", "sources", source._id),
    );
  }

  // The ONE validating pass: decode the staged values, re-resolve every
  // stored reference in-company, prove create-targets still free — and
  // COLLECT the resolved documents the commit loop will consume.
  const resolved: ResolvedChange[] = [];
  const currentCounters = new Map<string, number>();
  for (const entry of group.plannedChanges) {
    decodeFindingValue(entry.value);
    decodeKnowledgeState(entry.knowledgeState);
    if (entry.effectiveFrom !== undefined) {
      decodeTemporalValue(entry.effectiveFrom);
    }
    // C3 seam (additive, flagged): re-check every extension value against
    // its exact stored definition version inside THIS transaction — the
    // version may have moved (or been defined) since prepare. A staged value
    // that no longer interprets can never publish as staged: the set fails.
    const extensionCheck = await checkExtensionFindingValue(tx.db, companyId, entry.value);
    if (extensionCheck !== null && !extensionCheck.ok) {
      return failChangeSet(
        tx,
        changeSetId,
        group,
        `extension_value_invalid:${extensionCheck.code}`,
        validationError(extensionCheck.code),
      );
    }
    if (entry.findingId !== undefined) {
      const finding = await requireFinding(tx.db, entry.findingId, companyId);
      if (finding === null) {
        return failChangeSet(
          tx,
          changeSetId,
          group,
          "referenced_finding_missing",
          notFoundError("findings"),
        );
      }
      currentCounters.set(finding._id, finding.revisionCounter);
      resolved.push({ entry, finding });
    } else {
      let scopeProjectId: Id<"projects"> | undefined;
      if (entry.scopeKind === "project") {
        if (entry.scopeProjectId === undefined) {
          return failChangeSet(
            tx,
            changeSetId,
            group,
            "staged_plan_invalid",
            validationError("project_scope_without_project"),
          );
        }
        const resolvedProject = await requireProject(tx.db, entry.scopeProjectId, companyId);
        if (resolvedProject === null) {
          return failChangeSet(
            tx,
            changeSetId,
            group,
            "scope_project_missing",
            notFoundError("projects", "project_scope_not_found"),
          );
        }
        scopeProjectId = resolvedProject;
      }
      const existing = await findFindingByKey(
        tx.db,
        companyId,
        scopeProjectId,
        entry.semanticKey,
      );
      if (existing !== null) {
        // The identity this plan meant to CREATE exists now: staleness, not
        // a caller error — a second row would break stable identity, so the
        // set fails and the plan is re-prepared against the live finding.
        return failChangeSet(
          tx,
          changeSetId,
          group,
          "existing_finding_requires_finding_id",
          conflictError("existing_finding_requires_finding_id", "findings", existing._id),
        );
      }
      resolved.push({ entry, finding: null });
    }
    for (const item of entry.evidence) {
      const evidenceSource = await requireSource(tx.db, item.sourceId, companyId);
      if (evidenceSource === null) {
        // A staged reference that no longer resolves in-company: this set
        // cannot publish as staged.
        return failChangeSet(
          tx,
          changeSetId,
          group,
          "evidence_source_not_in_company",
          forbiddenError("evidence_source_not_in_company", "sources"),
        );
      }
      if (evidenceSource.lifecycle !== "active") {
        return failChangeSet(
          tx,
          changeSetId,
          group,
          "evidence_source_no_longer_active",
          conflictError("evidence_source_no_longer_active", "sources", evidenceSource._id),
        );
      }
    }
    for (const basis of entry.derivesFrom) {
      const basisFinding = await requireFinding(tx.db, basis, companyId);
      if (basisFinding === null) {
        return failChangeSet(
          tx,
          changeSetId,
          group,
          "derivation_basis_not_in_company",
          forbiddenError("derivation_basis_not_in_company", "findings"),
        );
      }
    }
  }

  // The stale-plan guard (pure core): captured AND caller expectations must
  // equal the CURRENT counters of every referenced finding.
  const current: Record<string, number> = Object.fromEntries(currentCounters);
  const callerExpectations: { findingId: string; revision: number }[] = [];
  for (const expectation of input.expectedRevisions) {
    // Caller-SUPPLIED ids: a refusal here is about the request, not the set.
    const finding = await requireFinding(tx.db, expectation.findingId, companyId);
    if (finding === null) {
      return errorResult(notFoundError("findings"));
    }
    current[finding._id] = finding.revisionCounter;
    callerExpectations.push({ findingId: finding._id, revision: expectation.revision });
  }
  const decision = decidePublish({
    changeSetState: changeSet.state,
    captured: group.expectedRevisions,
    caller: callerExpectations,
    current,
  });
  if (decision.decision === "refuse") {
    if (decision.code === "change_set_not_prepared") {
      // Already terminal; never touch the winner's state.
      return errorResult(conflictError(decision.code));
    }
    if (decision.code === "caller_expectation_mismatch") {
      // The CALLER's expectations are stale, not the plan's: refresh and
      // retry — the set itself stays publishable, so it stays prepared.
      return errorResult(conflictError(decision.code));
    }
    // stale_plan: the CAPTURED expectations no longer match the world —
    // re-preparing is the only recovery.
    return failChangeSet(tx, changeSetId, group, decision.code, conflictError(decision.code));
  }

  // Semantic invariants + acyclicity against the graph as it is NOW: the
  // live graph may have moved against the staged plan since prepare.
  const consistency = checkPlanConsistency(
    group.plannedChanges.map((change) => ({
      findingId: change.findingId ?? null,
      scope: planScopeOf(change),
      semanticKey: change.semanticKey,
      evidence: change.evidence.map((item) => ({ sourceId: item.sourceId })),
      derivesFrom: [...change.derivesFrom],
    })),
  );
  if (!consistency.ok) {
    return failChangeSet(
      tx,
      changeSetId,
      group,
      "staged_plan_invalid",
      validationError(consistency.code),
    );
  }
  if (
    wouldCreateCycle(
      await companyDependencyEdges(tx.db, companyId),
      plannedEdgesOf(group.plannedChanges),
    )
  ) {
    return failChangeSet(
      tx,
      changeSetId,
      group,
      "planned_dependencies_cyclic",
      validationError("planned_dependencies_cyclic"),
    );
  }

  // Pre-insert decode templates: the receipt and both event payloads in the
  // exact shapes this transaction constructs.
  Schema.decodeUnknownSync(publishChangeSetEntry.result)({
    publishedRevisionIds: [TEMPLATE_ID],
  });
  const changeSetPublished = events["memory.changeSetPublished"];
  const findingRevised = events["memory.findingRevised"];
  if (changeSetPublished === undefined || findingRevised === undefined) {
    // A code/config defect, not a plan defect: nothing is written and the
    // set stays prepared (retry after a fix).
    return errorResult(validationError("memory_events_missing"));
  }
  Schema.decodeUnknownSync(changeSetPublished.payload)({
    changeSetId: TEMPLATE_ID,
    revisionIds: [TEMPLATE_ID],
  });
  Schema.decodeUnknownSync(findingRevised.payload)({
    findingId: TEMPLATE_ID,
    revisionId: TEMPLATE_ID,
    supersedesRevisionId: null,
  });
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }

  // --- THE atomic commit: consumes the validated pass; only pre-validated
  // writes from here on ------------------------------------------------------
  const nowMs = Date.now();
  const publishedRevisionIds: Id<"findingRevisions">[] = [];
  const revisedEvents: {
    findingId: Id<"findings">;
    revisionId: Id<"findingRevisions">;
    supersedesRevisionId: Id<"findingRevisions"> | null;
  }[] = [];
  for (const { entry, finding } of resolved) {
    const findingId: Id<"findings"> =
      finding === null
        ? await tx.db.insert("findings", {
            companyId,
            scopeKind: entry.scopeKind,
            ...(entry.scopeProjectId === undefined ? {} : { scopeProjectId: entry.scopeProjectId }),
            semanticKey: entry.semanticKey,
            knowledgeState: entry.knowledgeState,
            revisionCounter: 1,
            updatedAtMs: nowMs,
          })
        : finding._id;
    const revisionNumber = finding === null ? 1 : finding.revisionCounter + 1;

    const fragmentIds = entry.evidence
      .map((item) => item.sourceFragmentId)
      .filter((id): id is Id<"sourceFragments"> => id !== undefined);
    const firstExtraction = entry.evidence
      .map((item) => item.extractionId)
      .find((id): id is Id<"extractions"> => id !== undefined);
    const revisionId = await tx.db.insert("findingRevisions", {
      findingId,
      revision: revisionNumber,
      value: entry.value,
      knowledgeState: entry.knowledgeState,
      ...(entry.effectiveFrom === undefined ? {} : { effectiveFrom: entry.effectiveFrom }),
      ...(finding !== null && finding.currentRevisionId !== undefined
        ? { supersedesRevisionId: finding.currentRevisionId }
        : {}),
      origin: "publication",
      provenance: {
        sourceId: source._id,
        fragmentIds,
        ...(firstExtraction === undefined ? {} : { extractionId: firstExtraction }),
        actorUserId,
        recordedAtMs: nowMs,
      },
      recordedByUserId: actorUserId,
      recordedAtMs: nowMs,
    });
    publishedRevisionIds.push(revisionId);
    // C3 seam (additive, flagged): the committed-usage counter moves WITH
    // the revision it counts, in this transaction — usage statistics are
    // derived from committed records, never estimated.
    await recordExtensionValueUsage(tx.db, companyId, entry.value, nowMs);
    revisedEvents.push({
      findingId,
      revisionId,
      supersedesRevisionId: finding === null ? null : finding.currentRevisionId ?? null,
    });

    for (const item of entry.evidence) {
      await tx.db.insert("evidenceLinks", {
        findingRevisionId: revisionId,
        sourceId: item.sourceId,
        ...(item.sourceFragmentId === undefined
          ? {}
          : { sourceFragmentId: item.sourceFragmentId }),
        supportKind: item.supportKind,
        ...(item.extractionId === undefined ? {} : { extractionId: item.extractionId }),
        createdAtMs: nowMs,
      });
    }
    for (const basis of entry.derivesFrom) {
      await tx.db.insert("findingDependencies", {
        companyId,
        dependentFindingId: findingId,
        dependsOnFindingId: basis,
        cause: "derivation",
        derivationRevisionId: revisionId,
        createdAtMs: nowMs,
      });
    }

    // The current projection moves WITH its revision, in this transaction.
    await tx.db.patch(findingId, {
      currentRevisionId: revisionId,
      knowledgeState: entry.knowledgeState,
      revisionCounter: revisionNumber,
      updatedAtMs: nowMs,
    });
  }

  await tx.db.patch(changeSetId, { state: "published", publishedAtMs: nowMs });
  await tx.db.patch(group._id, {
    state: "published",
    memberRevisionIds: publishedRevisionIds,
  });

  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "memory.changeSetPublished",
    payload: { changeSetId, revisionIds: publishedRevisionIds },
    dedupKey: `memory.changeSetPublished:${changeSetId}`,
  });
  for (const revised of revisedEvents) {
    await publishEvent(tx, {
      companyId: context.actor.companyId,
      eventName: "memory.findingRevised",
      payload: {
        findingId: revised.findingId,
        revisionId: revised.revisionId,
        supersedesRevisionId: revised.supersedesRevisionId,
      },
      dedupKey: `memory.findingRevised:${revised.revisionId}`,
    });
  }

  return okResult(
    Schema.decodeUnknownSync(publishChangeSetEntry.result)({ publishedRevisionIds }),
  );
}
