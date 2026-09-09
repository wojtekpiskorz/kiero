/**
 * Shared Convex value definitions and the single proved conversion path from
 * Effect Schema semantic values to Convex validators.
 *
 * Ownership rules (see docs/implementation/contracts/):
 *
 * - Only cross-domain value definitions live here. Tables and indexes live in
 *   each domain's schema fragment; `convex/schema.ts` only composes them.
 * - The semantic values themselves (knowledge state, temporal, money,
 *   extension values) are OWNED by `@kiero/contracts` in Effect Schema. This
 *   file maps each of them to a Convex validator through an explicit,
 *   type-checked table: every entry's declared Convex type must equal the
 *   schema's Encoded (wire) type exactly, or this file does not compile.
 *   There is deliberately no general-purpose Schema→Validator compiler:
 *   only this checked mapping.
 *
 * The runtime half of the proof (decoded value → encode → Convex JSON wire →
 * decode → equal value; malformed input rejected by the Effect decoder) lives
 * in tests/contracts. Deployment-time Convex validator enforcement is A3's
 * proof; the pinned convex 1.45.0 exposes no untyped local validate entry.
 *
 * Timestamps: table columns record trusted system time as epoch milliseconds
 * (`tsMs`). Timestamps inside semantic payloads stay in their encoded ISO
 * form within the encoded value itself. Revision counters are `float64`
 * (document counts are far below 2^53).
 *
 * Candidate definitions until A3 certifies them.
 */

import { v, type Validator } from "convex/values";
import type { Schema } from "effect";
import {
  ExtensionValue,
  FindingValue,
  KnowledgeState,
  MoneyValue,
  TemporalValue,
} from "@kiero/contracts";

/**
 * The wire representation of a semantic value or vocabulary schema. Exported
 * so domain fragments can pin their hand-written closed unions to the
 * contracts side; the mechanism lives here, the vocabularies stay in the
 * owning fragment.
 */
export type Encoded<S> = Schema.Codec.Encoded<S>;

/**
 * A required Convex validator whose TypeScript type must match `T` exactly.
 * Annotating a `v.*` expression with this type makes vocabulary drift (a
 * missing, extra or misspelled literal) fail typecheck instead of passing
 * silently.
 */
export type ValueValidator<T> = Validator<T, "required", string>;

// ---------------------------------------------------------------------------
// The one proved conversion path: Effect Schema semantic values → Convex
// validators. Each entry is hand-written and type-checked against the
// schema's Encoded type; changing either side without the other fails here.
// ---------------------------------------------------------------------------

const knowledgeStateValidator: ValueValidator<Encoded<typeof KnowledgeState>> =
  v.union(
    v.object({ _tag: v.literal("known") }),
    v.object({ _tag: v.literal("unknown"), reason: v.string() }),
    v.object({ _tag: v.literal("conflicted") }),
    v.object({ _tag: v.literal("not_applicable") }),
  );

const dateOnlyValidator = v.union(
  v.object({ _tag: v.literal("day"), day: v.string() }),
  v.object({ _tag: v.literal("month"), month: v.string() }),
  v.object({ _tag: v.literal("year"), year: v.string() }),
);

const temporalValueValidator: ValueValidator<Encoded<typeof TemporalValue>> =
  v.object({
    shape: v.union(
      dateOnlyValidator,
      v.object({ _tag: v.literal("date_time"), value: v.string() }),
      v.object({
        _tag: v.literal("range"),
        start: v.union(v.null(), dateOnlyValidator),
        end: v.union(v.null(), dateOnlyValidator),
      }),
    ),
    originalExpression: v.string(),
    role: v.union(
      v.literal("proposed"),
      v.literal("internal"),
      v.literal("agreed"),
      v.literal("actual"),
    ),
  });

const moneyValueValidator: ValueValidator<Encoded<typeof MoneyValue>> =
  v.object({
    role: v.union(
      v.literal("price_proposal"),
      v.literal("agreed_price"),
      v.literal("material_cost"),
      v.literal("deposit_received"),
      v.literal("estimated_labor"),
    ),
    amount: v.union(
      v.object({ _tag: v.literal("exact"), value: v.string() }),
      v.object({
        _tag: v.literal("range"),
        min: v.union(v.null(), v.string()),
        max: v.union(v.null(), v.string()),
      }),
    ),
    currency: v.string(),
    currencyOrigin: v.union(v.literal("stated"), v.literal("company_default")),
    taxBasis: v.union(v.literal("net"), v.literal("gross"), v.literal("not_specified")),
    certainty: v.union(v.literal("exact"), v.literal("estimate")),
  });

const entityReferenceValidator = v.union(
  v.object({ _tag: v.literal("project"), projectId: v.id("projects") }),
  v.object({ _tag: v.literal("task"), taskId: v.id("tasks") }),
  v.object({ _tag: v.literal("event"), eventId: v.id("events") }),
  v.object({ _tag: v.literal("contact"), contactId: v.id("contacts") }),
  v.object({ _tag: v.literal("source"), sourceId: v.id("sources") }),
);

const scalarExtensionValueValidator = v.union(
  v.object({ _tag: v.literal("text"), text: v.string() }),
  v.object({
    _tag: v.literal("quantity"),
    amount: v.string(),
    unit: v.string(),
  }),
  v.object({ _tag: v.literal("boolean"), value: v.boolean() }),
  v.object({ _tag: v.literal("enum"), optionId: v.string() }),
  v.object({ _tag: v.literal("financial"), money: moneyValueValidator }),
  v.object({ _tag: v.literal("temporal"), temporal: temporalValueValidator }),
  v.object({ _tag: v.literal("entity_ref"), reference: entityReferenceValidator }),
);

const extensionValueValidator: ValueValidator<Encoded<typeof ExtensionValue>> =
  v.union(
    scalarExtensionValueValidator,
    v.object({
      _tag: v.literal("object"),
      fields: v.array(
        v.object({ fieldId: v.string(), value: scalarExtensionValueValidator }),
      ),
    }),
    v.object({
      _tag: v.literal("list"),
      items: v.array(scalarExtensionValueValidator),
    }),
  );

const findingValueValidator: ValueValidator<Encoded<typeof FindingValue>> =
  v.union(
    v.object({ _tag: v.literal("temporal"), temporal: temporalValueValidator }),
    v.object({ _tag: v.literal("money"), money: moneyValueValidator }),
    v.object({ _tag: v.literal("extension"), extensionValue: extensionValueValidator }),
    v.object({ _tag: v.literal("text_note"), text: v.string() }),
  );

/** The proved mapping: schema name → Convex validator for its encoded form. */
export const semanticValueValidators = {
  knowledgeState: knowledgeStateValidator,
  temporalValue: temporalValueValidator,
  moneyValue: moneyValueValidator,
  extensionValue: extensionValueValidator,
  findingValue: findingValueValidator,
} as const;

/**
 * Optional-table-field variants of the same validators. Each entry is
 * `v.optional` of the EXACT validator object in `semanticValueValidators`,
 * so the pair cannot drift; there is no second conversion path.
 *
 * Current consumers: `temporalValue` (findingRevisions.effectiveFrom). The
 * remaining entries have no consuming column yet; they stay so that later
 * fragments take the optional variant from here instead of hand-building an
 * unchecked copy of a proved validator.
 */
export const semanticValueFields = {
  knowledgeState: v.optional(knowledgeStateValidator),
  temporalValue: v.optional(temporalValueValidator),
  moneyValue: v.optional(moneyValueValidator),
  extensionValue: v.optional(extensionValueValidator),
  findingValue: v.optional(findingValueValidator),
} as const;

// ---------------------------------------------------------------------------
// Cross-domain shared field validators.
// ---------------------------------------------------------------------------

/**
 * Shared cross-domain fields. Domain fragments compose these into their
 * tables; anything domain-specific stays in the fragment.
 */
export const shared = {
  // Document references (names match the table inventory in @kiero/contracts).
  companyId: v.id("companies"),
  userId: v.id("users"),
  sessionId: v.id("sessions"),
  membershipId: v.id("memberships"),
  invitationId: v.id("invitations"),
  contactId: v.id("contacts"),
  projectId: v.id("projects"),
  projectAliasId: v.id("projectAliases"),
  sourceId: v.id("sources"),
  sourceProjectLinkId: v.id("sourceProjectLinks"),
  uploadId: v.id("uploads"),
  attachmentId: v.id("attachments"),
  mediaRepresentationId: v.id("mediaRepresentations"),
  extractionId: v.id("extractions"),
  sourceFragmentId: v.id("sourceFragments"),
  findingId: v.id("findings"),
  findingRevisionId: v.id("findingRevisions"),
  evidenceLinkId: v.id("evidenceLinks"),
  findingDependencyId: v.id("findingDependencies"),
  taskId: v.id("tasks"),
  checklistItemId: v.id("checklistItems"),
  workEventId: v.id("events"),
  changeSetId: v.id("changeSets"),
  publicationGroupId: v.id("publicationGroups"),
  clarificationId: v.id("clarifications"),
  processingRunId: v.id("processingRuns"),
  processingStepId: v.id("processingSteps"),
  processingAttemptId: v.id("processingAttempts"),
  extensionDefinitionId: v.id("extensionDefinitions"),
  extensionVersionId: v.id("extensionVersions"),
  notificationIntentId: v.id("notificationIntents"),
  pushSubscriptionId: v.id("pushSubscriptions"),
  calendarConnectionId: v.id("calendarConnections"),
  calendarCopyId: v.id("calendarCopies"),
  exportId: v.id("exports"),
  gmAccessGrantId: v.id("gmAccessGrants"),

  /**
   * Monotonic non-negative counter: revisions, versions, attempt counts and
   * sequence numbers alike (document counts stay far below 2^53). Named
   * neutrally because most uses are plain counters, not revision references.
   */
  counter: v.float64(),

  // Trusted system time, epoch milliseconds.
  tsMs: v.float64(),

  // Provenance: which durable evidence supports a recorded revision.
  provenance: v.object({
    sourceId: v.id("sources"),
    fragmentIds: v.array(v.id("sourceFragments")),
    extractionId: v.optional(v.id("extractions")),
    /** Actor revision recorded by the server; never client-supplied. */
    actorUserId: v.id("users"),
    recordedAtMs: v.float64(),
  }),
} as const;
