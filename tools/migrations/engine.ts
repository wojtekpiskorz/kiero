/**
 * The expand-migrate-contract engine (I7): bounded, resumable, idempotent
 * batch migrations over any cursor-paginated document collection.
 *
 * The issue's bounded solution, as executable rules:
 *
 * - EXPAND first: the definition's `dualRead` proves the new code reads
 *   pre-migration documents and the old code's answers survive (backward-
 *   compatible support exists BEFORE any data moves);
 * - MIGRATE in bounded batches: each batch reads one page after the last
 *   recorded cursor, applies the idempotent transform, and only then
 *   appends its "batch-done" ledger entry. A kill between apply and
 *   record leaves at most one PARTIALLY applied batch, which the resumed
 *   run re-reads and re-applies safely (idempotency is verified, not
 *   assumed: verifyTransformIdempotent);
 * - RETRY transiently: a failing batch retries with bounded attempts
 *   (backoff injected by the caller); exhaustion records "failed" and the
 *   NEXT run resumes at that batch once the fault clears;
 * - CONTRACT last: removal of old support is gated by the measured-
 *   absence policy (tools/migrations/policy.ts), never by hope.
 *
 * The engine is deliberately store-agnostic: Convex, R2, whatever - the
 * owning surface implements DocumentCollection. Canonical data safety is
 * the transform's contract (pure, idempotent, never destructive) plus the
 * dual-read proof, which the rehearsal exercises.
 */

import { migrationState, type LedgerEntry, type MigrationLedger } from "./ledger.ts";

/** The bounds every migration definition must live inside. */
export const MAX_BATCH_SIZE = 500;
export const MAX_BATCH_ATTEMPTS = 10;

/** A document the engine can address by stable key. */
export interface MigratableDocument {
  /** Stable identity (the cursor and the idempotency address). */
  readonly key: string;
}

/**
 * The store-agnostic collection surface. `fetchPage` returns documents in
 * a STABLE key order so a cursor is a genuine resume point.
 */
export interface DocumentCollection<TDoc extends MigratableDocument> {
  /** How many documents this migration still concerns (progress denominator). */
  countPending(): Promise<number>;
  /** One bounded page strictly AFTER the cursor key (null = from start). */
  fetchPage(afterKey: string | null, limit: number): Promise<readonly TDoc[]>;
  /** Idempotently writes one migrated document. */
  apply(doc: TDoc): Promise<void>;
}

/** One migration's definition. The transform must be idempotent. */
export interface MigrationDefinition<TDoc extends MigratableDocument> {
  /** Immutable identity inside the ledger (one per release). */
  readonly migrationId: string;
  readonly description: string;
  /** Documents per batch (1..MAX_BATCH_SIZE). */
  readonly batchSize: number;
  /** Attempts per batch including the first (2..MAX_BATCH_ATTEMPTS). */
  readonly maxBatchAttempts: number;
  /**
   * The pure, idempotent per-document transform: old and already-new
   * shapes in, the new shape out, identical on re-application.
   */
  readonly transform: (doc: TDoc) => TDoc;
  /**
   * The EXPAND proof: reads one document (either shape) the way the NEW
   * code does and returns its canonical value; the rehearsal compares it
   * against the OLD code's reading of the same document before and after
   * migration. Throws when compatibility is absent.
   */
  readonly dualRead: (doc: TDoc) => unknown;
}

/** Run options (fault injection lives here so production paths stay pure). */
export interface RunOptions {
  /**
   * Simulated kill: after this many COMPLETED batches, apply only the
   * first document of the next batch and return "interrupted" WITHOUT
   * recording it (the exact mid-batch crash shape).
   */
  readonly interruptAfterBatches?: number;
  /** Clock and sleep injection (tests stay deterministic; CI is real). */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Backoff base for batch retries (doubles per attempt). */
  readonly retryBackoffBaseMs?: number;
}

/** Observable progress at any moment. */
export interface MigrationProgress {
  readonly totalDocuments: number;
  readonly doneDocuments: number;
  readonly completedBatches: number;
}

/** How one run ended. */
export type RunOutcome =
  | {
      readonly status: "migrated";
      readonly progress: MigrationProgress;
      readonly alreadyComplete: boolean;
    }
  | {
      readonly status: "interrupted";
      readonly progress: MigrationProgress;
      /** The partially applied batch the kill left behind. */
      readonly partialBatchIndex: number;
      readonly partiallyAppliedKeys: readonly string[];
    }
  | {
      readonly status: "failed";
      readonly progress: MigrationProgress;
      readonly failedBatchIndex: number;
      readonly attempts: number;
      readonly errorKind: string;
    };

/** Derives progress from the ledger (the observable answer, any time). */
export async function readProgress(
  def: { readonly migrationId: string },
  collection: { countPending(): Promise<number> },
  ledger: MigrationLedger,
): Promise<MigrationProgress> {
  const [entries, totalDocuments] = await Promise.all([
    ledger.read(def.migrationId),
    collection.countPending(),
  ]);
  const state = migrationState(entries);
  return {
    totalDocuments,
    doneDocuments: state.doneDocuments,
    completedBatches: state.completedBatches,
  };
}

/**
 * Verifies the idempotency contract on a sample: transform(transform(d))
 * must equal transform(d). The engine's crash-safety argument stands on
 * this property; a migration that fails it must not run at all.
 */
export function verifyTransformIdempotent<TDoc extends MigratableDocument>(
  def: Pick<MigrationDefinition<TDoc>, "transform">,
  sample: readonly TDoc[],
): { ok: true } | { ok: false; key: string } {
  for (const doc of sample) {
    const once = def.transform(doc);
    const twice = def.transform(once);
    if (JSON.stringify(once) !== JSON.stringify(twice)) {
      return { ok: false, key: doc.key };
    }
  }
  return { ok: true };
}

/** Classifies a thrown value into the bounded error vocabulary. */
function errorKindOf(cause: unknown): string {
  if (cause instanceof Error || (typeof cause === "object" && cause !== null)) {
    const named = cause as { name?: unknown; kind?: unknown };
    if (typeof named.kind === "string") {
      return named.kind;
    }
    if (typeof named.name === "string") {
      return named.name;
    }
  }
  return "unknown";
}

/**
 * Runs (or resumes) one migration to completion, interruption or bounded
 * failure. Safe to re-run: a complete migration returns immediately.
 */
export async function runMigration<TDoc extends MigratableDocument>(
  def: MigrationDefinition<TDoc>,
  collection: DocumentCollection<TDoc>,
  ledger: MigrationLedger,
  options: RunOptions = {},
): Promise<RunOutcome> {
  if (def.batchSize < 1 || def.batchSize > MAX_BATCH_SIZE) {
    throw new Error(`migration ${def.migrationId}: batchSize out of bounds`);
  }
  if (def.maxBatchAttempts < 2 || def.maxBatchAttempts > MAX_BATCH_ATTEMPTS) {
    throw new Error(`migration ${def.migrationId}: maxBatchAttempts out of bounds`);
  }
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? (async () => undefined);
  const backoffBase = options.retryBackoffBaseMs ?? 0;

  const entries = await ledger.read(def.migrationId);
  let state = migrationState(entries);
  if (state.complete) {
    return {
      status: "migrated",
      progress: {
        totalDocuments: await collection.countPending(),
        doneDocuments: state.doneDocuments,
        completedBatches: state.completedBatches,
      },
      alreadyComplete: true,
    };
  }

  // EXPAND: recorded once, before any data moves. The dual-read proof ran
  // before this point (the rehearsal asserts it); the entry is its mark.
  if (state.phase === "unstarted") {
    await ledger.append(def.migrationId, {
      kind: "expanded",
      atMs: now(),
      note: def.description,
    });
  }

  const totalDocuments = await collection.countPending();
  let batchIndex = state.completedBatches;
  let doneDocuments = state.doneDocuments;
  let cursor = state.lastCursor;

  for (;;) {
    const page = await collection.fetchPage(cursor, def.batchSize);
    if (page.length === 0) {
      await ledger.append(def.migrationId, {
        kind: "migrated",
        documents: doneDocuments,
        batches: batchIndex,
        atMs: now(),
      });
      return {
        status: "migrated",
        progress: { totalDocuments, doneDocuments, completedBatches: batchIndex },
        alreadyComplete: false,
      };
    }

    // The simulated kill: apply only the first document, record nothing.
    if (options.interruptAfterBatches !== undefined && batchIndex >= options.interruptAfterBatches) {
      await collection.apply(def.transform(page[0] as TDoc));
      return {
        status: "interrupted",
        progress: { totalDocuments, doneDocuments, completedBatches: batchIndex },
        partialBatchIndex: batchIndex,
        partiallyAppliedKeys: [(page[0] as TDoc).key],
      };
    }

    // MIGRATE: one bounded batch with bounded retries.
    let applied = false;
    for (let attempt = 1; attempt <= def.maxBatchAttempts; attempt += 1) {
      try {
        for (const doc of page) {
          await collection.apply(def.transform(doc));
        }
        applied = true;
        break;
      } catch (cause) {
        const errorKind = errorKindOf(cause);
        if (attempt === def.maxBatchAttempts) {
          await ledger.append(def.migrationId, {
            kind: "failed",
            batchIndex,
            attempts: attempt,
            errorKind,
            atMs: now(),
          });
          return {
            status: "failed",
            progress: { totalDocuments, doneDocuments, completedBatches: batchIndex },
            failedBatchIndex: batchIndex,
            attempts: attempt,
            errorKind,
          };
        }
        await ledger.append(def.migrationId, {
          kind: "batch-retry",
          batchIndex,
          attempt,
          errorKind,
          atMs: now(),
        });
        await sleep(backoffBase * 2 ** (attempt - 1));
      }
    }
    if (!applied) {
      // Unreachable: the loop returns on exhaustion.
      throw new Error(`migration ${def.migrationId}: batch retry loop exited without verdict`);
    }

    const toCursor = (page[page.length - 1] as TDoc).key;
    await ledger.append(def.migrationId, {
      kind: "batch-done",
      batchIndex,
      fromCursor: cursor,
      toCursor,
      documents: page.length,
      atMs: now(),
    });
    cursor = toCursor;
    batchIndex += 1;
    doneDocuments += page.length;
  }
}

/** Appends the contract-phase entry once the policy gate allows removal. */
export async function recordContraction(
  migrationId: string,
  ledger: MigrationLedger,
  note: string,
  now: () => number = () => Date.now(),
): Promise<void> {
  await ledger.append(migrationId, { kind: "contracted", atMs: now(), note });
}

/** Re-exported for consumers that compose the engine with its ledger. */
export type { LedgerEntry, MigrationLedger };
