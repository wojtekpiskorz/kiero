/**
 * C3 focused verification, part 1: the PURE domain rules from
 * packages/domain/extensions — bounded definition shapes, immutable version
 * succession (field-ID stability through label changes; incompatible
 * meaning/kind/unit changes refused), value-versus-version validation and
 * the catalog-reuse assessment with realistic Polish label collisions.
 *
 * The transaction halves (tenant checks, OCC races, atomic usage counts,
 * historic-value interpretation against stored rows) run against the REAL
 * leased dev deployment in tests/c3/live-proof.mjs.
 */

import { describe, expect, it } from "vitest";
import {
  assessCatalogCandidate,
  nameSimilarity,
  normalizeLabel,
  stableKeyOf,
  structureCompatible,
} from "@kiero/domain";
import {
  decideVersionSuccession,
  validateDefinitionShape,
  validateExtensionValueAgainstVersion,
  type FieldShapeView,
} from "@kiero/domain";

const quantityField = (fieldId: string, unit: string, label = fieldId): FieldShapeView => ({
  fieldId,
  label,
  kind: "quantity",
  unit,
});

// ---------------------------------------------------------------------------
// Bounded definition shapes: bounded data, never executable schema code.
// ---------------------------------------------------------------------------

describe("bounded definition shapes", () => {
  it("accepts the scalar kinds with their declared meaning anchors", () => {
    expect(
      validateDefinitionShape([
        { fieldId: "szerokosc", label: "Szerokość", kind: "quantity", unit: "mm" },
        { fieldId: "uwaga", label: "Uwaga", kind: "text" },
        { fieldId: "pilne", label: "Pilne", kind: "boolean" },
        {
          fieldId: "kolor",
          label: "Kolor",
          kind: "enum",
          options: [
            { optionId: "bezowa", label: "Beżowa" },
            { optionId: "szara", label: "Szara" },
          ],
        },
      ]),
    ).toEqual({ ok: true });
  });

  it("rejects the recursive shapes: object fields and container item kinds", () => {
    expect(
      validateDefinitionShape([
        { fieldId: "wezel", label: "Węzeł", kind: "object" } as never,
      ]),
    ).toEqual({ ok: false, code: "field_kind_object_forbidden" });
    expect(
      validateDefinitionShape([
        { fieldId: "macierz", label: "Macierz", kind: "list", itemKind: "list" } as never,
      ]),
    ).toEqual({ ok: false, code: "list_field_requires_scalar_item_kind" });
    expect(
      validateDefinitionShape([
        { fieldId: "lista_obiektow", label: "Lista obiektów", kind: "list", itemKind: "object" } as never,
      ]),
    ).toEqual({ ok: false, code: "list_field_requires_scalar_item_kind" });
  });

  it("rejects oversized shapes beyond the value-contract bounds", () => {
    expect(validateDefinitionShape([])).toEqual({ ok: false, code: "definition_without_fields" });
    const oversized: FieldShapeView[] = Array.from({ length: 33 }, (_, index) =>
      quantityField(`f${index}`, "mm"),
    );
    expect(validateDefinitionShape(oversized)).toEqual({
      ok: false,
      code: "definition_fields_exceeded",
    });
    const tooManyOptions: FieldShapeView[] = [
      {
        fieldId: "kolor",
        label: "Kolor",
        kind: "enum",
        options: Array.from({ length: 65 }, (_, index) => ({
          optionId: `o${index}`,
          label: `O${index}`,
        })),
      },
    ];
    expect(validateDefinitionShape(tooManyOptions)).toEqual({
      ok: false,
      code: "enum_options_exceeded",
    });
  });

  it("rejects meaning anchors in the wrong place (units, item kinds, options)", () => {
    expect(validateDefinitionShape([quantityField("grubosc", "")])).toEqual({
      ok: false,
      code: "quantity_field_without_unit",
    });
    expect(
      validateDefinitionShape([{ fieldId: "t", label: "T", kind: "text", unit: "mm" } as never]),
    ).toEqual({ ok: false, code: "unit_on_non_quantity_field" });
    expect(validateDefinitionShape([{ fieldId: "lista", label: "L", kind: "list" } as never])).toEqual(
      { ok: false, code: "list_field_requires_scalar_item_kind" },
    );
    expect(
      validateDefinitionShape([{ fieldId: "t", label: "T", kind: "text", itemKind: "text" } as never]),
    ).toEqual({ ok: false, code: "item_kind_on_non_list_field" });
    expect(
      validateDefinitionShape([{ fieldId: "kolor", label: "Kolor", kind: "enum", options: [] }]),
    ).toEqual({ ok: false, code: "enum_field_without_options" });
    expect(
      validateDefinitionShape([
        {
          fieldId: "t",
          label: "T",
          kind: "text",
          options: [{ optionId: "a", label: "A" }],
        } as never,
      ]),
    ).toEqual({ ok: false, code: "options_on_non_enum_field" });
    expect(
      validateDefinitionShape([
        quantityField("a", "mm"),
        quantityField("a", "cm"),
      ]),
    ).toEqual({ ok: false, code: "duplicate_field_id" });
    expect(
      validateDefinitionShape([
        quantityField("a", "mm"),
        { fieldId: "lista", label: "L", kind: "list", itemKind: "text" },
      ]),
    ).toEqual({ ok: false, code: "list_field_not_allowed_in_object" });
  });
});

// ---------------------------------------------------------------------------
// Version succession: labels move, meaning does not.
// ---------------------------------------------------------------------------

describe("version succession (immutable meaning, stable field IDs)", () => {
  const millimetres = [quantityField("grubosc", "mm", "Grubość płytki")];

  it("accepts label changes: the field ID outlives the label", () => {
    expect(
      decideVersionSuccession(millimetres, [quantityField("grubosc", "mm", "Grubość płytki (nowa nazwa)")]),
    ).toEqual({ ok: true });
  });

  it("accepts adding a field: the new version's addition is optional", () => {
    expect(
      decideVersionSuccession(millimetres, [
        quantityField("grubosc", "mm", "Grubość płytki"),
        quantityField("tolerancja", "mm", "Tolerancja"),
      ]),
    ).toEqual({ ok: true });
  });

  it("accepts adding enum options, refuses removing them", () => {
    const enumV1: FieldShapeView[] = [
      {
        fieldId: "kolor",
        label: "Kolor",
        kind: "enum",
        options: [
          { optionId: "bezowa", label: "Beżowa" },
          { optionId: "szara", label: "Szara" },
        ],
      },
    ];
    const optionAdded: FieldShapeView[] = [
      {
        fieldId: "kolor",
        label: "Kolor",
        kind: "enum",
        options: [
          { optionId: "bezowa", label: "Beżowa" },
          { optionId: "szara", label: "Szara" },
          { optionId: "antracytowa", label: "Antracytowa" },
        ],
      },
    ];
    expect(decideVersionSuccession(enumV1, optionAdded)).toEqual({ ok: true });
    expect(decideVersionSuccession(optionAdded, enumV1)).toEqual({
      ok: false,
      code: "enum_option_removed",
    });
  });

  it("refuses the millimetre-to-centimetre meaning change (and removals/kind changes)", () => {
    expect(decideVersionSuccession(millimetres, [quantityField("grubosc", "cm")])).toEqual({
      ok: false,
      code: "field_unit_changed",
    });
    expect(
      decideVersionSuccession(millimetres, [{ fieldId: "grubosc", label: "G", kind: "text" } as never]),
    ).toEqual({ ok: false, code: "field_kind_changed" });
    expect(decideVersionSuccession(millimetres, [])).toEqual({ ok: false, code: "field_removed" });
    expect(
      decideVersionSuccession(
        [{ fieldId: "lista", label: "L", kind: "list", itemKind: "text" }],
        [{ fieldId: "lista", label: "L", kind: "list", itemKind: "quantity" }],
      ),
    ).toEqual({ ok: false, code: "field_item_kind_changed" });
  });
});

// ---------------------------------------------------------------------------
// Value validation against one exact version.
// ---------------------------------------------------------------------------

describe("value validation against the exact stored version", () => {
  const singleFieldVersion = { fields: millimetres(), firstFields: millimetres() };
  function millimetres(): FieldShapeView[] {
    return [quantityField("grubosc", "mm", "Grubość płytki")];
  }

  it("validates a single-field version's DIRECT scalar (unit must match)", () => {
    expect(
      validateExtensionValueAgainstVersion({
        ...singleFieldVersion,
        value: { _tag: "quantity", amount: "8", unit: "mm" },
      }),
    ).toEqual({ ok: true });
    expect(
      validateExtensionValueAgainstVersion({
        ...singleFieldVersion,
        value: { _tag: "quantity", amount: "8", unit: "cm" },
      }),
    ).toEqual({ ok: false, code: "value_unit_mismatch" });
    expect(
      validateExtensionValueAgainstVersion({
        ...singleFieldVersion,
        value: { _tag: "text", text: "osiem" },
      }),
    ).toEqual({ ok: false, code: "value_kind_mismatch" });
  });

  it("validates a bounded list against its declared scalar item kind", () => {
    const listVersion = {
      fields: [{ fieldId: "telefony", label: "Telefony dostawcy", kind: "list", itemKind: "text" }],
      firstFields: [{ fieldId: "telefony", label: "Telefony dostawcy", kind: "list", itemKind: "text" }],
    };
    expect(
      validateExtensionValueAgainstVersion({
        ...listVersion,
        value: {
          _tag: "list",
          items: [
            { _tag: "text", text: "600 100 100" },
            { _tag: "text", text: "700 200 200" },
          ],
        },
      }),
    ).toEqual({ ok: true });
    expect(
      validateExtensionValueAgainstVersion({
        ...listVersion,
        value: { _tag: "list", items: [{ _tag: "quantity", amount: "8", unit: "mm" }] },
      }),
    ).toEqual({ ok: false, code: "list_item_kind_mismatch" });
    expect(
      validateExtensionValueAgainstVersion({
        ...listVersion,
        value: { _tag: "text", text: "jeden telefon" },
      }),
    ).toEqual({ ok: false, code: "value_shape_mismatch" });
  });

  const multiField = {
    fields: [
      quantityField("szerokosc", "mm", "Szerokość"),
      quantityField("wysokosc", "mm", "Wysokość"),
      {
        fieldId: "kolor",
        label: "Kolor",
        kind: "enum",
        options: [
          { optionId: "bezowa", label: "Beżowa" },
          { optionId: "szara", label: "Szara" },
        ],
      },
    ],
  };

  it("validates an object value: every v1 field required, kinds and options exact", () => {
    expect(
      validateExtensionValueAgainstVersion({
        ...multiField,
        firstFields: multiField.fields,
        value: {
          _tag: "object",
          fields: [
            { fieldId: "szerokosc", value: { _tag: "quantity", amount: "1200", unit: "mm" } },
            { fieldId: "wysokosc", value: { _tag: "quantity", amount: "600", unit: "mm" } },
            { fieldId: "kolor", value: { _tag: "enum", optionId: "bezowa" } },
          ],
        },
      }),
    ).toEqual({ ok: true });
    expect(
      validateExtensionValueAgainstVersion({
        ...multiField,
        firstFields: multiField.fields,
        value: {
          _tag: "object",
          fields: [
            { fieldId: "szerokosc", value: { _tag: "quantity", amount: "1200", unit: "mm" } },
            { fieldId: "kolor", value: { _tag: "enum", optionId: "bezowa" } },
          ],
        },
      }),
    ).toEqual({ ok: false, code: "required_field_missing" });
    expect(
      validateExtensionValueAgainstVersion({
        ...multiField,
        firstFields: multiField.fields,
        value: {
          _tag: "object",
          fields: [
            { fieldId: "szerokosc", value: { _tag: "quantity", amount: "1200", unit: "mm" } },
            { fieldId: "wysokosc", value: { _tag: "quantity", amount: "600", unit: "mm" } },
            { fieldId: "kolor", value: { _tag: "enum", optionId: "czarna" } },
          ],
        },
      }),
    ).toEqual({ ok: false, code: "enum_option_unknown" });
    expect(
      validateExtensionValueAgainstVersion({
        ...multiField,
        firstFields: multiField.fields,
        value: {
          _tag: "object",
          fields: [
            { fieldId: "szerokosc", value: { _tag: "quantity", amount: "1200", unit: "mm" } },
            { fieldId: "wysokosc", value: { _tag: "quantity", amount: "600", unit: "mm" } },
            { fieldId: "kolor", value: { _tag: "enum", optionId: "bezowa" } },
            { fieldId: "glebokosc", value: { _tag: "quantity", amount: "8", unit: "mm" } },
          ],
        },
      }),
    ).toEqual({ ok: false, code: "value_field_unknown" });
  });

  it("treats fields added by later versions as optional for their values", () => {
    const version2 = [
      ...multiField.fields,
      quantityField("tolerancja", "mm", "Tolerancja"),
    ];
    const withoutOptional = {
      _tag: "object",
      fields: [
        { fieldId: "szerokosc", value: { _tag: "quantity", amount: "1200", unit: "mm" } },
        { fieldId: "wysokosc", value: { _tag: "quantity", amount: "600", unit: "mm" } },
        { fieldId: "kolor", value: { _tag: "enum", optionId: "szara" } },
      ],
    };
    expect(
      validateExtensionValueAgainstVersion({
        fields: version2,
        firstFields: multiField.fields,
        value: withoutOptional,
      }),
    ).toEqual({ ok: true });
    // The same payload against version 1: still valid (v1 ignores the future
    // field) — but a v1 value MUST carry all v1 fields.
    expect(
      validateExtensionValueAgainstVersion({
        fields: multiField.fields,
        firstFields: multiField.fields,
        value: withoutOptional,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses duplicate assignments and non-object payloads for multi-field versions", () => {
    expect(
      validateExtensionValueAgainstVersion({
        ...multiField,
        firstFields: multiField.fields,
        value: {
          _tag: "object",
          fields: [
            { fieldId: "szerokosc", value: { _tag: "quantity", amount: "1", unit: "mm" } },
            { fieldId: "szerokosc", value: { _tag: "quantity", amount: "2", unit: "mm" } },
            { fieldId: "wysokosc", value: { _tag: "quantity", amount: "3", unit: "mm" } },
            { fieldId: "kolor", value: { _tag: "enum", optionId: "szara" } },
          ],
        },
      }),
    ).toEqual({ ok: false, code: "duplicate_field_assignment" });
    expect(
      validateExtensionValueAgainstVersion({
        ...multiField,
        firstFields: multiField.fields,
        value: { _tag: "quantity", amount: "8", unit: "mm" },
      }),
    ).toEqual({ ok: false, code: "value_shape_mismatch" });
  });
});

// ---------------------------------------------------------------------------
// Catalog reuse: Polish labels, typed verdicts, no silent duplicates.
// ---------------------------------------------------------------------------

describe("catalog reuse assessment (Polish label collisions)", () => {
  it("normalizes Polish labels: diacritics fold, case and punctuation vanish", () => {
    expect(normalizeLabel("Grubość Płytki")).toBe("grubosc plytki");
    expect(normalizeLabel("  GRUBOŚĆ   płytki!  ")).toBe("grubosc plytki");
    expect(stableKeyOf("Grubość płytki (mm)")).toBe("grubosc plytki mm");
    expect(stableKeyOf("Grubość płytki (mm)")).not.toBe(stableKeyOf("Grubość płytki (cm)"));
  });

  it("scores containment as near-duplicate and disjoint names as distinct", () => {
    expect(nameSimilarity("Grubość płytki", "grubość płytki (mm)")).toBe(1);
    // One differing unit token out of three: still near (it must surface as a
    // typed conflict), but the stable keys differ (two distinct names).
    expect(nameSimilarity("Grubość płytki (mm)", "Grubość płytki (cm)")).toBeGreaterThan(0.6);
    expect(nameSimilarity("Grubość płytki", "Kolor fugi")).toBe(0);
    expect(nameSimilarity("Telefony dostawcy", "Kontakt do dostawcy")).toBeLessThan(0.6);
  });

  it("requires meaning and type compatibility, never a name match alone", () => {
    const centimetreDraft = [quantityField("grubosc", "cm", "Grubość płytki (cm)")];
    const millimetreDraft = [quantityField("grubosc", "mm", "Grubość płytki")];
    const millimetreCandidate = [quantityField("grubosc", "mm", "Grubość płytki (mm)")];
    // Near name, incompatible unit: a typed conflict, NOT a silent reuse.
    expect(
      assessCatalogCandidate(
        { name: "Grubość płytki (cm)", fields: centimetreDraft },
        { name: "Grubość płytki (mm)", fields: millimetreCandidate },
      ),
    ).toEqual({
      score: expect.any(Number),
      verdict: "name_conflict",
      structureCompatible: false,
    });
    // Near name, compatible structure: a reuse candidate.
    expect(
      assessCatalogCandidate(
        { name: "Grubość płytki", fields: millimetreDraft },
        { name: "Grubość płytki (mm)", fields: millimetreCandidate },
      ).verdict,
    ).toBe("reuse_candidate");
    // Distant name: distinct, whatever the structure.
    expect(
      assessCatalogCandidate(
        { name: "Telefon do szefa", fields: millimetreDraft },
        { name: "Grubość płytki (mm)", fields: millimetreCandidate },
      ).verdict,
    ).toBe("distinct");
  });

  it("keeps structure compatibility about types, not label wording", () => {
    const draft = [
      quantityField("szerokosc", "mm", "Szerokość"),
      { fieldId: "kolor", label: "Kolor", kind: "enum", options: [
        { optionId: "a", label: "A" },
        { optionId: "b", label: "B" },
      ] },
    ];
    const sameTypesRelabeled = [
      quantityField("w", "mm", "Wymiar poziomy"),
      { fieldId: "c", label: "Barwa", kind: "enum", options: [
        { optionId: "x", label: "X" },
        { optionId: "y", label: "Y" },
      ] },
    ];
    expect(structureCompatible(draft, sameTypesRelabeled)).toBe(true);
    const superset = [...sameTypesRelabeled, quantityField("glebokosc", "mm", "Głębokość")];
    expect(structureCompatible(draft, superset)).toBe(true);
    expect(structureCompatible(superset, draft)).toBe(false);
    expect(structureCompatible(draft, [quantityField("szerokosc", "cm", "Szerokość")])).toBe(false);
  });

  it("reports unassessed compatibility explicitly when no draft was given", () => {
    const assessment = assessCatalogCandidate(
      { name: "Grubość płytki" },
      { name: "Grubość płytki (mm)", fields: [quantityField("grubosc", "mm")] },
    );
    expect(assessment.structureCompatible).toBeNull();
    expect(assessment.verdict).toBe("reuse_candidate");
  });
});
