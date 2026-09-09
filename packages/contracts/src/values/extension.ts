/**
 * Typed extension value contract ("Value contracts", architecture design;
 * issue 8 "Rdzeń i dodatkowe struktury").
 *
 * Rules encoded here:
 *
 * - Extension values are typed payloads — text, quantity with unit, boolean,
 *   enum option, financial, temporal, entity reference, object of scalar
 *   fields, bounded list of scalar items — never one free-text blob.
 * - Objects and lists are bounded to scalar members (no recursive nesting);
 *   an item that needs its own responsibility/deadline becomes its own
 *   related task instead.
 * - Field IDs are stable identifiers that outlive label changes. A change of
 *   meaning or field kind creates a new definition version; historic values
 *   keep the version they were written against (millimeters never silently
 *   become centimeters).
 * - Definitions are bounded data, never executable schema code.
 *
 * Candidate contract until A3 certifies the runtime conversion.
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

const MAX_OBJECT_FIELDS = 32;
const MAX_LIST_ITEMS = 64;

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
    // mutable first, then the bound check: piping checks before
    // Schema.mutable would rebuild the schema without them (rc.112).
    fields: Schema.mutable(Schema.Array(ObjectFieldValue)).pipe(
      Schema.check(Schema.isMaxLength(MAX_OBJECT_FIELDS)),
    ),
  }),
  Schema.TaggedStruct("list", {
    items: Schema.mutable(Schema.Array(ScalarExtensionValue)).pipe(
      Schema.check(Schema.isMaxLength(MAX_LIST_ITEMS)),
    ),
  }),
]);
export type ExtensionValue = Schema.Schema.Type<typeof ExtensionValue>;

/** Field kind declared by a definition version. */
export const ExtensionFieldKind = Schema.Literals([
  "text",
  "quantity",
  "boolean",
  "enum",
  "financial",
  "temporal",
  "entity_ref",
  "object",
  "list",
]);
export type ExtensionFieldKind = Schema.Schema.Type<typeof ExtensionFieldKind>;

/**
 * The immutable shape snapshot of one definition version. Version records are
 * append-only: a version never rewrites its snapshot, and a meaning/kind
 * change requires a new version (or a new definition plus migration).
 */
export const ExtensionFieldShape = Schema.Struct({
  fieldId: ExtensionFieldId,
  label: Schema.NonEmptyString,
  kind: ExtensionFieldKind,
  options: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(Schema.Struct({ optionId: ExtensionFieldId, label: Schema.NonEmptyString })),
    ).pipe(Schema.check(Schema.isMaxLength(MAX_LIST_ITEMS))),
  ),
  description: Schema.optionalKey(Schema.String),
});
export type ExtensionFieldShape = Schema.Schema.Type<typeof ExtensionFieldShape>;

/** A definition version: the full shape snapshot plus its changelog line. */
export const ExtensionDefinitionVersionValue = Schema.Struct({
  definitionId: tableIdSchema("extensionDefinitions"),
  version: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))),
  name: Schema.NonEmptyString,
  fields: Schema.mutable(Schema.Array(ExtensionFieldShape)).pipe(
    Schema.check(Schema.isMaxLength(MAX_OBJECT_FIELDS)),
  ),
  changeNote: Schema.String,
});
export type ExtensionDefinitionVersionValue =
  Schema.Schema.Type<typeof ExtensionDefinitionVersionValue>;
