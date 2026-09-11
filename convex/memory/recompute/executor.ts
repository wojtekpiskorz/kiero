/**
 * The `memory.recompute_dependents` executor (C5): the durable, idempotent
 * reaction to source withdrawal and to every finding revision — the
 * dependency-aware recomputation half of "Źródło wycofane".
 *
 * Three registered consumer edges drain into this job kind (this lane owns
 * all three projections, convex/platform/outbox.ts projectOneEdge):
 *
 * - `sources.sourceWithdrawn` → cause `source_withdrawn`: recheck the
 *   source's CURRENT lifecycle (marking follows withdrawal, never ahead of
 *   it — C2's rule), mark the findings that lost their sole witness
 *   (`markWithdrawnSupport` below), then hand EVERY removed root to the
 *   cascade by publishing one `memory.dependentsMarkedStale` carrier per
 *   root — the cascade jobs own level 1 exactly like every deeper level
 *   (one bounded transaction per job, no fat first level).
 *
 * - `memory.dependentsMarkedStale` → cause `dependent_stale`: the cascade
 *   carrier, for every level. Marks the root's direct derivation
 *   dependents `updating`-until-revalidated (value preserved verbatim,
 *   visibly marked, excluded from automation — NEVER discarded), publishes
 *   one revision-deduped carrier per newly marked dependent that has its
 *   own dependents, and registers linked re-analysis. Replay-safe
 *   (already-marked findings are skipped) and cycle-safe (a finding is
 *   marked at most once, so any cycle — a graph invariant violation —
 *   cannot loop the walk).
 *
 * - `memory.findingRevised` → cause `reanalysis`: the revalidation path.
 *   When a basis became known again (a re-analysis publication, a later
 *   independent confirmation, an explicit correction), every DIRECT
 *   dependent still in `updating` gets its linked re-analysis registered
 *   through E3's seam: a NEW `reanalysis` processing run of the dependent's
 *   own provenance source (withdrawn/purged provenance sources support no
 *   new run — their dependents stay honestly `updating` until NEW
 *   evidence). A non-known root is a no-op: the stale cascade above owns
 *   that direction.
 *
 * - `sources.sourceReassigned` → cause `source_reassigned` (E7 amendment,
 *   flagged): a project reassignment re-assesses DEPENDENT SCOPE. The
 *   moved source stays active (its evidence still witnesses), so nothing
 *   is marked unknown here; the findings whose project placement lost the
 *   source's link, narrowed to unlinked scopes, sparing explicit
 *   corrections, already-marked findings and findings with another active
 *   linked witness, become `updating`-until-revalidated through the
 *   reassignment lane's marking core, cascade to derivation dependents
 *   through the same carrier, and re-analyze through E3's seam (the new
 *   run reads the CURRENT project links).
 *
 * AMPLIFICATION NOTE (for H3's incident scanning): the findingRevised edge
 * fires one durable walk per revision — including the cascade's own
 * markings, most of which no-op. Accepted for alpha volume; per-reaction
 * outcomes live on the durableJobs rows and each walk is one bounded
 * indexed query.
 *
 * IDENTITY (review round 1, MAJOR 2): a deferred durable job must not die
 * on live-session availability — the withdrawer's session can be revoked
 * between the withdrawal transaction and this reaction, and an
 * `actor_session_unavailable` retry exhausts in seconds, leaving a
 * withdrawn source whose findings stay known and automation-eligible.
 * The marking here is therefore IDENTITY-INDEPENDENT: it calls the ONE
 * parameterized core (`markWithdrawnSupport`, ../findings/withdrawal.ts)
 * with the tenant and the recording user as arguments — the withdrawal's
 * actor (fallback: the source's author), both real user rows recorded
 * honestly as the marking's author, with the system-driven nature explicit
 * in the revision's reason and origin. C2's `performWithdrawalMarking` is
 * the same core behind the RequestContext-backed entry; the revision row,
 * projection patch and event payload exist exactly once.
 *
 * Recompute = linked re-analysis that cannot overwrite a newer correction:
 *   E3's publish re-checks the analysis's input revisions against CURRENT
 *   counters (C2's stale-plan guard), and this executor never writes a
 *   revision except a marking that preserves the value verbatim.
 *
 * Durable checkpoints / resumability: every level is one transaction whose
 * committed marking revisions, published events and registered jobs ARE
 * the checkpoints; a crash mid-transaction rolls back the whole level, a
 * retry re-runs it idempotently (no duplicate revisions, no missed
 * dependents — the events persist). The `updating` knowledge state is the
 * visible incomplete state until revalidation replaces it.
 */

import { Schema } from "effect";
import { events, executors } from "@kiero/contracts";
import {
  dependentUpdatingReason,
  directDependents,
  explicitUpdating,
  groupRecomputeBatches,
  decideDependentRecomputation,
  updatingUntilRevalidatedReason,
  type RecomputeTarget,
} from "@kiero/domain";
import { publishEvent, registerDurableJob } from "../../platform/publish";
import type { JobExecutor } from "../../platform/executors";
import type { MutationCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import { markWithdrawnSupport } from "../findings/withdrawal";
// E7 amendment (flagged): the reassignment lane's scope-marking core (the
// same one-core pattern as the withdrawal marking above).
import { markReassignedScope } from "../../sources/reassign/dependents";
import { encodeKnowledgeState, knowledgeTagOf } from "../findings/semantics";
import { RECOMPUTE_PIPELINE_VERSION } from "./withdrawal";

/** The decoded shape of this executor's input (registry schema authority). */
interface RecomputeInput {
  readonly rootFindingId: string | null;
  readonly sourceId: string | null;
  readonly cause:
    | "source_withdrawn"
    | "dependent_stale"
    | "reanalysis"
    | "source_reassigned";
  readonly reason: string | null;
  readonly withdrawnByUserId: string | null;
  /**
   * E7 amendment (flagged): the reassigning user of the
   * `source_reassigned` cause (optional like the registry key; absent on
   * every other cause).
   */
  readonly reassignedByUserId?: string | null;
}

/** Retry policy of the linked re-analysis registrations (E3's bound). */
const ANALYSIS_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

// ---------------------------------------------------------------------------
// The roots: which findings did one withdrawal remove support from.
// ---------------------------------------------------------------------------

/**
 * The findings whose CURRENT revision is a withdrawal marking of THIS
 * withdrawal: the marking revision itself carries no evidence links (they
 * stay on the superseded revision it preserves verbatim), so the walk
 * resolves each source-linked revision to its FINDING and matches the
 * marking revision's `withdrawnSourceId` — attribution by SOURCE ID, never
 * by reason text, so a marking left by a DIFFERENT withdrawal is never
 * adopted (its own reaction owns it). Fresh and prior markings of this
 * withdrawal alike, so a replayed or retried job derives the same root set
 * from committed state.
 */
async function withdrawnRootFindings(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  sourceId: Id<"sources">,
): Promise<Id<"findings">[]> {
  const links = await db
    .query("evidenceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const findingIds = new Set<Id<"findings">>();
  for (const link of links) {
    const revision = await db.get(link.findingRevisionId);
    if (revision !== null) {
      findingIds.add(revision.findingId);
    }
  }
  const roots: Id<"findings">[] = [];
  for (const findingId of findingIds) {
    const finding = await db.get(findingId);
    if (finding === null || finding.companyId !== companyId) {
      continue; // tenant scope: foreign rows are never recomputed
    }
    if (finding.currentRevisionId === undefined) {
      continue;
    }
    const currentRevision = await db.get(finding.currentRevisionId);
    if (
      currentRevision !== null &&
      currentRevision.origin === "withdrawal_marking" &&
      currentRevision.withdrawnSourceId === sourceId
    ) {
      roots.push(finding._id);
    }
  }
  return roots;
}

// ---------------------------------------------------------------------------
// Linked re-analysis registration (the E3 seam).
// ---------------------------------------------------------------------------

/** Registers one bounded re-analysis group: a NEW linked run + durable job. */
async function registerReanalysis(
  tx: MutationCtx,
  companyId: Id<"companies">,
  sourceId: Id<"sources">,
  triggerKey: string,
): Promise<boolean> {
  // Bounded per (provenance source, trigger): the same source hit at two
  // cascade levels of one storm may re-analyze once more; both runs read
  // fresh context and C2's guard keeps them from overwriting each other's
  // newer corrections.
  const dedupKey = `processing.analyze:memory.recompute:${sourceId}:${triggerKey}`;
  // Dedup BEFORE the run insert: an already-registered (active or
  // succeeded) reaction must not grow an orphaned run row. A definitely
  // FAILED row is the one re-registration path — registerDurableJob
  // re-queues it with the new run's input.
  const existing = await tx.db
    .query("durableJobs")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
    .first();
  if (existing !== null && existing.state !== "failed") {
    return false;
  }
  const nowMs = Date.now();
  const originalRun = await tx.db
    .query("processingRuns")
    .withIndex("by_source_started", (q) => q.eq("sourceId", sourceId))
    .order("asc")
    .filter((q) => q.eq(q.field("kind"), "initial_analysis"))
    .first();
  const runId = await tx.db.insert("processingRuns", {
    companyId,
    sourceId,
    kind: "reanalysis",
    ...(originalRun === null ? {} : { reanalysisOfRunId: originalRun._id }),
    pipelineVersion: RECOMPUTE_PIPELINE_VERSION,
    promptVersion: "none",
    schemaVersion: "none",
    modelConfigurationVersion: "none",
    state: "running",
    startedAtMs: nowMs,
  });
  await registerDurableJob(tx, {
    kind: "processing.analyze_change_plan",
    input: {
      sourceId,
      processingRunId: runId,
      reanalysisOfRunId: originalRun === null ? null : originalRun._id,
    },
    companyId,
    sourceId,
    processingRunId: runId,
    policy: ANALYSIS_RETRY_POLICY,
    dedupKey,
  });
  return true;
}

/** Registers the re-analysis of every active provenance source in the batch. */
async function registerReanalysisGroups(
  tx: MutationCtx,
  companyId: Id<"companies">,
  targets: RecomputeTarget[],
  triggerKey: string,
): Promise<number> {
  const groups = groupRecomputeBatches(targets);
  let registered = 0;
  for (const group of groups) {
    const sourceId = tx.db.normalizeId("sources", group.sourceId);
    if (sourceId === null) {
      continue;
    }
    if (await registerReanalysis(tx, companyId, sourceId, triggerKey)) {
      registered += 1;
    }
  }
  return registered;
}

// ---------------------------------------------------------------------------
// The stale cascade: mark one root's direct dependents.
// ---------------------------------------------------------------------------

/**
 * Publishes the cascade carrier for one newly marked root: the durable
 * checkpoint whose drain registers the next bounded level's job. The
 * payload names the root's direct dependents; the actor is carried so the
 * level's markings record the same user the cascade started from.
 */
async function publishCascadeCarrier(
  tx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    actorUserId: Id<"users">;
    rootFindingId: Id<"findings">;
    markingRevisionId: Id<"findingRevisions">;
  },
): Promise<void> {
  const childEdges = await tx.db
    .query("findingDependencies")
    .withIndex("by_depends_on", (q) => q.eq("dependsOnFindingId", args.rootFindingId))
    .collect();
  if (childEdges.length === 0) {
    return;
  }
  const dependentsMarkedStale = events["memory.dependentsMarkedStale"];
  if (dependentsMarkedStale === undefined) {
    throw new Error("recompute: memory.dependentsMarkedStale missing from the registry");
  }
  await publishEvent(tx, {
    companyId: args.companyId,
    eventName: "memory.dependentsMarkedStale",
    payload: {
      rootFindingId: args.rootFindingId,
      dependentFindingIds: directDependents(
        childEdges.map((edge) => ({
          dependent: edge.dependentFindingId,
          dependsOn: edge.dependsOnFindingId,
        })),
        args.rootFindingId,
      ),
      withdrawnByUserId: args.actorUserId,
    },
    // Revision-unique: a replayed level can never re-fire the cascade.
    dedupKey: `memory.dependentsMarkedStale:${args.rootFindingId}:${args.markingRevisionId}`,
  });
}

/** One resolved direct dependent of a root: its live row and current revision. */
interface ResolvedDependent {
  readonly cause: "derivation" | "shared_evidence" | "assignment";
  readonly finding: Doc<"findings">;
  readonly currentRevision: Doc<"findingRevisions">;
}

/**
 * Resolves one root's DIRECT dependents: each distinct edge's finding,
 * tenant-checked, with its current revision — the shared opening of the
 * stale-marking and revalidation walks. The per-dependent decisions stay
 * with their callers.
 */
async function resolveDirectDependents(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  rootFindingId: Id<"findings">,
): Promise<ResolvedDependent[]> {
  const edgeRows = await db
    .query("findingDependencies")
    .withIndex("by_depends_on", (q) => q.eq("dependsOnFindingId", rootFindingId))
    .collect();
  const seen = new Set<Id<"findings">>();
  const resolved: ResolvedDependent[] = [];
  for (const edge of edgeRows) {
    if (seen.has(edge.dependentFindingId)) {
      continue;
    }
    seen.add(edge.dependentFindingId);
    const finding = await db.get(edge.dependentFindingId);
    if (finding === null || finding.companyId !== companyId) {
      continue; // tenant scope: cross-company edges are never followed
    }
    if (finding.currentRevisionId === undefined) {
      continue;
    }
    const currentRevision = await db.get(finding.currentRevisionId);
    if (currentRevision === null) {
      continue;
    }
    resolved.push({ cause: edge.cause, finding, currentRevision });
  }
  return resolved;
}

/**
 * Marks the direct dependents of one root finding `updating`-until-
 * revalidated and registers their linked re-analysis — one bounded,
 * all-or-nothing transaction level. Everything that can refuse runs before
 * the first write; every write is idempotent on replay.
 */
async function markStaleDependents(
  tx: MutationCtx,
  args: {
    companyId: Id<"companies">;
    actorUserId: Id<"users">;
    rootFindingId: Id<"findings">;
    triggerKey: string;
    cause: string;
  },
): Promise<void> {
  const { companyId, actorUserId, rootFindingId } = args;

  // The validating pass: resolve the direct dependents, read their witness
  // lifecycles, decide, and COLLECT the markings.
  const decisions: ResolvedDependent[] = [];
  for (const dependent of await resolveDirectDependents(tx.db, companyId, rootFindingId)) {
    const links = await tx.db
      .query("evidenceLinks")
      .withIndex("by_revision", (q) =>
        q.eq("findingRevisionId", dependent.currentRevision._id),
      )
      .collect();
    const witnesses = [];
    for (const link of links) {
      const source = await tx.db.get(link.sourceId);
      witnesses.push({
        sourceId: link.sourceId,
        supportKind: link.supportKind,
        sourceActive: source !== null && source.lifecycle === "active",
      });
    }
    const decision = decideDependentRecomputation({
      cause: dependent.cause,
      currentRevisionOrigin: dependent.currentRevision.origin,
      currentKnowledgeTag: knowledgeTagOf(dependent.currentRevision.knowledgeState),
      currentWitnesses: witnesses,
    });
    if (decision.decision === "mark_updating") {
      decisions.push(dependent);
    }
  }

  const findingRevised = events["memory.findingRevised"];
  if (findingRevised === undefined) {
    throw new Error("recompute: memory.findingRevised missing from the registry");
  }

  // --- the commit loop: only pre-validated writes from here ----------------
  const nowMs = Date.now();
  const targets: RecomputeTarget[] = [];
  for (const marked of decisions) {
    const markedKnowledge = encodeKnowledgeState(
      explicitUpdating(updatingUntilRevalidatedReason(args.rootFindingId)),
    );
    const revisionId = await tx.db.insert("findingRevisions", {
      findingId: marked.finding._id,
      revision: marked.finding.revisionCounter + 1,
      // The inferred value is preserved verbatim; only its epistemic state
      // moves to updating-until-revalidated (never discarded).
      value: marked.currentRevision.value,
      knowledgeState: markedKnowledge,
      supersedesRevisionId: marked.currentRevision._id,
      origin: "withdrawal_marking",
      reason: dependentUpdatingReason(args.rootFindingId, args.cause),
      recordedByUserId: actorUserId,
      recordedAtMs: nowMs,
    });
    await tx.db.patch(marked.finding._id, {
      currentRevisionId: revisionId,
      knowledgeState: markedKnowledge,
      revisionCounter: marked.finding.revisionCounter + 1,
      updatedAtMs: nowMs,
    });
    await publishEvent(tx, {
      companyId: args.companyId,
      eventName: "memory.findingRevised",
      payload: {
        findingId: marked.finding._id,
        revisionId,
        supersedesRevisionId: marked.currentRevision._id,
      },
      dedupKey: `memory.findingRevised:${revisionId}`,
    });
    if (marked.currentRevision.provenance !== undefined) {
      const provenanceSource = await tx.db.get(marked.currentRevision.provenance.sourceId);
      targets.push({
        findingId: marked.finding._id,
        provenanceSourceId: marked.currentRevision.provenance.sourceId,
        provenanceSourceActive:
          provenanceSource !== null && provenanceSource.lifecycle === "active",
      });
    }
    // The cascade carrier: this marking is the durable checkpoint; the next
    // bounded level is a durable job, not a loop in this transaction.
    await publishCascadeCarrier(tx, {
      companyId,
      actorUserId,
      rootFindingId: marked.finding._id,
      markingRevisionId: revisionId,
    });
  }
  await registerReanalysisGroups(tx, companyId, targets, args.triggerKey);
}

// ---------------------------------------------------------------------------
// The revalidation path: a basis became known again.
// ---------------------------------------------------------------------------

/**
 * Registers linked re-analysis for every DIRECT dependent still in
 * `updating` whose basis (the root) is known again. Registrations only —
 * the re-analysis's checked publication (or a boss's explicit correction)
 * performs the actual revalidation; this code never writes a finding.
 */
async function revalidateUpdatingDependents(
  tx: MutationCtx,
  args: { companyId: Id<"companies">; rootFindingId: Id<"findings">; triggerKey: string },
): Promise<number> {
  const targets: RecomputeTarget[] = [];
  for (const dependent of await resolveDirectDependents(
    tx.db,
    args.companyId,
    args.rootFindingId,
  )) {
    if (knowledgeTagOf(dependent.currentRevision.knowledgeState) !== "updating") {
      continue;
    }
    if (dependent.currentRevision.provenance === undefined) {
      continue;
    }
    const provenanceSource = await tx.db.get(dependent.currentRevision.provenance.sourceId);
    targets.push({
      findingId: dependent.finding._id,
      provenanceSourceId: dependent.currentRevision.provenance.sourceId,
      provenanceSourceActive:
        provenanceSource !== null && provenanceSource.lifecycle === "active",
    });
  }
  return registerReanalysisGroups(tx, args.companyId, targets, args.triggerKey);
}

// ---------------------------------------------------------------------------
// The executor.
// ---------------------------------------------------------------------------

/** The registered executor for `memory.recompute_dependents`. */
export const recomputeDependentsExecutor: JobExecutor = {
  jobKind: "memory.recompute_dependents",
  execute: async (ctx, job, input) => {
    const entry = executors.find((candidate) => candidate.jobKind === job.kind);
    if (entry === undefined) {
      return { outcome: "failed", errorKind: "executor_not_registered", retryable: false };
    }
    let decoded: RecomputeInput;
    try {
      decoded = Schema.decodeUnknownSync(entry.input)(input) as RecomputeInput;
    } catch {
      return { outcome: "failed", errorKind: "job_input_rejected", retryable: false };
    }
    const companyId = ctx.db.normalizeId("companies", job.companyId ?? "");
    if (companyId === null) {
      return { outcome: "failed", errorKind: "company_scope_missing", retryable: false };
    }
    const triggerKey = job.dedupKey ?? job.jobKey;

    if (decoded.cause === "source_withdrawn") {
      const sourceId = ctx.db.normalizeId("sources", decoded.sourceId ?? "");
      if (sourceId === null) {
        return { outcome: "failed", errorKind: "source_id_invalid", retryable: false };
      }
      const source = await ctx.db.get(sourceId);
      if (source === null) {
        return { outcome: "failed", errorKind: "source_missing", retryable: false };
      }
      if (source.companyId !== companyId) {
        return { outcome: "failed", errorKind: "tenant_scope_mismatch", retryable: false };
      }
      // CURRENT lifecycle recheck: marking follows the explicit transition
      // (C2's rule) and stale work can never restore removed support.
      if (source.lifecycle !== "withdrawn") {
        return { outcome: "failed", errorKind: "source_not_withdrawn", retryable: false };
      }
      const reason = decoded.reason ?? source.withdrawnReason ?? "source withdrawn";
      const preferredActor = ctx.db.normalizeId("users", decoded.withdrawnByUserId ?? "");
      const actorUserId =
        preferredActor === null
          ? ctx.db.normalizeId("users", source.authorUserId)
          : preferredActor;
      if (actorUserId === null) {
        return { outcome: "failed", errorKind: "actor_unresolved", retryable: false };
      }
      // The marking is identity-independent (see the header): the shared
      // core takes tenant + recording user directly, so the reaction never
      // waits for a live session and cannot die on identity availability
      // after a withdrawal already committed.
      const marking = await markWithdrawnSupport(ctx, {
        companyId,
        actorUserId,
        sourceId: source._id,
        reason,
      });
      if (marking._tag === "error") {
        return {
          outcome: "failed",
          errorKind: `withdrawal_marking_refused:${marking.error.code}`,
          retryable: false,
        };
      }
      const roots = await withdrawnRootFindings(ctx.db, companyId, source._id);
      // Hand EVERY root (freshly marked here, or marked by an earlier
      // attempt of this same withdrawal — the carrier's revision-unique
      // dedup collapses the replay) to the cascade: the carrier jobs own
      // level 1 exactly like every deeper level — one bounded transaction
      // each, no fat first level inside this job.
      for (const root of roots) {
        const rootRow = await ctx.db.get(root);
        if (rootRow === null || rootRow.currentRevisionId === undefined) {
          continue; // a root that lost its current revision carries nothing
        }
        await publishCascadeCarrier(ctx, {
          companyId,
          actorUserId,
          rootFindingId: root,
          markingRevisionId: rootRow.currentRevisionId,
        });
      }
      return { outcome: "succeeded" };
    }

    // E7 amendment (flagged, issue #115): the scope re-assessment reaction
    // of one project reassignment. The marking is identity-independent like
    // the withdrawal half (the reassigning user, fallback the source's
    // author, recorded honestly as the marking's author), rechecks the
    // source's CURRENT lifecycle and CURRENT links (marking follows the
    // link change; only an active source's placement re-assesses), marks
    // the narrowed scope findings through the reassignment lane's own core
    // (../sources/reassign/dependents.ts), hands every marked root to the
    // SAME cascade carrier as withdrawal, and registers the marked
    // findings' linked re-analysis (an active source re-analyzes: the new
    // run reads the CURRENT project links and re-derives placement).
    if (decoded.cause === "source_reassigned") {
      const sourceId = ctx.db.normalizeId("sources", decoded.sourceId ?? "");
      if (sourceId === null) {
        return { outcome: "failed", errorKind: "source_id_invalid", retryable: false };
      }
      const source = await ctx.db.get(sourceId);
      if (source === null) {
        return { outcome: "failed", errorKind: "source_missing", retryable: false };
      }
      if (source.companyId !== companyId) {
        return { outcome: "failed", errorKind: "tenant_scope_mismatch", retryable: false };
      }
      // CURRENT lifecycle recheck: withdrawal/purge own the stronger
      // reactions for their lifecycles; scope re-assessment never runs
      // around them.
      if (source.lifecycle !== "active") {
        return { outcome: "failed", errorKind: "source_not_active", retryable: false };
      }
      const preferredActor = ctx.db.normalizeId("users", decoded.reassignedByUserId ?? "");
      const actorUserId =
        preferredActor === null
          ? ctx.db.normalizeId("users", source.authorUserId)
          : preferredActor;
      if (actorUserId === null) {
        return { outcome: "failed", errorKind: "actor_unresolved", retryable: false };
      }
      const links = await ctx.db
        .query("sourceProjectLinks")
        .withIndex("by_source", (q) => q.eq("sourceId", source._id))
        .collect();
      const marking = await markReassignedScope(ctx, {
        companyId,
        actorUserId,
        sourceId: source._id,
        currentProjectIds: links.map((link) => link.projectId),
      });
      if (marking._tag === "error") {
        return {
          outcome: "failed",
          errorKind: `scope_marking_refused:${marking.error.code}`,
          retryable: false,
        };
      }
      const marked = marking.value as {
        markedFindingIds: Id<"findings">[];
        targets: RecomputeTarget[];
      };
      for (const root of marked.markedFindingIds) {
        const rootRow = await ctx.db.get(root);
        if (rootRow === null || rootRow.currentRevisionId === undefined) {
          continue; // a root that lost its current revision carries nothing
        }
        await publishCascadeCarrier(ctx, {
          companyId,
          actorUserId,
          rootFindingId: root,
          markingRevisionId: rootRow.currentRevisionId,
        });
      }
      await registerReanalysisGroups(ctx, companyId, marked.targets, triggerKey);
      return { outcome: "succeeded" };
    }

    const rootFindingId = ctx.db.normalizeId("findings", decoded.rootFindingId ?? "");
    if (rootFindingId === null) {
      return { outcome: "failed", errorKind: "root_finding_id_invalid", retryable: false };
    }
    const root = await ctx.db.get(rootFindingId);
    if (root === null || root.companyId !== companyId) {
      return { outcome: "failed", errorKind: "root_finding_missing", retryable: false };
    }

    if (decoded.cause === "dependent_stale") {
      // The cascade carrier: markings record the withdrawal's actor; when
      // the event did not carry one, the root's own marking revision names
      // the actor the cascade already used.
      let actorUserId = ctx.db.normalizeId("users", decoded.withdrawnByUserId ?? "");
      if (actorUserId === null && root.currentRevisionId !== undefined) {
        const currentRevision = await ctx.db.get(root.currentRevisionId);
        actorUserId =
          currentRevision === null
            ? null
            : ctx.db.normalizeId("users", currentRevision.recordedByUserId);
      }
      if (actorUserId === null) {
        return { outcome: "failed", errorKind: "actor_unresolved", retryable: true };
      }
      await markStaleDependents(ctx, {
        companyId,
        actorUserId,
        rootFindingId,
        triggerKey,
        cause: "dependent_stale",
      });
      return { outcome: "succeeded" };
    }

    // cause "reanalysis": the revalidation walk. Non-known roots are a
    // no-op (the stale cascade owns that direction); a known basis
    // revalidates its updating dependents through linked re-analysis.
    if (root.currentRevisionId !== undefined) {
      const currentRevision = await ctx.db.get(root.currentRevisionId);
      if (
        currentRevision !== null &&
        knowledgeTagOf(currentRevision.knowledgeState) === "known"
      ) {
        await revalidateUpdatingDependents(ctx, { companyId, rootFindingId, triggerKey });
      }
    }
    return { outcome: "succeeded" };
  },
};
