/**
 * Extension definition command handlers (C3): the four operations this lane
 * registers in the SAME checked dispatch the findings lane uses.
 *
 * The handlers receive the dispatch's DECODED input and forward it (the
 * C2/B3 handler pattern — see the double-decode caveat in
 * memory/findings/dispatch.ts); each single type assertion is backed by the
 * runtime's guarantee that the value was decoded through THIS entry's input
 * schema. The findings dispatch merges this registry into its own; nothing
 * here re-implements identity, policy or envelope decoding.
 */

import type { HandlerRegistry } from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import { performDefineExtension } from "./define";
import { performVersionExtensionDefinition } from "./version";
import { performSearchExtensionCatalog } from "./catalog";
import { performValidateExtensionValue } from "./validate";
import type {
  DefineExtensionInput,
  SearchExtensionCatalogInput,
  ValidateExtensionValueInput,
  VersionExtensionDefinitionInput,
} from "./semantics";

export function extensionHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "memory.defineExtension": {
      intent: "write",
      run: (tx, context, input) =>
        performDefineExtension(tx, context, input as DefineExtensionInput),
    },
    "memory.versionExtensionDefinition": {
      intent: "write",
      run: (tx, context, input) =>
        performVersionExtensionDefinition(tx, context, input as VersionExtensionDefinitionInput),
    },
    "memory.searchExtensionCatalog": {
      intent: "read",
      run: (tx, context, input) =>
        performSearchExtensionCatalog(tx, context, input as SearchExtensionCatalogInput),
    },
    "memory.validateExtensionValue": {
      intent: "read",
      run: (tx, context, input) =>
        performValidateExtensionValue(tx, context, input as ValidateExtensionValueInput),
    },
  };
}

/** Exported for tests: the operation names this lane owns. */
export const EXTENSION_OPERATION_NAMES = [
  "memory.defineExtension",
  "memory.versionExtensionDefinition",
  "memory.searchExtensionCatalog",
  "memory.validateExtensionValue",
] as const;
