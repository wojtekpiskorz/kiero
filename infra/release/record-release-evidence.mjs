/**
 * Release evidence recording (I7/R6): appends immutable records to the
 * append-only ledger infra/release/evidence/releases.jsonl (or a path the
 * caller chooses). The ledger carries two record kinds:
 *
 * - "release-attempt" (one per workflow dispatch): target, revision,
 *   descriptor, the rehearsal verdict and row count, the runtime and
 *   client versions, the SHA-256 of the migration ledger and the
 *   dispatcher's notes when supplied.
 * - "component-outcome" (one per component per deploy run, written by
 *   deploy-component.mjs): the THREE truthful terminal states:
 *     deployed: component + revision + digest + descriptor + remote
 *               identity (a transport that reported no identity cannot
 *               produce this state);
 *     skipped:  ONLY when the target descriptor excludes the component;
 *     blocked:  missing or unauthorized configuration (names only),
 *               refused/missing Checks, failed build or transport.
 *
 * The file is append-only by convention and by tooling: this module never
 * rewrites or removes lines. Secret VALUES never appear; blocked records
 * carry configuration NAMES and observed labels only.
 *
 * Importable (tests/i7) and runnable (release.yml).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath as nodeFileURLToPath } from "node:url";

/** The canonical evidence ledger path (append-only). */
export const RELEASE_EVIDENCE_PATH = new URL("./evidence/releases.jsonl", import.meta.url);

/** The terminal component outcomes (R6 truthfulness contract). */
export const COMPONENT_OUTCOMES = ["deployed", "skipped", "blocked"];

/** Builds one "release-attempt" record (pure; the caller supplies every field). */
export function buildReleaseRecord({
  target,
  revision,
  rehearsalPassed,
  rehearsalRows,
  runtimeVersion,
  clientVersion,
  descriptorId = null,
  notes = null,
  migrationLedgerText = null,
  recordedAtIso = new Date().toISOString(),
}) {
  return {
    kind: "release-attempt",
    recordedAtIso,
    target,
    revision,
    ...(descriptorId === null ? {} : { descriptorId }),
    ...(notes === null || notes === "" ? {} : { notes }),
    rehearsal: rehearsalPassed ? `${rehearsalRows} PASS` : "FAILED",
    runtimeVersion,
    clientVersion,
    ...(migrationLedgerText === null
      ? {}
      : { migrationLedgerSha256: sha256Hex(migrationLedgerText) }),
  };
}

/**
 * Builds one "component-outcome" record from a deploy-components outcome
 * (pure; the caller supplies every field). The outcome detail is copied
 * verbatim; deploy-component.mjs guarantees names-only payloads.
 */
export function buildComponentOutcomeRecord({
  target,
  revision,
  descriptorId,
  outcome,
  recordedAtIso = new Date().toISOString(),
}) {
  if (!COMPONENT_OUTCOMES.includes(outcome.outcome)) {
    throw new Error(`unknown component outcome "${String(outcome.outcome)}"`);
  }
  const { component, outcome: state, ...detail } = outcome;
  if (typeof component !== "string" || component === "") {
    throw new Error("component outcome requires a non-empty component id");
  }
  if (state === "deployed") {
    if (typeof detail.digest !== "string" || detail.digest === "") {
      throw new Error("deployed requires an artifact digest");
    }
    if (
      typeof detail.remoteIdentity !== "object" ||
      detail.remoteIdentity === null ||
      typeof detail.remoteIdentity.id !== "string" ||
      detail.remoteIdentity.id === ""
    ) {
      throw new Error("deployed requires a remote identity (kind + id)");
    }
  }
  if (state === "skipped" && detail.skipReason !== "excluded-by-descriptor") {
    throw new Error('skipped requires skipReason "excluded-by-descriptor"');
  }
  if (state === "blocked" && typeof detail.blockedReason !== "string") {
    throw new Error("blocked requires a blockedReason");
  }
  return {
    kind: "component-outcome",
    recordedAtIso,
    target,
    revision,
    descriptorId,
    component,
    outcome: state,
    ...detail,
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
  const { loadTargetDescriptor } = await import("./target-descriptor.mjs");
  const { parseCliFlags } = await import("./cli-flags.mjs");
  const USAGE =
    "usage: record-release-evidence.mjs --target <staging|production> [--descriptor <targets/x.json>] [--revision <sha>] [--ledger <releases.jsonl>] ...";
  const { args, error } = parseCliFlags(process.argv.slice(2), {
    flags: [
      "target",
      "revision",
      "descriptor",
      "rehearsal-passed",
      "rehearsal-rows",
      "runtime-version",
      "client-version",
      "notes",
      "ledger",
      "migration-ledger",
    ],
  });
  if (error !== undefined) {
    console.error(`release evidence USAGE ERROR: ${error}\n${USAGE}`);
    process.exit(2);
  }
  const target = args.target;
  const revision = args.revision ?? "unknown";
  const descriptorPath = args.descriptor;
  const rehearsalPassed = args.rehearsalPassed === "true";
  const rehearsalRows = Number(args.rehearsalRows ?? 0);
  const runtimeVersion = args.runtimeVersion ?? "unknown";
  const clientVersion = args.clientVersion ?? "unknown";
  const notes = args.notes ?? null;
  const ledgerPath = args.ledger;
  const migrationLedgerPath = args.migrationLedger;
  if (target === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  let descriptorId = null;
  if (descriptorPath !== undefined) {
    const loaded = loadTargetDescriptor(descriptorPath);
    if (loaded.violations !== undefined) {
      console.error("release evidence REFUSED: the target descriptor is invalid:");
      for (const violation of loaded.violations) {
        console.error(`  - ${violation}`);
      }
      process.exit(1);
    }
    if (loaded.descriptor.target !== target) {
      console.error(
        `release evidence REFUSED: descriptor target ${loaded.descriptor.target} does not match --target ${target}`,
      );
      process.exit(1);
    }
    descriptorId = loaded.descriptor.descriptorId;
  }
  const record = buildReleaseRecord({
    target,
    revision,
    rehearsalPassed,
    rehearsalRows,
    runtimeVersion,
    clientVersion,
    descriptorId,
    notes,
    migrationLedgerText:
      migrationLedgerPath === undefined ? null : readFileSync(migrationLedgerPath, "utf8"),
  });
  appendReleaseRecord(record, ledgerPath ?? undefined);
  console.log(`release evidence recorded: ${JSON.stringify(record)}`);
}
