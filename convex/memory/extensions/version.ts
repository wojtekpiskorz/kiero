/**
 * versionExtensionDefinition (C3): append the NEXT immutable version of a
 * definition.
 *
 * Runs inside ONE Convex mutation. The compatibility rule is the pure
 * domain decision re-run here against the stored current version:
 * additions and label changes succeed (field IDs are stable through label
 * changes); removals, kind/unit/itemKind changes and enum-option removals
 * refuse `conflict` — those reinterpret historic values and require a NEW
 * DEFINITION or an explicit migration ("Version millimetres to an
 * incompatible centimetre meaning and require a new definition or explicit
 * migration", issue #26 focused verification).
 *
 * Shared definitions are read-only here: publishing a shared version is
 * product code's move, and no firm actor may change every tenant's catalog.
 *
 * Existing version rows are never touched — the insert plus the single
 * `currentVersionId` patch IS the new version; historic values keep the
 * version row they were written against. Two racing version proposals
 * serialize on the definition row patch: the loser's OCC retry re-reads the
 * bumped current version and appends after it.
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import { decideVersionSuccession, validateDefinitionShape } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import { normalizedCompany } from "../findings/references";
import { currentVersionOf, requireDefinition } from "./references";
import {
  versionExtensionDefinitionEntry,
  TEMPLATE_ID,
  type VersionExtensionDefinitionInput,
} from "./semantics";

export async function performVersionExtensionDefinition(
  tx: MutationCtx,
  context: RequestContext,
  input: VersionExtensionDefinitionInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const definition = await requireDefinition(tx.db, input.definitionId, companyId);
  if (definition === null) {
    return errorResult(notFoundError("extensionDefinitions"));
  }
  if (definition.companyId === undefined) {
    // Only product code publishes shared definitions (and their versions).
    return errorResult(
      forbiddenError("shared_definition_readonly", "extensionDefinitions"),
    );
  }
  const shape = validateDefinitionShape(input.fields);
  if (!shape.ok) {
    return errorResult(validationError(shape.code));
  }
  const current = await currentVersionOf(tx.db, definition);
  if (current === null) {
    return errorResult(conflictError("extension_definition_corrupt"));
  }
  const succession = decideVersionSuccession(current.fields, input.fields);
  if (!succession.ok) {
    // The incompatible-change refusal: the caller creates a new definition
    // (or migrates explicitly); this definition's meaning stays stable.
    return errorResult(conflictError(succession.code));
  }
  // The definition NAME is identity (its normalized form is the stable key):
  // versions carry it forward unchanged. Field labels are what versions may
  // re-word — the field IDs stay stable through those changes.
  const unchanged = JSON.stringify(current.fields) === JSON.stringify(input.fields);
  if (unchanged) {
    return errorResult(validationError("version_without_change"));
  }

  // Pre-insert decode template: the receipt this transaction constructs.
  Schema.decodeUnknownSync(versionExtensionDefinitionEntry.result)({
    versionId: TEMPLATE_ID,
    version: 1,
  });

  const nowMs = Date.now();
  const versionNumber = current.version + 1;
  const versionId = await tx.db.insert("extensionVersions", {
    definitionId: definition._id,
    version: versionNumber,
    name: current.name,
    fields: input.fields,
    changeNote: input.changeNote,
    createdAtMs: nowMs,
  });
  await tx.db.patch(definition._id, { currentVersionId: versionId });
  return okResult(
    Schema.decodeUnknownSync(versionExtensionDefinitionEntry.result)({
      versionId,
      version: versionNumber,
    }),
  );
}
