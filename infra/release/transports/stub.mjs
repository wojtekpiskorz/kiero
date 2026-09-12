/**
 * The stub transport (R6 tests/local rehearsal): records exactly what a
 * real transport would receive (the REAL artifact path, the manifest
 * digest and the validated descriptor) into an append-only JSONL file,
 * and returns a synthetic remote identity. It performs no deployment.
 *
 * Selected by "kind": "stub" in a target descriptor. The record path
 * comes from the descriptor's transport.recordPath or the
 * KIERO_STUB_TRANSPORT_RECORD environment variable; if neither is set
 * the stub refuses (a call without a record would be unobservable).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function run({ component, descriptor, transport, artifactPath, digest, revision, env }) {
  const recordPath = transport.recordPath ?? env.KIERO_STUB_TRANSPORT_RECORD ?? "";
  if (recordPath === "") {
    throw new Error("stub transport requires transport.recordPath or KIERO_STUB_TRANSPORT_RECORD");
  }
  const remoteIdentity = { kind: "stub", id: `stub:${descriptor.target}:${component.id}` };
  mkdirSync(dirname(recordPath), { recursive: true });
  appendFileSync(
    recordPath,
    `${JSON.stringify({
      happenedAtIso: new Date().toISOString(),
      component: component.id,
      descriptorId: descriptor.descriptorId,
      artifactPath,
      digest,
      revision,
      remoteIdentity,
    })}\n`,
    "utf8",
  );
  return { remoteIdentity };
}
