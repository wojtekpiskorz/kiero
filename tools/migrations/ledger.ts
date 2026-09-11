/**
 * The migration ledger (I7): the durable, append-only record that makes a
 * migration RESUMABLE and its progress OBSERVABLE.
 *
 * A ledger entry is only ever APPENDED, never edited: the entries are the
 * immutable evidence of what a release's migration did and when. State is
 * DERIVED from the entries (migrationState), so a process that dies
 * mid-batch leaves exactly the truth: the batches whose "batch-done"
 * entries exist are done; everything after the last recorded cursor is
 * (at best) partially applied, which is safe because migration
 * transforms are idempotent (the engine contract).
 *
 * Two adapters:
 * - memory (tests, rehearsal scenarios that need isolation);
 * - JSONL file (production/rehearsal): one envelope line per entry,
 *   appended whole; a torn final line is ignored on read.
 */

// ---------------------------------------------------------------------------
// Entries and derived state
// ---------------------------------------------------------------------------

/** The release's migration lifecycle (expand-migrate-contract). */
export type MigrationPhase =
  | "unstarted"
  | "expanded"
  | "migrating"
  | "migrated"
  | "failed"
  | "contracted";

/** One immutable ledger record. */
export type LedgerEntry =
  | { readonly kind: "expanded"; readonly atMs: number; readonly note: string }
  | {
      readonly kind: "batch-retry";
      readonly batchIndex: number;
      readonly attempt: number;
      readonly errorKind: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "batch-done";
      readonly batchIndex: number;
      readonly fromCursor: string | null;
      readonly toCursor: string | null;
      readonly documents: number;
      readonly atMs: number;
    }
  | {
      readonly kind: "failed";
      readonly batchIndex: number;
      readonly attempts: number;
      readonly errorKind: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "migrated";
      readonly documents: number;
      readonly batches: number;
      readonly atMs: number;
    }
  | { readonly kind: "contracted"; readonly atMs: number; readonly note: string };

/** What the world can derive from one migration's entries. */
export interface MigrationState {
  readonly phase: MigrationPhase;
  /** Documents inside recorded completed batches. */
  readonly doneDocuments: number;
  readonly completedBatches: number;
  /** Resume point: the cursor of the last recorded batch (null = start). */
  readonly lastCursor: string | null;
  /** True once the "migrated" entry exists (re-running is a verified no-op). */
  readonly complete: boolean;
}

/** Derives the migration state from its append-only entries. */
export function migrationState(entries: readonly LedgerEntry[]): MigrationState {
  let phase: MigrationPhase = "unstarted";
  let doneDocuments = 0;
  let completedBatches = 0;
  let lastCursor: string | null = null;
  let complete = false;
  for (const entry of entries) {
    switch (entry.kind) {
      case "expanded":
        if (phase === "unstarted") {
          phase = "expanded";
        }
        break;
      case "batch-retry":
        break;
      case "batch-done":
        completedBatches += 1;
        doneDocuments += entry.documents;
        lastCursor = entry.toCursor;
        if (phase === "expanded" || phase === "migrating") {
          phase = "migrating";
        }
        break;
      case "failed":
        if (phase !== "contracted" && phase !== "migrated") {
          phase = "failed";
        }
        break;
      case "migrated":
        phase = "migrated";
        complete = true;
        break;
      case "contracted":
        phase = "contracted";
        complete = true;
        break;
    }
  }
  return { phase, doneDocuments, completedBatches, lastCursor, complete };
}

// ---------------------------------------------------------------------------
// The ledger port and adapters
// ---------------------------------------------------------------------------

/** The durable ledger surface the engine writes through. */
export interface MigrationLedger {
  read(migrationId: string): Promise<readonly LedgerEntry[]>;
  append(migrationId: string, entry: LedgerEntry): Promise<void>;
}

/** A deterministic in-memory ledger (tests and isolated rehearsal legs). */
export function memoryLedger(): MigrationLedger & {
  /** Test view: every appended line (shared reference; asserts only). */
  readonly lines: readonly { migrationId: string; entry: LedgerEntry }[];
} {
  const lines: { migrationId: string; entry: LedgerEntry }[] = [];
  return {
    lines,
    async read(migrationId) {
      return lines
        .filter((line) => line.migrationId === migrationId)
        .map((line) => line.entry);
    },
    async append(migrationId, entry) {
      lines.push({ migrationId, entry });
    },
  };
}

/** The minimal file surface a JSONL ledger needs (adapters inject fs). */
export interface LedgerFile {
  readAll(): Promise<string>;
  appendLine(line: string): Promise<void>;
}

/**
 * A JSONL-file-backed ledger. Lines carry the envelope
 * `{ migrationId, entry }` so one file serves a whole release; a torn
 * final line (process killed mid-append) is ignored on read and simply
 * re-appended by the resumed run.
 */
export function jsonlLedger(file: LedgerFile): MigrationLedger {
  return {
    async read(migrationId) {
      const all = await file.readAll();
      const entries: LedgerEntry[] = [];
      for (const line of all.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { migrationId?: unknown }).migrationId === migrationId
        ) {
          const entry = (parsed as { entry?: unknown }).entry;
          if (
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as { kind?: unknown }).kind === "string"
          ) {
            entries.push(entry as LedgerEntry);
          }
        }
      }
      return entries;
    },
    async append(migrationId, entry) {
      await file.appendLine(JSON.stringify({ migrationId, entry }));
    },
  };
}
