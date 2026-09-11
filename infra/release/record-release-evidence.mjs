/**
 * Release evidence recording (I7): appends one immutable record per
 * release attempt to infra/release/evidence/releases.jsonl.
 *
 * The record carries versions and digests, never secret values: target,
 * revision, the rehearsal row count, the runtime and client versions and
 * the SHA-256 of the migration ledger the rehearsal produced. The file is
 * append-only by convention and by tooling: this script never rewrites or
 * removes lines, and the release workflow uploads the resulting file as
 * a build artifact alongside the deployment.
 *
 * Importable (tests/i7) and runnable (release.yml).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath as nodeFileURLToPath } from "node:url";

/** The canonical evidence ledger path (append-only). */
export const RELEASE_EVIDENCE_PATH = new URL("./evidence/releases.jsonl", import.meta.url);

/** Builds one record (pure; the caller supplies every field). */
export function buildReleaseRecord({
  target,
  revision,
  rehearsalPassed,
  rehearsalRows,
  runtimeVersion,
  clientVersion,
  migrationLedgerText = null,
  recordedAtIso = new Date().toISOString(),
}) {
  return {
    recordedAtIso,
    target,
    revision,
    rehearsal: rehearsalPassed ? `${rehearsalRows} PASS` : "FAILED",
    runtimeVersion,
    clientVersion,
    ...(migrationLedgerText === null
      ? {}
      : { migrationLedgerSha256: sha256Hex(migrationLedgerText) }),
  };
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Appends one JSON line to the ledger (creates directories as needed). */
export function appendReleaseRecord(record, path = RELEASE_EVIDENCE_PATH) {
  const target = typeof path === "string" ? path : fileURLToPath(path);
  if (!existsSync(target)) {
    mkdirSync(dirname(target), { recursive: true });
  }
  appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
}

/** Reads every complete record line (torn tails are skipped). */
export function readReleaseRecords(path = RELEASE_EVIDENCE_PATH) {
  const target = typeof path === "string" ? path : fileURLToPath(path);
  if (!existsSync(target)) {
    return [];
  }
  const records = [];
  for (const line of readFileSync(target, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn final line is skipped, never repaired in place.
    }
  }
  return records;
}

function fileURLToPath(url) {
  return nodeFileURLToPath(url);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const target = flag("--target");
  const revision = flag("--revision") ?? "unknown";
  const rehearsalPassed = flag("--rehearsal-passed") === "true";
  const rehearsalRows = Number(flag("--rehearsal-rows") ?? 0);
  const runtimeVersion = flag("--runtime-version") ?? "unknown";
  const clientVersion = flag("--client-version") ?? "unknown";
  const ledgerPath = flag("--migration-ledger");
  if (target === null) {
    console.error("usage: record-release-evidence.mjs --target <staging|production> [--revision <sha>] ...");
    process.exit(2);
  }
  const record = buildReleaseRecord({
    target,
    revision,
    rehearsalPassed,
    rehearsalRows,
    runtimeVersion,
    clientVersion,
    migrationLedgerText: ledgerPath === null ? null : readFileSync(ledgerPath, "utf8"),
  });
  appendReleaseRecord(record);
  console.log(`release evidence recorded: ${JSON.stringify(record)}`);
}
