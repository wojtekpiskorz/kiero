/**
 * The durable local draft store (D4): ONE stable, recoverable composer
 * draft per signed-in person, persisted in the browser's own storage.
 *
 * Honesty rules this module exists to enforce (issue #32):
 *
 * - a draft that was never confirmed by the server is LOCAL, and says so:
 *   the record's `phase` is the one authority the UI renders ("composing"
 *   and "uploading" are local states; only a durable `sources.acceptSource`
 *   receipt flips it to "sent");
 * - recording chunks are persisted INCREMENTALLY as MediaRecorder emits
 *   them, so an interruption (tab killed, battery, PWA update) leaves the
 *   exact recoverable fragment, not an all-or-nothing blob;
 * - every storage failure is classified (`unavailable`, `quota`, `corrupt`)
 *   and surfaced — never swallowed into a false saved state. A quota hit
 *   during recording marks the draft `storageDegraded`: in-session send
 *   still works, but the UI must say recovery is not guaranteed.
 *
 * Persistence is a minimal key/value+blob surface (`DraftPersistence`) so
 * the semantics are provable in node tests; the IndexedDB adapter is the
 * thin production shell (exercised by the live browser proof). Keys:
 *
 * - `<userId>#draft`         the draft metadata record (JSON-safe object);
 * - `<userId>#rec#<seq>`     one recording chunk blob (seq 0-based);
 * - `<userId>#photo#<id>`    one photo blob.
 *
 * No product duration cap exists here (charter: no imposed voice-duration
 * limit); the only limits are the protocol bounds the upload engine
 * enforces (MAX_ATTACHMENTS, part sizes).
 */

// ---------------------------------------------------------------------------
// The persisted record
// ---------------------------------------------------------------------------

/** Local phases of the one logical draft. "sent" requires a server receipt. */
export type DraftPhase = "composing" | "uploading" | "accepting" | "sent";

/** One server-side upload session mirrored locally for crash recovery. */
export interface DraftSession {
  /** The D2 ledger upload id (stable across retries of the same draft). */
  readonly uploadId: string;
  /**
   * The begun attachments in declaration order (audio first, then photos):
   * the gateway-minted ids the resume path needs.
   */
  readonly attachments: readonly {
    readonly attachmentId: string;
    readonly kind: "audio" | "image";
    readonly objectKey: string;
  }[];
}

/** The recoverable recording fragment (chunks live under their own keys). */
export interface DraftRecording {
  readonly mimeType: string;
  readonly chunkCount: number;
  readonly totalBytes: number;
  readonly startedAtMs: number;
  /** Measured recording length; final only once stopped. */
  readonly durationMs: number;
}

/** One photo attachment (the blob lives under its own key). */
export interface DraftPhoto {
  readonly photoId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: number;
}

/** The draft metadata record (JSON-safe; blobs are separate keys). */
export interface DraftRecord {
  readonly userId: string;
  /** Stable per logical message: the prepare draftId AND the acceptance idempotency key. */
  readonly draftId: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly text: string;
  /** The project pill selection: null = Auto (company-wide). */
  readonly scopeProjectId: string | null;
  /**
   * Captured at the FIRST send attempt; an interrupted/offline draft keeps
   * its original intention on every retry (D1: past values stay acceptable).
   */
  readonly intendedSentAtIso: string | null;
  readonly recording: DraftRecording | null;
  readonly photos: readonly DraftPhoto[];
  readonly phase: DraftPhase;
  /** The mirrored upload session once prepare/begin succeeded. */
  readonly session: DraftSession | null;
  /** The last honest failure (typed code + server/hint message), if any. */
  readonly lastError: { readonly code: string; readonly message: string } | null;
  /** True when a storage write failed mid-draft: send may work, recovery is NOT promised. */
  readonly storageDegraded: boolean;
  /** Set by the confirmed acceptance receipt (the only "saved" proof). */
  readonly sentSourceId: string | null;
}

/** A fresh, empty draft for the next logical message. */
export function freshDraft(userId: string, draftId: string, nowMs: number): DraftRecord {
  return {
    userId,
    draftId,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    text: "",
    scopeProjectId: null,
    intendedSentAtIso: null,
    recording: null,
    photos: [],
    phase: "composing",
    session: null,
    lastError: null,
    storageDegraded: false,
    sentSourceId: null,
  };
}

// ---------------------------------------------------------------------------
// Failures (classified, never swallowed)
// ---------------------------------------------------------------------------

/** The closed vocabulary of storage failures the UI must speak about. */
export type DraftStoreErrorKind = "unavailable" | "quota" | "corrupt";

export interface DraftStoreError {
  readonly kind: DraftStoreErrorKind;
  /** English detail for logs; the UI copy lives in the feature state. */
  readonly detail?: string;
}

/** Wraps any thrown value into the typed store error of `kind`. */
export function draftStoreError(kind: DraftStoreErrorKind, cause: unknown): DraftStoreError {
  const detail =
    cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);
  return { kind, ...(detail === undefined ? {} : { detail }) };
}

/**
 * Classifies one storage-layer failure. QuotaExceededError is the browser's
 * eviction/pressure signal (DOMException name or legacy code 22); a
 * structured-clone or corruption failure is `corrupt`; anything else means
 * the store could not be used at all (`unavailable`).
 */
export function classifyStorageFailure(cause: unknown): DraftStoreError {
  if (cause instanceof Error || (typeof cause === "object" && cause !== null)) {
    const named = cause as { name?: unknown; code?: unknown };
    if (named.name === "QuotaExceededError" || named.name === "NotReadableError") {
      return draftStoreError("quota", cause);
    }
    if (named.code === 22) {
      return draftStoreError("quota", cause);
    }
    if (named.name === "DataCloneError" || named.name === "DataError") {
      return draftStoreError("corrupt", cause);
    }
  }
  return draftStoreError("unavailable", cause);
}

// ---------------------------------------------------------------------------
// The minimal persistence surface (adapter-friendly on purpose)
// ---------------------------------------------------------------------------

/**
 * The key/value+blob surface the draft semantics need. Production wraps
 * IndexedDB; tests wrap an in-memory map. Values must be structured-clone
 * safe (plain objects and Blobs are).
 */
export interface DraftPersistence {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Lists stored keys beginning with the prefix, in storage order. */
  keys(prefix: string): Promise<string[]>;
}

/** The typed store over one persistence surface. */
export class DraftsStore {
  constructor(private readonly persistence: DraftPersistence) {}

  /** Loads the person's draft record (null when none was ever persisted). */
  async loadDraft(userId: string): Promise<DraftRecord | null> {
    const raw = await this.persistence.get(draftKey(userId));
    if (raw === undefined || raw === null) {
      return null;
    }
    if (typeof raw !== "object") {
      throw draftStoreError("corrupt", new Error("draft record is not an object"));
    }
    const record = raw as Partial<DraftRecord>;
    if (
      typeof record.userId !== "string" ||
      typeof record.draftId !== "string" ||
      typeof record.phase !== "string"
    ) {
      throw draftStoreError("corrupt", new Error("draft record is missing required fields"));
    }
    return record as DraftRecord;
  }

  /** Persists the whole metadata record (one write, atomic at the key). */
  async saveDraft(record: DraftRecord): Promise<void> {
    await this.persistence.put(
      draftKey(record.userId),
      withStamp(record, Date.now()) as unknown,
    );
  }

  /**
   * Appends one recording chunk durably (the incremental write that makes
   * interruption leave a recoverable fragment). Returns the updated record.
   */
  async appendRecordingChunk(
    record: DraftRecord,
    seq: number,
    chunk: Blob,
  ): Promise<DraftRecord> {
    await this.persistence.put(chunkKey(record.userId, seq), chunk);
    const recording: DraftRecording = {
      mimeType: record.recording?.mimeType ?? chunk.type,
      chunkCount: Math.max(record.recording?.chunkCount ?? 0, seq + 1),
      totalBytes: (record.recording?.totalBytes ?? 0) + chunk.size,
      startedAtMs: record.recording?.startedAtMs ?? Date.now(),
      durationMs: record.recording?.durationMs ?? 0,
    };
    const next = { ...record, recording, updatedAtMs: Date.now() };
    await this.saveDraft(next);
    return next;
  }

  /** Reads the persisted recording chunks as ONE concatenated blob (null when none). */
  async readRecording(record: DraftRecord): Promise<Blob | null> {
    if (record.recording === null || record.recording.chunkCount === 0) {
      return null;
    }
    const chunks: Blob[] = [];
    for (let seq = 0; seq < record.recording.chunkCount; seq += 1) {
      const blob = await this.persistence.get(chunkKey(record.userId, seq));
      if (!(blob instanceof Blob)) {
        // A gap means the fragment is not fully recoverable: say so loudly
        // instead of silently uploading truncated audio.
        throw draftStoreError("corrupt", new Error(`recording chunk ${seq} missing`));
      }
      chunks.push(blob);
    }
    return new Blob(chunks, { type: record.recording.mimeType });
  }

  /** Adds one photo blob and its metadata (removable before Send). */
  async addPhoto(record: DraftRecord, photo: DraftPhoto, blob: Blob): Promise<DraftRecord> {
    await this.persistence.put(photoKey(record.userId, photo.photoId), blob);
    const next: DraftRecord = {
      ...record,
      photos: [...record.photos, photo],
      updatedAtMs: Date.now(),
    };
    await this.saveDraft(next);
    return next;
  }

  /** Removes one photo (metadata and blob). */
  async removePhoto(record: DraftRecord, photoId: string): Promise<DraftRecord> {
    await this.persistence.delete(photoKey(record.userId, photoId));
    const next: DraftRecord = {
      ...record,
      photos: record.photos.filter((photo) => photo.photoId !== photoId),
      updatedAtMs: Date.now(),
    };
    await this.saveDraft(next);
    return next;
  }

  /** Reads one photo's blob (null when absent; a missing blob is corrupt). */
  async readPhoto(record: DraftRecord, photoId: string): Promise<Blob | null> {
    const blob = await this.persistence.get(photoKey(record.userId, photoId));
    if (blob === undefined || blob === null) {
      return null;
    }
    if (!(blob instanceof Blob)) {
      throw draftStoreError("corrupt", new Error(`photo ${photoId} is not a blob`));
    }
    return blob;
  }

  /** Drops the recording fragment (metadata + every chunk). */
  async discardRecording(record: DraftRecord): Promise<DraftRecord> {
    if (record.recording !== null) {
      for (let seq = 0; seq < record.recording.chunkCount; seq += 1) {
        await this.persistence.delete(chunkKey(record.userId, seq));
      }
    }
    const next: DraftRecord = { ...record, recording: null, updatedAtMs: Date.now() };
    await this.saveDraft(next);
    return next;
  }

  /**
   * Clears the whole draft after a CONFIRMED send (or an explicit user
   * discard): the metadata record and every blob key it owned.
   */
  async clearDraft(record: DraftRecord): Promise<void> {
    if (record.recording !== null) {
      for (let seq = 0; seq < record.recording.chunkCount; seq += 1) {
        await this.persistence.delete(chunkKey(record.userId, seq));
      }
    }
    for (const photo of record.photos) {
      await this.persistence.delete(photoKey(record.userId, photo.photoId));
    }
    await this.persistence.delete(draftKey(record.userId));
  }
}

function draftKey(userId: string): string {
  return `${userId}#draft`;
}

function chunkKey(userId: string, seq: number): string {
  return `${userId}#rec#${seq}`;
}

function photoKey(userId: string, photoId: string): string {
  return `${userId}#photo#${photoId}`;
}

function withStamp(record: DraftRecord, nowMs: number): DraftRecord {
  return { ...record, updatedAtMs: nowMs };
}

// ---------------------------------------------------------------------------
// The IndexedDB adapter (production; thin on purpose, live-proved)
// ---------------------------------------------------------------------------

/**
 * The structural IDB surface the adapter needs. Structural (not the DOM
 * lib types) so the node test programs can import this module without a
 * DOM lib; the real browser `indexedDB` satisfies every member.
 */
export interface IdbRequestLike {
  result: unknown;
  onupgradeneeded: ((event: unknown) => void) | null;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface IdbFactoryLike {
  open(name: string, version: number): IdbRequestLike;
}

interface IdbDatabaseLike {
  transaction(stores: string[], mode: "readonly" | "readwrite"): IdbTransactionLike;
}

interface IdbTransactionLike {
  objectStore(name: string): IdbObjectStoreLike;
  oncomplete: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface IdbObjectStoreLike {
  get(key: string): IdbRequestLike;
  put(value: unknown, key?: string): IdbRequestLike;
  delete(key: string): IdbRequestLike;
  getAllKeys(): IdbRequestLike;
}

const DB_NAME = "kiero-drafts";
const DB_VERSION = 1;
const STORE = "entries";

/**
 * Opens the browser draft store. Rejects with a classified error when
 * IndexedDB is unavailable (private-mode eviction, disabled storage).
 */
export function openBrowserDraftStore(
  idb: IdbFactoryLike,
): Promise<DraftsStore | DraftStoreError> {
  return new Promise((resolve) => {
    let database: IdbDatabaseLike;
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result as IdbDatabaseLike & { createObjectStore(name: string): void };
      // A fresh database gets the one object store; existing databases at
      // version 1 already have it (open with a higher version is a later
      // coordinated change).
      try {
        db.createObjectStore(STORE);
      } catch {
        // Already created by an earlier upgrade within this same open.
      }
    };
    request.onsuccess = () => {
      database = request.result as IdbDatabaseLike;
      resolve(new DraftsStore(idbPersistence(() => database)));
    };
    request.onerror = () => {
      resolve(classifyStorageFailure(new Error("indexeddb open failed")));
    };
  });
}

/**
 * The IndexedDB persistence adapter: one object store, one key per entry,
 * every operation in its own transaction. Failures classify through
 * `classifyStorageFailure` so quota/corrupt states reach the UI typed.
 */
export function idbPersistence(connect: () => IdbDatabaseLike): DraftPersistence {
  /** Runs one request in its own transaction; failures classify and rethrow. */
  const inTransaction = async <T>(
    mode: "readonly" | "readwrite",
    work: (store: IdbObjectStoreLike) => IdbRequestLike,
  ): Promise<T> => {
    const db = connect();
    const tx = db.transaction([STORE], mode);
    const request = work(tx.objectStore(STORE));
    try {
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error("indexeddb transaction failed"));
      });
    } catch (cause) {
      throw rethrowClassified(cause);
    }
    return request.result as T;
  };
  return {
    async get(key) {
      try {
        return await inTransaction<unknown>("readonly", (store) => store.get(key));
      } catch (cause) {
        throw rethrowClassified(cause);
      }
    },
    async put(key, value) {
      try {
        await inTransaction<void>("readwrite", (store) => store.put(value, key));
      } catch (cause) {
        throw rethrowClassified(cause);
      }
    },
    async delete(key) {
      try {
        await inTransaction<void>("readwrite", (store) => store.delete(key));
      } catch (cause) {
        throw rethrowClassified(cause);
      }
    },
    async keys(prefix) {
      try {
        const all = await inTransaction<unknown[]>("readonly", (store) => store.getAllKeys());
        return all.filter(
          (key): key is string => typeof key === "string" && key.startsWith(prefix),
        );
      } catch (cause) {
        throw rethrowClassified(cause);
      }
    },
  };
}

/** Rethrows a thrown cause as a classified store error (once). */
function rethrowClassified(cause: unknown): never {
  if (isDraftStoreError(cause)) {
    throw cause;
  }
  throw classifyStorageFailure(cause);
}

/**
 * Structural guard for a classified store error (the UI's catch branches).
 * Structural, not `instanceof`, because persistence adapters rethrow plain
 * objects across boundaries.
 */
export function isDraftStoreErrorLike(value: unknown): value is DraftStoreError {
  return isDraftStoreError(value);
}

function isDraftStoreError(value: unknown): value is DraftStoreError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof (value as { kind: unknown }).kind === "string"
  );
}

// ---------------------------------------------------------------------------
// In-memory persistence (node tests; also the shape of any future shim)
// ---------------------------------------------------------------------------

/** A deterministic in-memory DraftPersistence for the node test programs. */
export function memoryPersistence(): DraftPersistence & {
  /** Test view of the stored entries (shared reference; asserts only). */
  readonly entries: ReadonlyMap<string, unknown>;
  /** Test seam: makes the next `count` writes fail with the given error. */
  failNextWrites(count: number, error: unknown): void;
} {
  const entries = new Map<string, unknown>();
  let failing = { count: 0, error: null as unknown };
  return {
    entries,
    failNextWrites(count, error) {
      failing = { count, error };
    },
    async get(key) {
      return entries.get(key);
    },
    async put(key, value) {
      if (failing.count > 0) {
        failing.count -= 1;
        throw failing.error;
      }
      entries.set(key, value);
    },
    async delete(key) {
      if (failing.count > 0) {
        failing.count -= 1;
        throw failing.error;
      }
      entries.delete(key);
    },
    async keys(prefix) {
      return [...entries.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}
