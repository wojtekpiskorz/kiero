/**
 * Extension value validation (C3): the validate-value operation for E6
 * tools, and the seam helpers the C2 publish/prepare/correction cores call
 * so every extension finding value validates against the exact stored
 * definition version.
 *
 * Two layers, both inside the caller's transaction:
 *
 * - the PURE domain rule (shape derivation, kind/unit/option membership,
 *   bounded sizes, required-versus-optional fields) against the version row
 *   the value names — never a newer or older one;
 * - the tenant layer: the version's definition must be visible to the
 *   company (own or shared), and every entity reference inside the value
 *   must resolve to a row OF THIS COMPANY.
 *
 * `checkExtensionFindingValue` consumes the ENCODED (wire) finding value —
 * the shape stored in planned-change rows and revisions; it returns null
 * for non-extension values (nothing to check) and the domain check outcome
 * otherwise. `recordExtensionValueUsage` moves the committed-usage counter
 * for an extension value, atomically with the revision that carries it.
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { notFoundError, validationError, type RequestContext } from "@kiero/runtime";
import { validateExtensionValueAgainstVersion, type ExtensionCheck } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { normalizedCompany, requireSource } from "../findings/references";
import { bumpExtensionUsage, firstVersionOf, requireDefinitionVersion, type Db } from "./references";
import { validateExtensionValueEntry, type ValidateExtensionValueInput } from "./semantics";

/** The encoded finding value shape the seam checks (structural view). */
interface EncodedFindingValueView {
  readonly _tag: string;
  readonly definitionVersionId?: string | undefined;
  readonly extensionValue?: unknown | undefined;
}

/** Structural walk of entity references inside one extension value. */
async function checkEntityReferences(
  db: Db,
  companyId: Id<"companies">,
  value: unknown,
): Promise<ExtensionCheck> {
  if (value === null || typeof value !== "object") {
    return { ok: true };
  }
  const view = value as {
    _tag?: unknown;
    reference?: { _tag?: unknown } & Record<string, unknown>;
    fields?: { value?: unknown }[];
    items?: unknown[];
  };
  if (view._tag === "entity_ref" && view.reference !== undefined) {
    const kind = String(view.reference._tag);
    const referenced =
      kind === "project"
        ? view.reference.projectId
        : kind === "task"
          ? view.reference.taskId
          : kind === "event"
            ? view.reference.eventId
            : kind === "contact"
              ? view.reference.contactId
              : kind === "source"
                ? view.reference.sourceId
                : undefined;
    if (referenced === undefined) {
      return { ok: false, code: "entity_reference_malformed" };
    }
    if (kind === "source") {
      const source = await requireSource(db, String(referenced), companyId);
      return source === null ? { ok: false, code: "entity_reference_not_in_company" } : { ok: true };
    }
    // projects/tasks/events/contacts all carry companyId: the tenant check
    // reads the row and compares it, without existence leaks.
    const table: "projects" | "tasks" | "events" | "contacts" =
      kind === "project"
        ? "projects"
        : kind === "task"
          ? "tasks"
          : kind === "event"
            ? "events"
            : "contacts";
    const normalized = db.normalizeId(table, String(referenced));
    const row = normalized === null ? null : await db.get(normalized);
    if (row === null || row.companyId !== companyId) {
      return { ok: false, code: "entity_reference_not_in_company" };
    }
    return { ok: true };
  }
  for (const entry of view.fields ?? []) {
    const nested = await checkEntityReferences(db, companyId, entry.value);
    if (!nested.ok) {
      return nested;
    }
  }
  for (const item of view.items ?? []) {
    const nested = await checkEntityReferences(db, companyId, item);
    if (!nested.ok) {
      return nested;
    }
  }
  return { ok: true };
}

/** Resolves and validates one extension value against its exact stored version. */
async function checkExtensionValue(
  db: Db,
  companyId: Id<"companies">,
  definitionVersionRef: string,
  extensionValue: unknown,
): Promise<ExtensionCheck> {
  const resolved = await requireDefinitionVersion(db, definitionVersionRef, companyId);
  if (resolved === null) {
    // Missing, malformed, another firm's or corrupt: no existence leak.
    return { ok: false, code: "extension_version_not_visible" };
  }
  const first = await firstVersionOf(db, resolved.definition._id);
  const check = validateExtensionValueAgainstVersion({
    fields: resolved.version.fields,
    firstFields: first?.fields ?? resolved.version.fields,
    value: extensionValue as never,
  });
  if (!check.ok) {
    return check;
  }
  return await checkEntityReferences(db, companyId, extensionValue);
}

/**
 * The C2 seam check: one ENCODED finding value. Returns null when the value
 * is not an extension value (nothing to check); otherwise the outcome of
 * validating it against its exact stored definition version, including the
 * entity-reference tenant checks.
 */
export async function checkExtensionFindingValue(
  db: Db,
  companyId: Id<"companies">,
  encodedValue: EncodedFindingValueView,
): Promise<ExtensionCheck | null> {
  if (encodedValue._tag !== "extension") {
    return null;
  }
  if (encodedValue.definitionVersionId === undefined || encodedValue.extensionValue === undefined) {
    return { ok: false, code: "extension_value_malformed" };
  }
  return await checkExtensionValue(
    db,
    companyId,
    encodedValue.definitionVersionId,
    encodedValue.extensionValue,
  );
}

/**
 * Moves the committed-usage counter for one ENCODED finding value, inside
 * the transaction that commits the revision carrying it. A no-op for
 * non-extension values.
 */
export async function recordExtensionValueUsage(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  encodedValue: EncodedFindingValueView,
  nowMs: number,
): Promise<void> {
  if (
    encodedValue._tag !== "extension" ||
    encodedValue.definitionVersionId === undefined
  ) {
    return;
  }
  const versionId = db.normalizeId("extensionVersions", encodedValue.definitionVersionId);
  if (versionId === null) {
    return;
  }
  const version = await db.get(versionId);
  if (version === null) {
    return;
  }
  await bumpExtensionUsage(db, companyId, version.definitionId, versionId, nowMs);
}

/** The validate-value operation (E6 tools and the agent tool surface). */
export async function performValidateExtensionValue(
  tx: MutationCtx,
  context: RequestContext,
  input: ValidateExtensionValueInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const resolved = await requireDefinitionVersion(tx.db, input.versionId, companyId);
  if (resolved === null) {
    return errorResult(notFoundError("extensionVersions"));
  }
  const first = await firstVersionOf(tx.db, resolved.definition._id);
  const check = validateExtensionValueAgainstVersion({
    fields: resolved.version.fields,
    firstFields: first?.fields ?? resolved.version.fields,
    value: input.value as never,
  });
  if (!check.ok) {
    return errorResult(validationError(check.code));
  }
  const entityCheck = await checkEntityReferences(tx.db, companyId, input.value);
  if (!entityCheck.ok) {
    return errorResult(validationError(entityCheck.code));
  }
  return okResult(
    Schema.decodeUnknownSync(validateExtensionValueEntry.result)({
      definitionId: resolved.definition._id,
      version: resolved.version.version,
    }),
  );
}
