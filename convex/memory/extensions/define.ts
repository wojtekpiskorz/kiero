/**
 * defineExtension (C3): create a FIRM-scoped definition with its immutable
 * version 1 — or idempotently reuse the equivalent one that already exists.
 *
 * Runs inside ONE Convex mutation through the checked dispatch. The reuse
 * decision runs BEFORE any insert (issue #26: "Reuse and similarity checks
 * precede creating near-duplicates"):
 *
 * - same normalized name + compatible structure (own firm definition or a
 *   shared one) → REUSE: the existing definition and its current version are
 *   returned with `created: false`. Two racing identical proposals therefore
 *   converge on one reusable result (the stableKey scan is the OCC overlap;
 *   the loser's retry sees the winner's row).
 * - same normalized name + INCOMPATIBLE structure → `conflict`: the catalog
 *   never silently reuses a different meaning ("Grubość płytki" in
 *   millimetres is not "Grubość płytki" in centimetres); the caller renames
 *   or migrates explicitly.
 * - anything else → create: definition row + append-only version 1, with the
 *   shape checked as bounded data by the pure domain rule first.
 *
 * Shared definitions cannot be created here at all: the input has no shared
 * flag and companyId is always the actor's firm — "only product code can
 * publish shared definitions" is enforced by the absence of a path.
 */

import { Schema } from "effect";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  conflictError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import { stableKeyOf, structureCompatible, validateDefinitionShape } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import { normalizedCompany } from "../findings/references";
import {
  currentVersionOf,
  findDefinitionByStableKey,
  type Db,
  type DefinitionDoc,
} from "./references";
import { defineExtensionEntry, TEMPLATE_ID, type DefineExtensionInput } from "./semantics";

/**
 * The reuse-or-refuse decision for one existing same-key definition: fetch
 * its current version (a definition without one is corrupt and refused
 * loudly), decide compatibility, and answer with the reuse receipt or the
 * typed conflict. Always answers — never falls through to creation.
 */
async function reuseOutcome(
  db: Db,
  existing: DefinitionDoc,
  input: DefineExtensionInput,
): Promise<ResultEnvelope> {
  const current = await currentVersionOf(db, existing);
  if (current === null || existing.currentVersionId === undefined) {
    return errorResult(conflictError("extension_definition_corrupt"));
  }
  if (!structureCompatible(input.fields, current.fields)) {
    return errorResult(
      conflictError("extension_definition_name_conflict", "extensionDefinitions", existing._id),
    );
  }
  return okResult(
    Schema.decodeUnknownSync(defineExtensionEntry.result)({
      definitionId: existing._id,
      versionId: existing.currentVersionId,
      created: false,
    }),
  );
}

export async function performDefineExtension(
  tx: MutationCtx,
  context: RequestContext,
  input: DefineExtensionInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const shape = validateDefinitionShape(input.fields);
  if (!shape.ok) {
    return errorResult(validationError(shape.code));
  }

  const stableKey = stableKeyOf(input.name);
  const existing = await findDefinitionByStableKey(tx.db, companyId, stableKey);
  if (existing.own !== null) {
    return await reuseOutcome(tx.db, existing.own, input);
  }
  if (existing.shared !== null) {
    return await reuseOutcome(tx.db, existing.shared, input);
  }

  // Pre-insert decode template: the receipt this transaction constructs.
  Schema.decodeUnknownSync(defineExtensionEntry.result)({
    definitionId: TEMPLATE_ID,
    versionId: TEMPLATE_ID,
    created: true,
  });

  const nowMs = Date.now();
  const definitionId = await tx.db.insert("extensionDefinitions", {
    companyId,
    stableKey,
    createdAtMs: nowMs,
  });
  const versionId = await tx.db.insert("extensionVersions", {
    definitionId,
    version: 1,
    name: input.name,
    fields: input.fields,
    changeNote: "initial version",
    createdAtMs: nowMs,
  });
  await tx.db.patch(definitionId, { currentVersionId: versionId });
  return okResult(
    Schema.decodeUnknownSync(defineExtensionEntry.result)({
      definitionId,
      versionId,
      created: true,
    }),
  );
}
