/**
 * The Convex deletion-bridge client (I4): how the gateway's purge route
 * resolves the AUTHORITATIVE media object keys of one deletion record.
 *
 * The Worker's own service credential authenticates the bridge call; the
 * Convex boundary re-verifies it and answers the ledger-recorded key list
 * (content-free opaque identities) or the typed refusal when no pending
 * media stage exists. A key list in the purge request's body is never
 * consulted - the ledger row is the only authority.
 */

import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { unavailableError } from "@kiero/runtime";
import { postBridge, type BridgeEnv } from "../platform/bridge";

/** The resolved purge targets of one deletion record. */
export interface PurgeTargets {
  readonly deletionRecordId: string;
  readonly objectKeys: readonly string[];
}

/** Resolves the deletion record's pending media object keys, or the typed refusal. */
export async function resolvePurgeTargets(
  env: BridgeEnv,
  deletionRecordId: string,
): Promise<{ ok: true; targets: PurgeTargets } | { ok: false; result: ResultEnvelope }> {
  const token = env.KIERO_SERVICE_TOKEN;
  if (token === undefined || token === "") {
    return { ok: false, result: errorResult(unavailableError(false, "service_credential_missing")) };
  }
  const bridged = await postBridge(
    env,
    "/operations/deletion/bridge",
    { op: "targets", deletionRecordId },
    `Bearer ${token}`,
  );
  if (!bridged.ok) {
    return { ok: false, result: bridged.error };
  }
  if (bridged.body._tag !== "ok") {
    return { ok: false, result: bridged.body };
  }
  const value: unknown = bridged.body.value;
  const objectKeys = (value as { objectKeys?: unknown }).objectKeys;
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(objectKeys) ||
    objectKeys.some((key) => typeof key !== "string")
  ) {
    return { ok: false, result: errorResult(unavailableError(false, "purge_targets_invalid")) };
  }
  return {
    ok: true,
    targets: { deletionRecordId, objectKeys: objectKeys as string[] },
  };
}
