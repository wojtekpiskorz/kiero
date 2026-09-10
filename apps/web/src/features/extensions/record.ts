/**
 * The extension value recording and correction sections (H2).
 *
 * Recording one value is deliberately the full evidence-backed path, not a
 * free write: the boss's statement first becomes a REAL accepted source
 * (the conversation's own prepare/accept commands), then ONE staged change
 * set carries the typed value with that source as its evidence witness,
 * and the publish commits atomically. Corrections ride C2's audited
 * command with the revision the boss actually saw.
 *
 * JSX-free (createElement only), node-importable like the rest.
 */

import { createElement, useState, type ChangeEvent, type ReactNode } from "react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { Schema } from "effect";
import { FindingValue, memoryOperations, sourcesOperations } from "@kiero/contracts";
import { api } from "../../../../../convex/_generated/api";
import type { CurrentFindingWireRow } from "../../../../../convex/memory/findings/read";
import type { FindingHistoryWireRow } from "../../../../../convex/memory/findings/exposition";
import { SessionEnded, envelopeOf } from "../company/CompanyGate";
import { asConvexId } from "../company/convex-ids";
import { signInCopy } from "../sign-in/state";
import { failureHint, extensionsCopy as copy } from "./state";
import { useMemoryDispatch, NoticeArea } from "./hooks";
import type { FieldShape } from "./value-editor";
import {
  FieldValueControls,
  buildExtensionValue,
  emptySlots,
  type FieldInputSlots,
} from "./value-editor";

/** One catalog candidate as the search returns it (wire fields). */
export interface Candidate {
  readonly definitionId: string;
  readonly versionId: string;
  readonly version: number;
  readonly name: string;
  readonly fields: readonly FieldShape[];
  readonly shared: boolean;
  readonly usageCount: number;
  readonly lastUsedAtMs: number | null;
  readonly similarity: { readonly verdict: string };
}

/** The scope args shape both sections receive (already contract-branded). */
export interface FindingsScopeArgs {
  readonly scope: { readonly _tag: "company" } | { readonly _tag: "project"; readonly projectId: string };
}

/** The typed result shapes of the two source commands (contract authority). */
const prepareUploadResult = sourcesOperations["sources.prepareUpload"].result;
const acceptSourceResult = sourcesOperations["sources.acceptSource"].result;
const prepareChangeSetResult = memoryOperations["memory.prepareChangeSet"].result;

/**
 * A fresh idempotency key per logical statement. The shape is the certified
 * `idem_` + v4-uuid pattern the command envelope requires; the UUID always
 * comes from getRandomValues (the baseline CSPRNG API), never from a
 * weaker source.
 */
function uuidV4(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Renders the per-field value controls of one candidate's version. */
function CandidateValueFields({
  candidate,
  temporal,
  inputs,
  onInputs,
}: {
  readonly candidate: Candidate;
  readonly temporal: { readonly companyZone: string; readonly zoneOffset: string };
  readonly inputs: Record<string, FieldInputSlots>;
  readonly onInputs: (inputs: Record<string, FieldInputSlots>) => void;
}): ReactNode {
  return createElement(
    "fieldset", null,
    createElement("legend", null, copy.valueDefinitionLabel),
    ...candidate.fields.map((field) =>
      createElement(FieldValueControls, {
        key: field.fieldId,
        field,
        slots: inputs[field.fieldId] ?? emptySlots(),
        temporal,
        onSlot: (patch) =>
          onInputs({
            ...inputs,
            [field.fieldId]: { ...(inputs[field.fieldId] ?? emptySlots()), ...patch },
          }),
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Record a value: statement -> source -> staged change set -> publish
// ---------------------------------------------------------------------------

export function ValueSection({
  candidates,
  temporal,
  findingsArgs,
}: {
  readonly candidates: readonly Candidate[];
  readonly temporal: { readonly companyZone: string; readonly zoneOffset: string };
  readonly findingsArgs: FindingsScopeArgs;
}): ReactNode {
  const memory = useMemoryDispatch();
  const prepareUpload = useMutation(api.sources.uploads.commands.prepareUploadCommand);
  const acceptSource = useMutation(api.sources.accept.commands.acceptSourceCommand);
  const [statement, setStatement] = useState("");
  const [semanticKey, setSemanticKey] = useState("");
  const [versionId, setVersionId] = useState("");
  const [inputs, setInputs] = useState<Record<string, FieldInputSlots>>({});

  const candidate = candidates.find((entry) => entry.versionId === versionId) ?? null;

  async function validate(): Promise<void> {
    if (candidate === null) {
      return;
    }
    const built = buildExtensionValue(candidate.fields, candidate.fields, inputs, temporal);
    if (!built.ok) {
      memory.setNotice({ kind: "error", text: failureHint(built.code, built.code) });
      return;
    }
    await memory.run("memory.validateExtensionValue", { versionId, value: built.value }, copy.valueValidated);
  }

  async function submit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    if (candidate === null) {
      return;
    }
    const built = buildExtensionValue(candidate.fields, candidate.fields, inputs, temporal);
    if (!built.ok) {
      memory.setNotice({ kind: "error", text: failureHint(built.code, built.code) });
      return;
    }
    memory.setBusy(true);
    try {
      // The boss's statement becomes a REAL source first (the evidence
      // basis), exactly like the conversation's send loop.
      const prepared = await prepareUpload({
        envelope: envelopeOf("sources.prepareUpload", {
          draftId: `idem_${uuidV4()}`,
          parts: 1,
          mediaKinds: [],
        }),
      });
      if (prepared._tag === "error") {
        memory.setNotice({ kind: "error", text: failureHint(prepared.error.code, prepared.error.message) });
        return;
      }
      const upload = Schema.decodeUnknownSync(prepareUploadResult)(prepared.value);
      const accepted = await acceptSource({
        envelope: {
          operation: "sources.acceptSource",
          input: {
            uploadId: upload.uploadId,
            authorText: statement.trim(),
            timezoneSnapshot: temporal.companyZone,
            projectHints: [],
          },
          expectedRevisions: [],
          idempotencyKey: `idem_${uuidV4()}`,
        },
      });
      if (accepted._tag === "error") {
        memory.setNotice({ kind: "error", text: failureHint(accepted.error.code, accepted.error.message) });
        return;
      }
      const receipt = Schema.decodeUnknownSync(acceptSourceResult)(accepted.value);
      const staged = await memory.run(
        "memory.prepareChangeSet",
        {
          sourceId: receipt.sourceId,
          plannedRevisions: [
            {
              findingId: null,
              scope: findingsArgs.scope,
              semanticKey: semanticKey.trim(),
              value: { _tag: "extension", definitionVersionId: versionId, extensionValue: built.value },
              knowledgeState: { _tag: "known" },
              effectiveFrom: null,
              evidence: [{ sourceId: receipt.sourceId, fragmentId: null, supportKind: "support" }],
              derivesFrom: [],
            },
          ],
        },
        copy.valueSaved,
      );
      if (staged === null) {
        return;
      }
      const changeSet = Schema.decodeUnknownSync(prepareChangeSetResult)(staged);
      await memory.run(
        "memory.publishChangeSet",
        { changeSetId: changeSet.changeSetId, expectedRevisions: [] },
        copy.valueSaved,
      );
      setStatement("");
      setSemanticKey("");
      setInputs({});
    } catch {
      memory.setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      memory.setBusy(false);
    }
  }

  if (candidates.length === 0) {
    return null;
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.valueHeading),
    createElement("p", null, copy.valueIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "value-statement" }, copy.valueStatementLabel),
      createElement("textarea", {
        id: "value-statement",
        rows: 2,
        placeholder: copy.valueStatementPlaceholder,
        value: statement,
        onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setStatement(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "value-key" }, copy.valueKeyLabel),
      createElement("input", {
        id: "value-key",
        type: "text",
        value: semanticKey,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setSemanticKey(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "value-version" }, copy.valueDefinitionLabel),
      createElement("select", {
        id: "value-version",
        value: versionId,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => setVersionId(event.target.value),
        required: true,
      },
        createElement("option", { value: "" }, copy.noneOption),
        ...candidates.map((entry) =>
          createElement("option", { key: entry.versionId, value: entry.versionId },
            `${entry.name} (${copy.versionLabel(entry.version)})`),
        ),
      ),
      candidate === null
        ? null
        : createElement(CandidateValueFields, { candidate, temporal, inputs, onInputs: setInputs }),
      createElement("button", {
        type: "button",
        disabled: memory.busy || candidate === null,
        onClick: () => void validate(),
      }, copy.valueValidate),
      createElement("button", {
        type: "submit",
        disabled:
          memory.busy ||
          candidate === null ||
          statement.trim().length === 0 ||
          semanticKey.trim().length === 0,
      }, copy.valueSubmit),
      createElement(NoticeArea, { notice: memory.notice }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Correct an existing extension finding
// ---------------------------------------------------------------------------

/** Whether one findings row's current value is an extension value. */
function isExtensionRow(row: CurrentFindingWireRow): boolean {
  try {
    return Schema.decodeUnknownSync(FindingValue)(row.value)._tag === "extension";
  } catch {
    return false;
  }
}

export function CorrectSection({
  candidates,
  temporal,
  findingsArgs,
}: {
  readonly candidates: readonly Candidate[];
  readonly temporal: { readonly companyZone: string; readonly zoneOffset: string };
  readonly findingsArgs: FindingsScopeArgs;
}): ReactNode {
  const memory = useMemoryDispatch();
  const findings = useQueryState({
    query: api.memory.findings.functions.readCurrentFindings,
    args: findingsArgs,
  });
  const [findingId, setFindingId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [reason, setReason] = useState("");
  const [inputs, setInputs] = useState<Record<string, FieldInputSlots>>({});

  // The revision counter comes from the history read (the current-findings
  // row deliberately does not carry counters); "skip" until a finding is
  // chosen keeps the query well-formed without a placeholder id.
  const history = useQueryState({
    query: api.memory.findings.functions.readFindingHistory,
    args:
      findingId === ""
        ? "skip"
        : { findingId: asConvexId("findings", findingId) },
  });

  if (findings.status === "error" || history.status === "error") {
    return createElement(SessionEnded);
  }
  if (findings.status !== "success") {
    return createElement("p", { role: "status" }, "Sprawdzamy Twoją sesję…");
  }

  const extensionRows = findings.data.filter(isExtensionRow);
  const selected = extensionRows.find((row) => row.findingId === findingId) ?? null;
  const candidate = candidates.find((entry) => entry.versionId === versionId) ?? null;

  async function submit(event: { preventDefault(): void }): Promise<void> {
    event.preventDefault();
    if (selected === null || candidate === null || history.status !== "success") {
      return;
    }
    const row = history.data as FindingHistoryWireRow;
    const built = buildExtensionValue(candidate.fields, candidate.fields, inputs, temporal);
    if (!built.ok) {
      memory.setNotice({ kind: "error", text: failureHint(built.code, built.code) });
      return;
    }
    await memory.run(
      "memory.correctFinding",
      {
        findingId: selected.findingId,
        expectedRevision: row.revisionCounter,
        value: {
          _tag: "extension",
          definitionVersionId: candidate.versionId,
          extensionValue: built.value,
        },
        knowledgeState: { _tag: "known" },
        reason: reason.trim(),
      },
      copy.corrected,
    );
  }

  if (extensionRows.length === 0 || candidates.length === 0) {
    return createElement("section", null,
      createElement("h2", null, copy.correctHeading),
      createElement("p", null, copy.noExtensionFindings));
  }
  return createElement(
    "section",
    null,
    createElement("h2", null, copy.correctHeading),
    createElement("p", null, copy.correctIntro),
    createElement("form", { onSubmit: (event) => void submit(event) },
      createElement("label", { htmlFor: "correct-finding" }, copy.correctFindingLabel),
      createElement("select", {
        id: "correct-finding",
        value: findingId,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          setFindingId(event.target.value);
          setInputs({});
        },
        required: true,
      },
        createElement("option", { value: "" }, copy.noneOption),
        ...extensionRows.map((row) =>
          createElement("option", { key: row.findingId, value: row.findingId }, row.semanticKey)),
      ),
      createElement("label", { htmlFor: "correct-version" }, copy.valueDefinitionLabel),
      createElement("select", {
        id: "correct-version",
        value: versionId,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => setVersionId(event.target.value),
        required: true,
      },
        createElement("option", { value: "" }, copy.noneOption),
        ...candidates.map((entry) =>
          createElement("option", { key: entry.versionId, value: entry.versionId },
            `${entry.name} (${copy.versionLabel(entry.version)})`),
        ),
      ),
      candidate === null
        ? null
        : createElement(CandidateValueFields, { candidate, temporal, inputs, onInputs: setInputs }),
      createElement("label", { htmlFor: "correct-reason" }, copy.correctReasonLabel),
      createElement("input", {
        id: "correct-reason",
        type: "text",
        placeholder: copy.correctReasonPlaceholder,
        value: reason,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setReason(event.target.value),
        required: true,
      }),
      createElement("button", {
        type: "submit",
        disabled:
          memory.busy ||
          findingId === "" ||
          versionId === "" ||
          reason.trim().length === 0 ||
          history.status !== "success",
      }, copy.correctSubmit),
      createElement(NoticeArea, { notice: memory.notice }),
    ),
  );
}
