/**
 * The client-side draft schema migration (I7): the "persist/migrate the
 * local draft FIRST" half of the PWA update order.
 *
 * The draft store belongs to D4 (apps/web/src/storage/drafts/store.ts);
 * this module never edits it. It operates on the SAME database through
 * the browser's IndexedDB with its own structural types: enumerate every
 * `<userId>#draft` record, run the versioned migration steps, and write
 * the migrated records back BEFORE the new version activates. Recording
 * chunks and photo blobs live under their own keys and are not touched
 * (their shape is untouched by record migration).
 *
 * Step registry semantics (a miniature expand-migrate-contract for the
 * client): each step moves a record from `fromVersion` to `toVersion`
 * idempotently; a record at CURRENT_DRAFT_RECORD_VERSION passes through
 * untouched; an unreadable record is LEFT INTACT and reported (a
 * migration never destroys the thing it cannot understand).
 */

/** Mirrors D4's private DB/store names; tests/i7 drift-guard both. */
// The mirrored D4 constants (round 2): the migration opens the SAME
// database D4's composer owns, so the name, store and version drift-guard
// against apps/web/src/storage/drafts/store.ts (its DB_NAME/STORE/DB_VERSION).
export const DRAFTS_DB_NAME = "kiero-drafts";
export const DRAFTS_STORE_NAME = "entries";
export const DRAFTS_DB_VERSION = 1;
/** Every draft metadata record key ends with this suffix (D4's convention). */
export const DRAFT_KEY_SUFFIX = "#draft";

/** The record schema version this client writes and migrates to. */
export const CURRENT_DRAFT_RECORD_VERSION = 1;

// ---------------------------------------------------------------------------
// The structural IndexedDB surface this migration needs (the real browser
// indexedDB satisfies every member; node tests inject a fake).
// ---------------------------------------------------------------------------

export interface MigrationIdbRequest {
  readonly result: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface MigrationIdbObjectStore {
  getAllKeys(): MigrationIdbRequest;
  get(key: unknown): MigrationIdbRequest;
  put(value: unknown, key: unknown): MigrationIdbRequest;
}

export interface MigrationIdbTransaction {
  objectStore(name: string): MigrationIdbObjectStore;
  oncomplete: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface MigrationIdbDatabase {
  transaction(
    stores: string[],
    mode: "readonly" | "readwrite",
  ): MigrationIdbTransaction;
  /** The probe surface (round 2): presence, version and teardown. */
  readonly objectStoreNames?: { contains(name: string): boolean };
  readonly version?: number;
  close?(): void;
}

export interface MigrationIdbFactory {
  open(name: string, version?: number): MigrationIdbRequest;
  /** The side-effect-free existence check (round 3): absent on old engines. */
  databases?(): Promise<{ name?: string }[]>;
  deleteDatabase?(name: string): { queue?(): void };
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/** One versioned record migration (pure, idempotent). */
export interface DraftMigrationStep {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly migrate: (
    record: Record<string, unknown>,
  ) => Record<string, unknown> | null;
}

/** The field this module stamps; readers: the step registry itself. */
export const DRAFT_RECORD_VERSION_FIELD = "draftSchemaVersion";

/**
 * v0 -> v1: a record written before this module existed may lack any of
 * the optional-with-default fields D4's surface null-checks. Missing
 * fields become their honest defaults; every other field (known or not)
 * is preserved verbatim; unknown fields survive forward-compatibly.
 */
export function normalizeLegacyDraftRecord(
  record: Record<string, unknown>,
): Record<string, unknown> | null {
  if (
    typeof record.userId !== "string" ||
    typeof record.draftId !== "string" ||
    typeof record.phase !== "string"
  ) {
    return null;
  }
  const normalized: Record<string, unknown> = { ...record };
  if (typeof normalized.storageDegraded !== "boolean") {
    normalized.storageDegraded = false;
  }
  if (normalized.lastError === undefined) {
    normalized.lastError = null;
  }
  if (normalized.sentSourceId === undefined) {
    normalized.sentSourceId = null;
  }
  if (normalized.intendedSentAtIso === undefined) {
    normalized.intendedSentAtIso = null;
  }
  if (normalized.scopeProjectId === undefined) {
    normalized.scopeProjectId = null;
  }
  if (normalized.text === undefined) {
    normalized.text = "";
  }
  if (normalized.recording === undefined) {
    normalized.recording = null;
  }
  if (!Array.isArray(normalized.photos)) {
    normalized.photos = [];
  }
  normalized[DRAFT_RECORD_VERSION_FIELD] = 1;
  return normalized;
}

/** The shipped step registry (a future v2 appends one step, never edits). */
export const draftMigrationSteps: readonly DraftMigrationStep[] = [
  { fromVersion: 0, toVersion: 1, migrate: normalizeLegacyDraftRecord },
];

/** What one migration pass concluded. */
export interface DraftMigrationReport {
  readonly status: "migrated" | "already-current" | "store-unavailable";
  readonly draftRecords: number;
  readonly migrated: number;
  readonly alreadyCurrent: number;
  readonly leftIntact: number;
  readonly problems: readonly string[];
}

/** Runs the pending steps over one record (idempotent, pure). */
export function migrateDraftRecordValue(
  raw: unknown,
):
  | { ok: true; record: unknown; changed: boolean }
  | { ok: false; problem: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: "record is not an object" };
  }
  const record = raw as Record<string, unknown>;
  const version = record[DRAFT_RECORD_VERSION_FIELD];
  if (version === CURRENT_DRAFT_RECORD_VERSION) {
    return { ok: true, record, changed: false };
  }
  if (version !== undefined && typeof version !== "number") {
    return {
      ok: false,
      problem: `${DRAFT_RECORD_VERSION_FIELD} is not a number`,
    };
  }
  let current = record;
  let fromVersion = typeof version === "number" ? version : 0;
  let changed = false;
  while (fromVersion < CURRENT_DRAFT_RECORD_VERSION) {
    const step = draftMigrationSteps.find(
      (candidate) => candidate.fromVersion === fromVersion,
    );
    if (step === undefined) {
      return {
        ok: false,
        problem: `no migration step from version ${fromVersion}`,
      };
    }
    const migrated = step.migrate(current);
    if (migrated === null) {
      return {
        ok: false,
        problem: `step ${step.fromVersion}->${step.toVersion} rejected the record`,
      };
    }
    current = migrated;
    fromVersion = step.toVersion;
    changed = true;
  }
  return { ok: true, record: current, changed };
}

/** True when every IndexedDB member the migration needs exists. */
function realIndexedDb(): MigrationIdbFactory | undefined {
  return (globalThis as { indexedDB?: MigrationIdbFactory }).indexedDB;
}

/**
 * Migrates every draft record in the browser's draft store to the current
 * client schema. Never throws: a store that cannot be opened reports
 * "store-unavailable" and the update flow proceeds (the records simply
 * stay as they are; the new client's own loader tolerates them or says
 * so honestly).
 */
export async function migrateBrowserDraftStore(
  idb: MigrationIdbFactory | undefined = realIndexedDb(),
): Promise<DraftMigrationReport> {
  if (idb === undefined) {
    return {
      status: "store-unavailable",
      draftRecords: 0,
      migrated: 0,
      alreadyCurrent: 0,
      leftIntact: 0,
      problems: ["indexeddb unavailable"],
    };
  }
  return new Promise<DraftMigrationReport>((resolve) => {
    // Probe first, with NO side effect (round 3): even a versionless
    // open CREATES a nonexistent database, which would poison the profile
    // for D4's own open (its onupgradeneeded never fires on the
    // now-existing version-1 database). indexedDB.databases() answers
    // existence without opening; where it is unavailable, the fallback
    // probe opens and DELETES what it just created. A database that does
    // not exist simply has no drafts to migrate.
    const absent = (): DraftMigrationReport => ({
      status: "store-unavailable",
      draftRecords: 0,
      migrated: 0,
      alreadyCurrent: 0,
      leftIntact: 0,
      problems: ["drafts database not present"],
    });
    const openFailed = (): DraftMigrationReport => ({
      status: "store-unavailable",
      draftRecords: 0,
      migrated: 0,
      alreadyCurrent: 0,
      leftIntact: 0,
      problems: ["indexeddb open failed"],
    });
    const proceed = () => {
      const openRequest = idb.open(DRAFTS_DB_NAME, DRAFTS_DB_VERSION);
      openRequest.onerror = () => {
        resolve(openFailed());
        return;
      };
      openRequest.onsuccess = () => {
        const database = openRequest.result as MigrationIdbDatabase;
        try {
          const readTx = database.transaction([DRAFTS_STORE_NAME], "readonly");
          const keysRequest = readTx
            .objectStore(DRAFTS_STORE_NAME)
            .getAllKeys();
          readTx.onerror = () => {
            resolve({
              status: "store-unavailable",
              draftRecords: 0,
              migrated: 0,
              alreadyCurrent: 0,
              leftIntact: 0,
              problems: ["read transaction failed"],
            });
          };
          keysRequest.onsuccess = () => {
            const keys = Array.isArray(keysRequest.result)
              ? keysRequest.result
              : [];
            const draftKeys = keys.filter(
              (key): key is string =>
                typeof key === "string" && key.endsWith(DRAFT_KEY_SUFFIX),
            );
            void migrateKeys(database, draftKeys).then(resolve);
          };
        } catch {
          // A structural surprise resolves honestly instead of hanging the
          // cached prepare promise.
          resolve({
            status: "store-unavailable",
            draftRecords: 0,
            migrated: 0,
            alreadyCurrent: 0,
            leftIntact: 0,
            problems: ["drafts store unreadable"],
          });
        }
      };
    };
    if (typeof idb.databases === "function") {
      idb
        .databases()
        .then((names) => {
          if (!names.some((entry) => entry.name === DRAFTS_DB_NAME)) {
            resolve(absent());
            return;
          }
          proceed();
        })
        .catch(() => resolve(openFailed()));
      return;
    }
    // Legacy engines without databases(): probe-open, then delete what the
    // probe created so the profile is left exactly as it was found.
    const probeRequest = idb.open(DRAFTS_DB_NAME);
    probeRequest.onerror = () => resolve(openFailed());
    probeRequest.onsuccess = () => {
      const probed = probeRequest.result as MigrationIdbDatabase;
      const existed =
        probed.objectStoreNames !== undefined &&
        probed.objectStoreNames.contains(DRAFTS_STORE_NAME);
      probed.close?.();
      if (!existed) {
        idb.deleteDatabase?.(DRAFTS_DB_NAME);
        resolve(absent());
        return;
      }
      proceed();
    };
  });
}

async function migrateKeys(
  database: MigrationIdbDatabase,
  draftKeys: readonly string[],
): Promise<DraftMigrationReport> {
  const problems: string[] = [];
  let migrated = 0;
  let alreadyCurrent = 0;
  let leftIntact = 0;
  const writes: Promise<void>[] = [];
  for (const key of draftKeys) {
    const raw = await readRecord(database, key);
    const outcome = migrateDraftRecordValue(raw);
    if (!outcome.ok) {
      leftIntact += 1;
      problems.push(`${key}: ${outcome.problem}`);
      continue;
    }
    if (!outcome.changed) {
      alreadyCurrent += 1;
      continue;
    }
    migrated += 1;
    writes.push(writeRecord(database, key, outcome.record));
  }
  await Promise.all(writes);
  const status: DraftMigrationReport["status"] =
    migrated > 0 ? "migrated" : "already-current";
  return {
    status,
    draftRecords: draftKeys.length,
    migrated,
    alreadyCurrent,
    leftIntact,
    problems,
  };
}

function readRecord(
  database: MigrationIdbDatabase,
  key: string,
): Promise<unknown> {
  return new Promise((resolve) => {
    const tx = database.transaction([DRAFTS_STORE_NAME], "readonly");
    const request = tx.objectStore(DRAFTS_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

function writeRecord(
  database: MigrationIdbDatabase,
  key: string,
  value: unknown,
): Promise<void> {
  return new Promise((resolve) => {
    const tx = database.transaction([DRAFTS_STORE_NAME], "readwrite");
    tx.objectStore(DRAFTS_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}
