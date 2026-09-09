/**
 * Findings transaction cores (C2): prepare, the atomic publish, explicit
 * corrections, clarifications and the current-read projection.
 *
 * Every perform* body runs inside ONE Convex mutation (through the checked
 * dispatch, exactly like D1's acceptance). ATOMICITY IS STRUCTURAL, not
 * write-order-dependent: the checked dispatch converts a handler throw into
 * a returned sanitized envelope and a RETURNING mutation commits — so every
 * step that can throw (Effect decodes of the staged plan, result templates,
 * event payload templates) runs BEFORE the first insert. Between the first
 * insert and the end only pre-validated writes remain: an abort at any point
 * (validation return, pre-insert throw, post-insert crash) leaves nothing
 * committed — no revision without its projection, no provenance without its
 * revision, no half-published group ("A publication group either commits
 * revisions, provenance and all authoritative projections together or
 * writes none").
 *
 * The findings row is the CURRENT projection: it is patched only inside the
 * same transaction that writes the revision it projects (publish, correction,
 * withdrawal marking) and by nothing else. Current reads join findings with
 * their current revision — no conversation replay.
 *
 * Pure decisions (plan consistency, stale-plan guard, correction
 * supersession, cycle checks) come from @kiero/domain/findings and run at
 * PREPARE and again at PUBLISH against the then-current graph and counters:
 * "Ponowne przetworzenie starszego źródła nie może cofnąć późniejszej jawnej
 * poprawki" — precedence is decided by expected revisions, never by arrival
 * or completion time.
 */

import { Schema } from "effect";
import {
  FindingValue,
  KnowledgeState,
  TemporalValue,
  errorResult,
  events,
  memoryOperations,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import {
  checkPlanConsistency,
  decideCorrection,
  decidePublish,
  planScopeKey,
  wouldCreateCycle,
  type DependencyEdge,
  type PlanScope,
} from "@kiero/domain";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";

// ---------------------------------------------------------------------------
// Contract entries (decode/typed authority for this lane's operations).
// ---------------------------------------------------------------------------

export const readCurrentFindingsEntry = memoryOperations["memory.readCurrentFindings"];
export const prepareChangeSetEntry = memoryOperations["memory.prepareChangeSet"];
export const publishChangeSetEntry = memoryOperations["memory.publishChangeSet"];
export const correctFindingEntry = memoryOperations["memory.correctFinding"];
export const raiseClarificationEntry = memoryOperations["memory.raiseClarification"];
export const resolveClarificationEntry = memoryOperations["memory.resolveClarification"];

export type PrepareChangeSetInput = Schema.Schema.Type<typeof prepareChangeSetEntry.input>;
export type PublishChangeSetInput = Schema.Schema.Type<typeof publishChangeSetEntry.input>;
export type CorrectFindingInput = Schema.Schema.Type<typeof correctFindingEntry.input>;
export type RaiseClarificationInput = Schema.Schema.Type<typeof raiseClarificationEntry.input>;
export type ResolveClarificationInput = Schema.Schema.Type<
  typeof resolveClarificationEntry.input
>;
export type ReadCurrentFindingsInput = Schema.Schema.Type<
  typeof readCurrentFindingsEntry.input
>;

const encodeFindingValue = Schema.encodeSync(FindingValue);
const encodeKnowledgeState = Schema.encodeSync(KnowledgeState);
const encodeTemporalValue = Schema.encodeSync(TemporalValue);
const decodeFindingValue = Schema.decodeUnknownSync(FindingValue);
const decodeKnowledgeState = Schema.decodeUnknownSync(KnowledgeState);
const decodeTemporalValue = Schema.decodeUnknownSync(TemporalValue);

/**
 * A representative table id used only by the pre-insert decode templates
 * (D1's pattern): proves the result/event schemas still accept the exact
 * shapes this transaction constructs, BEFORE anything is written.
 */
const TEMPLATE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";

// ---------------------------------------------------------------------------
// Shared reference checks (tenant-scoped: the resolved company is the only
// company any row may belong to).
// ---------------------------------------------------------------------------

type Db = MutationCtx["db"] | QueryCtx["db"];

/** The actor's normalized company id (null when malformed — refuse loudly). */
export function normalizedCompany(
  db: Db,
  context: RequestContext,
): Id<"companies"> | null {
  return db.normalizeId("companies", context.actor.companyId);
}

function normalizedActor(
  db: Db,
  context: RequestContext,
): Id<"users"> | null {
  return db.normalizeId("users", context.actor.userId);
}

async function requireSource(
  db: Db,
  sourceRef: string,
  companyId: Id<"companies">,
): Promise<Doc<"sources"> | null> {
  const sourceId = db.normalizeId("sources", sourceRef);
  if (sourceId === null) {
    return null;
  }
  const source = await db.get(sourceId);
  if (source === null || source.companyId !== companyId) {
    return null;
  }
  return source;
}

async function requireProject(
  db: Db,
  projectRef: string,
  companyId: Id<"companies">,
): Promise<Id<"projects"> | null> {
  const projectId = db.normalizeId("projects", projectRef);
  if (projectId === null) {
    return null;
  }
  const project = await db.get(projectId);
  if (project === null || project.companyId !== companyId) {
    return null;
  }
  return projectId;
}

async function requireFinding(
  db: Db,
  findingRef: string,
  companyId: Id<"companies">,
): Promise<Doc<"findings"> | null> {
  const findingId = db.normalizeId("findings", findingRef);
  if (findingId === null) {
    return null;
  }
  const finding = await db.get(findingId);
  if (finding === null || finding.companyId !== companyId) {
    return null;
  }
  return finding;
}

/** Finds the live finding identity for one scope key, if any. */
async function findFindingByKey(
  db: Db,
  companyId: Id<"companies">,
  scopeProjectId: Id<"projects"> | undefined,
  semanticKey: string,
): Promise<Doc<"findings"> | null> {
  return await db
    .query("findings")
    .withIndex("by_company_scope_key", (q) =>
      q
        .eq("companyId", companyId)
        .eq("scopeProjectId", scopeProjectId)
        .eq("semanticKey", semanticKey),
    )
    .first();
}

/** All dependency edges of one company (the acyclicity check's graph). */
async function companyDependencyEdges(
  db: Db,
  companyId: Id<"companies">,
): Promise<DependencyEdge[]> {
  const rows = await db
    .query("findingDependencies")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .collect();
  return rows.map((row) => ({
    dependent: row.dependentFindingId,
    dependsOn: row.dependsOnFindingId,
  }));
}

// ---------------------------------------------------------------------------
// The normalized staged plan (produced at prepare, consumed at publish;
// every id is a Convex-normalized id, every semantic value encoded).
// ---------------------------------------------------------------------------

interface NormalizedEvidence {
  readonly sourceId: Id<"sources">;
  readonly sourceFragmentId?: Id<"sourceFragments">;
  readonly supportKind: "support" | "independent_corroboration";
  readonly extractionId?: Id<"extractions">;
}

/**
 * The row type the publicationGroups table stores for one planned change:
 * the normalized staged plan (every id Convex-normalized, every semantic
 * value in its encoded form).
 */
type PlannedChangeRow = NonNullable<
  Doc<"publicationGroups">["plannedChanges"][number]
>;

/** The plan scope of one staged change, for the pure plan checks. */
function planScopeOf(change: {
  scopeKind: "company" | "project";
  scopeProjectId?: Id<"projects"> | undefined;
}): PlanScope {
  return change.scopeKind === "company"
    ? { kind: "company" }
    : { kind: "project", projectId: change.scopeProjectId };
}

/** The dependency edges a staged plan would add (dependent keyed by id or plan key). */
function plannedEdgesOf(changes: readonly PlannedChangeRow[]): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const change of changes) {
    const dependent = change.findingId ?? planScopeKey(planScopeOf(change), change.semanticKey);
    for (const basis of change.derivesFrom) {
      edges.push({ dependent, dependsOn: basis });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// prepareChangeSet: stage the checked plan with captured expectations.
// ---------------------------------------------------------------------------

/**
 * Prepares one change set: validates the source, every scope, every evidence
 * reference (source AND fragment tenant-checked), every derivation basis and
 * the whole plan's consistency + acyclicity against the live graph, then
 * stages the encoded plan with the expectations captured NOW. Nothing about
 * any finding is written yet.
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

  // One pass: reference checks produce the NORMALIZED staged plan.
  const staged: PlannedChangeRow[] = [];
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

    staged.push({
      ...(findingId === undefined ? {} : { findingId }),
      scopeKind: entry.scope._tag,
      ...(scopeProjectId === undefined ? {} : { scopeProjectId }),
      semanticKey: entry.semanticKey,
      value: encodeFindingValue(entry.value),
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

  // Captured expectations: the CURRENT counters (findings not yet live have
  // no entry — publish treats "absent" as 0 for new identities).
  const expectedRevisions: { findingId: Id<"findings">; revision: number }[] = [];
  for (const change of staged) {
    if (change.findingId !== undefined) {
      const finding = await requireFinding(tx.db, change.findingId, companyId);
      if (finding === null) {
        return errorResult(notFoundError("findings"));
      }
      expectedRevisions.push({ findingId: finding._id, revision: finding.revisionCounter });
    }
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

// ---------------------------------------------------------------------------
// publishChangeSet: the ONE atomic commit of a logically dependent group.
// ---------------------------------------------------------------------------

/**
 * Publishes one prepared change set in a single transaction:
 *
 * 1. recheck the change set (tenant, still prepared);
 * 2. recheck the SOURCE (still present, tenant, still active) and every
 *    evidence source of the staged plan (a withdrawn source is no witness);
 * 3. recheck EXPECTED REVISIONS — the captured (prepare-time) and caller
 *    expectations against the CURRENT counters (the stale-plan guard);
 * 4. recheck semantic invariants (the staged values must still decode) and
 *    graph acyclicity against the graph as it is NOW;
 * 5. write revisions + evidence links + dependencies + the findings current
 *    projection + the group/changeSet state + the canonical events — all
 *    together or not at all.
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
    return errorResult(notFoundError("publicationGroups"));
  }

  // Idempotent-republish guard FIRST, before any write: a concurrent publish
  // of the same set that already committed (or an OCC-retried loser rerunning
  // after the winner) must refuse WITHOUT overwriting the winner's state.
  // (No recordTable here: "changeSets" is not in the closed
  // ExpectedRecordTable vocabulary, and an unconstructible error envelope
  // would itself be sanitized away.)
  if (changeSet.state !== "prepared") {
    return errorResult(conflictError("change_set_not_prepared"));
  }

  // Source validity recheck: a withdrawn/purged source supports no new truth.
  const source = await requireSource(tx.db, changeSet.sourceId, companyId);
  if (source === null) {
    return errorResult(notFoundError("sources"));
  }
  if (source.lifecycle !== "active") {
    await tx.db.patch(changeSetId, {
      state: "failed",
      failedReason: "source_no_longer_active",
    });
    await tx.db.patch(group._id, { state: "failed" });
    return errorResult(conflictError("source_not_active", "sources", source._id));
  }

  // Semantic invariant recheck + reference resolution: the staged values
  // must still decode, scopes/evidence/bases must still resolve in-company,
  // and evidence sources must still be active witnesses. All before writes.
  const currentCounters = new Map<string, number>();
  for (const entry of group.plannedChanges) {
    decodeFindingValue(entry.value);
    decodeKnowledgeState(entry.knowledgeState);
    if (entry.effectiveFrom !== undefined) {
      decodeTemporalValue(entry.effectiveFrom);
    }
    if (entry.findingId !== undefined) {
      const finding = await requireFinding(tx.db, entry.findingId, companyId);
      if (finding === null) {
        return errorResult(notFoundError("findings"));
      }
      currentCounters.set(finding._id, finding.revisionCounter);
    } else {
      let scopeProjectId: Id<"projects"> | undefined;
      if (entry.scopeKind === "project") {
        if (entry.scopeProjectId === undefined) {
          return errorResult(validationError("project_scope_without_project"));
        }
        const resolved = await requireProject(tx.db, entry.scopeProjectId, companyId);
        if (resolved === null) {
          return errorResult(notFoundError("projects", "project_scope_not_found"));
        }
        scopeProjectId = resolved;
      }
      const existing = await findFindingByKey(
        tx.db,
        companyId,
        scopeProjectId,
        entry.semanticKey,
      );
      if (existing !== null) {
        // The identity this plan meant to CREATE exists now (another change
        // set committed it between this set's prepare and publish). This is
        // staleness, not a caller error: writing a second row for one
        // semantic identity would break stable identity, so the set fails
        // and the plan must be re-prepared against the live finding.
        await tx.db.patch(changeSetId, {
          state: "failed",
          failedReason: "existing_finding_requires_finding_id",
        });
        await tx.db.patch(group._id, { state: "failed" });
        return errorResult(
          conflictError("existing_finding_requires_finding_id", "findings", existing._id),
        );
      }
    }
    for (const item of entry.evidence) {
      const evidenceSource = await requireSource(tx.db, item.sourceId, companyId);
      if (evidenceSource === null) {
        return errorResult(forbiddenError("evidence_source_not_in_company", "sources"));
      }
      if (evidenceSource.lifecycle !== "active") {
        return errorResult(
          conflictError("evidence_source_no_longer_active", "sources", evidenceSource._id),
        );
      }
    }
    for (const basis of entry.derivesFrom) {
      const basisFinding = await requireFinding(tx.db, basis, companyId);
      if (basisFinding === null) {
        return errorResult(forbiddenError("derivation_basis_not_in_company", "findings"));
      }
    }
  }

  // The stale-plan guard (pure core): captured AND caller expectations must
  // equal the CURRENT counters of every referenced finding.
  const current: Record<string, number> = Object.fromEntries(currentCounters);
  const callerExpectations: { findingId: string; revision: number }[] = [];
  for (const expectation of input.expectedRevisions) {
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
      return errorResult(conflictError(decision.code));
    }
    // The plan is stale: mark it failed (partial processing stays visible)
    // and refuse — the older plan never overwrites newer truth. ("changeSets"
    // is outside the closed conflict recordTable vocabulary, so the code
    // carries the detail alone.)
    await tx.db.patch(changeSetId, { state: "failed", failedReason: decision.code });
    await tx.db.patch(group._id, { state: "failed" });
    return errorResult(conflictError(decision.code));
  }

  // Semantic invariants + acyclicity against the graph as it is NOW.
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
    return errorResult(validationError(consistency.code));
  }
  if (
    wouldCreateCycle(
      await companyDependencyEdges(tx.db, companyId),
      plannedEdgesOf(group.plannedChanges),
    )
  ) {
    return errorResult(validationError("planned_dependencies_cyclic"));
  }

  // Pre-insert decode templates: the receipt and both event payloads in the
  // exact shapes this transaction constructs.
  Schema.decodeUnknownSync(publishChangeSetEntry.result)({
    publishedRevisionIds: [TEMPLATE_ID],
  });
  const changeSetPublished = events["memory.changeSetPublished"];
  const findingRevised = events["memory.findingRevised"];
  if (changeSetPublished === undefined || findingRevised === undefined) {
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

  // --- THE atomic commit: only pre-validated writes from here on ----------
  const nowMs = Date.now();
  const publishedRevisionIds: Id<"findingRevisions">[] = [];
  const revisedEvents: {
    findingId: Id<"findings">;
    revisionId: Id<"findingRevisions">;
    supersedesRevisionId: Id<"findingRevisions"> | null;
  }[] = [];
  for (const entry of group.plannedChanges) {
    const finding =
      entry.findingId === undefined
        ? null
        : await requireFinding(tx.db, entry.findingId, companyId);
    let findingId: Id<"findings">;
    let revisionNumber: number;
    if (finding === null) {
      findingId = await tx.db.insert("findings", {
        companyId,
        scopeKind: entry.scopeKind,
        ...(entry.scopeProjectId === undefined ? {} : { scopeProjectId: entry.scopeProjectId }),
        semanticKey: entry.semanticKey,
        knowledgeState: entry.knowledgeState,
        revisionCounter: 1,
        updatedAtMs: nowMs,
      });
      revisionNumber = 1;
    } else {
      findingId = finding._id;
      revisionNumber = finding.revisionCounter + 1;
    }

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

// ---------------------------------------------------------------------------
// correctFinding: the explicit correction (supersede with history retained).
// ---------------------------------------------------------------------------

/**
 * Applies one explicit correction: a NEW revision (author, time, reason)
 * superseding the current one, with the projection moving in the same
 * transaction. The expected-revision check refuses when the finding moved
 * since the corrector saw it — arrival or completion time never decides.
 */
export async function performCorrectFinding(
  tx: MutationCtx,
  context: RequestContext,
  input: CorrectFindingInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const finding = await requireFinding(tx.db, input.findingId, companyId);
  if (finding === null) {
    return errorResult(notFoundError("findings"));
  }
  const decision = decideCorrection(input.expectedRevision, finding.revisionCounter);
  if (decision.decision === "refuse") {
    return errorResult(conflictError(decision.code, "findings", finding._id));
  }
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }
  Schema.decodeUnknownSync(correctFindingEntry.result)({ revisionId: TEMPLATE_ID });
  const findingRevised = events["memory.findingRevised"];
  if (findingRevised === undefined) {
    return errorResult(validationError("memory_events_missing"));
  }
  Schema.decodeUnknownSync(findingRevised.payload)({
    findingId: TEMPLATE_ID,
    revisionId: TEMPLATE_ID,
    supersedesRevisionId: null,
  });

  const nowMs = Date.now();
  const revisionNumber = finding.revisionCounter + 1;
  const revisionId = await tx.db.insert("findingRevisions", {
    findingId: finding._id,
    revision: revisionNumber,
    value: encodeFindingValue(input.value),
    knowledgeState: encodeKnowledgeState(input.knowledgeState),
    ...(finding.currentRevisionId === undefined
      ? {}
      : { supersedesRevisionId: finding.currentRevisionId }),
    origin: "correction",
    reason: input.reason,
    recordedByUserId: actorUserId,
    recordedAtMs: nowMs,
  });
  await tx.db.patch(finding._id, {
    currentRevisionId: revisionId,
    knowledgeState: encodeKnowledgeState(input.knowledgeState),
    revisionCounter: revisionNumber,
    updatedAtMs: nowMs,
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "memory.findingRevised",
    payload: {
      findingId: finding._id,
      revisionId,
      supersedesRevisionId: finding.currentRevisionId ?? null,
    },
    dedupKey: `memory.findingRevised:${revisionId}`,
  });
  return okResult(Schema.decodeUnknownSync(correctFindingEntry.result)({ revisionId }));
}

// ---------------------------------------------------------------------------
// Clarifications: the explicit conflicted-knowledge path.
// ---------------------------------------------------------------------------

export async function performRaiseClarification(
  tx: MutationCtx,
  context: RequestContext,
  input: RaiseClarificationInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  let scopeProjectId: Id<"projects"> | undefined;
  if (input.scope._tag === "project") {
    const resolved = await requireProject(tx.db, input.scope.projectId, companyId);
    if (resolved === null) {
      return errorResult(notFoundError("projects", "project_scope_not_found"));
    }
    scopeProjectId = resolved;
  }
  const fragmentIds: Id<"sourceFragments">[] = [];
  for (const fragmentRef of input.conflictingEvidence) {
    const fragmentId = tx.db.normalizeId("sourceFragments", fragmentRef);
    const fragment = fragmentId === null ? null : await tx.db.get(fragmentId);
    if (fragment === null || fragmentId === null) {
      return errorResult(validationError("conflicting_fragment_not_found"));
    }
    const fragmentSource = await tx.db.get(fragment.sourceId);
    if (fragmentSource === null || fragmentSource.companyId !== companyId) {
      return errorResult(
        forbiddenError("conflicting_fragment_not_in_company", "sourceFragments"),
      );
    }
    fragmentIds.push(fragmentId);
  }
  const raised = events["memory.clarificationRaised"];
  if (raised === undefined) {
    return errorResult(validationError("memory_events_missing"));
  }
  Schema.decodeUnknownSync(raised.payload)({ clarificationId: TEMPLATE_ID });
  Schema.decodeUnknownSync(raiseClarificationEntry.result)({ clarificationId: TEMPLATE_ID });

  const clarificationId = await tx.db.insert("clarifications", {
    companyId,
    scopeKind: input.scope._tag,
    ...(scopeProjectId === undefined ? {} : { scopeProjectId }),
    question: input.question,
    conflictingFragmentIds: fragmentIds,
    state: "open",
    raisedAtMs: Date.now(),
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "memory.clarificationRaised",
    payload: { clarificationId },
    dedupKey: `memory.clarificationRaised:${clarificationId}`,
  });
  return okResult(
    Schema.decodeUnknownSync(raiseClarificationEntry.result)({ clarificationId }),
  );
}

export async function performResolveClarification(
  tx: MutationCtx,
  context: RequestContext,
  input: ResolveClarificationInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const clarificationId = tx.db.normalizeId("clarifications", input.clarificationId);
  if (clarificationId === null) {
    return errorResult(notFoundError("clarifications"));
  }
  const clarification = await tx.db.get(clarificationId);
  if (clarification === null || clarification.companyId !== companyId) {
    return errorResult(notFoundError("clarifications"));
  }
  if (clarification.state !== "open") {
    return errorResult(
      conflictError("clarification_already_resolved", "clarifications", clarificationId),
    );
  }
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }
  const resolved = events["memory.clarificationResolved"];
  if (resolved === undefined) {
    return errorResult(validationError("memory_events_missing"));
  }
  Schema.decodeUnknownSync(resolved.payload)({ clarificationId: TEMPLATE_ID });
  Schema.decodeUnknownSync(resolveClarificationEntry.result)({ clarificationId: TEMPLATE_ID });

  const nowMs = Date.now();
  await tx.db.patch(clarificationId, {
    state: "resolved",
    resolvedByUserId: actorUserId,
    resolutionNote: input.resolutionNote,
    resolvedAtMs: nowMs,
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "memory.clarificationResolved",
    payload: { clarificationId },
    dedupKey: `memory.clarificationResolved:${clarificationId}`,
  });
  return okResult(
    Schema.decodeUnknownSync(resolveClarificationEntry.result)({ clarificationId }),
  );
}

// ---------------------------------------------------------------------------
// readCurrentFindings: current knowledge without replaying the conversation.
// ---------------------------------------------------------------------------

/**
 * One current-findings row in its WIRE form: `value` and `knowledgeState`
 * cross the API boundary ENCODED (the runtime envelope carries JSON values;
 * Effect decoding guards input boundaries, and BigDecimal objects are not
 * Convex-serializable). The contract schemas define the shapes; rows carry
 * their encoded form.
 */
export interface CurrentFindingWireRow {
  readonly findingId: string;
  readonly semanticKey: string;
  readonly value: unknown;
  readonly knowledgeState: unknown;
  readonly currentRevisionId: string;
}

/** Reads the current findings of one scope (no conversation replay). */
export async function readCurrentFindingsRows(
  db: QueryCtx["db"],
  context: RequestContext,
  input: ReadCurrentFindingsInput,
): Promise<
  | { readonly ok: true; readonly rows: CurrentFindingWireRow[] }
  | { readonly ok: false; readonly error: ResultEnvelope }
> {
  const companyId = db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return { ok: false, error: errorResult(validationError("company_scope_unresolved")) };
  }
  let scopeProjectId: Id<"projects"> | undefined;
  if (input.scope._tag === "project") {
    const resolved = await requireProject(db, input.scope.projectId, companyId);
    if (resolved === null) {
      return {
        ok: false,
        error: errorResult(notFoundError("projects", "project_scope_not_found")),
      };
    }
    scopeProjectId = resolved;
  }
  const findings = await db
    .query("findings")
    .withIndex("by_company_scope_key", (q) =>
      q.eq("companyId", companyId).eq("scopeProjectId", scopeProjectId),
    )
    .order("asc")
    .collect();
  const rows: CurrentFindingWireRow[] = [];
  for (const finding of findings) {
    if (finding.currentRevisionId === undefined) {
      continue;
    }
    const revision = await db.get(finding.currentRevisionId);
    if (revision === null) {
      continue;
    }
    rows.push({
      findingId: finding._id,
      semanticKey: finding.semanticKey,
      value: revision.value,
      knowledgeState: revision.knowledgeState,
      currentRevisionId: revision._id,
    });
  }
  return { ok: true, rows };
}
