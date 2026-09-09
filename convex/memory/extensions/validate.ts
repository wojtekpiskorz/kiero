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
 *   (enumerated by the pure domain walk) must resolve to a row OF THIS
 *   COMPANY.
 *
 * `checkExtensionValue` is the ONE resolution sequence both callers share;
 * `checkExtensionFindingValue` adapts it to the encoded finding-value shape
 * the C2 seam checks, and `performValidateExtensionValue` surfaces it as the
 * validate-value operation. `recordExtensionValueUsage` moves the
 * committed-usage counter for an extension value, atomically with the
 * revision that carries it.
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import {
  collectEntityReferences,
  validateExtensionValueAgainstVersion,
  type ExtensionCheck,
} from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { normalizedCompany } from "../findings/references";
import { bumpExtensionUsage, firstVersionOf, requireDefinitionVersion, type Db, type DefinitionDoc, type VersionDoc } from "./references";
import { validateExtensionValueEntry, type ValidateExtensionValueInput } from "./semantics";

/** The target table of each entity-reference kind (all carry companyId). */
const REFERENCE_TABLES = {
  project: "projects",
  task: "tasks",
  event: "events",
  contact: "contacts",
  source: "sources",
} as const;

/** The tenant check over one walked entity reference. */
async function checkEntityReferences(
  db: Db,
  companyId: Id<"companies">,
  value: unknown,
): Promise<ExtensionCheck> {
  const walk = collectEntityReferences(value);
  if (!walk.ok) {
    return { ok: false, code: walk.code };
  }
  for (const reference of walk.references) {
    const table = REFERENCE_TABLES[reference.kind];
    const normalized = db.normalizeId(table, reference.id);
    const row = normalized === null ? null : await db.get(normalized);
    if (row === null || row.companyId !== companyId) {
      return { ok: false, code: "entity_reference_not_in_company" };
    }
  }
  return { ok: true };
}

/** The resolved outcome of validating one extension value against its version. */
export type ExtensionValueResolution =
  | { readonly ok: true; readonly definition: DefinitionDoc; readonly version: VersionDoc }
  | { readonly ok: false; readonly code: string };

/**
 * The ONE resolution sequence: exact-version visibility, the pure
 * value-versus-version rule, and the entity-reference tenant checks.
 */
async function checkExtensionValue(
  db: Db,
  companyId: Id<"companies">,
  definitionVersionRef: string,
  extensionValue: unknown,
): Promise<ExtensionValueResolution> {
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
  const entityCheck = await checkEntityReferences(db, companyId, extensionValue);
  if (!entityCheck.ok) {
    return entityCheck;
  }
  return { ok: true, definition: resolved.definition, version: resolved.version };
}

/** The encoded finding value shape the seam checks (structural view). */
interface EncodedFindingValueView {
  readonly _tag: string;
  readonly definitionVersionId?: string | undefined;
  readonly extensionValue?: unknown | undefined;
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
  const resolution = await checkExtensionValue(
    db,
    companyId,
    encodedValue.definitionVersionId,
    encodedValue.extensionValue,
  );
  return resolution.ok ? { ok: true } : { ok: false, code: resolution.code };
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
  const resolution = await checkExtensionValue(tx.db, companyId, input.versionId, input.value);
  if (!resolution.ok) {
    // An invisible version (missing, malformed or another firm's) is the
    // honest not-found; every other refusal is a validation outcome.
    return resolution.code === "extension_version_not_visible"
      ? errorResult(notFoundError("extensionVersions"))
      : errorResult(validationError(resolution.code));
  }
  return okResult(
    Schema.decodeUnknownSync(validateExtensionValueEntry.result)({
      definitionId: resolution.definition._id,
      version: resolution.version.version,
    }),
  );
}
