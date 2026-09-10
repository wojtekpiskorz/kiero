/**
 * The extensions lane's typed authority surface (C3): the contract entries
 * it implements and the input types their handlers consume, mirroring the
 * findings lane's semantics module.
 *
 * The dispatch decodes untrusted input through these entries exactly once
 * and hands handlers the DECODED value; the transaction cores re-encode
 * through the contracts codecs when staging rows (the wire form is what
 * Convex persists). Field shapes cross as plain structures: the domain rule
 * views accept the decoded and the encoded form alike.
 */

import type { Schema } from "effect";
import { memoryOperations } from "@kiero/contracts";

export const defineExtensionEntry = memoryOperations["memory.defineExtension"];
export const versionExtensionDefinitionEntry =
  memoryOperations["memory.versionExtensionDefinition"];
export const searchExtensionCatalogEntry = memoryOperations["memory.searchExtensionCatalog"];
export const validateExtensionValueEntry = memoryOperations["memory.validateExtensionValue"];

export type DefineExtensionInput = Schema.Schema.Type<typeof defineExtensionEntry.input>;
export type VersionExtensionDefinitionInput = Schema.Schema.Type<
  typeof versionExtensionDefinitionEntry.input
>;
export type SearchExtensionCatalogInput = Schema.Schema.Type<
  typeof searchExtensionCatalogEntry.input
>;
export type ValidateExtensionValueInput = Schema.Schema.Type<
  typeof validateExtensionValueEntry.input
>;

/**
 * A representative table id used only by the pre-insert decode templates
 * (the D1/C2 pattern): proves the result schemas still accept the exact
 * shapes this transaction constructs, BEFORE anything is written.
 */
export const TEMPLATE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";
