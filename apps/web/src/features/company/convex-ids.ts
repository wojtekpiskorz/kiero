/**
 * The two brandings of one id value (H1 review round 1): the contract's
 * `TableId<T>` brand (what decoded rows and parseTableId carry) and
 * Convex's generated `Id<T>` brand (what the generated query and mutation
 * args require). Both brand the SAME wire string; converting between them
 * never transforms the value.
 *
 * The conversion is legitimate (the value's provenance is a decoded row of
 * that very table, or a contract-branded id), and this helper is its one
 * home: a single documented cast instead of a scatter of inline
 * `as unknown as import(...)` expressions dragging the generated module
 * type into every call site.
 */

import type { TableId, TableIdName } from "@kiero/contracts";
import type { Id, TableNames } from "../../../../../convex/_generated/dataModel";

/**
 * Converts one table id from the contract's brand to the generated Convex
 * brand. The table name exists only to type the conversion (it must be a
 * table of both inventories); the value passes through unchanged.
 */
export function asConvexId<T extends TableIdName & TableNames>(
  table: T,
  value: TableId<T> | string,
): Id<T> {
  void table; // inference and readability only; the value is never touched
  // The single documented cast: the two brands are nominal over one string.
  return value as unknown as Id<T>;
}
