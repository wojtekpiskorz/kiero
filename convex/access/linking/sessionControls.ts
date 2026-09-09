/**
 * The session-controls core (B2): revoke every OTHER device session of
 * the actor through B1's canonical revocation core (one call per session,
 * the current device stays). Per-device revocation is B1's own
 * `revokeSession`; this loop only batches it.
 */

import type { LinkingTx } from "./store";

/**
 * Revokes every OTHER device session of the actor through B1's canonical
 * revocation core (one call per session; the current device stays).
 */
export async function revokeOtherSessionsCore(
  tx: LinkingTx,
  args: {
    actorUserId: string;
    currentSessionId: string;
    nowMs: number;
    companyIdForEvent: string | null;
  },
): Promise<{ revokedAtMs: number; revokedCount: number; skipped: number }> {
  const rows = await tx.registrySessionsByUser(args.actorUserId);
  let revokedCount = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.id === args.currentSessionId || row.revokedAtMs !== null) {
      skipped += 1;
      continue;
    }
    const outcome = await tx.revokeRegistrySession({
      actorUserId: args.actorUserId,
      targetSessionId: row.id,
      nowMs: args.nowMs,
      companyIdForEvent: args.companyIdForEvent,
    });
    if (outcome.revoked) {
      revokedCount += 1;
    } else {
      skipped += 1;
    }
  }
  return { revokedAtMs: args.nowMs, revokedCount, skipped };
}
