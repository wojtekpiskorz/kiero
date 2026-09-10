/**
 * Convex schema composition entry (A2 candidate, amended by A3).
 *
 * This file composes the modular domain fragments and nothing else: table
 * definitions and indexes live in each domain's schema fragment, shared
 * cross-domain value definitions live in `convex/schema/shared.ts`. Later
 * domain lanes edit their own fragment; this entry only gains an import
 * spread when a new fragment is added (a coordinated change).
 *
 * Composition checks at construction time that no two fragments claim the
 * same table name and that the composed tables and the closed
 * `TABLE_ID_NAMES` inventory in `@kiero/contracts` are equal in BOTH
 * directions. Drift of either side fails loudly here, long before
 * deployment.
 *
 * A3 certification amendment: `defineSchema` now receives the literal
 * spread (not the checked `Record`) so per-table INDEX types survive into
 * the generated data model: `withIndex("by_dedup", ...)` and friends
 * typecheck against real index names instead of only system indexes. The
 * runtime uniqueness/inventory checks are unchanged and still run first.
 */

import { defineSchema, type TableDefinition } from "convex/server";
import { TABLE_ID_NAMES } from "@kiero/contracts";

import { identityTables } from "./access/identity/schema";
import { membershipTables } from "./access/membership/schema";
import { gmTables } from "./access/gm/schema";
import { linkingTables } from "./access/linking/schema";
import { projectsTables } from "./projects/schema";
import { findingsTables } from "./memory/findings/schema";
import { extensionsTables } from "./memory/extensions/schema";
import { workTables } from "./work/schema";
import { acceptTables } from "./sources/accept/schema";
import { uploadsTables } from "./sources/uploads/schema";
// D6 amendment (flagged coordinated change): the audio STT fragment.
import { audioTables } from "./processing/audio/schema";
// E4 amendment (flagged coordinated change): the multimodal-join fragment.
import { multimodalTables } from "./processing/multimodal/schema";
import { platformTables } from "./platform/schema";
import { searchTables } from "./search/schema";
import { readStateTables } from "./attention/read-state/schema";
import { preferencesTables } from "./attention/preferences/schema";
import { deliveryTables } from "./attention/delivery/schema";
import { calendarConnectionTables } from "./calendar/connection/schema";
import { calendarProjectionTables } from "./calendar/projection/schema";
import { exportsTables } from "./operations/exports/schema";
import { deletionTables } from "./operations/deletion/schema";
import { backupsTables } from "./operations/backups/schema";
import { telemetryTables } from "./operations/telemetry/schema";

const fragments: ReadonlyArray<Record<string, TableDefinition>> = [
  identityTables,
  membershipTables,
  gmTables,
  linkingTables,
  projectsTables,
  findingsTables,
  extensionsTables,
  workTables,
  acceptTables,
  uploadsTables,
  audioTables,
  multimodalTables,
  platformTables,
  searchTables,
  readStateTables,
  preferencesTables,
  deliveryTables,
  calendarConnectionTables,
  calendarProjectionTables,
  exportsTables,
  deletionTables,
  backupsTables,
  telemetryTables,
];

const composed: Record<string, TableDefinition> = {};
for (const fragment of fragments) {
  for (const table of Object.keys(fragment)) {
    if (table in composed) {
      throw new Error(`Schema composition: duplicate table ${table}`);
    }
    const definition = fragment[table];
    if (definition === undefined) {
      throw new Error(`Schema composition: empty definition for ${table}`);
    }
    composed[table] = definition;
  }
}

const contractInventory: ReadonlySet<string> = new Set<string>(TABLE_ID_NAMES);
for (const table of Object.keys(composed)) {
  if (!contractInventory.has(table)) {
    throw new Error(
      `Schema composition: table ${table} is absent from the @kiero/contracts table inventory`,
    );
  }
}
for (const table of TABLE_ID_NAMES) {
  if (!(table in composed)) {
    throw new Error(
      `Schema composition: inventory table ${table} has no owning fragment`,
    );
  }
}

// The literal spread preserves each fragment's per-table index types; the
// loop above guarantees the spread introduces no unexpected key.
export default defineSchema({
  ...identityTables,
  ...membershipTables,
  ...gmTables,
  ...linkingTables,
  ...projectsTables,
  ...findingsTables,
  ...extensionsTables,
  ...workTables,
  ...acceptTables,
  ...uploadsTables,
  ...audioTables,
  ...multimodalTables,
  ...platformTables,
  ...searchTables,
  ...readStateTables,
  ...preferencesTables,
  ...deliveryTables,
  ...calendarConnectionTables,
  ...calendarProjectionTables,
  ...exportsTables,
  ...deletionTables,
  ...backupsTables,
  ...telemetryTables,
});
