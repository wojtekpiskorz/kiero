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
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { RevisionCounter } from "../actor";
import { KnowledgeState } from "../values/knowledge";
import { ExtensionFieldId, ExtensionFieldKind } from "../values/extension";
import { MoneyValue } from "../values/money";
import { TemporalValue } from "../values/temporal";
import { ExtensionValue } from "../values/extension";
import { PublicationState } from "../media";
import { operationEntry, eventEntry } from "./registration";

/** The value of one finding: exactly one payload shape plus its knowledge state. */
export const FindingValue = Schema.TaggedUnion({
  temporal: { temporal: TemporalValue },
  money: { money: MoneyValue },
  extension: { extensionValue: ExtensionValue },
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
  "memory.defineExtension": operationEntry({
    kind: "operation",
    name: "memory.defineExtension",
    input: Schema.Struct({
      name: Schema.NonEmptyString,
      fields: Schema.Array(
        Schema.Struct({
          fieldId: ExtensionFieldId,
          label: Schema.NonEmptyString,
          kind: ExtensionFieldKind,
        }),
      ),
    }),
    result: Schema.Struct({ definitionId: tableIdSchema("extensionDefinitions") }),
    errorKinds: ["forbidden", "validation", "conflict"],
  }),
  "memory.versionExtensionDefinition": operationEntry({
    kind: "operation",
    name: "memory.versionExtensionDefinition",
    input: Schema.Struct({
      definitionId: tableIdSchema("extensionDefinitions"),
      changeNote: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ versionId: tableIdSchema("extensionVersions") }),
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
    }),
  }),
} as const;
