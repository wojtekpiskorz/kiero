/**
 * I7 focused tests: the migration's existence probe has NO side effect
 * (review round 3). Even a versionless open CREATES a nonexistent
 * kiero-drafts database at version 1, which poisons the profile for D4's
 * own open (its onupgradeneeded never fires on the now-existing database).
 * The probe must answer "absent" while creating NOTHING; where
 * databases() is unavailable, the fallback probe deletes what it created.
 */

import { describe, expect, it } from "vitest";
import {
  DRAFTS_DB_NAME,
  migrateBrowserDraftStore,
  type MigrationIdbFactory,
  type MigrationIdbRequest,
} from "../../apps/web/src/pwa/update/draft-migration";

interface RecordedDb {
  name: string;
  version: number;
  stores: Set<string>;
}

/** A minimal factory that records every created database. */
function recordingFactory(options: { withDatabases: boolean }) {
  const databases = new Map<string, RecordedDb>();
  const opened: string[] = [];
  const deleted: string[] = [];
  const factory = {
    open(name: string, version?: number): MigrationIdbRequest {
      opened.push(`${name}@${version ?? 0}`);
      const request: MigrationIdbRequest = {
        onsuccess: null,
        onerror: null,
        get result(): unknown {
          const existing = databases.get(name);
          if (existing !== undefined) {
            return { objectStoreNames: { contains: (s: string) => existing.stores.has(s) } };
          }
          // A versionless or version-matching open CREATES the database
          // (IndexedDB semantics); the store only exists if an upgrade
          // created it, which this factory mirrors as "absent" (fresh).
          const created: RecordedDb = { name, version: version ?? 1, stores: new Set() };
          databases.set(name, created);
          return { objectStoreNames: { contains: () => false } };
        },
      };
      // IndexedDB fires success on the next microtask.
      queueMicrotask(() => request.onsuccess?.(null as never));
      return request;
    },
    deleteDatabase(name: string) {
      deleted.push(name);
      return { queue: () => undefined };
    },
  };
  if (options.withDatabases) {
    (factory as MigrationIdbFactory).databases = async () =>
      [...databases.keys()].map((name) => ({ name }));
  }
  return { factory: factory as MigrationIdbFactory, databases, opened, deleted };
}

describe("the migration's existence probe creates nothing (round 3)", () => {
  it("answers absent via databases() without opening the database", async () => {
    const { factory, opened } = recordingFactory({ withDatabases: true });
    const report = await migrateBrowserDraftStore(factory);
    expect(report.status).toBe("store-unavailable");
    expect(report.problems).toContain("drafts database not present");
    expect(opened).toEqual([]);
  });

  it("the legacy fallback deletes the database its probe created", async () => {
    const { factory, opened, deleted } = recordingFactory({ withDatabases: false });
    const report = await migrateBrowserDraftStore(factory);
    expect(report.status).toBe("store-unavailable");
    expect(report.problems).toContain("drafts database not present");
    // The versionless probe opened (and thus created) the database; the
    // fallback must delete exactly what it created.
    expect(opened).toEqual([`${DRAFTS_DB_NAME}@0`]);
    expect(deleted).toEqual([DRAFTS_DB_NAME]);
  });
});
