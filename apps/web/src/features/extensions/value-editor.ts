/**
 * The extension value editor (H2): the pure input-to-wire builders and the
 * matching barebones controls for one definition version's value.
 *
 * The builders are I/O-free and decode their OWN output through the
 * contract's `ExtensionValue` before returning it, so a builder bug fails
 * at the boundary instead of sending a malformed value to the checked
 * dispatch. The shape rule mirrors the domain validator exactly:
 * a ONE-field version takes that field's value directly (scalar, or a
 * bounded list when the field is a list kind); a MULTI-field version takes
 * an object assigning every required field (the version-1 baseline),
 * optionally the fields later versions added, and nothing else.
 *
 * JSX-free (createElement only), node-importable; the builders are the
 * deterministic test surface for "invalid extension version/value".
 */

import { createElement, type ChangeEvent, type ReactNode } from "react";
import { Schema } from "effect";
import {
  ExtensionValue,
  type DefinitionFieldKind,
  type MoneyRole,
  type ScalarFieldKind,
  type TaxBasis,
  type TemporalRole,
} from "@kiero/contracts";
import { entityRefKindLabels, extensionsCopy as copy } from "./state";

/** One structural field view (decoded and encoded forms both satisfy it). */
export interface FieldShape {
  readonly fieldId: string;
  readonly label: string;
  readonly kind: DefinitionFieldKind;
  readonly unit?: string | undefined;
  readonly itemKind?: ScalarFieldKind | undefined;
  readonly options?: readonly { readonly optionId: string; readonly label: string }[] | undefined;
}

/** The field-declared context a scalar parser needs beyond the raw slots. */
export interface ScalarContext {
  /** Declared unit of a quantity field. */
  readonly unit?: string | undefined;
  /** Company zone for an exact (zoned) temporal value. */
  readonly companyZone?: string | undefined;
  /** The zone's current UTC offset, e.g. "+02:00". */
  readonly zoneOffset?: string | undefined;
}

/** The raw text slots one field's editor tracks (empty string = untouched). */
export interface FieldInputSlots {
  /** text payload */
  readonly text: string;
  /** quantity amount, or the financial amount */
  readonly amount: string;
  /** boolean select: "true" | "false" | "" */
  readonly boolean: string;
  /** enum option id */
  readonly optionId: string;
  /** financial role / tax basis / certainty selects */
  readonly moneyRole: string;
  readonly taxBasis: string;
  readonly certainty: string;
  /** temporal shape: "day" | "month" | "year" | "exact" | "" */
  readonly temporalShape: string;
  /** temporal calendar value: day (YYYY-MM-DD), month (YYYY-MM), year (YYYY) */
  readonly temporalValue: string;
  /** temporal exact datetime-local value, interpreted in the company zone */
  readonly temporalExact: string;
  /** the original spoken expression, preserved verbatim */
  readonly originalExpression: string;
  /** temporal role select */
  readonly temporalRole: string;
  /** entity reference kind select ("project"…) and its table id */
  readonly refKind: string;
  readonly refId: string;
  /** list items, one per line (each parsed as the declared item kind) */
  readonly lines: string;
}

/** Fresh, untouched slots. */
export function emptySlots(): FieldInputSlots {
  return {
    text: "",
    amount: "",
    boolean: "",
    optionId: "",
    moneyRole: "agreed_price",
    taxBasis: "not_specified",
    certainty: "exact",
    temporalShape: "",
    temporalValue: "",
    temporalExact: "",
    originalExpression: "",
    temporalRole: "agreed",
    refKind: "project",
    refId: "",
    lines: "",
  };
}

/** Whether every meaningful slot of these inputs is still untouched. */
export function slotsUntouched(slots: FieldInputSlots): boolean {
  return (
    slots.text.trim() === "" &&
    slots.amount.trim() === "" &&
    slots.boolean === "" &&
    slots.optionId === "" &&
    slots.temporalShape === "" &&
    slots.refId.trim() === "" &&
    slots.lines.trim() === ""
  );
}

export type BuildResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string };

// ---------------------------------------------------------------------------
// Scalar parsing (one field's slots -> one scalar wire value)
// ---------------------------------------------------------------------------

const AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_PATTERN = /^\d{4}$/;
const ZONED_EXACT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Parses one scalar value of `kind` from slots; refuses with a stable code. */
export function parseScalarValue(
  kind: ScalarFieldKind,
  slots: FieldInputSlots,
  context: ScalarContext = {},
): BuildResult {
  switch (kind) {
    case "text": {
      const text = slots.text.trim();
      return text === "" ? { ok: false, code: "input_required" } : { ok: true, value: { _tag: "text", text } };
    }
    case "quantity": {
      const amount = slots.amount.trim();
      if (!AMOUNT_PATTERN.test(amount)) {
        return { ok: false, code: "input_amount_invalid" };
      }
      if ((context.unit ?? "") === "") {
        return { ok: false, code: "value_unit_required" };
      }
      return { ok: true, value: { _tag: "quantity", amount, unit: context.unit } };
    }
    case "boolean": {
      if (slots.boolean !== "true" && slots.boolean !== "false") {
        return { ok: false, code: "input_required" };
      }
      return { ok: true, value: { _tag: "boolean", value: slots.boolean === "true" } };
    }
    case "enum": {
      if (slots.optionId === "") {
        return { ok: false, code: "input_required" };
      }
      return { ok: true, value: { _tag: "enum", optionId: slots.optionId } };
    }
    case "financial": {
      const amount = slots.amount.trim();
      if (!AMOUNT_PATTERN.test(amount)) {
        return { ok: false, code: "input_amount_invalid" };
      }
      return {
        ok: true,
        value: {
          _tag: "financial",
          money: {
            role: slots.moneyRole,
            amount: { _tag: "exact", value: amount },
            // The honest default the contract sanctions: PLN from company
            // settings when the speaker did not state a currency.
            currency: "PLN",
            currencyOrigin: "company_default",
            taxBasis: slots.taxBasis,
            certainty: slots.certainty,
          },
        },
      };
    }
    case "temporal": {
      const originalExpression = slots.originalExpression.trim();
      if (originalExpression === "") {
        return { ok: false, code: "input_required" };
      }
      const role = (temporalRoleOrder as readonly string[]).includes(slots.temporalRole)
        ? slots.temporalRole
        : "agreed";
      let shape: Record<string, unknown> | null = null;
      if (slots.temporalShape === "day") {
        shape = DAY_PATTERN.test(slots.temporalValue)
          ? { _tag: "day", day: slots.temporalValue }
          : null;
      } else if (slots.temporalShape === "month") {
        shape = MONTH_PATTERN.test(slots.temporalValue)
          ? { _tag: "month", month: slots.temporalValue }
          : null;
      } else if (slots.temporalShape === "year") {
        shape = YEAR_PATTERN.test(slots.temporalValue)
          ? { _tag: "year", year: slots.temporalValue }
          : null;
      } else if (slots.temporalShape === "exact") {
        const zone = context.companyZone ?? "";
        const offset = context.zoneOffset ?? "";
        shape =
          ZONED_EXACT_PATTERN.test(slots.temporalExact) && zone !== "" && offset !== ""
            ? { _tag: "date_time", value: `${slots.temporalExact}:00.000${offset}[${zone}]` }
            : null;
      }
      if (shape === null) {
        return { ok: false, code: "input_day_invalid" };
      }
      return {
        ok: true,
        value: { _tag: "temporal", temporal: { shape, originalExpression, role } },
      };
    }
    case "entity_ref": {
      const refId = slots.refId.trim();
      if (refId === "") {
        return { ok: false, code: "input_required" };
      }
      const keyOf: Record<string, string> = {
        project: "projectId",
        task: "taskId",
        event: "eventId",
        contact: "contactId",
        source: "sourceId",
      };
      const key = keyOf[slots.refKind];
      if (key === undefined) {
        return { ok: false, code: "input_required" };
      }
      return { ok: true, value: { _tag: "entity_ref", reference: { _tag: slots.refKind, [key]: refId } } };
    }
  }
}

// ---------------------------------------------------------------------------
// The top-level builder (the domain validator's shape rule, client half)
// ---------------------------------------------------------------------------

function decodeBuilt(value: unknown): BuildResult {
  try {
    // The decode is the validity CHECK; the WIRE form is what crosses to
    // the dispatch (BigDecimal stays the decimal string it was built as).
    Schema.decodeUnknownSync(ExtensionValue)(value);
    return { ok: true, value };
  } catch {
    return { ok: false, code: "value_kind_mismatch" };
  }
}

/** Slots for one list line: the line text in whichever slot the item kind reads. */
function lineSlots(line: string, slots: FieldInputSlots): FieldInputSlots {
  return { ...slots, text: line, amount: line, boolean: line, optionId: line, refId: line };
}

function parseListField(
  field: FieldShape,
  slots: FieldInputSlots,
  context: ScalarContext,
): BuildResult {
  const itemKind = field.itemKind ?? "text";
  const lines = slots.lines
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { ok: false, code: "input_required" };
  }
  const items: unknown[] = [];
  for (const line of lines) {
    const parsed = parseScalarValue(itemKind, lineSlots(line, slots), context);
    if (!parsed.ok) {
      return parsed;
    }
    items.push(parsed.value);
  }
  return decodeBuilt({ _tag: "list", items });
}

/**
 * Builds one version's wire value from per-field slots. `fields` is the
 * target version's snapshot; `firstFields` the definition's version-1
 * baseline (required fields). A field whose slots are untouched is skipped
 * when it is optional, and refused when it is required.
 */
export function buildExtensionValue(
  fields: readonly FieldShape[],
  firstFields: readonly FieldShape[],
  inputs: Readonly<Record<string, FieldInputSlots>>,
  context: ScalarContext = {},
): BuildResult {
  const field = fields.length === 1 ? fields[0] : undefined;
  if (field !== undefined) {
    const slots = inputs[field.fieldId] ?? emptySlots();
    if (slotsUntouched(slots)) {
      return { ok: false, code: "input_required" };
    }
    if (field.kind === "list") {
      return parseListField(field, slots, context);
    }
    const parsed = parseScalarValue(field.kind, slots, {
      ...context,
      unit: field.unit ?? context.unit,
    });
    if (!parsed.ok) {
      return parsed;
    }
    return decodeBuilt(parsed.value);
  }

  const required = new Set(firstFields.map((field) => field.fieldId));
  const entries: { fieldId: string; value: unknown }[] = [];
  for (const field of fields) {
    const slots = inputs[field.fieldId] ?? emptySlots();
    if (slotsUntouched(slots)) {
      if (required.has(field.fieldId)) {
        return { ok: false, code: "value_field_missing" };
      }
      continue;
    }
    if (field.kind === "list") {
      const parsed = parseListField(field, slots, context);
      if (!parsed.ok) {
        return parsed;
      }
      entries.push({ fieldId: field.fieldId, value: parsed.value });
      continue;
    }
    const parsed = parseScalarValue(field.kind, slots, {
      ...context,
      unit: field.unit ?? context.unit,
    });
    if (!parsed.ok) {
      return parsed;
    }
    entries.push({ fieldId: field.fieldId, value: parsed.value });
  }
  if (entries.length === 0) {
    return { ok: false, code: "input_required" };
  }
  return decodeBuilt({ _tag: "object", fields: entries });
}

// ---------------------------------------------------------------------------
// The barebones controls (one field's labeled inputs)
// ---------------------------------------------------------------------------

/** The extra context the temporal editor needs (company zone, UTC offset). */
export interface TemporalContext {
  readonly companyZone: string;
  readonly zoneOffset: string;
}

function labeled(id: string, label: string, control: ReactNode): ReactNode {
  return createElement("div", null, createElement("label", { htmlFor: id }, label), control);
}

function textInput(
  id: string,
  value: string,
  onChange: (value: string) => void,
  extra: { readonly type?: string; readonly placeholder?: string; readonly required?: boolean } = {},
): ReactNode {
  return createElement("input", {
    id,
    type: extra.type ?? "text",
    placeholder: extra.placeholder,
    value,
    required: extra.required ?? false,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
  });
}

/**
 * One field's value controls. Every control carries the field id in its
 * HTML id, so label pairing survives multiple fields with equal labels.
 */
export function FieldValueControls({
  field,
  slots,
  temporal,
  onSlot,
}: {
  readonly field: FieldShape;
  readonly slots: FieldInputSlots;
  readonly temporal: TemporalContext;
  readonly onSlot: (patch: Partial<FieldInputSlots>) => void;
}): ReactNode {
  const id = (slot: string): string => `value-${field.fieldId}-${slot}`;
  const set =
    (slot: keyof FieldInputSlots) =>
    (value: string): void => {
      onSlot({ [slot]: value } as Partial<FieldInputSlots>);
    };

  switch (field.kind) {
    case "text":
      return labeled(id("text"), field.label, textInput(id("text"), slots.text, set("text"), { required: true }));
    case "quantity":
      return labeled(
        id("amount"),
        `${field.label} (${field.unit ?? "?"})`,
        textInput(id("amount"), slots.amount, set("amount"), { required: true, placeholder: "np. 8.5" }),
      );
    case "boolean":
      return labeled(
        id("boolean"),
        field.label,
        createElement(
          "select",
          {
            id: id("boolean"),
            value: slots.boolean,
            required: true,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => set("boolean")(event.target.value),
          },
          createElement("option", { value: "" }, copy.noneOption),
          createElement("option", { value: "true" }, "tak"),
          createElement("option", { value: "false" }, "nie"),
        ),
      );
    case "enum":
      return labeled(
        id("option"),
        field.label,
        createElement(
          "select",
          {
            id: id("option"),
            value: slots.optionId,
            required: true,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => set("optionId")(event.target.value),
          },
          createElement("option", { value: "" }, copy.noneOption),
          ...(field.options ?? []).map((option) =>
            createElement("option", { key: option.optionId, value: option.optionId }, option.label),
          ),
        ),
      );
    case "financial":
      return createElement(
        "div",
        null,
        labeled(id("amount"), `${field.label} (kwota)`, textInput(id("amount"), slots.amount, set("amount"), { required: true, placeholder: "np. 1250.50" })),
        labeled(
          id("role"),
          `${field.label} (rola kwoty)`,
          createElement(
            "select",
            { id: id("role"), value: slots.moneyRole, onChange: (event: ChangeEvent<HTMLSelectElement>) => set("moneyRole")(event.target.value) },
            ...moneyRoleOrder.map((role) =>
              createElement("option", { key: role, value: role }, moneyRoleLabels[role]),
            ),
          ),
        ),
        labeled(
          id("tax"),
          `${field.label} (podatek)`,
          createElement(
            "select",
            { id: id("tax"), value: slots.taxBasis, onChange: (event: ChangeEvent<HTMLSelectElement>) => set("taxBasis")(event.target.value) },
            ...taxBasisOrder.map((basis) =>
              createElement("option", { key: basis, value: basis }, taxBasisLabels[basis]),
            ),
          ),
        ),
        labeled(
          id("certainty"),
          `${field.label} (pewność)`,
          createElement(
            "select",
            { id: id("certainty"), value: slots.certainty, onChange: (event: ChangeEvent<HTMLSelectElement>) => set("certainty")(event.target.value) },
            createElement("option", { value: "exact" }, "kwota dokładna"),
            createElement("option", { value: "estimate" }, "kwota szacunkowa"),
          ),
        ),
      );
    case "temporal":
      return createElement(
        "div",
        null,
        labeled(
          id("shape"),
          `${field.label} (rodzaj terminu)`,
          createElement(
            "select",
            {
              id: id("shape"),
              value: slots.temporalShape,
              required: true,
              onChange: (event: ChangeEvent<HTMLSelectElement>) => set("temporalShape")(event.target.value),
            },
            createElement("option", { value: "" }, copy.noneOption),
            createElement("option", { value: "day" }, "dokładny dzień"),
            createElement("option", { value: "month" }, "miesiąc"),
            createElement("option", { value: "year" }, "rok"),
            createElement("option", { value: "exact" }, "dokładna data i godzina"),
          ),
        ),
        slots.temporalShape === "exact"
          ? labeled(
              id("exact"),
              `${field.label} (data i godzina, strefa firmy ${temporal.companyZone})`,
              textInput(id("exact"), slots.temporalExact, set("temporalExact"), { required: true, type: "datetime-local" }),
            )
          : labeled(
              id("temporal"),
              `${field.label} (wartość)`,
              textInput(id("temporal"), slots.temporalValue, set("temporalValue"), {
                required: slots.temporalShape !== "",
                placeholder:
                  slots.temporalShape === "month"
                    ? "RRRR-MM"
                    : slots.temporalShape === "year"
                      ? "RRRR"
                      : "RRRR-MM-DD",
              }),
            ),
        labeled(
          id("words"),
          `${field.label} (powiedziano)`,
          textInput(id("words"), slots.originalExpression, set("originalExpression"), { required: true, placeholder: "np. koniec tygodnia" }),
        ),
        labeled(
          id("trole"),
          `${field.label} (rola terminu)`,
          createElement(
            "select",
            { id: id("trole"), value: slots.temporalRole, onChange: (event: ChangeEvent<HTMLSelectElement>) => set("temporalRole")(event.target.value) },
            ...temporalRoleOrder.map((role) =>
              createElement("option", { key: role, value: role }, temporalRoleLabels[role]),
            ),
          ),
        ),
      );
    case "entity_ref":
      return createElement(
        "div",
        null,
        labeled(
          id("refkind"),
          `${field.label} (rodzaj odwołania)`,
          createElement(
            "select",
            { id: id("refkind"), value: slots.refKind, onChange: (event: ChangeEvent<HTMLSelectElement>) => set("refKind")(event.target.value) },
            ...Object.entries(entityRefKindLabels).map(([kind, label]) =>
              createElement("option", { key: kind, value: kind }, label),
            ),
          ),
        ),
        labeled(id("refid"), `${field.label} (identyfikator)`, textInput(id("refid"), slots.refId, set("refId"), { required: true })),
      );
    case "list":
      return labeled(
        id("lines"),
        `${field.label} (po jednym elemencie w wierszu, rodzaj: ${field.itemKind ?? "?"})`,
        createElement("textarea", {
          id: id("lines"),
          rows: 3,
          value: slots.lines,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => set("lines")(event.target.value),
        }),
      );
  }
}

/** Polish labels of the money roles (the contract's closed vocabulary). */
const moneyRoleLabels: Record<MoneyRole, string> = {
  price_proposal: "wycena",
  agreed_price: "uzgodniona cena",
  material_cost: "koszt materiałów",
  deposit_received: "otrzymana zaliczka",
  estimated_labor: "szacunek robocizny",
};

const moneyRoleOrder: readonly MoneyRole[] = [
  "price_proposal",
  "agreed_price",
  "material_cost",
  "deposit_received",
  "estimated_labor",
];

const taxBasisLabels: Record<TaxBasis, string> = {
  net: "netto",
  gross: "brutto",
  not_specified: "podatek nieokreślony",
};

const taxBasisOrder: readonly TaxBasis[] = ["net", "gross", "not_specified"];

const temporalRoleLabels: Record<TemporalRole, string> = {
  proposed: "propozycja",
  internal: "plan wewnętrzny",
  agreed: "uzgodnione",
  actual: "stan faktyczny",
};

const temporalRoleOrder: readonly TemporalRole[] = ["proposed", "internal", "agreed", "actual"];
