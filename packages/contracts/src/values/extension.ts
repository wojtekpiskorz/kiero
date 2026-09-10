/**
 * Typed extension value contract ("Value contracts", architecture design;
 * issue 8 "Rdzeń i dodatkowe struktury").
 *
 * Rules encoded here:
 *
 * - Extension values are typed payloads: text, quantity with unit, boolean,
 *   enum option, financial, temporal, entity reference, object of scalar
 *   fields, bounded list of scalar items, never one free-text blob.
 * - Objects and lists are bounded to scalar members (no recursive nesting);
 *   an item that needs its own responsibility/deadline becomes its own
 *   related task instead.
 * - Field IDs are stable identifiers that outlive label changes. A change of
 *   meaning or field kind creates a new definition version; historic values
 *   keep the version they were written against (millimeters never silently
 *   become centimeters).
 * - Definitions are bounded data, never executable schema code.
 *
 * Certified by A3 on 2026-09-09 (docs/implementation/contracts/README.md).
 *
 * C3 amendments (the owning lane completes the candidate surface, additive
 * and flagged on the B3/C2 precedent):
 * - `ExtensionFieldShape.kind` narrows to `DefinitionFieldKind`: a definition
 *   FIELD may be one of the seven scalar kinds or a bounded `list` with a
 *   scalar `itemKind`. `object` stays a legal VALUE kind (the A2 value
 *   vocabulary is untouched) but is not a legal FIELD kind: a multi-field
 *   definition version IS the object type, so an object field would demand
 *   the nesting this contract forbids.
 * - `unit` (quantity fields) and `itemKind` (list fields) make meaning
 *   machine-checkable: a version that changes a field's unit is an
 *   incompatible change, and near-duplicate names with incompatible units
 *   can be told apart mechanically (issue #26 focused verification).
 * - The bounded-array helper and its bounds are exported so the definition
 *   operation inputs share the exact value-contract bounds.
 */

import { Schema } from "effect";
import { MoneyValue } from "./money";
import { TemporalValue } from "./temporal";
import { tableIdSchema } from "../tableIds";

/** Stable field identifier; labels may change, this may not. */
export const ExtensionFieldId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/)),
  Schema.brand("ExtensionFieldId"),
);
export type ExtensionFieldId = Schema.Schema.Type<typeof ExtensionFieldId>;

/** Entity kinds an extension value may reference (supported references only). */
export const EntityReference = Schema.TaggedUnion({
  project: { projectId: tableIdSchema("projects") },
  task: { taskId: tableIdSchema("tasks") },
  event: { eventId: tableIdSchema("events") },
  contact: { contactId: tableIdSchema("contacts") },
  source: { sourceId: tableIdSchema("sources") },
});
export type EntityReference = Schema.Schema.Type<typeof EntityReference>;

/** Scalar extension payloads; objects and lists are bounded to these. */
export const ScalarExtensionValue = Schema.TaggedUnion({
  text: { text: Schema.String },
  quantity: { amount: Schema.BigDecimalFromString, unit: Schema.NonEmptyString },
  boolean: { value: Schema.Boolean },
  enum: { optionId: ExtensionFieldId },
  financial: { money: MoneyValue },
  temporal: { temporal: TemporalValue },
  entity_ref: { reference: EntityReference },
});
export type ScalarExtensionValue = Schema.Schema.Type<typeof ScalarExtensionValue>;

export const MAX_OBJECT_FIELDS = 32;
export const MAX_LIST_ITEMS = 64;

/**
 * Bounded mutable array: the encoded wire form must use mutable arrays to
 * match the Convex value model. WARNING (single-sourced here): the length
 * check is piped AFTER `Schema.mutable` because piping checks before
 * `Schema.mutable` rebuilds the schema WITHOUT them on effect 4.0.0-rc.112.
 *
 * C3: exported (additive) so definition operation inputs reuse the exact
 * value-contract bounds instead of restating them.
 */
export const boundedMutableArray = <S extends Schema.Codec<unknown, unknown, never, never>>(
  element: S,
  maxLength: number,
) => Schema.mutable(Schema.Array(element)).pipe(Schema.check(Schema.isMaxLength(maxLength)));

/** One field assignment inside an object value. */
export const ObjectFieldValue = Schema.Struct({
  fieldId: ExtensionFieldId,
  value: ScalarExtensionValue,
});
export type ObjectFieldValue = Schema.Schema.Type<typeof ObjectFieldValue>;

/**
 * Any extension value, including bounded objects and lists. The arrays are
 * declared mutable so the encoded wire form matches the Convex value model
 * (whose arrays are mutable) without an unchecked bridge.
 */
export const ExtensionValue = Schema.Union([
  ScalarExtensionValue,
  Schema.TaggedStruct("object", {
    fields: boundedMutableArray(ObjectFieldValue, MAX_OBJECT_FIELDS),
  }),
  Schema.TaggedStruct("list", {
    items: boundedMutableArray(ScalarExtensionValue, MAX_LIST_ITEMS),
  }),
]);
export type ExtensionValue = Schema.Schema.Type<typeof ExtensionValue>;

/**
 * The single-source kind arrays (C3, the bounds pattern): every kind schema
 * below is BUILT from one of these, so a vocabulary change is one edit and
 * the arrays, the schemas and the domain rule layer cannot drift apart.
 */

/** The scalar subset of the value vocabulary: what fields and list items take. */
export const SCALAR_FIELD_KINDS = [
  "text",
  "quantity",
  "boolean",
  "enum",
  "financial",
  "temporal",
  "entity_ref",
] as const;

/** What a definition FIELD may take: the scalar kinds plus bounded lists. */
export const DEFINITION_FIELD_KINDS = [...SCALAR_FIELD_KINDS, "list"] as const;

/** The full A2 value vocabulary: scalar kinds plus objects and lists. */
export const EXTENSION_FIELD_KINDS = [...SCALAR_FIELD_KINDS, "object", "list"] as const;

/**
 * The full A2 value vocabulary, as a schema. This names the VALUE space
 * (what an ExtensionValue branch may be); the tagged union
 * `ScalarExtensionValue`/`ExtensionValue` is the enforcing schema, and
 * definition FIELDS pin to the narrower `DefinitionFieldKind` (`object` is
 * not a legal field kind). Kept as the certified A2 export for consumers
 * that reason about the value vocabulary as one set.
 */
export const ExtensionFieldKind = Schema.Literals(EXTENSION_FIELD_KINDS);
export type ExtensionFieldKind = Schema.Schema.Type<typeof ExtensionFieldKind>;

/**
 * The scalar subset of the value vocabulary: the kinds a definition FIELD or
 * a list item may take (C3). Everything bounded ends here — objects and
 * lists are containers, never members.
 */
export const ScalarFieldKind = Schema.Literals(SCALAR_FIELD_KINDS);
export type ScalarFieldKind = Schema.Schema.Type<typeof ScalarFieldKind>;

/**
 * The kinds a definition FIELD may take (C3): the seven scalar kinds plus a
 * bounded `list` of one scalar kind. `object` is deliberately absent — a
 * multi-field definition version IS the object type; an object field would
 * demand the recursive nesting the value contract forbids.
 */
export const DefinitionFieldKind = Schema.Literals(DEFINITION_FIELD_KINDS);
export type DefinitionFieldKind = Schema.Schema.Type<typeof DefinitionFieldKind>;

/**
 * The immutable shape snapshot of one definition version. Version records are
 * append-only: a version never rewrites its snapshot, and a meaning/kind
 * change requires a new version (or a new definition plus migration).
 *
 * C3: `unit` is required for quantity fields and `itemKind` for list fields
 * (enforced by the domain rule layer, kept optional on the wire shape so the
 * stored snapshot decodes without a migration); enum fields declare their
 * closed option set in `options`.
 */
export const ExtensionFieldShape = Schema.Struct({
  fieldId: ExtensionFieldId,
  label: Schema.NonEmptyString,
  kind: DefinitionFieldKind,
  /** Declared unit of a quantity field; a version changing it is incompatible. */
  unit: Schema.optionalKey(Schema.NonEmptyString),
  /** Declared item kind of a list field; scalar kinds only (bounded). */
  itemKind: Schema.optionalKey(ScalarFieldKind),
  options: Schema.optionalKey(
    boundedMutableArray(
      Schema.Struct({ optionId: ExtensionFieldId, label: Schema.NonEmptyString }),
      MAX_LIST_ITEMS,
    ),
  ),
  description: Schema.optionalKey(Schema.String),
});
export type ExtensionFieldShape = Schema.Schema.Type<typeof ExtensionFieldShape>;

/** A definition version: the full shape snapshot plus its changelog line. */
export const ExtensionDefinitionVersionValue = Schema.Struct({
  definitionId: tableIdSchema("extensionDefinitions"),
  version: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  name: Schema.NonEmptyString,
  fields: boundedMutableArray(ExtensionFieldShape, MAX_OBJECT_FIELDS),
  changeNote: Schema.String,
});
export type ExtensionDefinitionVersionValue =
  Schema.Schema.Type<typeof ExtensionDefinitionVersionValue>;
