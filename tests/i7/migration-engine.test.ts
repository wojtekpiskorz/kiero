/**
 * I7 focused tests: the expand-migrate-contract engine's resumability,
 * bounded batches, retry policy and canonical-data safety, over the same
 * synthetic canonical collection shape the rehearsal walks (amounts gain
 * an explicit currency, additively).
 *
 * The live halves (a real deployment's collection adapter) stay with the
 * release rehearsal evidence; these rows pin the mechanism.
 */

import { describe, expect, it } from "vitest";
import {
  runMigration,
  readProgress,
  verifyTransformIdempotent,
  type DocumentCollection,
  type MigrationDefinition,
} from "../../tools/migrations/engine";
import { memoryLedger, migrationState } from "../../tools/migrations/ledger";

interface AmountDoc {
  readonly key: string;
  readonly amountMinor: number;
  readonly currency?: string;
}

const definition: MigrationDefinition<AmountDoc> = {
  migrationId: "test.amounts_currency",
  description: "expand: explicit currency",
  batchSize: 4,
  maxBatchAttempts: 3,
  transform: (doc) => (doc.currency === undefined ? { ...doc, currency: "PLN" } : doc),
  dualRead: (doc) => ({ amountMinor: doc.amountMinor, currency: doc.currency ?? "PLN" }),
};

function collectionOver(docs: readonly AmountDoc[]): DocumentCollection<AmountDoc> & {
  failNextApplies(count: number): void;
  applies(): number;
  snapshot(): readonly AmountDoc[];
} {
  const store = new Map(docs.map((doc) => [doc.key, { ...doc }]));
  let failing = 0;
  let appliedCount = 0;
  return {
    failNextApplies(count) {
      failing = count;
    },
    applies: () => appliedCount,
    snapshot: () => [...store.values()].sort((a, b) => a.key.localeCompare(b.key)),
    async countPending() {
      return store.size;
    },
    async fetchPage(afterKey, limit) {
      const sorted = [...store.keys()].sort();
      const start = afterKey === null ? 0 : sorted.findIndex((key) => key > afterKey);
      const from = start < 0 ? sorted.length : start;
      return sorted.slice(from, from + limit).map((key) => store.get(key) as AmountDoc);
    },
    async apply(doc) {
      if (failing > 0) {
        failing -= 1;
        throw new Error("transient_unavailable");
      }
      store.set(doc.key, { ...doc });
      appliedCount += 1;
    },
  };
}

const docs: AmountDoc[] = Array.from({ length: 10 }, (_, index) => ({
  key: `doc_${index}`,
  amountMinor: 100 + index,
}));

const clock = { ms: 0 };
const now = () => (clock.ms += 1);
const sleep = async () => undefined;

describe("the expand proof", () => {
  it("verifies transform idempotency and rejects a non-idempotent transform", () => {
    expect(verifyTransformIdempotent(definition, docs)).toEqual({ ok: true });
    const bad: MigrationDefinition<AmountDoc> = {
      ...definition,
      transform: (doc) => ({ ...doc, amountMinor: doc.amountMinor + 1 }),
    };
    expect(verifyTransformIdempotent(bad, docs)).toEqual({ ok: false, key: "doc_0" });
  });

  it("runs bounded batches and records the full ledger lifecycle", async () => {
    const ledger = memoryLedger();
    const collection = collectionOver(docs);
    const outcome = await runMigration(definition, collection, ledger, { now, sleep });
    expect(outcome.status).toBe("migrated");
    if (outcome.status === "migrated") {
      expect(outcome.progress).toEqual({
        totalDocuments: 10,
        doneDocuments: 10,
        completedBatches: 3,
      });
    }
    const kinds = ledger.lines.map((line) => line.entry.kind);
    expect(kinds).toEqual([
      "expanded",
      "batch-done",
      "batch-done",
      "batch-done",
      "migrated",
    ]);
  });

  it("refuses out-of-bounds definitions loudly", async () => {
    await expect(
      runMigration(
        { ...definition, batchSize: 0 },
        collectionOver(docs),
        memoryLedger(),
        { now, sleep },
      ),
    ).rejects.toThrow(/batchSize out of bounds/);
    await expect(
      runMigration(
        { ...definition, maxBatchAttempts: 1 },
        collectionOver(docs),
        memoryLedger(),
        { now, sleep },
      ),
    ).rejects.toThrow(/maxBatchAttempts out of bounds/);
  });
});

describe("resumability", () => {
  it("a mid-batch kill leaves partial applies that the resume re-applies idempotently", async () => {
    const ledger = memoryLedger();
    const collection = collectionOver(docs);
    const interrupted = await runMigration(definition, collection, ledger, {
      interruptAfterBatches: 1,
      now,
      sleep,
    });
    expect(interrupted.status).toBe("interrupted");
    if (interrupted.status === "interrupted") {
      // Batch 1 (docs 0..3) recorded complete; one doc of batch 2 applied
      // WITHOUT its ledger entry: the exact crash shape.
      expect(interrupted.partiallyAppliedKeys).toEqual(["doc_4"]);
    }
    // Mid-migration the store holds BOTH shapes and old reads still work.
    const mid = collection.snapshot();
    expect(mid.filter((doc) => doc.currency === undefined)).toHaveLength(5);
    expect(mid.map((doc) => definition.dualRead(doc))).toEqual(
      docs.map((doc) => definition.dualRead(doc)),
    );

    const resumed = await runMigration(definition, collection, ledger, { now, sleep });
    expect(resumed.status).toBe("migrated");
    expect(collection.snapshot().every((doc) => doc.currency === "PLN")).toBe(true);
    // Canonical values never moved.
    expect(
      collection.snapshot().map((doc) => ({ amountMinor: doc.amountMinor })),
    ).toEqual(docs.map((doc) => ({ amountMinor: doc.amountMinor })));
  });

  it("a completed migration re-runs as a verified no-op", async () => {
    const ledger = memoryLedger();
    const collection = collectionOver(docs);
    await runMigration(definition, collection, ledger, { now, sleep });
    const before = collection.applies();
    const rerun = await runMigration(definition, collection, ledger, { now, sleep });
    expect(rerun).toMatchObject({ status: "migrated", alreadyComplete: true });
    expect(collection.applies()).toBe(before);
  });

  it("progress is observable from the ledger alone", async () => {
    const ledger = memoryLedger();
    const collection = collectionOver(docs);
    await runMigration(definition, collection, ledger, {
      interruptAfterBatches: 1,
      now,
      sleep,
    });
    const progress = await readProgress(definition, collection, ledger);
    expect(progress).toEqual({
      totalDocuments: 10,
      doneDocuments: 4,
      completedBatches: 1,
    });
    const state = migrationState(await ledger.read(definition.migrationId));
    expect(state.phase).toBe("migrating");
    expect(state.lastCursor).toBe("doc_3");
  });
});

describe("retry policy", () => {
  it("retries a transient failure inside the attempt budget and completes", async () => {
    const ledger = memoryLedger();
    const collection = collectionOver(docs);
    collection.failNextApplies(2);
    const outcome = await runMigration(definition, collection, ledger, { now, sleep });
    expect(outcome.status).toBe("migrated");
    const retries = ledger.lines
      .map((line) => line.entry)
      .filter((entry) => entry.kind === "batch-retry");
    expect(retries).toHaveLength(2);
  });

  it("exhausted attempts record bounded failure; a later run resumes and completes", async () => {
    const ledger = memoryLedger();
    const broken = collectionOver(docs);
    broken.failNextApplies(Number.POSITIVE_INFINITY);
    const failed = await runMigration(definition, broken, ledger, { now, sleep });
    expect(failed.status).toBe("failed");
    if (failed.status === "failed") {
      expect(failed.attempts).toBe(3);
      expect(failed.errorKind).toBe("Error");
      expect(failed.failedBatchIndex).toBe(0);
    }
    expect(migrationState(await ledger.read(definition.migrationId)).phase).toBe("failed");

    const healed = collectionOver(docs);
    const later = await runMigration(definition, healed, ledger, { now, sleep });
    expect(later.status).toBe("migrated");
    expect(healed.snapshot().every((doc) => doc.currency === "PLN")).toBe(true);
  });

  it("backoff doubles per attempt through the injected sleep", async () => {
    const ledger = memoryLedger();
    const collection = collectionOver(docs);
    collection.failNextApplies(2);
    const sleeps: number[] = [];
    await runMigration(definition, collection, ledger, {
      now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      retryBackoffBaseMs: 100,
    });
    expect(sleeps).toEqual([100, 200]);
  });
});
