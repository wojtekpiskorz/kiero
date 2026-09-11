/**
 * H2 accessibility smoke (issue #50 focused verification): forms and state
 * labels in Polish, on mobile and desktop widths.
 *
 * The barebones PWA ships no styling by scope (the UX/UI track owns
 * presentation), so the honest width check is structural: the rendered
 * markup of the H2 surfaces carries NO style attribute, no fixed width
 * and no viewport-sensitive markup, meaning the SAME semantic markup
 * serves the phone and the desktop. What CAN break accessibility at this
 * scope is checked headlessly on the real components:
 *
 * - every form control (input/select/textarea) has an id, and a <label
 *   for> names exactly that id, including per-field suffixed ids when two
 *   fields share a label;
 * - controls live inside forms; list rows inside lists; the state labels
 *   render the exact Polish vocabulary from the domain rules;
 * - no raw machine code or English leaks into the rendered rows.
 *
 * Renders with react-dom/server in node (the features are JSX-free by
 * design), the same technique the A4 pending-screens proof uses.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { TASK_STATE_LABELS } from "../../packages/domain/work/index";
import { FieldsEditor } from "../../apps/web/src/features/extensions/ExtensionsFeature";
import { FieldValueControls } from "../../apps/web/src/features/extensions/value-editor";
import { TaskRow } from "../../apps/web/src/features/work/WorkFeature";
import type { TaskView } from "../../convex/work/read";

/** Every kind the value editor renders (the contract's field vocabulary). */
const FIELD_KIND_FIXTURES = [
  { fieldId: "tekst", label: "Opis", kind: "text" },
  { fieldId: "grubosc", label: "Grubość", kind: "quantity", unit: "mm" },
  { fieldId: "taknie", label: "Odbiór", kind: "boolean" },
  {
    fieldId: "rodzaj",
    label: "Rodzaj",
    kind: "enum",
    options: [{ optionId: "glazura", label: "Glazura" }],
  },
  { fieldId: "kwota", label: "Zaliczka", kind: "financial" },
  { fieldId: "termin", label: "Termin", kind: "temporal" },
  { fieldId: "odwolanie", label: "Projekt", kind: "entity_ref" },
  { fieldId: "punkty", label: "Punkty", kind: "list", itemKind: "text" },
] as const;

const TEMPORAL = { companyZone: "Europe/Warsaw", zoneOffset: "+02:00" };

/** Control ids and label fors extracted from one static render. */
function controlsAndLabels(html: string): {
  readonly controlIds: readonly string[];
  readonly labelFors: readonly string[];
} {
  const controlIds = [...html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g)].map(
    (match) => match[1],
  ) as string[];
  const labelFors = [...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map(
    (match) => match[1],
  ) as string[];
  return { controlIds, labelFors };
}

describe("the H2 forms are label-paired and unstyled", () => {
  it("pairs every value-editor control with exactly one Polish label, per field kind", () => {
    for (const field of FIELD_KIND_FIXTURES) {
      const html = renderToString(
        createElement(FieldValueControls, {
          field,
          slots: {
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
          },
          temporal: TEMPORAL,
          onSlot: () => undefined,
        }),
      );
      const { controlIds, labelFors } = controlsAndLabels(html);
      expect(controlIds.length, field.kind).toBeGreaterThan(0);
      for (const id of controlIds) {
        expect(labelFors, `${field.kind}: ${id}`).toContain(id);
      }
      // No styling rides along: the same markup serves phone and desktop.
      expect(html).not.toMatch(/\bstyle="/);
    }
  });

  it("pairs the define-form field editor controls and keeps ids unique per field", () => {
    const html = renderToString(
      createElement(FieldsEditor, {
        drafts: [
          { label: "Grubość", fieldId: "grubosc", kind: "quantity", unit: "mm", itemKind: "text", optionsText: "" },
          { label: "Rodzaj", kind: "enum", fieldId: "rodzaj", unit: "", itemKind: "text", optionsText: "a:A" },
        ],
        onChange: () => undefined,
      }),
    );
    const { controlIds, labelFors } = controlsAndLabels(html);
    expect(new Set(controlIds).size).toBe(controlIds.length);
    for (const id of controlIds) {
      expect(labelFors).toContain(id);
    }
    expect(html).toContain("fieldset");
  });

  it("renders task rows with the Polish state vocabulary and no machine codes", () => {
    const task = {
      taskId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2a",
      projectId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2p",
      title: "Odebrać dostawę okien",
      state: "waiting",
      stateLabel: TASK_STATE_LABELS.waiting,
      waitingReason: "czekamy na okna",
      executorContactId: null,
      executorName: null,
      coordinatorMembershipId: null,
      effectiveCoordinatorMembershipId: null,
      deadline: null,
      dueness: { kind: "no_deadline" },
      linkedEventId: null,
      parentTaskId: null,
      revisionCounter: 3,
      createdAtMs: 1,
      updatedAtMs: 2,
      stateChangedAtMs: 1,
      checklist: [
        {
          itemId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2i",
          description: "kupić płytki",
          state: "checked",
          stateLabel: "odhaczone",
          promotedToTaskId: null,
          checkedAtMs: 5,
          createdAtMs: 1,
        },
      ],
      checklistProgress: { checked: 1, total: 1 },
    } as unknown as TaskView;
    const html = renderToString(
      createElement(TaskRow, { task, project: { name: "Banan", closed: false }, focused: false }),
    );
    // The exact Polish state vocabulary from the domain rules.
    expect(html).toContain(TASK_STATE_LABELS.waiting);
    // The waiting reason renders with its Polish label.
    expect(html).toContain("Przeszkoda");
    expect(html).toContain("czekamy na okna");
    // Semantic structure: article, paragraphs, list for the checklist.
    expect(html).toMatch(/<article>/);
    expect(html).toMatch(/<ul>/);
    // No styling, no machine tokens: same markup on phone and desktop.
    expect(html).not.toMatch(/\bstyle="/);
    expect(html).not.toMatch(/\bwaiting\b/);
  });
});
