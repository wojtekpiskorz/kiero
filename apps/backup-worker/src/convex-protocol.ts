/**
 * The Convex protocol client over the verified HTTP boundary (I5): the
 * container's transport for lease/complete/fail/sweep/state. Bearer is the
 * deployment's shared service credential (digest-compared server side);
 * a missing credential is a typed refusal, never a silent skip.
 */

import type { BackupProtocol, ProtocolBegin, ProtocolCompleteInput, ProtocolSweepPlan } from "./ports.ts";

export interface ConvexProtocolEnv {
  readonly CONVEX_SITE_URL?: string;
  readonly KIERO_SERVICE_TOKEN?: string;
}

export function convexProtocol(env: ConvexProtocolEnv): BackupProtocol | { readonly notConfigured: "protocol_not_configured" } {
  const siteUrl = env.CONVEX_SITE_URL;
  const token = env.KIERO_SERVICE_TOKEN;
  if (siteUrl === undefined || siteUrl === "" || token === undefined || token === "") {
    return { notConfigured: "protocol_not_configured" };
  }
  const call = async <T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> => {
    const response = await fetch(`${siteUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.status !== 200) {
      throw new Error(`convex_protocol_http_${response.status}`);
    }
    return payload.value as T;
  };
  return {
    begin: () => call<ProtocolBegin>("/operations/backups/run", "POST", {}),
    complete: (input: ProtocolCompleteInput) =>
      call<{ ok: boolean; reason?: string; tier?: string; expiresAtMs?: number }>(
        "/operations/backups/complete",
        "POST",
        input,
      ),
    fail: (manifestId, attempt, reason) =>
      call<{ ok: boolean }>("/operations/backups/fail", "POST", { manifestId, attempt, reason }),
    sweep: () => call<ProtocolSweepPlan>("/operations/backups/sweep", "POST", {}),
    sweepComplete: (input) =>
      call<{ collected: number; replayed: number; prunedFailed: number; skipped: number }>(
        "/operations/backups/sweep/complete",
        "POST",
        input,
      ),
  };
}
