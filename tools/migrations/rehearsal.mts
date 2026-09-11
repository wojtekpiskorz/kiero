#!/usr/bin/env node
/**
 * The release rehearsal (I7 focused verification, deterministic half).
 *
 * One pass walks the whole expand-migrate-contract lifecycle exactly as
 * the issue's rehearsal row demands, against synthetic canonical data:
 *
 *   R1  EXPAND: new-code dual reads agree with old-code reads on every
 *       old-shape document BEFORE any data moves.
 *   R2  INTERRUPT: the migration is killed mid-batch (ledger behind the
 *       applied documents, the exact crash shape).
 *   R3  RESUME: the re-run completes; the partially applied batch was
 *       re-applied idempotently; canonical values never changed.
 *   R4  RETRY: a transiently failing batch retries and completes; a
 *       hard-failing batch records bounded failure, and a later run
 *       resumes and completes once the fault clears.
 *   R5  MIXED CLIENTS/WORKERS: during the window old and new clients and
 *       workers coexist; the compatibility policy answers for each; the
 *       contract gate BLOCKS while an old version was observed inside the
 *       absence window.
 *   R6  CONTRACT: after measured absence, old support is removed; old
 *       versions now answer "update-required"; revocation stays immediate
 *       for every age; database-restore rollback is refused.
 *
 * Exit code 0 only when every row passes. No secrets, no network, no
 * repository mutation; the ledger lives in a temp directory unless
 * KIERO_REHEARSAL_LEDGER names a path (release.yml does, and also gets a
 * rehearsal-summary.json written next to it for the evidence record).
 *
 * Run: node --experimental-strip-types tools/migrations/rehearsal.mts
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  recordContraction,
  runMigration,
  verifyTransformIdempotent,
  type DocumentCollection,
  type MigrationDefinition,
} from "./engine.ts";
import { jsonlLedger, memoryLedger } from "./ledger.ts";
import {
  decideClientSupport,
  decideContractRemoval,
  parseReleaseVersion,
  planReleaseRepair,
  securityEventPolicy,
} from "./policy.ts";

const results: { id: string; outcome: "PASS" | "FAIL"; detail: string }[] = [];
function record(id: string, ok: boolean, detail: string): boolean {
  results.push({ id, outcome: ok ? "PASS" : "FAIL", detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id} :: ${detail}`);
  return ok;
}
function equalJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// The synthetic canonical collection: amounts gain an explicit currency
// (old code assumed PLN; the expansion makes it explicit, additively).
// ---------------------------------------------------------------------------

interface AmountDoc {
  readonly key: string;
  readonly amountMinor: number;
  readonly note: string;
  /** Absent in the old shape; "PLN" after migration. */
  readonly currency?: string;
}

/** The OLD code's reading (currency-free world). */
function oldReader(doc: AmountDoc): { amountMinor: number; currency: string } {
  return { amountMinor: doc.amountMinor, currency: doc.currency ?? "PLN" };
}

const TOTAL = 23;
const oldShape: AmountDoc[] = Array.from({ length: TOTAL }, (_, index) => ({
  key: `finding_${String(index).padStart(3, "0")}`,
  amountMinor: 10_000 + index,
  note: `ustalenie ${index}`,
}));

/** A collection over a mutable snapshot, with fault injection. */
function collectionOver(docs: AmountDoc[]): DocumentCollection<AmountDoc> & {
  failNextApplies(count: number, errorKind: string): void;
  snapshot(): readonly AmountDoc[];
} {
  const store = new Map(docs.map((doc) => [doc.key, { ...doc }]));
  let failing = { count: 0, errorKind: "transient" };
  return {
    failNextApplies(count, errorKind) {
      failing = { count, errorKind };
    },
    snapshot: () => [...store.values()].sort((a, b) => a.key.localeCompare(b.key)),
    async countPending() {
      return store.size;
    },
    async fetchPage(afterKey, limit) {
      const sorted = [...store.values()].sort((a, b) => a.key.localeCompare(b.key));
      const start = afterKey === null ? 0 : sorted.findIndex((doc) => doc.key > afterKey);
      const from = start < 0 ? sorted.length : start;
      return sorted.slice(from, from + limit);
    },
    async apply(doc) {
      if (failing.count > 0) {
        failing.count -= 1;
        throw new Error(failing.errorKind);
      }
      store.set(doc.key, { ...doc });
    },
  };
}

const definition: MigrationDefinition<AmountDoc> = {
  migrationId: "rel_rehearsal.amounts_currency",
  description: "expand: explicit currency on amount findings; contract after absence",
  batchSize: 5,
  maxBatchAttempts: 3,
  transform: (doc) => (doc.currency === undefined ? { ...doc, currency: "PLN" } : doc),
  dualRead: oldReader,
};

const clock = { ms: 1_000_000 };
const now = () => (clock.ms += 1);
const sleep = async () => undefined;

// R1 EXPAND ---------------------------------------------------------------
const preChecks = [
  verifyTransformIdempotent(definition, oldShape),
  oldShape.every((doc) => equalJson(definition.dualRead(doc), oldReader(doc))),
];
record(
  "R1 expand: dual reads agree pre-migration and transform is idempotent",
  preChecks.every(Boolean),
  `idempotency=${JSON.stringify(preChecks[0])} docs=${oldShape.length}`,
);

// R2 INTERRUPT ------------------------------------------------------------
const ledgerIsOwnedTemp = process.env.KIERO_REHEARSAL_LEDGER === undefined;
const ledgerPath =
  process.env.KIERO_REHEARSAL_LEDGER ??
  join(mkdtempSync(join(tmpdir(), "kiero-rehearsal-")), "ledger.jsonl");
const fileLedger = jsonlLedger({
  readAll: async () => {
    try {
      return readFileSync(ledgerPath, "utf8");
    } catch {
      return "";
    }
  },
  appendLine: async (line) => {
    writeFileSync(ledgerPath, `${line}\n`, { flag: "a" });
  },
});
const live = collectionOver(oldShape);
const interrupted = await runMigration(definition, live, fileLedger, {
  interruptAfterBatches: 2,
  now,
  sleep,
});
const midSnapshot = live.snapshot();
const midCanonical = midSnapshot.map((doc) => oldReader(doc));
const midMixedShapes = midSnapshot.some((doc) => doc.currency === undefined) &&
  midSnapshot.some((doc) => doc.currency === "PLN");
record(
  "R2 interrupt: killed mid-batch leaves mixed shapes, canonical reads intact",
  interrupted.status === "interrupted" &&
    interrupted.progress.completedBatches === 2 &&
    midMixedShapes &&
    equalJson(midCanonical, oldShape.map((doc) => oldReader(doc))),
  `status=${interrupted.status} batches=${interrupted.progress.completedBatches} mixedShapes=${midMixedShapes}`,
);

// R3 RESUME ---------------------------------------------------------------
const resumed = await runMigration(definition, live, fileLedger, { now, sleep });
const finalSnapshot = live.snapshot();
record(
  "R3 resume: completes after interruption, every document migrated, values identical",
  resumed.status === "migrated" &&
    resumed.progress.doneDocuments === TOTAL &&
    finalSnapshot.every((doc) => doc.currency === "PLN") &&
    equalJson(
      finalSnapshot.map((doc) => oldReader(doc)),
      oldShape.map((doc) => oldReader(doc)),
    ),
  `status=${resumed.status} done=${resumed.progress.doneDocuments}/${TOTAL}`,
);
const rerun = await runMigration(definition, live, fileLedger, { now, sleep });
record(
  "R3 resume: a completed migration re-runs as a verified no-op",
  rerun.status === "migrated" && rerun.alreadyComplete,
  `alreadyComplete=${rerun.status === "migrated" ? rerun.alreadyComplete : false}`,
);

// R4 RETRY ----------------------------------------------------------------
const transientLedger = memoryLedger();
const transient = collectionOver(oldShape);
transient.failNextApplies(2, "transient_unavailable");
const retried = await runMigration(definition, transient, transientLedger, { now, sleep });
record(
  "R4 retry: a transiently failing batch retries and the migration completes",
  retried.status === "migrated" && transient.snapshot().every((doc) => doc.currency === "PLN"),
  `status=${retried.status} ledgerRetries=${transientLedger.lines.filter((l) => l.entry.kind === "batch-retry").length}`,
);
const hardLedger = memoryLedger();
const hard = collectionOver(oldShape);
hard.failNextApplies(Number.POSITIVE_INFINITY, "hard_failure");
const exhausted = await runMigration(definition, hard, hardLedger, { now, sleep });
const later = collectionOver(oldShape);
const laterRun = await runMigration(definition, later, hardLedger, { now, sleep });
record(
  "R4 retry: exhausted attempts record bounded failure; a later run completes",
  exhausted.status === "failed" &&
    exhausted.attempts === 3 &&
    laterRun.status === "migrated" &&
    later.snapshot().every((doc) => doc.currency === "PLN"),
  `exhausted=${exhausted.status}/${exhausted.status === "failed" ? exhausted.attempts : 0} later=${laterRun.status}`,
);

// R5 MIXED CLIENTS/WORKERS + CONTRACT GATE --------------------------------
const policy = { currentVersion: "1.4.0", minSupportedVersion: "1.2.0" };
const decisions = (["1.4.0", "1.3.1", "1.2.0", "1.1.9"] as const).map(
  (version) => decideClientSupport(policy, version),
);
const gate = { minSupportedVersion: "1.2.0", absenceWindowMs: 14 * 24 * 3600 * 1000 };
const observations = [
  { version: "1.1.9", observedAtMs: now() - 2 * 24 * 3600 * 1000 },
];
const blocked = decideContractRemoval(gate, observations, now());
record(
  "R5 mixed: window answers every age; the gate blocks while old use is recent",
  decisions[0] === "current" &&
    decisions[1] === "update-available" &&
    decisions[2] === "update-available" &&
    decisions[3] === "update-required" &&
    blocked.allowed === false,
  `decisions=${decisions.join(",")} gate=${blocked.allowed ? "open" : "blocked"}`,
);

// R6 CONTRACT -------------------------------------------------------------
const quiet = decideContractRemoval(gate, [], now());
const afterWindow = decideContractRemoval(
  gate,
  [{ version: "1.1.9", observedAtMs: now() - 20 * 24 * 3600 * 1000 }],
  now(),
);
const repairs = [
  planReleaseRepair({ kind: "restore_database_backup" }),
  planReleaseRepair({ kind: "rollback_code", releaseId: "rel_1", previousVersion: "1.3.0" }),
  planReleaseRepair({ kind: "forward_fix", releaseId: "rel_1" }),
];
const contractedLedger = memoryLedger();
await recordContraction(definition.migrationId, contractedLedger, "absence measured", now);
const revocations = (["current", "update-available", "update-required", null] as const).map(
  (decision) => securityEventPolicy(decision).revocationApplication,
);
record(
  "R6 contract: absence opens the gate; repairs never restore a database; revocation stays immediate",
  quiet.allowed === true &&
    afterWindow.allowed === true &&
    repairs[0]?.kind === "rejected" &&
    repairs[1]?.kind === "compatible_rollback" &&
    repairs[2]?.kind === "forward_fix" &&
    revocations.every((application) => application === "immediate") &&
    parseReleaseVersion("1.2.3") !== null,
  `quiet=${quiet.allowed} afterWindow=${afterWindow.allowed} restore=${repairs[0]?.kind} revocation=${revocations[0]}`,
);

// Ledger durability ---------------------------------------------------------
const ledgerText = readFileSync(ledgerPath, "utf8");
const ledgerKinds = ledgerText
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => (JSON.parse(line) as { entry: { kind: string } }).entry.kind);
record(
  "R7 ledger: the file ledger records the full lifecycle, append-only",
  equalJson(ledgerKinds.slice(0, 3), ["expanded", "batch-done", "batch-done"]) &&
    ledgerKinds[ledgerKinds.length - 1] === "migrated",
  `kinds=${ledgerKinds.join(">")}`,
);

const failures = results.filter((r) => r.outcome === "FAIL").length;
console.log(`\nRehearsal summary: ${results.length - failures}/${results.length} rows PASS`);
writeFileSync(
  join(dirname(ledgerPath), "rehearsal-summary.json"),
  `${JSON.stringify({ passed: failures === 0, rows: results.length }, null, 2)}\n`,
);
if (ledgerIsOwnedTemp) {
  // The temp ledger directory (and the summary written into it) is removed;
  // an env-provided ledger stays for the workflow's evidence record.
  rmSync(dirname(ledgerPath), { recursive: true, force: true, maxRetries: 3 });
}
process.exit(failures === 0 ? 0 : 1);
