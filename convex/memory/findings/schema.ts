/**
 * Memory findings, revisions, provenance and publication tables
 * (A2 candidate, certified by A3; completed by C2 for the atomic
 * findings/revisions/provenance/corrections lane).
 *
 * Owning implementers: C2 (this lane), C5 (withdrawal recomputation over
 * these rows), E3 (change-plan preparation feeding these transactions).
 *
 * Revisions are immutable; the findings row is the CURRENT projection and is
 * only ever patched inside the same transaction that writes the revision it
 * projects (publication, correction or withdrawal marking) — it is never
 * separately editable. `recordedAtMs` is trusted system time;
 * `effectiveFrom` exists only when evidence establishes when the agreement
 * applied. Derivations are acyclic (checked at prepare AND re-checked at
 * publish) and inference is never another witness; withdrawal/correction
 * locates affected findings without discarding independent evidence.
 *
 * C2 amendments (the owning lane completes the candidate fragment):
 * - `findingRevisions.origin` + optional `provenance`/`reason` +
 *   `recordedByUserId`/`recordedAtMs`: a revision names WHERE it came from —
 *   a source-backed publication (provenance: source, fragments, actor),
 *   an explicit correction (author, time, reason; issue 8: "osobnym
 *   rozstrzygnięciem z autorem, czasem i historią") or a withdrawal marking.
 * - `evidenceLinks.sourceId` required with optional fragment: whole-source
 *   evidence is first-class ("Gdy nie da się wiarygodnie wskazać fragmentu,
 *   podstawą pozostaje cały materiał") and tenant checks key on the source;
 *   fragment-typed links arrive with E3's extractions.
 * - `publicationGroups.plannedChanges`: the staged, decoded plan with the
 *   expectations captured at prepare time — the stale-plan guard's base.
 *
 * Tables: findings, findingRevisions, evidenceLinks, findingDependencies,
 * changeSets, publicationGroups, clarifications.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  shared,
  semanticValueFields,
  semanticValueValidators,
  type Encoded,
  type ValueValidator,
} from "../../schema/shared";
import { PublicationState } from "@kiero/contracts";

// Vocabulary pin: the change-set lifecycle must equal the contracts-side
// PublicationState literals exactly, or this file fails typecheck.
const publicationState: ValueValidator<Encoded<typeof PublicationState>> = v.union(
  v.literal("prepared"),
  v.literal("publishing"),
  v.literal("published"),
  v.literal("failed"),
  v.literal("superseded"),
);

/** Where one recorded revision came from (its provenance shape follows). */
const revisionOrigin = v.union(
  v.literal("publication"),
  v.literal("correction"),
  v.literal("withdrawal_marking"),
  // E7 amendment (additive, flagged): the scope re-assessment marking of a
  // project reassignment: value preserved verbatim, knowledge state
  // updating-until-revalidated, never a withdrawal.
  v.literal("reassignment_marking"),
  // I4 amendment (additive, flagged, the E7 precedent): the support-removal
  // marking of a permanent source deletion (issue #56): a purged source can
  // witness nothing, so findings it alone supported become unknown with a
  // machine reason, attributed by SOURCE ID.
  v.literal("purge_marking"),
);

/** Witness kinds a PLAN may claim (derivation/supersession are not witnesses). */
const plannedSupportKind = v.union(
  v.literal("support"),
  v.literal("independent_corroboration"),
);

/** One staged planned change: the decoded plan persisted at prepare time. */
const plannedChange = v.object({
  findingId: v.optional(shared.findingId),
  scopeKind: v.union(v.literal("company"), v.literal("project")),
  scopeProjectId: v.optional(shared.projectId),
  semanticKey: v.string(),
  value: semanticValueValidators.findingValue,
  knowledgeState: semanticValueValidators.knowledgeState,
  effectiveFrom: semanticValueFields.temporalValue,
  evidence: v.array(
    v.object({
      sourceId: shared.sourceId,
      sourceFragmentId: v.optional(shared.sourceFragmentId),
      supportKind: plannedSupportKind,
      extractionId: v.optional(shared.extractionId),
    }),
  ),
  derivesFrom: v.array(shared.findingId),
});

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
    revisionCounter: shared.counter,
    updatedAtMs: shared.tsMs,
  })
    // by_project (companyId, scopeProjectId) is intentionally absent: it is
    // a strict prefix of by_company_scope_key.
    .index("by_company_scope_key", ["companyId", "scopeProjectId", "semanticKey"]),

  /**
   * Immutable snapshot of one recorded revision. Never edited, only superseded.
   * The origin names the change path; a publication carries source-backed
   * provenance, a correction or marking carries author, time and reason.
   */
  findingRevisions: defineTable({
    findingId: shared.findingId,
    revision: shared.counter,
    value: semanticValueValidators.findingValue,
    knowledgeState: semanticValueValidators.knowledgeState,
    /** Present only when evidence establishes when the agreement applied. */
    effectiveFrom: semanticValueFields.temporalValue,
    supersedesRevisionId: v.optional(shared.findingRevisionId),
    origin: revisionOrigin,
    /** Source-backed provenance (publications); absent for corrections. */
    provenance: v.optional(shared.provenance),
    /** Why an explicit correction or withdrawal marking happened. */
    reason: v.optional(v.string()),
    /**
     * C5 amendment (additive, flagged): the source whose withdrawal a
     * marking revision belongs to. Attribution is by SOURCE ID, never by
     * reason text (two withdrawals may share wording); recomputation
     * adopts only the roots of its own withdrawal.
     */
    withdrawnSourceId: v.optional(shared.sourceId),
    /**
     * E7 amendment (additive, flagged): the source whose project
     * reassignment a `reassignment_marking` revision belongs to (the same
     * by-SOURCE-ID attribution rule; a withdrawal marking never carries
     * one).
     */
    reassignedSourceId: v.optional(shared.sourceId),
    /**
     * I4 amendment (additive, flagged, the E7 attribution precedent): the
     * source whose permanent deletion a `purge_marking` revision belongs
     * to (by SOURCE ID, never by reason text).
     */
    purgedSourceId: v.optional(shared.sourceId),
    recordedByUserId: shared.userId,
    recordedAtMs: shared.tsMs,
  }).index("by_finding_revision", ["findingId", "revision"]),

  /**
   * Typed evidence support between a revision and a source or one of its
   * fragments. `independent_corroboration` is a second witness, not a
   * derivation; withdrawal keys on `sourceId` to find what it supported.
   */
  evidenceLinks: defineTable({
    findingRevisionId: shared.findingRevisionId,
    sourceId: shared.sourceId,
    /** Absent = whole-source evidence (no fragment reliably identifiable). */
    sourceFragmentId: v.optional(shared.sourceFragmentId),
    supportKind: v.union(
      v.literal("support"),
      v.literal("independent_corroboration"),
      v.literal("derivation"),
      v.literal("supersession"),
    ),
    extractionId: v.optional(shared.extractionId),
    createdAtMs: shared.tsMs,
  })
    .index("by_revision", ["findingRevisionId"])
    .index("by_fragment", ["sourceFragmentId"])
    .index("by_source", ["sourceId"]),

  /** Dependency graph between findings (acyclic by domain rule, re-checked). */
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
    .index("by_depends_on", ["dependsOnFindingId"])
    .index("by_company", ["companyId"]),

  /** One checked memory change prepared from a source; staged publication. */
  changeSets: defineTable({
    companyId: shared.companyId,
    sourceId: shared.sourceId,
    state: publicationState,
    preparedAtMs: shared.tsMs,
    publishedAtMs: v.optional(shared.tsMs),
    failedReason: v.optional(v.string()),
  })
    .index("by_source", ["sourceId"])
    .index("by_company_state", ["companyId", "state"]),

  /**
   * The atomically-publishing dependent group inside a change set: the
   * staged plan plus the expectations captured at prepare time (the
   * stale-plan guard compares them to the CURRENT counters at publish).
   */
  publicationGroups: defineTable({
    changeSetId: shared.changeSetId,
    plannedChanges: v.array(plannedChange),
    expectedRevisions: v.array(
      v.object({ findingId: shared.findingId, revision: shared.counter }),
    ),
    memberRevisionIds: v.optional(v.array(shared.findingRevisionId)),
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
    /**
     * R1 amendment (additive, flagged on the E7 precedent): whether the
     * resolution's basis is source-backed or a manual boss decision.
     * Absent on open rows and on PRE-REPAIR resolved rows — the read side
     * then reports `legacy_unknown`, never a guessed manual decision.
     */
    resolutionBasis: v.optional(
      v.union(
        v.literal("source_backed"),
        v.literal("manual_boss_decision"),
      ),
    ),
    /**
     * R1 amendment (additive, flagged): the normalized evidence references a
     * source-backed resolution rests on (validated company-owned active
     * source + matching fragment). `sourceFragmentId` absent = whole-source
     * evidence, the fragment contract's rule.
     */
    resolutionEvidence: v.optional(
      v.array(
        v.object({
          sourceId: shared.sourceId,
          sourceFragmentId: v.optional(shared.sourceFragmentId),
        }),
      ),
    ),
    /**
     * R2 amendment (additive, flagged on the R1 precedent): the content-free
     * audit trail of one row's purge redaction (issue #127) — WHICH source
     * deletions contributed and WHEN each text was replaced. Never carries
     * any text of the removed content. Absent on rows no purge touched;
     * pre-existing rows read as un-redacted until a purge reaches them.
     */
    purgeAudit: v.optional(
      v.object({
        /** Every permanently deleted source this row was redacted for. */
        redactedSourceIds: v.array(shared.sourceId),
        /** Set when the stored question text was replaced by the fixed copy. */
        questionRedactedAtMs: v.optional(shared.tsMs),
        /** Set when the stored resolution note was replaced by the fixed copy. */
        resolutionNoteRedactedAtMs: v.optional(shared.tsMs),
      }),
    ),
  })
    .index("by_company_state", ["companyId", "state"])
    .index("by_project", ["companyId", "scopeProjectId"]),
} as const;
