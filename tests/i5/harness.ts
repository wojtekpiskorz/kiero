/**
 * I5 test harness: the shared D2 in-memory Convex emulation with one
 * extension - `withIndex` may be called WITHOUT a callback (the composed
 * backups-state read orders by a bare index). Everything else
 * (insert/patch/get/delete, eq/lte chains, filter, order, take) is the
 * shared harness, so the REAL transaction functions run against it.
 */

import { fakeCtx, type FakeCtx, type Row } from "../d2/harness";

export { fakeCtx };
export type { FakeCtx, Row };

/** The tables the backups functions touch. */
export const BACKUP_TABLES = [
  "recoveryManifests",
  "mediaRepresentations",
  "attachments",
  "deletionRecords",
  "diagnosticEvents",
  "auditRecords",
  "costEntries",
  "costAlertStates",
  "healthHeartbeats",
] as const;

/**
 * The fake ctx with callback-optional withIndex (the only deviation from
 * the shared harness; documented here so a harness upgrade cannot hide it).
 */
export function fakeBackupCtx(tableNames: readonly string[]): FakeCtx {
  const ctx = fakeCtx(tableNames);
  const originalQuery = ctx.db.query.bind(ctx.db);
  const query = (table: string) => {
    const inner = originalQuery(table);
    const flexible = inner as unknown as {
      withIndex(name: string, fn: (q: never) => never): typeof inner;
    };
    return {
      withIndex: (name: string, fn?: (q: never) => never) =>
        flexible.withIndex(name, fn ?? (() => inner as never)),
      order: (dir: "asc" | "desc") => inner.order(dir),
      filter: (fn: Parameters<typeof inner.filter>[0]) => inner.filter(fn),
      first: () => inner.first(),
      unique: () => inner.unique(),
      collect: () => inner.collect(),
      take: (limit: number) => inner.take(limit),
    };
  };
  (ctx.db as unknown as { query: typeof query }).query = query;
  return ctx;
}
