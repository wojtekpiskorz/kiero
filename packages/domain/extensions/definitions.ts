/**
 * Pure definition-shape rules (C3): bounded-data validation of definition
 * versions, the version-succession compatibility rule and value-versus-
 * version validation.
 *
 * Everything here is I/O-free and deterministic; the Convex transaction
 * cores (convex/memory/extensions) re-run every one of these decisions
 * inside their own transaction against stored rows, exactly like the C2
 * pattern (packages/domain/findings).
 *
 * The semantic model (one sentence each):
 *
 * - A definition version is a bounded list of FIELDS. A version with ONE
 *   field takes that field's value DIRECTLY (a scalar, or a bounded list
 *   when the field is a list) — "określający rodzaj wartości". A version
 *   with SEVERAL fields takes an OBJECT value assigning each field —
 *   "określający ... pole obiektu" (CONTEXT.md, Definicja dodatkowej
 *   informacji).
 * - Fields are scalar kinds (text, quantity with a declared unit, boolean,
 *   enum with a closed option set, financial, temporal, approved entity
 *   references) or a bounded list of ONE scalar kind. `object` is never a
 *   field kind: a multi-field version IS the object, so an object field
 *   would demand the recursive nesting the value contract forbids —
 *   definitions are bounded data, not executable or recursive schema code.
 * - Field IDs are stable and outlive label changes. Versions are
 *   append-only snapshots: additions and label changes are compatible
 *   successors; removals, kind/unit/itemKind changes and enum-option
 *   removals are INCOMPATIBLE and require a new definition or an explicit
 *   migration. Historic values keep the version they were written against.
 * - A field is REQUIRED in the values of version V when it was already
 *   present in version 1; fields added by later versions are optional
 *   ("Adding an optional firm field creates a new version", issue #26).
 *
 * The field/value views below are deliberately structural: the decoded
 * (Effect) and encoded (Convex wire) forms both satisfy them, so the same
 * rule runs at the operation boundary and over stored rows.
 */

import { MAX_LIST_ITEMS, MAX_OBJECT_FIELDS, SCALAR_FIELD_KINDS, DEFINITION_FIELD_KINDS } from "@kiero/contracts";

/** The structural view of one definition field (decoded or encoded form). */
export interface FieldShapeView {
  readonly fieldId: string;
  readonly label: string;
  readonly kind: string;
  readonly unit?: string | undefined;
  readonly itemKind?: string | undefined;
  readonly options?: readonly { optionId: string; label: string }[] | undefined;
  readonly description?: string | undefined;
}

/** The structural view of one extension value (decoded or encoded form). */
export interface ExtensionValueView {
  readonly _tag: string;
  readonly unit?: string | undefined;
  readonly optionId?: string | undefined;
  readonly reference?: { readonly _tag: string } | undefined;
  readonly fields?: readonly { fieldId: string; value: ExtensionValueView }[] | undefined;
  readonly items?: readonly ExtensionValueView[] | undefined;
  /** Payload properties (amount, text, money, temporal…) ride along opaquely. */
  readonly [extra: string]: unknown;
}

/** The scalar kinds a field (or list item) may take: the contracts array. */
const SCALAR_KINDS: ReadonlySet<string> = new Set(SCALAR_FIELD_KINDS);

/** All legal field kinds: the scalar kinds plus a bounded list. */
const FIELD_KINDS: ReadonlySet<string> = new Set(DEFINITION_FIELD_KINDS);

/** A sanitized check outcome: ok, or a stable refusal code. */
export type ExtensionCheck = { readonly ok: true } | { readonly ok: false; readonly code: string };

/** A scalar value's tag must be one of the scalar kinds. */
function isScalarValue(value: ExtensionValueView): boolean {
  return SCALAR_KINDS.has(value._tag);
}

// ---------------------------------------------------------------------------
// Entity-reference walk: the pure half of the tenant check.
// ---------------------------------------------------------------------------

/** One approved entity reference found inside an extension value. */
export interface EntityReferenceView {
  /** The value-space reference tag; names the referenced table. */
  readonly kind: "project" | "task" | "event" | "contact" | "source";
  /** The referenced document id, exactly as carried in the value. */
  readonly id: string;
}

/** The walk outcome: every reference in the value, or a malformed marker. */
export type EntityReferenceWalk =
  | { readonly ok: true; readonly references: readonly EntityReferenceView[] }
  | { readonly ok: false; readonly code: "entity_reference_malformed" };

/** The id property each reference kind carries (keyed by the reference tag). */
const REFERENCE_ID_FIELDS: Record<string, string> = {
  project: "projectId",
  task: "taskId",
  event: "eventId",
  contact: "contactId",
  source: "sourceId",
};

/**
 * Purely enumerates every entity reference inside one extension value
 * (decoded or encoded form): object members and list items are descended,
 * `entity_ref` scalars are collected. The transaction layer owns what the
 * references are checked AGAINST (tenant visibility of the target rows).
 */
export function collectEntityReferences(value: unknown): EntityReferenceWalk {
  if (value === null || typeof value !== "object") {
    return { ok: true, references: [] };
  }
  const view = value as {
    _tag?: unknown;
    reference?: Record<string, unknown> | undefined;
    fields?: { value?: unknown }[] | undefined;
    items?: unknown[] | undefined;
  };
  if (view._tag === "entity_ref") {
    const reference = view.reference;
    if (reference === null || typeof reference !== "object") {
      return { ok: false, code: "entity_reference_malformed" };
    }
    const idField = reference._tag === undefined ? undefined : REFERENCE_ID_FIELDS[String(reference._tag)];
    const id = idField === undefined ? undefined : reference[idField];
    if (typeof id !== "string") {
      return { ok: false, code: "entity_reference_malformed" };
    }
    return {
      ok: true,
      references: [{ kind: String(reference._tag) as EntityReferenceView["kind"], id }],
    };
  }
  const collected: EntityReferenceView[] = [];
  for (const entry of view.fields ?? []) {
    const nested = collectEntityReferences(entry.value);
    if (!nested.ok) {
      return nested;
    }
    collected.push(...nested.references);
  }
  for (const item of view.items ?? []) {
    const nested = collectEntityReferences(item);
    if (!nested.ok) {
      return nested;
    }
    collected.push(...nested.references);
  }
  return { ok: true, references: collected };
}

/**
 * Bounded-data validation of one definition version's field list. This is
 * the "definitions are bounded data" gate: recursion, oversized shapes,
 * missing units/options and duplicate identities all refuse here, before
 * anything is stored.
 */
export function validateDefinitionShape(fields: readonly FieldShapeView[]): ExtensionCheck {
  if (fields.length === 0) {
    return { ok: false, code: "definition_without_fields" };
  }
  if (fields.length > MAX_OBJECT_FIELDS) {
    return { ok: false, code: "definition_fields_exceeded" };
  }
  const singleField = fields.length === 1;
  const seenFieldIds = new Set<string>();
  for (const field of fields) {
    if (!FIELD_KINDS.has(field.kind)) {
      // "object" (and any unknown literal): an object field would demand the
      // nesting the value contract forbids — the recursive-shape refusal.
      return { ok: false, code: field.kind === "object" ? "field_kind_object_forbidden" : "field_kind_unknown" };
    }
    if (seenFieldIds.has(field.fieldId)) {
      return { ok: false, code: "duplicate_field_id" };
    }
    seenFieldIds.add(field.fieldId);
    if (field.kind === "quantity") {
      if (field.unit === undefined || field.unit.length === 0) {
        return { ok: false, code: "quantity_field_without_unit" };
      }
    } else if (field.unit !== undefined) {
      return { ok: false, code: "unit_on_non_quantity_field" };
    }
    if (field.kind === "list") {
      if (!singleField) {
        // A list member inside an object value is impossible: object members
        // are scalar by the value contract. List-shaped definitions have the
        // one list field as their sole field.
        return { ok: false, code: "list_field_not_allowed_in_object" };
      }
      if (field.itemKind === undefined || !SCALAR_KINDS.has(field.itemKind)) {
        return { ok: false, code: "list_field_requires_scalar_item_kind" };
      }
    } else if (field.itemKind !== undefined) {
      return { ok: false, code: "item_kind_on_non_list_field" };
    }
    if (field.kind === "enum") {
      const options = field.options ?? [];
      if (options.length === 0) {
        return { ok: false, code: "enum_field_without_options" };
      }
      if (options.length > MAX_LIST_ITEMS) {
        return { ok: false, code: "enum_options_exceeded" };
      }
      const seenOptionIds = new Set<string>();
      for (const option of options) {
        if (seenOptionIds.has(option.optionId)) {
          return { ok: false, code: "duplicate_enum_option_id" };
        }
        seenOptionIds.add(option.optionId);
      }
    } else if (field.options !== undefined) {
      return { ok: false, code: "options_on_non_enum_field" };
    }
  }
  return { ok: true };
}

/**
 * The version-succession rule: may `next` become the NEXT version of a
 * definition whose current version is `previous`? Compatible successors add
 * optional fields and change labels freely (field IDs are stable through
 * label changes); anything that would reinterpret existing values refuses —
 * millimetres never silently become centimetres.
 */
export function decideVersionSuccession(
  previous: readonly FieldShapeView[],
  next: readonly FieldShapeView[],
): ExtensionCheck {
  const nextById = new Map<string, FieldShapeView>();
  for (const field of next) {
    nextById.set(field.fieldId, field);
  }
  for (const prior of previous) {
    const successor = nextById.get(prior.fieldId);
    if (successor === undefined) {
      return { ok: false, code: "field_removed" };
    }
    if (successor.kind !== prior.kind) {
      return { ok: false, code: "field_kind_changed" };
    }
    if ((successor.unit ?? undefined) !== (prior.unit ?? undefined)) {
      return { ok: false, code: "field_unit_changed" };
    }
    if ((successor.itemKind ?? undefined) !== (prior.itemKind ?? undefined)) {
      return { ok: false, code: "field_item_kind_changed" };
    }
    if (prior.kind === "enum") {
      const successorOptionIds = new Set(
        (successor.options ?? []).map((option) => option.optionId),
      );
      for (const option of prior.options ?? []) {
        if (!successorOptionIds.has(option.optionId)) {
          return { ok: false, code: "enum_option_removed" };
        }
      }
    }
  }
  return { ok: true };
}

/**
 * Checks one scalar value against one scalar field (kind, unit, option).
 * List items reuse this per item.
 */
function checkScalarAgainstField(
  field: FieldShapeView,
  value: ExtensionValueView,
): ExtensionCheck {
  if (!isScalarValue(value)) {
    return { ok: false, code: "value_kind_mismatch" };
  }
  if (value._tag !== field.kind) {
    return { ok: false, code: "value_kind_mismatch" };
  }
  if (field.kind === "quantity" && value.unit !== field.unit) {
    return { ok: false, code: "value_unit_mismatch" };
  }
  if (field.kind === "enum") {
    const optionIds = new Set((field.options ?? []).map((option) => option.optionId));
    if (value.optionId === undefined || !optionIds.has(value.optionId)) {
      return { ok: false, code: "enum_option_unknown" };
    }
  }
  return { ok: true };
}

/**
 * Validates one extension value against ONE stored definition version.
 *
 * - `fields` is the version's snapshot; `firstFields` is the definition's
 *   version-1 snapshot (required-field baseline; equal to `fields` when the
 *   version IS version 1).
 * - Single-field versions take the field's value DIRECTLY (scalar, or a
 *   bounded list when the field is a list kind); multi-field versions take
 *   an object value assigning every REQUIRED field, optionally the fields
 *   later versions added, and nothing else.
 */
export function validateExtensionValueAgainstVersion(args: {
  readonly fields: readonly FieldShapeView[];
  readonly firstFields: readonly FieldShapeView[];
  readonly value: ExtensionValueView;
}): ExtensionCheck {
  const { fields, firstFields, value } = args;
  const single = fields.length === 1 ? fields[0] : undefined;
  if (single !== undefined) {
    if (single.kind === "list") {
      if (value._tag !== "list") {
        return { ok: false, code: "value_shape_mismatch" };
      }
      const items = value.items ?? [];
      if (items.length > MAX_LIST_ITEMS) {
        return { ok: false, code: "list_items_exceeded" };
      }
      for (const item of items) {
        if (!isScalarValue(item) || item._tag !== single.itemKind) {
          return { ok: false, code: "list_item_kind_mismatch" };
        }
      }
      return { ok: true };
    }
    return checkScalarAgainstField(single, value);
  }
  if (value._tag !== "object") {
    return { ok: false, code: "value_shape_mismatch" };
  }
  const fieldById = new Map<string, FieldShapeView>();
  for (const field of fields) {
    fieldById.set(field.fieldId, field);
  }
  const required = new Set(
    firstFields.filter((field) => fieldById.has(field.fieldId)).map((field) => field.fieldId),
  );
  const assigned = new Set<string>();
  for (const entry of value.fields ?? []) {
    const field = fieldById.get(entry.fieldId);
    if (field === undefined) {
      return { ok: false, code: "value_field_unknown" };
    }
    if (assigned.has(entry.fieldId)) {
      return { ok: false, code: "duplicate_field_assignment" };
    }
    assigned.add(entry.fieldId);
    const scalarCheck = checkScalarAgainstField(field, entry.value);
    if (!scalarCheck.ok) {
      return scalarCheck;
    }
  }
  for (const fieldId of required) {
    if (!assigned.has(fieldId)) {
      return { ok: false, code: "required_field_missing" };
    }
  }
  return { ok: true };
}
