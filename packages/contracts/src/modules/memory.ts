/**
 * Memory/findings module surface (architecture "Deep modules": Memory).
 * Implements lanes: C2 (findings/revisions/provenance), C3 (extensions),
 * C5 (withdrawal/recomputation), E3/E4 (change plans), E6 (answers).
 *
 * Typed states, immutable revisions, support/derivation/supersession,
 * stale-plan checks, extension definitions, independent corroboration,
 * current versus historical retrieval. Revisions are immutable: a correction
 * or a knowledge-state change writes a new revision with its own actor and
 * recorded time; reprocessing an older source cannot overwrite a newer
 * explicit correction (issue 8).
 *
 * C3 completed the extension operations this surface declared as candidates
 * (define, version, catalog search, validate-value) and added the definition
 * version reference to the extension finding value (all additive, flagged).
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { RevisionCounter } from "../actor";
import { KnowledgeState } from "../values/knowledge";
import {
  MAX_OBJECT_FIELDS,
  boundedMutableArray,
  ExtensionFieldShape,
  ExtensionValue,
} from "../values/extension";
import { MoneyValue } from "../values/money";
import { TemporalValue } from "../values/temporal";
import { PublicationState } from "../media";
import { operationEntry, eventEntry } from "./registration";

/**
 * The value of one finding: exactly one payload shape plus its knowledge state.
 *
 * C3 amendment (additive, flagged on the B3/C2 precedent): the extension
 * branch carries the `extensionVersions` row the value validates against.
 * The version reference is atomic with the payload, so every historic
 * revision stays interpretable under its original definition version after
 * labels, optional fields or newer versions appear.
 */
export const FindingValue = Schema.TaggedUnion({
  temporal: { temporal: TemporalValue },
  money: { money: MoneyValue },
  extension: {
    definitionVersionId: tableIdSchema("extensionVersions"),
    extensionValue: ExtensionValue,
  },
  text_note: { text: Schema.NonEmptyString },
});
export type FindingValue = Schema.Schema.Type<typeof FindingValue>;

/** Scope a finding belongs to: firm-wide memory or one project. */
export const FindingScope = Schema.TaggedUnion({
  company: {},
  project: { projectId: tableIdSchema("projects") },
});
export type FindingScope = Schema.Schema.Type<typeof FindingScope>;

/**
 * One evidence reference inside a planned revision: the source (whole-source
 * evidence when `fragmentId` is null, per the fragment contract), the fragment
 * when one is reliably identifiable, and whether this is plain support or
 * INDEPENDENT corroboration — a second witness, not a derivation.
 */
export const PlannedEvidence = Schema.Struct({
  sourceId: tableIdSchema("sources"),
  fragmentId: Schema.NullOr(tableIdSchema("sourceFragments")),
  supportKind: Schema.Literals(["support", "independent_corroboration"]),
  extractionId: Schema.optionalKey(tableIdSchema("extractions")),
});
export type PlannedEvidence = Schema.Schema.Type<typeof PlannedEvidence>;

/**
 * One planned revision in a change set (C2 amendment: the certified A2 entry
 * carried only findingId/semanticKey/value/knowledgeState, which cannot
 * express scope for new findings, evidence witnesses or a derivation basis —
 * the provenance and acyclicity criteria of issue #25 are inexpressible
 * without them). Additive, flagged coordinated edit on the B3 precedent.
 */
export const PlannedRevision = Schema.Struct({
  findingId: Schema.NullOr(tableIdSchema("findings")),
  scope: FindingScope,
  semanticKey: Schema.NonEmptyString,
  value: FindingValue,
  knowledgeState: KnowledgeState,
  /** Present only when evidence establishes when the agreement applied. */
  effectiveFrom: Schema.NullOr(TemporalValue),
  evidence: Schema.Array(PlannedEvidence),
  /** Findings this revision derives from ("Wniosek agenta" needs its basis). */
  derivesFrom: Schema.Array(tableIdSchema("findings")),
});
export type PlannedRevision = Schema.Schema.Type<typeof PlannedRevision>;

export const memoryOperations = {
  "memory.readCurrentFindings": operationEntry({
    kind: "operation",
    name: "memory.readCurrentFindings",
    input: Schema.Struct({ scope: FindingScope }),
    result: Schema.Array(
      Schema.Struct({
        findingId: tableIdSchema("findings"),
        semanticKey: Schema.NonEmptyString,
        value: FindingValue,
        knowledgeState: KnowledgeState,
        currentRevisionId: tableIdSchema("findingRevisions"),
      }),
    ),
    errorKinds: ["forbidden"],
  }),
  "memory.prepareChangeSet": operationEntry({
    kind: "operation",
    name: "memory.prepareChangeSet",
    input: Schema.Struct({
      sourceId: tableIdSchema("sources"),
      plannedRevisions: Schema.Array(PlannedRevision),
    }),
    result: Schema.Struct({
      changeSetId: tableIdSchema("changeSets"),
      state: PublicationState,
    }),
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "memory.publishChangeSet": operationEntry({
    kind: "operation",
    name: "memory.publishChangeSet",
    input: Schema.Struct({
      changeSetId: tableIdSchema("changeSets"),
      expectedRevisions: Schema.Array(
        Schema.Struct({ findingId: tableIdSchema("findings"), revision: RevisionCounter }),
      ),
    }),
    result: Schema.Struct({
      publishedRevisionIds: Schema.Array(tableIdSchema("findingRevisions")),
    }),
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  /**
   * H1 amendment (issue #49, additive, flagged on the B3 precedent): the
   * boss-facing revision-history read. C2 proved the immutable
   * findings/findingRevisions/evidenceLinks rows, but no public read exposed
   * them; the conversation/memory surface must let a boss "inspect
   * old/current revisions and provenance" without replaying the
   * conversation. Read-only, same tenant rules as readCurrentFindings;
   * `value`/`knowledgeState` cross the boundary in their encoded wire form.
   */
  "memory.readFindingHistory": operationEntry({
    kind: "operation",
    name: "memory.readFindingHistory",
    input: Schema.Struct({ findingId: tableIdSchema("findings") }),
    result: Schema.Struct({
      findingId: tableIdSchema("findings"),
      semanticKey: Schema.NonEmptyString,
      scope: FindingScope,
      currentRevisionId: tableIdSchema("findingRevisions"),
      revisionCounter: RevisionCounter,
      revisions: Schema.Array(
        Schema.Struct({
          revisionId: tableIdSchema("findingRevisions"),
          revision: RevisionCounter,
          value: FindingValue,
          knowledgeState: KnowledgeState,
          origin: Schema.Literals([
            "publication",
            "correction",
            "withdrawal_marking",
            // E7 amendment (additive, flagged): a project reassignment's
            // scope re-assessment marking.
            "reassignment_marking",
          ]),
          /** Why an explicit correction or a marking revision happened. */
          reason: Schema.NullOr(Schema.String),
          recordedByUserId: tableIdSchema("users"),
          recordedAtMs: Schema.Number,
          supersedesRevisionId: Schema.NullOr(tableIdSchema("findingRevisions")),
          /** The evidence witnesses this revision rests on (provenance links). */
          evidence: Schema.Array(
            Schema.Struct({
              sourceId: tableIdSchema("sources"),
              fragmentId: Schema.NullOr(tableIdSchema("sourceFragments")),
              supportKind: Schema.Literals([
                "support",
                "independent_corroboration",
                "derivation",
                "supersession",
              ]),
            }),
          ),
        }),
      ),
    }),
    errorKinds: ["forbidden", "not_found"],
  }),
  /**
   * H1 amendment (issue #49, additive, flagged on the B3 precedent): the
   * boss-facing clarifications read. C2/E3 proved raising and resolving
   * ("Sprawa do wyjaśnienia"), and `memory.resolveClarification` is a
   * declared command, but no public read listed the open questions; the
   * surface must display E3's sourced clarification and let a boss answer
   * it. Read-only; each conflicting-evidence pointer dereferences to its
   * canonical source so provenance stays inspectable.
   */
  "memory.readClarifications": operationEntry({
    kind: "operation",
    name: "memory.readClarifications",
    input: Schema.Struct({ scope: FindingScope }),
    result: Schema.Array(
      Schema.Struct({
        clarificationId: tableIdSchema("clarifications"),
        question: Schema.NonEmptyString,
        state: Schema.Literals(["open", "resolved"]),
        raisedAtMs: Schema.Number,
        resolvedByUserId: Schema.NullOr(tableIdSchema("users")),
        resolutionNote: Schema.NullOr(Schema.String),
        resolvedAtMs: Schema.NullOr(Schema.Number),
        /** The sourced contradiction the question is about (E3's evidence). */
        conflictingEvidence: Schema.Array(
          Schema.Struct({
            fragmentId: tableIdSchema("sourceFragments"),
            sourceId: tableIdSchema("sources"),
          }),
        ),
      }),
    ),
    errorKinds: ["forbidden", "not_found"],
  }),
  "memory.correctFinding": operationEntry({
    kind: "operation",
    name: "memory.correctFinding",
    input: Schema.Struct({
      findingId: tableIdSchema("findings"),
      expectedRevision: RevisionCounter,
      value: FindingValue,
      knowledgeState: KnowledgeState,
      reason: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ revisionId: tableIdSchema("findingRevisions") }),
    errorKinds: ["forbidden", "not_found", "validation", "conflict"],
  }),
  "memory.raiseClarification": operationEntry({
    kind: "operation",
    name: "memory.raiseClarification",
    input: Schema.Struct({
      question: Schema.NonEmptyString,
      conflictingEvidence: Schema.Array(tableIdSchema("sourceFragments")),
      scope: FindingScope,
    }),
    result: Schema.Struct({ clarificationId: tableIdSchema("clarifications") }),
    errorKinds: ["forbidden", "validation"],
  }),
  "memory.resolveClarification": operationEntry({
    kind: "operation",
    name: "memory.resolveClarification",
    input: Schema.Struct({
      clarificationId: tableIdSchema("clarifications"),
      resolutionNote: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ clarificationId: tableIdSchema("clarifications") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  /**
   * C3 completion (the owning lane finishes the A2 candidate). Creates a
   * FIRM-scoped definition with its immutable version 1, or idempotently
   * reuses the existing definition when an equivalent one (same normalized
   * name, compatible structure) already exists in the firm catalog or the
   * shared catalog. A same-named but structurally INCOMPATIBLE definition
   * refuses `conflict`: the catalog never silently reuses a different
   * meaning. Shared definitions are published only by product code; this
   * operation has no shared-creation path at all.
   */
  "memory.defineExtension": operationEntry({
    kind: "operation",
    name: "memory.defineExtension",
    input: Schema.Struct({
      name: Schema.NonEmptyString,
      fields: boundedMutableArray(ExtensionFieldShape, MAX_OBJECT_FIELDS),
    }),
    result: Schema.Struct({
      definitionId: tableIdSchema("extensionDefinitions"),
      versionId: tableIdSchema("extensionVersions"),
      /** false when an equivalent definition was reused (idempotent define). */
      created: Schema.Boolean,
    }),
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  /**
   * C3 completion (the owning lane finishes the A2 candidate). Appends the
   * NEXT immutable version of a definition: additions and label changes are
   * compatible; removals, kind/unit/itemKind changes and enum-option removals
   * refuse `conflict` — those need a new definition or an explicit migration.
   * Existing version rows are never rewritten, so historic values keep the
   * version they were written against.
   */
  "memory.versionExtensionDefinition": operationEntry({
    kind: "operation",
    name: "memory.versionExtensionDefinition",
    input: Schema.Struct({
      definitionId: tableIdSchema("extensionDefinitions"),
      changeNote: Schema.NonEmptyString,
      fields: boundedMutableArray(ExtensionFieldShape, MAX_OBJECT_FIELDS),
    }),
    result: Schema.Struct({
      versionId: tableIdSchema("extensionVersions"),
      version: Schema.Number.pipe(Schema.check(Schema.isInt())),
    }),
    errorKinds: ["forbidden", "not_found", "validation", "conflict"],
  }),
  /**
   * C3: catalog lookup with similarity candidates. Called BEFORE creating a
   * definition; each candidate carries a typed verdict — `reuse_candidate`
   * (near name AND compatible structure), `name_conflict` (near name,
   * incompatible meaning/type: create a distinct definition, never a silent
   * reuse) or `distinct` — plus this firm's committed usage statistics.
   */
  "memory.searchExtensionCatalog": operationEntry({
    kind: "operation",
    name: "memory.searchExtensionCatalog",
    input: Schema.Struct({
      name: Schema.NonEmptyString,
      /** Optional draft structure: with it, verdicts are typed compatibility outcomes. */
      fields: Schema.optionalKey(boundedMutableArray(ExtensionFieldShape, MAX_OBJECT_FIELDS)),
    }),
    result: Schema.Struct({
      candidates: Schema.Array(
        Schema.Struct({
          definitionId: tableIdSchema("extensionDefinitions"),
          versionId: tableIdSchema("extensionVersions"),
          version: Schema.Number,
          name: Schema.NonEmptyString,
          fields: boundedMutableArray(ExtensionFieldShape, MAX_OBJECT_FIELDS),
          /** true for product-owned shared definitions, false for firm-owned. */
          shared: Schema.Boolean,
          usageCount: Schema.Number,
          lastUsedAtMs: Schema.NullOr(Schema.Number),
          similarity: Schema.Struct({
            score: Schema.Number,
            verdict: Schema.Literals(["reuse_candidate", "name_conflict", "distinct"]),
            /** null when no draft structure was provided (name-level lookup). */
            structureCompatible: Schema.NullOr(Schema.Boolean),
          }),
        }),
      ),
    }),
    errorKinds: ["forbidden"],
  }),
  /**
   * C3: the validate-value operation for E6 tools and the publish seam. One
   * extension value against ONE stored definition version: shape derivation,
   * kind/unit/option membership, bounded sizes, required-versus-optional
   * fields. The transaction layer adds the tenant checks for entity refs.
   */
  "memory.validateExtensionValue": operationEntry({
    kind: "operation",
    name: "memory.validateExtensionValue",
    input: Schema.Struct({
      versionId: tableIdSchema("extensionVersions"),
      value: ExtensionValue,
    }),
    result: Schema.Struct({
      definitionId: tableIdSchema("extensionDefinitions"),
      version: Schema.Number,
    }),
    errorKinds: ["forbidden", "not_found", "validation"],
  }),
} as const;

export const memoryEvents = {
  "memory.changeSetPublished": eventEntry({
    kind: "event",
    name: "memory.changeSetPublished",
    payload: Schema.Struct({
      changeSetId: tableIdSchema("changeSets"),
      revisionIds: Schema.Array(tableIdSchema("findingRevisions")),
    }),
  }),
  "memory.findingRevised": eventEntry({
    kind: "event",
    name: "memory.findingRevised",
    payload: Schema.Struct({
      findingId: tableIdSchema("findings"),
      revisionId: tableIdSchema("findingRevisions"),
      supersedesRevisionId: Schema.NullOr(tableIdSchema("findingRevisions")),
    }),
  }),
  "memory.clarificationRaised": eventEntry({
    kind: "event",
    name: "memory.clarificationRaised",
    payload: Schema.Struct({ clarificationId: tableIdSchema("clarifications") }),
  }),
  "memory.clarificationResolved": eventEntry({
    kind: "event",
    name: "memory.clarificationResolved",
    payload: Schema.Struct({ clarificationId: tableIdSchema("clarifications") }),
  }),
  "memory.dependentsMarkedStale": eventEntry({
    kind: "event",
    name: "memory.dependentsMarkedStale",
    payload: Schema.Struct({
      rootFindingId: tableIdSchema("findings"),
      dependentFindingIds: Schema.Array(tableIdSchema("findings")),
      /**
       * C5 amendment (additive, flagged on the B3 precedent): the actor the
       * recomputation cascade records its markings for (the withdrawal's
       * actor). Nullable so external publishers without an actor still
       * decode; the executor then resolves identity itself.
       */
      withdrawnByUserId: Schema.NullOr(tableIdSchema("users")),
    }),
  }),
} as const;
