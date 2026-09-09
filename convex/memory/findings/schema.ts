/**
 * Memory findings, revisions, provenance and publication tables
 * (candidate fragment, A2).
 *
 * Owning implementers: C2 (atomic findings/revisions/provenance/corrections),
 * C5 (withdrawal and dependency-aware recomputation), E3 (change plans).
 *
 * Revisions are immutable; current state is readable without replaying the
 * conversation. `recordedAtMs` is trusted system time; `effectiveFrom` exists
 * only when evidence establishes when the agreement applied. Derivations are
 * acyclic and inference is never another witness; withdrawal/correction can
 * locate affected dependents without discarding independent evidence.
 *
 * Tables: findings, findingRevisions, evidenceLinks, findingDependencies,
 * changeSets, publicationGroups, clarifications.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, semanticValueFields, semanticValueValidators } from "../../schema/shared";

export const findingsTables = {
  /** Stable finding identity within one semantic scope (firm or project memory). */
  findings: defineTable({
    companyId: shared.companyId,
    scopeKind: v.union(v.literal("company"), v.literal("project")),
    scopeProjectId: v.optional(shared.projectId),
    semanticKey: v.string(),
    currentRevisionId: v.optional(shared.findingRevisionId),
    /** Current knowledge state, stored through the proved semantic conversion. */
    knowledgeState: semanticValueValidators.knowledgeState,
    revisionCounter: shared.revisionCounter,
    updatedAtMs: shared.tsMs,
  })
    .index("by_company_scope_key", ["companyId", "scopeProjectId", "semanticKey"])
    .index("by_project", ["companyId", "scopeProjectId"]),

  /** Immutable snapshot of one recorded revision. Never edited, only superseded. */
  findingRevisions: defineTable({
    findingId: shared.findingId,
    revision: shared.revisionCounter,
    value: semanticValueValidators.findingValue,
    knowledgeState: semanticValueValidators.knowledgeState,
    /** Present only when evidence establishes when the agreement applied. */
    effectiveFrom: semanticValueFields.temporalValue,
    supersedesRevisionId: v.optional(shared.findingRevisionId),
    provenance: shared.provenance,
  }).index("by_finding_revision", ["findingId", "revision"]),

  /** Typed evidence support between a revision and a source fragment. */
  evidenceLinks: defineTable({
    findingRevisionId: shared.findingRevisionId,
    sourceFragmentId: shared.sourceFragmentId,
    supportKind: v.union(
      v.literal("support"),
      v.literal("independent_corroboration"),
      v.literal("derivation"),
      v.literal("supersession"),
    ),
    extractionId: v.optional(shared.extractionId),
  })
    .index("by_revision", ["findingRevisionId"])
    .index("by_fragment", ["sourceFragmentId"]),

  /** Dependency graph between findings (acyclic by domain rule, C5). */
  findingDependencies: defineTable({
    companyId: shared.companyId,
    dependentFindingId: shared.findingId,
    dependsOnFindingId: shared.findingId,
    cause: v.union(
      v.literal("derivation"),
      v.literal("shared_evidence"),
      v.literal("assignment"),
    ),
    derivationRevisionId: v.optional(shared.findingRevisionId),
    createdAtMs: shared.tsMs,
  })
    .index("by_dependent", ["dependentFindingId"])
    .index("by_depends_on", ["dependsOnFindingId"]),

  /** One checked memory change prepared from a source; staged publication. */
  changeSets: defineTable({
    companyId: shared.companyId,
    sourceId: shared.sourceId,
    state: v.union(
      v.literal("prepared"),
      v.literal("publishing"),
      v.literal("published"),
      v.literal("failed"),
      v.literal("superseded"),
    ),
    preparedAtMs: shared.tsMs,
    publishedAtMs: v.optional(shared.tsMs),
    failedReason: v.optional(v.string()),
  })
    .index("by_source", ["sourceId"])
    .index("by_company_state", ["companyId", "state"]),

  /** Atomically-publishing dependent group inside a change set. */
  publicationGroups: defineTable({
    changeSetId: shared.changeSetId,
    memberRevisionIds: v.array(shared.findingRevisionId),
    expectedRevisions: v.array(
      v.object({ findingId: shared.findingId, revision: shared.revisionCounter }),
    ),
    state: v.union(
      v.literal("prepared"),
      v.literal("published"),
      v.literal("failed"),
    ),
  }).index("by_change_set", ["changeSetId"]),

  /** Shared open question for entitled bosses; resolution keeps its author. */
  clarifications: defineTable({
    companyId: shared.companyId,
    scopeKind: v.union(v.literal("company"), v.literal("project")),
    scopeProjectId: v.optional(shared.projectId),
    question: v.string(),
    conflictingFragmentIds: v.array(shared.sourceFragmentId),
    state: v.union(v.literal("open"), v.literal("resolved")),
    raisedAtMs: shared.tsMs,
    raisedByRunId: v.optional(shared.processingRunId),
    resolvedByUserId: v.optional(shared.userId),
    resolutionNote: v.optional(v.string()),
    resolvedAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_state", ["companyId", "state"])
    .index("by_project", ["companyId", "scopeProjectId"]),
} as const;
