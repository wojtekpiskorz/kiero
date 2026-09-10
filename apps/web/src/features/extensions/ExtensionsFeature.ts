/**
 * The extensions feature (H2): the /dodatkowe surface for C3's typed
 * extension definitions and the extension values bosses record.
 *
 * JSX-free on purpose (createElement only), like the sibling surfaces.
 *
 * - catalog: `memory.searchExtensionCatalog` BEFORE any definition is
 *   created; candidates render by field kind with their STABLE field ids
 *   visible (labels may change, ids may not);
 * - define/version: `memory.defineExtension` and
 *   `memory.versionExtensionDefinition` through the checked memory
 *   dispatch; the define form derives a stable field id from the Polish
 *   label, and the boss may adjust it;
 * - values: recording an extension value is an evidence-backed finding:
 *   the boss's statement becomes a real source (D1's prepare/accept pair),
 *   then one staged change set (`memory.prepareChangeSet` +
 *   `memory.publishChangeSet`) writes the typed value with that source as
 *   its basis; `memory.validateExtensionValue` pre-flights the value
 *   against the exact stored version;
 * - corrections: `memory.correctFinding` replaces an existing extension
 *   finding's value (optionally under a newer definition version) with the
 *   revision the boss actually saw, keeping author, time and reason.
 *
 * The value/correction sections live in ./record.ts; both dispatch through
 * the shared checked-dispatch hook (`../company/dispatch`).
 */

import { createElement, useState, type ChangeEvent, type ReactNode } from "react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { Schema } from "effect";
import { memoryOperations, parseTableId } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import { CompanyFeatureGate, SessionEnded, type MemberOverview } from "../company/CompanyGate";
import { useCheckedDispatch, NoticeArea } from "../company/dispatch";
import { temporalContextOf } from "../company/time";
import { PROJECT_PARAM, searchParam, writeScopeParam } from "../company/route-params";
import {
  deriveFieldId,
  failureHint,
  fieldKindLabels,
  extensionsCopy as copy,
} from "./state";
import { ValueSection, CorrectSection, type Candidate, type FindingsScopeArgs } from "./record";
import type { FieldShape } from "./value-editor";

export type { FieldShape };

/** The feature root: mounted by the host entry at "/dodatkowe" (memory.extensions). */
export function ExtensionsFeature(): ReactNode {
  return createElement(CompanyFeatureGate, {
    title: copy.title,
    // The member callback already carries the company's timezone (the
    // gate's MemberOverview); the surface takes it here instead of
    // subscribing to the work module's overview for one string.
    member: (overview: MemberOverview) =>
      createElement(ExtensionsMain, { companyTimezone: overview.company.timezone }),
  });
}

function ExtensionsMain({ companyTimezone }: { readonly companyTimezone: string }): ReactNode {
  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  const [scope, setScope] = useState<string>(() => searchParam(PROJECT_PARAM) ?? "company");
  const [candidates, setCandidates] = useState<readonly Candidate[]>([]);

  if (projects.status === "error") {
    return createElement(SessionEnded);
  }
  if (projects.status !== "success") {
    return createElement("p", { role: "status" }, "Sprawdzamy Twoją sesję…");
  }

  const scopeProjectId = parseTableId("projects", scope);
  const findingsArgs: FindingsScopeArgs =
    scope === "company" || scopeProjectId === null
      ? { scope: { _tag: "company" } }
      : { scope: { _tag: "project", projectId: scopeProjectId } };
  const temporal = temporalContextOf(companyTimezone);

  return createElement(
    "section",
    null,
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement("label", { htmlFor: "extensions-scope" }, copy.valueScopeLabel),
    createElement(
      "select",
      {
        id: "extensions-scope",
        value: scope,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const next = event.target.value;
          writeScopeParam(next === "company" ? null : next);
          setScope(next);
        },
      },
      createElement("option", { value: "company" }, copy.valueScopeCompany),
      ...[...projects.data.active, ...projects.data.closed].map((project) =>
        createElement("option", { key: project.projectId, value: project.projectId }, project.displayName),
      ),
    ),
    createElement(CatalogSection, { candidates, onCandidates: setCandidates }),
    createElement(DefineSection, null),
    createElement(VersionSection, { candidates }),
    createElement(ValueSection, {
      candidates,
      temporal,
      findingsArgs,
    }),
    createElement(CorrectSection, {
      candidates,
      temporal,
      findingsArgs,
    }),
  );
}

// ---------------------------------------------------------------------------
// Candidate rendering (fields by kind, stable ids visible)
// ---------------------------------------------------------------------------

function FieldShapeLine({ field }: { readonly field: FieldShape }): ReactNode {
  const parts = [
    `${field.label} [${field.fieldId}]`,
    fieldKindLabels[field.kind],
    ...(field.kind === "quantity" ? [`${field.unit ?? "?"}`] : []),
    ...(field.kind === "list" ? [`elementy: ${field.itemKind ?? "?"}`] : []),
    ...(field.kind === "enum"
      ? [(field.options ?? []).map((option) => `${option.optionId}=${option.label}`).join(", ")]
      : []),
  ];
  return createElement("li", null, parts.join(" · "));
}

/** Renders one catalog candidate: identity, usage, and the field shapes. */
export function CandidateRow({ candidate }: { readonly candidate: Candidate }): ReactNode {
  return createElement(
    "li",
    null,
    createElement("p", null, createElement("strong", null, candidate.name), ` (${copy.versionLabel(candidate.version)})`),
    createElement(
      "p",
      null,
      candidate.shared ? copy.sharedMark : copy.ownMark,
      // The similarity verdict IS the answer to searchIntro's question.
      ` · ${copy.verdictLabels[candidate.similarity.verdict]}`,
      ` · ${copy.usageLabel(candidate.usageCount, candidate.lastUsedAtMs === null ? null : `${candidate.lastUsedAtMs}`)}`,
    ),
    createElement(
      "details",
      null,
      createElement("summary", null, copy.fieldsHeading),
      createElement("ul", null, ...candidate.fields.map((field) =>
        createElement(FieldShapeLine, { key: field.fieldId, field }),
      )),
    ),
  );
}

// ---------------------------------------------------------------------------
// Catalog search
// ---------------------------------------------------------------------------

function CatalogSection({
  candidates,
  onCandidates,
}: {
  readonly candidates: readonly Candidate[];
  readonly onCandidates: (candidates: readonly Candidate[]) => void;
}): ReactNode {
  const { run, notice, busy } = useCheckedDispatch(
    useMutation(api.memory.findings.functions.dispatchMemoryCommandEntry),
    failureHint,
  );
  const [name, setName] = useState("");

  async function submit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    const value = await run("memory.searchExtensionCatalog", { name: name.trim() }, copy.searchSearching);
    if (value !== null) {
      onCandidates(decodeSearchResult(value));
    }
  }

  return createElement(
    "section",
    null,
    createElement("h2", null, copy.searchHeading),
    createElement("p", null, copy.searchIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "catalog-name" }, copy.searchNameLabel),
      createElement("input", {
        id: "catalog-name",
        type: "text",
        placeholder: copy.searchNamePlaceholder,
        value: name,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        required: true,
      }),
      createElement("button", { type: "submit", disabled: busy || name.trim().length === 0 }, copy.searchSubmit),
      createElement(NoticeArea, { notice }),
    ),
    createElement("h3", null, copy.catalogHeading),
    candidates.length === 0
      ? createElement("p", null, copy.noCandidates)
      : createElement("ul", null, ...candidates.map((candidate) =>
          createElement(CandidateRow, { key: candidate.definitionId, candidate }),
        )),
  );
}

// ---------------------------------------------------------------------------
// Define: name + field drafts
// ---------------------------------------------------------------------------

/** One define/version form field row (editable draft). */
export interface FieldDraft {
  readonly label: string;
  readonly fieldId: string;
  readonly kind: FieldShape["kind"];
  readonly unit: string;
  readonly itemKind: string;
  readonly optionsText: string;
}

/** The scalar kinds a list's item kind may take (mirrors the contract set). */
const SCALAR_KINDS: readonly FieldShape["kind"][] = [
  "text",
  "quantity",
  "boolean",
  "enum",
  "financial",
  "temporal",
  "entity_ref",
];

export function draftFromField(field: FieldShape): FieldDraft {
  return {
    label: field.label,
    fieldId: field.fieldId,
    kind: field.kind,
    unit: field.unit ?? "",
    itemKind: field.itemKind ?? "text",
    optionsText: (field.options ?? []).map((option) => `${option.optionId}:${option.label}`).join("\n"),
  };
}

function freshDraft(): FieldDraft {
  return { label: "", fieldId: "", kind: "text", unit: "", itemKind: "text", optionsText: "" };
}

/** Parses one draft row into a field shape, or refuses with a stable code. */
export function draftToField(draft: FieldDraft):
  | { readonly ok: true; readonly field: FieldShape }
  | { readonly ok: false; readonly code: string } {
  const label = draft.label.trim();
  if (label === "") {
    return { ok: false, code: "input_required" };
  }
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(draft.fieldId)) {
    return { ok: false, code: "input_field_id_invalid" };
  }
  if (draft.kind === "quantity" && draft.unit.trim() === "") {
    return { ok: false, code: "quantity_field_without_unit" };
  }
  if (draft.kind === "list" && !SCALAR_KINDS.includes(draft.itemKind as FieldShape["kind"])) {
    return { ok: false, code: "list_field_requires_scalar_item_kind" };
  }
  let options: { optionId: string; label: string }[] | undefined;
  if (draft.kind === "enum") {
    options = [];
    for (const line of draft.optionsText.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      const separator = trimmed.indexOf(":");
      if (separator <= 0) {
        return { ok: false, code: "input_option_invalid" };
      }
      const optionId = trimmed.slice(0, separator).trim();
      const optionLabel = trimmed.slice(separator + 1).trim();
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(optionId) || optionLabel === "") {
        return { ok: false, code: "input_option_invalid" };
      }
      options.push({ optionId, label: optionLabel });
    }
    if (options.length === 0) {
      return { ok: false, code: "enum_field_without_options" };
    }
  }
  return {
    ok: true,
    field: {
      fieldId: draft.fieldId,
      label,
      kind: draft.kind,
      ...(draft.kind === "quantity" ? { unit: draft.unit.trim() } : {}),
      ...(draft.kind === "list"
        ? { itemKind: draft.itemKind as FieldShape["itemKind"] }
        : {}),
      ...(options !== undefined ? { options } : {}),
    },
  };
}

/** Parses every draft row, or refuses with the first row's stable code. */
export function draftsToFields(drafts: readonly FieldDraft[]):
  | { readonly ok: true; readonly fields: FieldShape[] }
  | { readonly ok: false; readonly code: string } {
  const fields: FieldShape[] = [];
  for (const draft of drafts) {
    const parsed = draftToField(draft);
    if (!parsed.ok) {
      return parsed;
    }
    fields.push(parsed.field);
  }
  return { ok: true, fields };
}

/** The label-paired editor for one definition's field drafts. */
export function FieldsEditor({
  drafts,
  onChange,
}: {
  readonly drafts: readonly FieldDraft[];
  readonly onChange: (drafts: readonly FieldDraft[]) => void;
}): ReactNode {
  function patch(index: number, next: Partial<FieldDraft>): void {
    onChange(drafts.map((draft, position) => (position === index ? { ...draft, ...next } : draft)));
  }
  return createElement(
    "fieldset", null,
    createElement("legend", null, copy.defineFieldsLabel),
    ...drafts.map((draft, index) =>
      createElement(
        "div", { key: `field-${index}` },
        createElement("label", { htmlFor: `define-label-${index}` }, `${copy.defineFieldLabelLabel} #${index + 1}`),
        createElement("input", {
          id: `define-label-${index}`,
          type: "text",
          value: draft.label,
          onChange: (event: ChangeEvent<HTMLInputElement>) => {
            const label = event.target.value;
            patch(index, {
              label,
              // Propose the stable id only while the boss has not set one.
              fieldId: draft.fieldId === "" ? deriveFieldId(label) : draft.fieldId,
            });
          },
          required: true,
        }),
        createElement("label", { htmlFor: `define-id-${index}` }, copy.defineFieldIdLabel),
        createElement("input", {
          id: `define-id-${index}`,
          type: "text",
          value: draft.fieldId,
          onChange: (event: ChangeEvent<HTMLInputElement>) => patch(index, { fieldId: event.target.value }),
          required: true,
        }),
        createElement("label", { htmlFor: `define-kind-${index}` }, copy.defineFieldKindLabel),
        createElement("select", {
          id: `define-kind-${index}`,
          value: draft.kind,
          onChange: (event: ChangeEvent<HTMLSelectElement>) =>
            patch(index, { kind: event.target.value as FieldShape["kind"] }),
        },
          ...[...SCALAR_KINDS, "list" as const].map((kind) =>
            createElement("option", { key: kind, value: kind }, fieldKindLabels[kind]),
          ),
        ),
        ...(draft.kind === "quantity"
          ? [
              createElement("label", { htmlFor: `define-unit-${index}` }, copy.defineFieldUnitLabel),
              createElement("input", {
                id: `define-unit-${index}`,
                type: "text",
                value: draft.unit,
                onChange: (event: ChangeEvent<HTMLInputElement>) => patch(index, { unit: event.target.value }),
                required: true,
              }),
            ]
          : []),
        ...(draft.kind === "list"
          ? [
              createElement("label", { htmlFor: `define-itemkind-${index}` }, copy.defineFieldItemKindLabel),
              createElement("select", {
                id: `define-itemkind-${index}`,
                value: draft.itemKind,
                onChange: (event: ChangeEvent<HTMLSelectElement>) =>
                  patch(index, { itemKind: event.target.value }),
              },
                ...SCALAR_KINDS.map((kind) =>
                  createElement("option", { key: kind, value: kind }, fieldKindLabels[kind]),
                ),
              ),
            ]
          : []),
        ...(draft.kind === "enum"
          ? [
              createElement("label", { htmlFor: `define-options-${index}` }, copy.defineFieldOptionsLabel),
              createElement("textarea", {
                id: `define-options-${index}`,
                rows: 3,
                value: draft.optionsText,
                onChange: (event: ChangeEvent<HTMLTextAreaElement>) =>
                  patch(index, { optionsText: event.target.value }),
              }),
            ]
          : []),
        createElement("button", {
          type: "button",
          onClick: () => onChange(drafts.filter((_, position) => position !== index)),
        }, copy.defineRemoveField),
      ),
    ),
    createElement("button", {
      type: "button",
      onClick: () => onChange([...drafts, freshDraft()]),
    }, copy.defineAddField),
  );
}

function DefineSection(): ReactNode {
  const { run, notice, busy, setNotice } = useCheckedDispatch(
    useMutation(api.memory.findings.functions.dispatchMemoryCommandEntry),
    failureHint,
  );
  const [name, setName] = useState("");
  const [drafts, setDrafts] = useState<readonly FieldDraft[]>([freshDraft()]);

  async function submit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    const parsed = draftsToFields(drafts);
    if (!parsed.ok) {
      setNotice({ kind: "error", text: failureHint(parsed.code, parsed.code) });
      return;
    }
    const value = await run("memory.defineExtension", { name: name.trim(), fields: parsed.fields }, copy.defineCreated);
    if (value !== null) {
      const decoded = Schema.decodeUnknownSync(defineResultSchema)(value);
      if (!decoded.created) {
        // Idempotent reuse: the catalog already had an equivalent definition.
        setNotice({ kind: "ok", text: copy.defineReused });
      }
    }
  }

  return createElement(
    "section",
    null,
    createElement("h2", null, copy.defineHeading),
    createElement("p", null, copy.defineIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "define-name" }, copy.defineNameLabel),
      createElement("input", {
        id: "define-name",
        type: "text",
        value: name,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        required: true,
      }),
      createElement(FieldsEditor, { drafts, onChange: setDrafts }),
      createElement("button", { type: "submit", disabled: busy || name.trim().length === 0 }, copy.defineSubmit),
      createElement(NoticeArea, { notice }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Version: a compatible successor of a catalog definition
// ---------------------------------------------------------------------------

function VersionSection({ candidates }: { readonly candidates: readonly Candidate[] }): ReactNode {
  const { run, notice, busy, setNotice } = useCheckedDispatch(
    useMutation(api.memory.findings.functions.dispatchMemoryCommandEntry),
    failureHint,
  );
  const [definitionId, setDefinitionId] = useState("");
  const [changeNote, setChangeNote] = useState("");
  const candidate = candidates.find((entry) => entry.definitionId === definitionId) ?? null;
  const [drafts, setDrafts] = useState<readonly FieldDraft[]>([]);

  function pickDefinition(nextDefinitionId: string): void {
    setDefinitionId(nextDefinitionId);
    const chosen = candidates.find((entry) => entry.definitionId === nextDefinitionId) ?? null;
    setDrafts(chosen === null ? [] : chosen.fields.map(draftFromField));
  }

  async function submit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    if (candidate === null) {
      return;
    }
    const parsed = draftsToFields(drafts);
    if (!parsed.ok) {
      setNotice({ kind: "error", text: failureHint(parsed.code, parsed.code) });
      return;
    }
    await run(
      "memory.versionExtensionDefinition",
      { definitionId, changeNote: changeNote.trim(), fields: parsed.fields },
      copy.versionSaved(candidate.version + 1),
    );
  }

  if (candidates.length === 0) {
    return null;
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.versionHeading),
    createElement("p", null, copy.versionIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "version-definition" }, copy.versionDefinitionLabel),
      createElement("select", {
        id: "version-definition",
        value: definitionId,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => pickDefinition(event.target.value),
        required: true,
      },
        createElement("option", { value: "" }, copy.noneOption),
        ...candidates.map((entry) =>
          createElement("option", { key: entry.definitionId, value: entry.definitionId },
            `${entry.name} (${copy.versionLabel(entry.version)})`),
        ),
      ),
      createElement("label", { htmlFor: "version-note" }, copy.versionNoteLabel),
      createElement("input", {
        id: "version-note",
        type: "text",
        placeholder: copy.versionNotePlaceholder,
        value: changeNote,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setChangeNote(event.target.value),
        required: true,
      }),
      drafts.length === 0 ? null : createElement(FieldsEditor, { drafts, onChange: setDrafts }),
      createElement("button", {
        type: "submit",
        disabled: busy || definitionId === "" || changeNote.trim().length === 0,
      }, copy.versionSubmit),
      createElement(NoticeArea, { notice }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Boundary helpers (contract-decoded, one per result shape)
// ---------------------------------------------------------------------------

const defineResultSchema = memoryOperations["memory.defineExtension"].result;

/** Decodes the catalog search result at the boundary (contract authority). */
export function decodeSearchResult(value: unknown): readonly Candidate[] {
  const decoded = Schema.decodeUnknownSync(searchResultSchema)(value);
  return decoded.candidates.map((candidate) => ({
    ...candidate,
    // The one brand strip: contract ids are branded, the UI's fixtures and
    // builders speak plain strings (FieldShape's doc tells the story).
    fields: candidate.fields as unknown as readonly FieldShape[],
    similarity: { verdict: candidate.similarity.verdict },
  }));
}

const searchResultSchema = memoryOperations["memory.searchExtensionCatalog"].result;
